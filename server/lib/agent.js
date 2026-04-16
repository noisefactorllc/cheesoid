import { CircuitOpenError } from './circuit-breaker.js'

/**
 * Heuristic intent classifier — determines tool vs text without an API call.
 * Returns 'required', 'none', or 'uncertain' (needs LLM classification).
 */
const ACTION_PATTERNS = /\b(run|check|execute|start|stop|restart|deploy|show|look up|find|search|fetch|get|list|read|write|create|delete|update|send|post|curl|ssh|grep|approve|reject|moderate|inspect)\b/i
const CONVERSATION_PATTERNS = /^(thanks|thank you|ok|okay|lol|haha|nice|cool|great|good|got it|understood|sure|yep|yeah|yes|no|nah|hmm|interesting|wow|huh|right|true|fair|agreed)\b/i
const QUESTION_ABOUT_AGENT = /\b(how are you|what do you think|who are you|what are you|how do you feel|tell me about yourself)\b/i

export function classifyIntentHeuristic(lastUserContent) {
  if (!lastUserContent || typeof lastUserContent !== 'string') return 'uncertain'
  const trimmed = lastUserContent.trim()
  if (!trimmed) return 'uncertain'

  // Short acknowledgments → text
  if (trimmed.length < 20 && CONVERSATION_PATTERNS.test(trimmed)) return 'none'

  // Questions about the agent → text
  if (QUESTION_ABOUT_AGENT.test(trimmed)) return 'none'

  // Action verbs → tool
  if (ACTION_PATTERNS.test(trimmed)) return 'required'

  return 'uncertain'
}

/**
 * Attempt to extract a tool call from text that was narrated instead of
 * being emitted as a structured tool_calls response. Returns a tool_use
 * block if found, null otherwise.
 */
export function _rescueNarratedToolCall(text, toolDefs) {
  const trimmed = text.trim()
  const validNames = new Set(toolDefs.map(t => t.name))

  // Strategy 0a: XML-style tag wrapping JSON args, e.g.
  //   <internal>{"backchannel": "...", "trigger": true}</internal>
  // Haiku falls back to this when it should have used function-calling.
  for (const name of validNames) {
    const re = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, 'i')
    const m = trimmed.match(re)
    if (m) {
      try {
        const args = JSON.parse(m[1])
        if (args && typeof args === 'object') {
          return {
            type: 'tool_use',
            id: `toolu_rescued_${Date.now()}`,
            name,
            input: args,
          }
        }
      } catch { /* fall through */ }
    }
  }

  // Strategy 0b: XML-parameter style (Claude's alternative tool-use fallback):
  //   <internal>
  //     <parameter name="thought">...</parameter>
  //     <parameter name="trigger">true</parameter>
  //   </internal>
  // Parse each parameter element into the args object.
  for (const name of validNames) {
    const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i')
    const m = trimmed.match(re)
    if (m) {
      const inner = m[1]
      const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g
      const args = {}
      let match
      while ((match = paramRe.exec(inner)) !== null) {
        const pname = match[1]
        let pval = match[2].trim()
        // coerce booleans and numbers when unambiguous
        if (pval === 'true') args[pname] = true
        else if (pval === 'false') args[pname] = false
        else if (/^-?\d+(\.\d+)?$/.test(pval)) args[pname] = Number(pval)
        else args[pname] = pval
      }
      if (Object.keys(args).length > 0) {
        return {
          type: 'tool_use',
          id: `toolu_rescued_${Date.now()}`,
          name,
          input: args,
        }
      }
    }
  }

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
 * Extract the text content of the last user message (for heuristic classification).
 */
function getLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    // tool_result arrays aren't user text
    if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) continue
    return null
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
  let reasonerUsage = { input_tokens: 0, output_tokens: 0 }
  let iterations = 0
  const maxTurns = config.maxTurns || 20

  const MAX_CONSECUTIVE_TOOLS = 8
  let consecutiveToolCalls = 0
  let rescueCount = 0
  let totalToolTurns = 0
  let rescueFailed = false

  while (iterations < maxTurns) {
    // Intent routing for providers that support it (open models).
    let toolChoice = undefined
    if (provider.supportsIntentRouting && tools.definitions.length > 0) {
      const lastMsg = messages[messages.length - 1]
      const isPostToolResult = Array.isArray(lastMsg?.content) &&
        lastMsg.content.some(b => b.type === 'tool_result')

      if (rescueFailed) {
        toolChoice = 'none'
      } else if (consecutiveToolCalls >= MAX_CONSECUTIVE_TOOLS) {
        toolChoice = 'none'
        console.log(`[intent-router] toolChoice=none (forced after ${consecutiveToolCalls} consecutive tool calls)`)
      } else if (isPostToolResult) {
        toolChoice = 'auto'
      } else {
        const lastUserText = getLastUserText(messages)
        const heuristic = classifyIntentHeuristic(lastUserText)

        if (heuristic !== 'uncertain') {
          toolChoice = heuristic
          console.log(`[intent-router] toolChoice=${toolChoice} (heuristic) text="${(lastUserText || '').slice(0, 40)}"`)
        } else {
          toolChoice = await provider.classifyIntent({
            model: config.model,
            system: systemPrompt,
            messages,
            tools: tools.definitions,
          })
          console.log(`[intent-router] toolChoice=${toolChoice} (llm-classifier)`)
        }
      }

      if (!rescueFailed && toolChoice !== undefined) {
        console.log(`[intent-router] final=${toolChoice} postToolResult=${isPostToolResult} consecutiveTools=${consecutiveToolCalls}`)
      }
    }

    const repairedGaps = repairToolUseGaps(messages)
    if (repairedGaps > 0) {
      console.log(`[agent] ${repairedGaps} interrupted tool calls detected — injecting recovery context`)
      messages.push({ role: 'user', content: `[SYSTEM: You were interrupted mid-operation. ${repairedGaps} tool call(s) did not complete. Review current state before re-attempting any operations.]` })
    }

    let result
    try {
      result = await provider.streamMessage(
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
    } catch (err) {
      err.layer = err.layer || config.layer
      err.triedModels = err.triedModels || [config.model]
      throw err
    }

    let { contentBlocks, stopReason, usage } = result
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens

    // Rescue narrated tool calls — fires when a text block contains a tool
    // call written as prose/XML instead of via function calling. Handles both
    // pure-text responses (stopReason !== 'tool_use') and mixed responses
    // where the model called some tools correctly but narrated others.
    if (toolChoice !== 'none' && !rescueFailed) {
      const textBlock = contentBlocks.find(b => b.type === 'text')
      if (textBlock) {
        const rescued = _rescueNarratedToolCall(textBlock.text, tools.definitions)
        if (rescued) {
          // Strip the narrated call from the text, keep any remaining text
          const cleanedText = textBlock.text
            .replace(/<\w+>[\s\S]*?<\/\w+>/g, '')
            .trim()
          contentBlocks = contentBlocks.filter(b => b !== textBlock)
          if (cleanedText) {
            contentBlocks.push({ type: 'text', text: cleanedText })
          }
          contentBlocks.push(rescued)
          stopReason = 'tool_use'
          onEvent({ type: 'tool_start', name: rescued.name })
          rescueCount++
          console.log(`[intent-router] rescued narrated tool call: ${rescued.name} (rescue #${rescueCount})`)

          if (totalToolTurns >= 4 && rescueCount / totalToolTurns > 0.5) {
            console.log(`[intent-router] rescue rate ${rescueCount}/${totalToolTurns} > 50% — disabling tools for rest of run`)
            rescueFailed = true
          }
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

    // Strip thinking blocks — they cause 400 errors when replayed in history
    const cleanedContent = assistantContent.filter(b => b.type !== 'thinking')
    messages.push({ role: 'assistant', content: cleanedContent })

    // If no tool use, we're done
    if (stopReason !== 'tool_use') {
      consecutiveToolCalls = 0
      break
    }
    consecutiveToolCalls++
    totalToolTurns++

    // Execute tools
    const toolResults = []
    for (const block of assistantContent.filter(b => b.type === 'tool_use')) {
      let result
      try {
        result = await tools.execute(block.name, block.input, { onEvent })
      } catch (err) {
        result = { output: `Tool error: ${err.message}`, is_error: true }
      }
      if (result._usage) {
        reasonerUsage.input_tokens += result._usage.input_tokens
        reasonerUsage.output_tokens += result._usage.output_tokens
      }
      onEvent({ type: 'tool_result', name: block.name, input: block.input, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof result.output === 'string' ? result.output : JSON.stringify(result),
      })
    }

    // Correction feedback after rescue
    const wasRescued = contentBlocks.some(b => b.type === 'tool_use' && b.id?.startsWith('toolu_rescued_'))
    if (wasRescued && provider.supportsIntentRouting) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: 'system_correction',
        content: '[system: You narrated a tool call instead of using function calling. The call was executed, but you must use the function calling API directly.]',
      })
    }

    messages.push({ role: 'user', content: toolResults })
    iterations++
  }

  // If the model ended with no text after tool results, make one more call
  // with tools disabled so it summarizes in its own voice.
  await _nudgeIfEmpty(messages, provider, config, systemPrompt, totalUsage, onEvent)

  onEvent({ type: 'done', model: config.model, usage: { input_tokens: totalUsage.input_tokens + reasonerUsage.input_tokens, output_tokens: totalUsage.output_tokens + reasonerUsage.output_tokens } })
  return { messages, usage: totalUsage }
}

