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
    const result = await provider.streamMessage(
      {
        model: config.model,
        maxTokens: 16384,
        system: systemPrompt,
        messages,
        tools: tools.definitions,
        serverTools: config.serverTools || [],
        thinkingBudget: config.thinkingBudget || null,
      },
      onEvent,
    )

    const { contentBlocks, stopReason, usage } = result
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens

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
