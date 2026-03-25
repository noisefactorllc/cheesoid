import { getClient } from '../ai-client.js'

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

export function createAnthropicProvider(_config) {
  const client = getClient()

  return {
    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget }, onEvent) {
      let activeModel = model

      const params = {
        model: activeModel,
        max_tokens: maxTokens,
        system,
        messages,
        tools: [...tools, ...(serverTools || [])],
        stream: true,
      }

      if (thinkingBudget && isOpusModel(activeModel)) {
        params.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
      }

      try {
        return await streamOnce(client, params, onEvent)
      } catch (err) {
        if (isOpusModel(activeModel) && isUnavailableError(err)) {
          console.warn(`[anthropic] ${activeModel} unavailable (${err.status}), falling back to ${SONNET_FALLBACK}`)
          onEvent({ type: 'model_fallback', from: activeModel, to: SONNET_FALLBACK })
          params.model = SONNET_FALLBACK
          delete params.thinking
          return await streamOnce(client, params, onEvent)
        }
        throw err
      }
    },
  }
}