/**
 * If the final assistant message has no text and the previous message was
 * tool results, make one more API call with tools disabled so the model
 * provides a followup in its own voice.
 */
async function _nudgeIfEmpty(messages, provider, config, systemPrompt, totalUsage, onEvent) {
  const lastAssistant = messages[messages.length - 1]
  if (lastAssistant?.role !== 'assistant') return

  const hasText = Array.isArray(lastAssistant.content) &&
    lastAssistant.content.some(b => b.type === 'text' && b.text?.trim())
  if (hasText) return

  const prevMsg = messages[messages.length - 2]
  const isPostToolResult = Array.isArray(prevMsg?.content) &&
    prevMsg.content.some(b => b.type === 'tool_result')
  if (!isPostToolResult) return

  console.log(`[agent] empty response after tool use — nudging orchestrator for followup`)

  // Remove the empty assistant message to maintain valid alternation
  messages.pop()

  let result
  try {
    result = await provider.streamMessage(
      {
        model: config.model,
        maxTokens: 4096,
        system: systemPrompt,
        messages,
        tools: [],
        serverTools: [],
        thinkingBudget: null,
      },
      onEvent,
    )
  } catch (err) {
    // Enrich with context if missing — nudge uses the orchestrator model
    err.layer = err.layer || config.layer
    err.triedModels = err.triedModels || [config.model]
    throw err
  }

  totalUsage.input_tokens += result.usage.input_tokens
  totalUsage.output_tokens += result.usage.output_tokens

  const cleanedBlocks = result.contentBlocks.filter(b => b.type !== 'thinking')
  messages.push({ role: 'assistant', content: cleanedBlocks })
}

/**
 * Repair orphaned tool_use/tool_result blocks in message history.
 * - If an assistant message has tool_use blocks without matching tool_results
 *   in the next message, insert synthetic results.
 * - If a user message has tool_result blocks referencing tool_use_ids not
 *   present in the preceding assistant message, remove them.
 */
/**
 * Repair orphaned tool_use/tool_result blocks in message history.
 * Returns the number of orphaned tool_use blocks that were repaired
 * (i.e. tool calls that never got results — indicates prior interruption).
 */
function repairToolUseGaps(messages) {
  let repairedCount = 0

  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue

    const toolUseIds = new Set(
      msg.content.filter(b => b.type === 'tool_use').map(b => b.id)
    )

    const next = messages[i + 1]
    if (!next || next.role !== 'user' || !Array.isArray(next.content)) {
      // No user message follows — insert synthetic results for all tool_use blocks
      if (toolUseIds.size > 0) {
        console.log(`[hybrid] repairing ${toolUseIds.size} orphaned tool_use blocks at message ${i}`)
        repairedCount += toolUseIds.size
        const syntheticResults = [...toolUseIds].map(id => ({
          type: 'tool_result',
          tool_use_id: id,
          content: '{"output":"[tool result unavailable — previous session interrupted]","is_error":true}',
        }))
        messages.splice(i + 1, 0, { role: 'user', content: syntheticResults })
      }
      continue
    }

    const existingResultIds = new Set()
    for (const b of next.content) {
      if (b.type === 'tool_result') existingResultIds.add(b.tool_use_id)
    }

    // Forward: add synthetic results for tool_use blocks missing results
    const missingResults = [...toolUseIds].filter(id => !existingResultIds.has(id))
    if (missingResults.length > 0) {
      console.log(`[hybrid] repairing ${missingResults.length} orphaned tool_use blocks at message ${i}`)
      repairedCount += missingResults.length
      next.content.push(...missingResults.map(id => ({
        type: 'tool_result',
        tool_use_id: id,
        content: '{"output":"[tool result unavailable — previous session interrupted]","is_error":true}',
      })))
    }

    // Inverse: remove tool_result blocks referencing non-existent tool_use ids
    const orphanedResults = next.content.filter(
      b => b.type === 'tool_result' && !toolUseIds.has(b.tool_use_id)
    )
    if (orphanedResults.length > 0) {
      console.log(`[hybrid] removing ${orphanedResults.length} orphaned tool_result blocks at message ${i + 1}`)
      next.content = next.content.filter(
        b => b.type !== 'tool_result' || toolUseIds.has(b.tool_use_id)
      )
      // If no content left, replace with placeholder
      if (next.content.length === 0) {
        next.content = '[tool results removed — referenced non-existent tool calls]'
      }
    }
  }

  // Second pass: catch user messages with tool_results that have no preceding
  // assistant message at all (e.g. at position 0 or after another user message)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue

    const toolResults = msg.content.filter(b => b.type === 'tool_result')
    if (toolResults.length === 0) continue

    const prev = i > 0 ? messages[i - 1] : null
    const prevToolUseIds = new Set()
    if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
      for (const b of prev.content) {
        if (b.type === 'tool_use') prevToolUseIds.add(b.id)
      }
    }

    const orphaned = toolResults.filter(b => !prevToolUseIds.has(b.tool_use_id))
    if (orphaned.length > 0) {
      console.log(`[hybrid] removing ${orphaned.length} orphaned tool_result blocks at message ${i} (no matching tool_use in preceding message)`)
      msg.content = msg.content.filter(
        b => b.type !== 'tool_result' || prevToolUseIds.has(b.tool_use_id)
      )
      if (msg.content.length === 0) {
        msg.content = '[tool results removed — referenced non-existent tool calls]'
      }
    }
  }

  return repairedCount
}

