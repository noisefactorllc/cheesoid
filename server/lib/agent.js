/**
 * Attempt to extract a tool call from text that was narrated instead of
 * being emitted as a structured tool_calls response. Returns a tool_use
 * block if found, null otherwise.
 */
export function _rescueNarratedToolCall(text, toolDefs) {
  const trimmed = text.trim()
  const validNames = new Set(toolDefs.map(t => t.name))

  // Strategy 1: try to parse the whole text as JSON
  try {
    const obj = JSON.parse(trimmed)
    if (obj.name && validNames.has(obj.name) && typeof obj.arguments === 'object') {
      return {
        type: 'tool_use',
        id: `toolu_rescued_${Date.now()}`,
        name: obj.name,
        input: obj.arguments,
      }
    }
  } catch {
    // not clean JSON, try extraction
  }

  // Strategy 2: find first JSON object in text using balanced brace matching
  const startIdx = trimmed.indexOf('{')
  if (startIdx === -1) return null

  let depth = 0
  let endIdx = -1
  for (let i = startIdx; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++
    else if (trimmed[i] === '}') depth--
    if (depth === 0) { endIdx = i; break }
  }
  if (endIdx === -1) return null

  try {
    const obj = JSON.parse(trimmed.slice(startIdx, endIdx + 1))
    if (obj.name && validNames.has(obj.name) && typeof obj.arguments === 'object') {
      return {
        type: 'tool_use',
        id: `toolu_rescued_${Date.now()}`,
        name: obj.name,
        input: obj.arguments,
      }
    }
  } catch {
    // couldn't parse
  }

  return null
}

/**
 * Run the agent loop. Calls onEvent with SSE events as it goes.
 * Delegates streaming to the provider (Anthropic, OpenAI-compat, etc.).
 * Handles tool execution and message assembly.
 */
export async function runAgent(systemPrompt, messages, tools, config, onEvent) {
  const { provider } = config
  let totalUsage = { input_tokens: 0, output_tokens: 0 }
  let iterations = 0
  const maxTurns = config.maxTurns || 20

  while (iterations < maxTurns) {
    // Intent routing for providers that support it (open models).
    // Classifies whether the next turn needs tools or is conversational,
    // then forces the appropriate mode to prevent tool-use hallucination.
    let toolChoice = undefined
    if (provider.supportsIntentRouting && tools.definitions.length > 0) {
      // Fast path: after tool results, let the model decide freely (auto).
      // It needs to either call more tools or summarize — both are valid.
      const lastMsg = messages[messages.length - 1]
      const isPostToolResult = Array.isArray(lastMsg?.content) &&
        lastMsg.content.some(b => b.type === 'tool_result')

      if (isPostToolResult) {
        toolChoice = 'auto'
      } else {
        toolChoice = await provider.classifyIntent({
          model: config.model,
          system: systemPrompt,
          messages,
          tools: tools.definitions,
        })
      }
      console.log(`[intent-router] toolChoice=${toolChoice} postToolResult=${isPostToolResult}`)
    }

    const result = await provider.streamMessage(
      {
        model: config.model,
        maxTokens: 16384,
        system: systemPrompt,
        messages,
        tools: toolChoice === 'none' ? [] : tools.definitions,
        serverTools: config.serverTools || [],
        thinkingBudget: config.thinkingBudget || null,
        toolChoice: toolChoice === 'none' ? undefined : toolChoice,
      },
      onEvent,
    )

    let { contentBlocks, stopReason, usage } = result
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens

    // Rescue narrated tool calls: if the model wrote a tool call as text
    // (e.g. {"name":"bash","arguments":{...}}) instead of using the structured
    // tool_calls API, extract it and convert to a real tool_use block.
    if (stopReason !== 'tool_use' && provider.supportsIntentRouting) {
      const textBlock = contentBlocks.find(b => b.type === 'text')
      if (textBlock) {
        const rescued = _rescueNarratedToolCall(textBlock.text, tools.definitions)
        if (rescued) {
          contentBlocks = contentBlocks.filter(b => b !== textBlock)
          contentBlocks.push(rescued)
          stopReason = 'tool_use'
          onEvent({ type: 'tool_start', name: rescued.name })
        }
      }
    }

    // Finalize content blocks — parse tool input JSON (for providers that return raw strings)
    const assistantContent = contentBlocks.map(block => {
      if ((block.type === 'tool_use' || block.type === 'server_tool_use') && typeof block.input === 'string') {
        try {
          return { ...block, input: JSON.parse(block.input || '{}') }
        } catch {
          return { ...block, input: {} }
        }
      }
      return block
    })

    messages.push({ role: 'assistant', content: assistantContent })

    // If no tool use, we're done
    if (stopReason !== 'tool_use') break

    // Execute tools — always produce a tool_result for every tool_use,
    // even on error, to keep message history valid for the API
    const toolResults = []
    for (const block of assistantContent.filter(b => b.type === 'tool_use')) {
      let result
      try {
        result = await tools.execute(block.name, block.input)
      } catch (err) {
        result = { output: `Tool error: ${err.message}`, is_error: true }
      }
      onEvent({ type: 'tool_result', name: block.name, input: block.input, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      })
    }

    messages.push({ role: 'user', content: toolResults })
    iterations++
  }

  onEvent({ type: 'done', usage: totalUsage })
  return { messages, usage: totalUsage }
}
