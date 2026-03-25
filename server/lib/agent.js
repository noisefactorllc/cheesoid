import { getClient } from './ai-client.js'

const SONNET_FALLBACK = 'claude-sonnet-4-6'

function isOpusModel(model) {
  return model && model.includes('opus')
}

function isUnavailableError(err) {
  if (err.status === 529 || err.status === 503 || err.status === 404) return true
  // Overloaded errors can also arrive as SSE events with type 'overloaded_error'
  if (err.errorType === 'overloaded_error' || err.errorType === 'api_error') return true
  return false
}

async function streamOnce(client, params, onEvent) {
  const stream = client.messages.stream(params)
  const contentBlocks = []
  let stopReason = null
  const usage = { input_tokens: 0, output_tokens: 0 }

  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'text') {
        contentBlocks.push({ type: 'text', text: '' })
      } else if (block.type === 'tool_use') {
        contentBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: '' })
        onEvent({ type: 'tool_start', name: block.name })
      } else if (block.type === 'server_tool_use') {
        contentBlocks.push({ type: 'server_tool_use', id: block.id, name: block.name, input: '' })
        onEvent({ type: 'tool_start', name: block.name, server: true })
      } else if (block.type === 'web_search_tool_result') {
        contentBlocks.push(block)
      } else if (block.type === 'thinking') {
        contentBlocks.push({ type: 'thinking', thinking: '', signature: '' })
      }
    } else if (event.type === 'content_block_delta') {
      const current = contentBlocks[contentBlocks.length - 1]
      if (!current) continue
      if (event.delta.type === 'text_delta') {
        current.text += event.delta.text
        onEvent({ type: 'text_delta', text: event.delta.text })
      } else if (event.delta.type === 'input_json_delta') {
        current.input += event.delta.partial_json
      } else if (event.delta.type === 'thinking_delta') {
        current.thinking += event.delta.thinking
        onEvent({ type: 'thinking_delta', text: event.delta.thinking })
      } else if (event.delta.type === 'signature_delta') {
        current.signature += event.delta.signature
      }
    } else if (event.type === 'message_delta') {
      stopReason = event.delta?.stop_reason
      if (event.usage) {
        usage.input_tokens += event.usage.input_tokens || 0
        usage.output_tokens += event.usage.output_tokens || 0
      }
    } else if (event.type === 'message_start' && event.message?.usage) {
      usage.input_tokens += event.message.usage.input_tokens || 0
      usage.output_tokens += event.message.usage.output_tokens || 0
    } else if (event.type === 'error') {
      const err = new Error(event.error?.message || 'Stream error')
      err.status = event.error?.type === 'overloaded_error' ? 529 : 500
      err.errorType = event.error?.type
      throw err
    }
  }

  return { contentBlocks, stopReason, usage }
}

/**
 * Run the agent loop. Calls onEvent with SSE events as it goes.
 * Handles streaming text, tool use, and thinking blocks.
 * Falls back to sonnet if an opus model is unavailable.
 */
export async function runAgent(systemPrompt, messages, tools, config, onEvent) {
  const client = getClient()
  let totalUsage = { input_tokens: 0, output_tokens: 0 }
  let iterations = 0
  const maxTurns = config.maxTurns || 20
  let activeModel = config.model || SONNET_FALLBACK

  while (iterations < maxTurns) {
    const params = {
      model: activeModel,
      max_tokens: 16384,
      system: systemPrompt,
      messages,
      tools: [...tools.definitions, ...(config.serverTools || [])],
      stream: true,
    }

    if (config.thinkingBudget && isOpusModel(activeModel)) {
      params.thinking = { type: 'enabled', budget_tokens: config.thinkingBudget }
    }

    // Stream the response — fall back to sonnet if opus is unavailable
    let result
    try {
      result = await streamOnce(client, params, onEvent)
    } catch (err) {
      if (isOpusModel(activeModel) && isUnavailableError(err)) {
        console.warn(`[agent] ${activeModel} unavailable (${err.status}), falling back to ${SONNET_FALLBACK}`)
        onEvent({ type: 'model_fallback', from: activeModel, to: SONNET_FALLBACK })
        activeModel = SONNET_FALLBACK
        params.model = SONNET_FALLBACK
        delete params.thinking // thinking is not supported on sonnet
        result = await streamOnce(client, params, onEvent)
      } else {
        throw err
      }
    }

    const { contentBlocks, stopReason, usage } = result
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens

    // Finalize content blocks — parse tool input JSON
    const assistantContent = contentBlocks.map(block => {
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
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