const EXECUTOR_SYSTEM = `You are a tool executor for an English-language business application. You receive tool results and may need to call follow-up tools.
- Respond ONLY in English.
- If a result contains data needed for an obvious next step, call that tool.
- If results are complete, respond with ONLY the word "done".
- Do NOT generate content, commentary, or text beyond tool calls and "done".
- Do NOT explore, speculate, or call tools out of curiosity.
- Maximum 2 follow-up tool calls, then you MUST respond "done".`

/**
 * Call executor streamMessage with fallback chain. Tries each model
 * in order, resolving provider via registry. Falls back through the
 * list until one succeeds.
 */
async function callExecutorWithFallback(config, params, onEvent) {
  const models = [config.executorModel, ...(config.executorFallbackModels || [])]
  const registry = config.registry
  let lastErr
  const triedModels = []

  for (const modelString of models) {
    let provider, modelId
    if (registry) {
      const resolved = registry.resolve(modelString)
      provider = resolved.provider
      modelId = resolved.modelId
    } else {
      // Legacy/test path — no registry, use executorProvider directly
      const { resolveModel } = await import('./providers/resolve.js')
      const parsed = resolveModel(modelString)
      modelId = parsed.modelId

      if (parsed.providerName === 'anthropic') {
        provider = (config.fallbackProviders || {}).anthropic || config.executorProvider
      } else if (parsed.providerName && parsed.providerName !== 'anthropic') {
        // Can't resolve named providers without registry — skip
        continue
      } else {
        provider = config.executorProvider
      }
    }

    triedModels.push(modelId)
    try {
      const t0 = Date.now()
      const result = await provider.streamMessage({ ...params, model: modelId }, onEvent)
      result._latencyMs = Date.now() - t0
      result._model = modelId
      return { result, model: modelId }
    } catch (err) {
      lastErr = err
      if (err.isCircuitOpen) {
        console.log(`[hybrid] executor ${modelId} skipped: circuit open for ${err.url}`)
      } else {
        console.log(`[hybrid] executor ${modelId} failed: ${err.message}, trying next`)
      }
    }
  }
  const finalErr = lastErr || new Error('All executor models failed')
  finalErr.layer = 'execution'
  finalErr.triedModels = triedModels
  throw finalErr
}

async function callOrchestratorWithFallback(config, params, onEvent) {
  const triedModels = [params.model]
  const layer = config.layer
  try {
    const t0 = Date.now()
    const result = await config.provider.streamMessage(params, onEvent)
    return { ...result, actualModel: params.model, _latencyMs: Date.now() - t0 }
  } catch (err) {
    // Always attempt the fallback chain. Fallbacks typically cross providers
    // (e.g. anthropic → openai), so per-provider errors — billing (400 credit
    // balance), auth (401/403), rate limits (429), overload (529), server
    // errors — all warrant trying the backup.
    if (!config.orchestratorFallbackModels?.length) {
      err.layer = err.layer || layer
      err.triedModels = triedModels
      throw err
    }
    console.log(`[hybrid] orchestrator ${params.model} failed: ${err.message}, trying fallbacks`)

    let lastErr = err
    for (const modelString of config.orchestratorFallbackModels) {
      const { modelId, provider } = config.registry.resolve(modelString)
      triedModels.push(modelId)
      try {
        onEvent({ type: 'model_fallback', from: params.model, to: modelId })
        const t0 = Date.now()
        const result = await provider.streamMessage({ ...params, model: modelId }, onEvent)
        return { ...result, actualModel: modelId, _latencyMs: Date.now() - t0 }
      } catch (fallbackErr) {
        lastErr = fallbackErr
        console.log(`[hybrid] orchestrator fallback ${modelId} failed: ${fallbackErr.message}`)
      }
    }
    lastErr.layer = layer
    lastErr.triedModels = triedModels
    throw lastErr
  }
}

/**
 * Hybrid agent loop. The orchestrator (smart, expensive model) handles
 * reasoning, persona, and planning. The executor (cheap model) handles
 * the tool-result loop — processing results and deciding if more tools
 * are needed. Tools execute directly via tools.execute().
 *
 * Flow:
 * 1. Orchestrator: sees full context, emits tool calls + text
 * 2. Tools: execute directly
 * 3. Executor: sees tool results + tool definitions (NO persona/history),
 *    decides if more tools needed, loops until done
 * 4. Orchestrator: sees all accumulated results, generates final response
 */
export async function runHybridAgent(systemPrompt, messages, tools, config, onEvent) {
  // NOTE: do not capture config.provider — step_up may reassign it mid-loop
  let orchestrator = config.provider
  // Resolve executor from registry if available, fall back to config.executorProvider
  const executorResolved = config.registry && config.executorModel
    ? config.registry.resolve(config.executorModel)
    : null
  const executor = executorResolved?.provider || config.executorProvider
  const executorModel = executorResolved?.modelId || config.executorModel
  let totalUsage = { input_tokens: 0, output_tokens: 0 }
  let executorUsage = { input_tokens: 0, output_tokens: 0 }
  let reasonerUsage = { input_tokens: 0, output_tokens: 0 }
  let iterations = 0
  const maxTurns = config.maxTurns || 20

  const MAX_CONSECUTIVE_TOOLS = 8
  let consecutiveToolCalls = 0
  let rescueCount = 0
  let totalToolTurns = 0
  let rescueFailed = false
  let stepUpUsed = false // one step_up re-run per agent call
  let endTurnByTool = false // a tool requested hard-stop (e.g. internal trigger)
  let lastRespondedModel = null // actual model that responded (may differ from config.model after fallback)
  const calledTools = new Set() // track tool+args for dedup across executor turns
  const metrics = { models: {}, totalLatencyMs: 0, fallbackCount: 0, duplicateToolCalls: 0, startTime: Date.now() }

  while (iterations < maxTurns) {
    // Intent routing — applies when orchestrator is openai-compat
    let toolChoice = undefined
    if (orchestrator.supportsIntentRouting && tools.definitions.length > 0) {
      const lastMsg = messages[messages.length - 1]
      const isPostToolResult = Array.isArray(lastMsg?.content) &&
        lastMsg.content.some(b => b.type === 'tool_result')

      if (rescueFailed) {
        toolChoice = 'none'
      } else if (consecutiveToolCalls >= MAX_CONSECUTIVE_TOOLS) {
        toolChoice = 'none'
        console.log(`[hybrid] toolChoice=none (forced after ${consecutiveToolCalls} consecutive tool calls)`)
      } else if (isPostToolResult) {
        toolChoice = 'auto'
      } else {
        const lastUserText = getLastUserText(messages)
        const heuristic = classifyIntentHeuristic(lastUserText)

        if (heuristic !== 'uncertain') {
          toolChoice = heuristic
        } else {
          toolChoice = await orchestrator.classifyIntent({
            model: config.model,
            system: systemPrompt,
            messages,
            tools: tools.definitions,
          })
        }
      }
    }

    // Safety: ensure no orphaned tool_use blocks without matching tool_results
    // (can happen if a previous turn crashed mid-execution)
    const repairedGaps = repairToolUseGaps(messages)
    if (repairedGaps > 0) {
      console.log(`[hybrid] ${repairedGaps} interrupted tool calls detected — injecting recovery context`)
      messages.push({ role: 'user', content: `[SYSTEM: You were interrupted mid-operation. ${repairedGaps} tool call(s) did not complete. Review current state before re-attempting any operations.]` })
    }

    // Orchestrator call — full context
    const result = await callOrchestratorWithFallback(
      config,
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

    let { contentBlocks, stopReason, usage, actualModel, _latencyMs } = result
    lastRespondedModel = actualModel
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens
    // Track per-model metrics
    if (actualModel) {
      if (!metrics.models[actualModel]) metrics.models[actualModel] = { calls: 0, tokens_in: 0, tokens_out: 0, latency_ms: [], tools: 0, fallbacks: 0 }
      const m = metrics.models[actualModel]
      m.calls++
      m.tokens_in += usage.input_tokens
      m.tokens_out += usage.output_tokens
      if (_latencyMs) m.latency_ms.push(_latencyMs)
      if (actualModel !== config.model) { m.fallbacks++; metrics.fallbackCount++ }
    }

    const toolUseCount = contentBlocks.filter(b => b.type === 'tool_use').length
    const hasText = contentBlocks.some(b => b.type === 'text' && b.text)
    console.log(`[hybrid] orchestrator turn ${iterations + 1}: ${usage.input_tokens} in / ${usage.output_tokens} out | tools=${toolUseCount} text=${hasText} stop=${stopReason}`)

    // Rescue narrated tool calls — fires for ANY orchestrator (haiku
    // narrates as XML-parameter when it slips out of function-calling
    // discipline; open-weight models narrate as plain JSON; gemini-pro
    // sometimes wraps in code fences). Previously gated on
    // `orchestrator.supportsIntentRouting`, which excluded Anthropic
    // entirely and let haiku's narrated calls leak straight to chat.
    // Also fires on mixed responses (real tool_use + narrated text).
    if (toolChoice !== 'none' && !rescueFailed) {
      const textBlock = contentBlocks.find(b => b.type === 'text')
      if (textBlock) {
        const rescued = _rescueNarratedToolCall(textBlock.text, tools.definitions)
        if (rescued) {
          // Strip narrated XML from the text; keep any remaining visible prose.
          const cleanedText = textBlock.text
            .replace(/<\w+>[\s\S]*?<\/\w+>/g, '')
            .trim()
          contentBlocks = contentBlocks.filter(b => b !== textBlock)
          if (cleanedText) {
            contentBlocks.push({ type: 'text', text: cleanedText })
          }
          contentBlocks.push(rescued)
          stopReason = 'tool_use'
          onEvent({ type: 'tool_start', name: rescued.name })
          rescueCount++

          if (totalToolTurns >= 4 && rescueCount / totalToolTurns > 0.5) {
            rescueFailed = true
          }
        }
      }
    }

    // Finalize content blocks
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

    // Strip thinking blocks — they cause 400 errors when replayed in history
    const cleanedAssistant = assistantContent.filter(b => b.type !== 'thinking')
    messages.push({ role: 'assistant', content: cleanedAssistant })

    // Emit this turn's text as a standalone event so downstream listeners
    // (chat-session) can persist to history incrementally, independent of
    // whether subsequent tool execution hangs, errors, or completes. Without
    // this, a stalled tool (e.g. deep_think mid-stream) would delay text
    // persistence until the entire orchestrator loop returns.
    const turnText = cleanedAssistant
      .filter(b => b.type === 'text' && b.text?.trim())
      .map(b => b.text)
      .join('\n')
    if (turnText) {
      onEvent({ type: 'assistant_text_turn', text: turnText, model: actualModel })
    }

    // No tool use — orchestrator is done
    if (stopReason !== 'tool_use') {
      consecutiveToolCalls = 0
      break
    }

    // Execute tools directly
    let toolResults = []
    let stepUpTriggered = false
    let endTurnRequested = false
    const orchestratorToolNames = assistantContent.filter(b => b.type === 'tool_use').map(b => b.name)
    if (orchestratorToolNames.length > 0) {
      console.log(`[hybrid] orchestrator tools: ${orchestratorToolNames.join(', ')}`)
    }
    for (const block of assistantContent.filter(b => b.type === 'tool_use')) {
      calledTools.add(`${block.name}(${JSON.stringify(block.input)})`)
      let toolResult
      try {
        toolResult = await tools.execute(block.name, block.input, { onEvent })
      } catch (err) {
        toolResult = { output: `Tool error: ${err.message}`, is_error: true }
      }
      if (toolResult._stepUp) stepUpTriggered = true
      if (toolResult._endTurn) endTurnRequested = true
      if (toolResult._usage) {
        reasonerUsage.input_tokens += toolResult._usage.input_tokens
        reasonerUsage.output_tokens += toolResult._usage.output_tokens
      }
      onEvent({ type: 'tool_result', name: block.name, input: block.input, result: toolResult })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof toolResult.output === 'string' ? toolResult.output : JSON.stringify(toolResult),
      })
    }
    consecutiveToolCalls++
    totalToolTurns++

    // --- MODALITY: step_up re-run ---
    // If a modality step_up tool was called AND the mode actually changed,
    // discard the attention response and re-run this turn with the new model.
    // Only one re-run per turn to prevent infinite loops.
    if (config.modality && !stepUpUsed) {
      if (stepUpTriggered) {
        // Remove the attention model's assistant message — tool results
        // are intentionally NOT pushed, so the cognition model sees the
        // original conversation without the aborted attention turn.
        messages.pop()

        // Re-resolve model from modality (now cognition)
        const newModel = config.modality.model
        const resolved = config.registry.resolve(newModel)
        config.model = resolved.modelId
        config.provider = resolved.provider
        orchestrator = resolved.provider // update local ref for intent routing
        stepUpUsed = true // prevent re-run loops

        console.log(`[hybrid] step_up: re-running turn with ${resolved.modelId}`)

        // Don't count this as an iteration — we're re-running, not advancing
        consecutiveToolCalls--
        totalToolTurns--
        continue // re-enters the while loop with the cognition model
      }
    }

    // --- EXECUTOR TOOL LOOP ---
    // The cheap executor processes tool results and can call follow-up tools.
    // It sees only results + tool definitions — no persona, no history.
    // Hard cap of 3 turns to prevent runaway loops.
    // Filter out voice-driven tools — these need the orchestrator's quality.
    // The executor only gets mechanical tools (bash, reads, lookups, API calls).
    const ORCHESTRATOR_ONLY_TOOLS = new Set([
      'write_memory', 'append_memory', 'write_shared',
      'send_chat_message', 'send_mail', 'internal',
      // react_to_message and reply_to_message need messageId from user
      // context, which the executor never sees (executor context is only
      // tool results). Keep them on the orchestrator.
      'react_to_message', 'reply_to_message',
    ])
    const executorTools = tools.definitions.filter(t => !ORCHESTRATOR_ONLY_TOOLS.has(t.name))

    // Skip the executor turn entirely when every orchestrator tool was a
    // no-followup-needed action (backchannel triggers, message sends, memory
    // writes, reactions). Their tool_results contain only confirmation strings
    // — there is nothing for the executor to chain on. With tool_choice:
    // 'required' the executor would be forced to invent a tool call,
    // hallucinating placeholder paths like read_file('path/to/file'), and the
    // resulting error would feed back into the orchestrator and trigger a
    // cascade of duplicate calls.
    const allOrchestratorOnly = orchestratorToolNames.length > 0
      && orchestratorToolNames.every(n => ORCHESTRATOR_ONLY_TOOLS.has(n))

    if (executor && executorModel && executorTools.length > 0 && !allOrchestratorOnly) {

      // Latest results start as the orchestrator's tool results
      let latestResultText = toolResults.map(r => r.content).join('\n\n')

      const MAX_EXECUTOR_TURNS = 1
      const MAX_EXECUTOR_RETRIES = 3
      const EXECUTOR_BACKOFF_BASE_MS = 2000
      let activeExecutorModel = executorModel // best-known executor model for event tagging
      for (let execTurn = 0; execTurn < MAX_EXECUTOR_TURNS; execTurn++) {
        // Fresh context each turn — only latest results + already-called list.
        // Prevents context accumulation that triggers prose mode in open weight models.
        const alreadyCalled = calledTools.size > 0 ? `\n\nAlready called (do NOT repeat): ${[...calledTools].join(', ')}` : ''
        const executorMessages = [
          { role: 'user', content: `Tool results:\n\n${latestResultText}${alreadyCalled}\n\nIf a follow-up tool call is needed based on these results, call it. Otherwise respond "done".` },
        ]
        try {
          // Retry with exponential backoff before giving up on this turn
          let execResult, usedModel, lastRetryErr
          for (let retry = 0; retry < MAX_EXECUTOR_RETRIES; retry++) {
            try {
              const res = await callExecutorWithFallback(
                config,
                {
                  maxTokens: 3000,
                  system: EXECUTOR_SYSTEM,
                  messages: executorMessages,
                  tools: executorTools,
                  serverTools: [],
                  thinkingBudget: null,
                  toolChoice: 'required',
                },
                (event) => {
                  if (event.type === 'tool_start' || event.type === 'tool_result') {
                    onEvent({ ...event, model: activeExecutorModel, executor: true })
                  }
                },
              )
              execResult = res.result
              usedModel = res.model
              break // success
            } catch (retryErr) {
              lastRetryErr = retryErr
              if (retry < MAX_EXECUTOR_RETRIES - 1) {
                const delayMs = EXECUTOR_BACKOFF_BASE_MS * Math.pow(2, retry)
                console.log(`[hybrid] executor turn ${execTurn + 1} retry ${retry + 1}/${MAX_EXECUTOR_RETRIES} failed: ${retryErr.message} — backoff ${delayMs}ms`)
                await new Promise(resolve => setTimeout(resolve, delayMs))
              }
            }
          }
          if (!execResult) {
            // All retries exhausted — surface error to room and bail
            const triedList = lastRetryErr?.triedModels?.length
              ? lastRetryErr.triedModels.map(m => `\`${m}\``).join(', ')
              : 'unknown'
            onEvent({
              type: 'executor_error',
              message: `Executor failed after ${MAX_EXECUTOR_RETRIES} retries (tried: ${triedList}): ${lastRetryErr?.message || 'unknown error'}`,
              error: lastRetryErr,
            })
            console.log(`[hybrid] executor turn ${execTurn + 1} failed after ${MAX_EXECUTOR_RETRIES} retries — returning to orchestrator`)
            break
          }
          activeExecutorModel = usedModel // update with actual model used (may differ after fallback)

          executorUsage.input_tokens += execResult.usage.input_tokens
          executorUsage.output_tokens += execResult.usage.output_tokens
          // Track executor model metrics
          if (usedModel) {
            if (!metrics.models[usedModel]) metrics.models[usedModel] = { calls: 0, tokens_in: 0, tokens_out: 0, latency_ms: [], tools: 0, fallbacks: 0 }
            const em = metrics.models[usedModel]
            em.calls++
            em.tokens_in += execResult.usage.input_tokens
            em.tokens_out += execResult.usage.output_tokens
            if (execResult._latencyMs) em.latency_ms.push(execResult._latencyMs)
          }

          const execContent = execResult.contentBlocks.map(block => {
            if (block.type === 'tool_use' && typeof block.input === 'string') {
              try { return { ...block, input: JSON.parse(block.input || '{}') } }
              catch { return { ...block, input: {} } }
            }
            return block
          })

          const execToolCalls = execContent.filter(b => b.type === 'tool_use')

          console.log(`[hybrid] executor turn ${execTurn + 1} (${usedModel}): ${execResult.usage.input_tokens} in / ${execResult.usage.output_tokens} out | tools=${execToolCalls.length} stop=${execResult.stopReason}`)

          // Executor done or no tool calls — break
          if (execResult.stopReason !== 'tool_use' || execToolCalls.length === 0) {
            break
          }

          // Execute the tools the executor requested
          const moreResults = []
          for (const block of execToolCalls) {
            calledTools.add(`${block.name}(${JSON.stringify(block.input)})`)
            let toolResult
            try {
              toolResult = await tools.execute(block.name, block.input)
            } catch (err) {
              toolResult = { output: `Tool error: ${err.message}`, is_error: true }
            }
            onEvent({ type: 'tool_result', name: block.name, input: block.input, result: toolResult, model: activeExecutorModel, executor: true })
            moreResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(toolResult),
            })
          }
          // Update latest results for next turn's fresh context
          latestResultText = moreResults.map(r => r.content).join('\n\n')

          // Append executor tool results as text to orchestrator's tool results
          // (can't use tool_result format — orchestrator never emitted these IDs)
          const execResultText = moreResults.map(r => r.content).join('\n')
          if (toolResults.length > 0) {
            toolResults[toolResults.length - 1].content += `\n\n[executor follow-up results]\n${execResultText}`
          }

          totalToolTurns++
          iterations++ // count against maxTurns
        } catch (err) {
          console.log(`[hybrid] executor failed: ${err.message} — returning to orchestrator`)
          onEvent({
            type: 'executor_error',
            message: `Executor error: ${err.message}`,
            error: err,
          })
          break
        }
      }
    }

    messages.push({ role: 'user', content: toolResults })
    iterations++

    // A tool requested an explicit end-of-turn (e.g. internal({trigger:true})
    // — the agent has done its job by waking another agent; any further
    // orchestrator turn would just re-trigger or hallucinate). Hard-stop the
    // loop here regardless of whether the model wants to keep going.
    if (endTurnRequested) {
      console.log(`[hybrid] tool requested end-of-turn — breaking orchestrator loop`)
      endTurnByTool = true
      break
    }
  }

  // If the orchestrator ended with no text after tool results, make one more call
  // with tools disabled so it summarizes in its own voice.
  // Use config.provider (not the captured `orchestrator`) because step_up may have changed it.
  // Skip the nudge if a tool explicitly ended the turn (e.g. internal trigger
  // delegated to another agent — the moderator should NOT then narrate).
  if (!endTurnByTool && !config.skipEmptyNudge) {
    await _nudgeIfEmpty(messages, config.provider, config, systemPrompt, totalUsage, onEvent)
  }

  metrics.totalLatencyMs = Date.now() - metrics.startTime
  metrics.duplicateToolCalls = calledTools.size < totalToolTurns ? totalToolTurns - calledTools.size : 0
  // Per-model summary
  const modelSummary = Object.entries(metrics.models).map(([model, m]) => {
    const avgLatency = m.latency_ms.length ? Math.round(m.latency_ms.reduce((a, b) => a + b, 0) / m.latency_ms.length) : 0
    const p95Latency = m.latency_ms.length ? Math.round(m.latency_ms.sort((a, b) => a - b)[Math.floor(m.latency_ms.length * 0.95)]) : 0
    return `${model}: ${m.calls} calls, ${m.tokens_in}/${m.tokens_out} tok, avg ${avgLatency}ms, p95 ${p95Latency}ms${m.fallbacks ? `, ${m.fallbacks} fallback` : ''}`
  }).join(' | ')
  console.log(`[hybrid] orchestrator: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out | executor: ${executorUsage.input_tokens} in / ${executorUsage.output_tokens} out | reasoner: ${reasonerUsage.input_tokens} in / ${reasonerUsage.output_tokens} out | tools: ${totalToolTurns} | total: ${metrics.totalLatencyMs}ms | fallbacks: ${metrics.fallbackCount}`)
  console.log(`[hybrid] models: ${modelSummary}`)
  onEvent({ type: 'done', model: lastRespondedModel, usage: { input_tokens: totalUsage.input_tokens + executorUsage.input_tokens + reasonerUsage.input_tokens, output_tokens: totalUsage.output_tokens + executorUsage.output_tokens + reasonerUsage.output_tokens } })
  return { messages, usage: totalUsage }
}
