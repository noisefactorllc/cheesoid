/**
 * OpenAI Responses API provider.
 *
 * Uses /v1/responses instead of /v1/chat/completions.
 * Supports reasoning_effort with tools (which Chat Completions doesn't).
 * Different streaming event format and message structure.
 */

/**
 * Translate Anthropic tool defs to Responses API format.
 * Responses API wants { type, name, description, parameters } flat,
 * NOT { type, function: { name, description, parameters } } like Chat Completions.
 */
function translateToolDefsForResponses(anthropicTools) {
  return anthropicTools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }))
}

/**
 * Translate Anthropic-format messages to Responses API input format.
 * The Responses API uses a flat array of items, not messages with roles.
 */
function translateToResponsesInput(messages) {
  const input = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        input.push({ role: 'user', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        // tool_result blocks become function_call_output items
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            input.push({
              type: 'function_call_output',
              call_id: block.tool_use_id,
              output: block.content,
            })
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        input.push({ role: 'assistant', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            input.push({ role: 'assistant', content: block.text })
          } else if (block.type === 'tool_use') {
            input.push({
              type: 'function_call',
              name: block.name,
              arguments: JSON.stringify(block.input),
              call_id: block.id,
              id: `fc_${block.id}`,
            })
          }
          // Skip thinking blocks — Responses API doesn't accept them back
        }
      }
    }
  }

  return input
}

/**
 * Process Responses API streaming events into normalized content blocks.
 */
export async function _processResponsesStream(stream, onEvent) {
  const contentBlocks = []
  const toolCalls = new Map() // call_id -> { id, name, arguments }
  let stopReason = null
  const usage = { input_tokens: 0, output_tokens: 0 }

  for await (const event of stream) {
    const type = event.type

    // Text delta
    if (type === 'response.output_text.delta') {
      if (!contentBlocks.some(b => b.type === 'text')) {
        contentBlocks.push({ type: 'text', text: '' })
      }
      const textBlock = contentBlocks.find(b => b.type === 'text')
      textBlock.text += event.delta
      onEvent({ type: 'text_delta', text: event.delta })
    }

    // Reasoning item (thinking)
    if (type === 'response.output_item.added' && event.item?.type === 'reasoning') {
      contentBlocks.push({ type: 'thinking', thinking: '', signature: '' })
    }

    // Function call start — key by item.id since deltas reference item_id
    if (type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const item = event.item
      toolCalls.set(item.id, {
        id: item.call_id || item.id,
        name: item.name,
        arguments: item.arguments || '',
      })
      if (item.name) {
        onEvent({ type: 'tool_start', name: item.name })
      }
    }

    // Function call arguments delta — item_id matches the item.id we stored
    if (type === 'response.function_call_arguments.delta') {
      const tc = toolCalls.get(event.item_id)
      if (tc) tc.arguments += event.delta
    }

    // Function call arguments done
    if (type === 'response.function_call_arguments.done') {
      const tc = toolCalls.get(event.item_id)
      if (tc) tc.arguments = event.arguments
    }

    // Response completed — extract usage and stop reason
    if (type === 'response.completed') {
      const resp = event.response
      if (resp?.usage) {
        usage.input_tokens = resp.usage.input_tokens || 0
        usage.output_tokens = resp.usage.output_tokens || 0
      }
      // Determine stop reason from output items
      const hasToolCalls = resp?.output?.some(o => o.type === 'function_call')
      stopReason = hasToolCalls ? 'tool_use' : 'end_turn'
    }
  }

  // Finalize tool calls into content blocks
  for (const tc of toolCalls.values()) {
    let input = {}
    try {
      input = JSON.parse(tc.arguments || '{}')
    } catch {
      // leave as empty object
    }
    contentBlocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input,
    })
  }

  return { contentBlocks, stopReason, usage }
}

/**
 * Parse Responses API SSE stream. Format differs from Chat Completions:
 * - Uses "event: <type>\ndata: <json>" format
 * - No [DONE] sentinel — stream ends after response.completed
 */
export async function* _parseResponsesSSE(body) {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('event:')) continue
      if (!trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data)
      } catch {
        // skip unparseable
      }
    }
  }
}

export function createOpenAIResponsesProvider(config) {
  if (!config.base_url) throw new Error('openai-responses provider requires base_url in persona config')
  if (!config.api_key) throw new Error('openai-responses provider requires api_key in persona config')

  const baseUrl = config.base_url.replace(/\/$/, '')
  const apiKey = config.api_key
  const reasoningEffort = config.reasoning_effort || 'high'

  return {
    supportsIntentRouting: false, // Responses API handles this natively via reasoning

    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget, toolChoice }, onEvent) {
      const input = translateToResponsesInput(messages)
      const openaiTools = translateToolDefsForResponses(tools)

      // Flatten system prompt array
      const instructions = Array.isArray(system)
        ? system.map(s => s.content || s).join('\n\n---\n\n')
        : system

      const body = {
        model,
        instructions,
        input,
        stream: true,
        max_output_tokens: maxTokens,
        reasoning: { effort: reasoningEffort },
      }

      if (openaiTools.length > 0) {
        body.tools = openaiTools
        if (toolChoice && toolChoice !== 'auto') {
          body.tool_choice = toolChoice
        }
      }

      const MAX_RETRIES = 3
      const RETRY_DELAY_MS = 2000
      let response
      let lastErr

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          response = await fetch(`${baseUrl}/responses`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
          })
        } catch (err) {
          const cause = err.cause ? `: ${err.cause.message || err.cause.code || err.cause}` : ''
          lastErr = new Error(`OpenAI Responses fetch failed${cause}`)
          response = null
          console.log(`[openai-responses] fetch attempt ${attempt + 1}/${MAX_RETRIES} failed${cause}`)
        }

        if (response && response.status !== 429 && response.status < 500) break

        if (response && response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10)
          const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAY_MS * (attempt + 1)
          lastErr = new Error(`OpenAI Responses rate limited (429)`)
          if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, delay))
        } else if (response && response.status >= 500) {
          const text = await response.text().catch(() => '')
          lastErr = new Error(`OpenAI Responses server error ${response.status}: ${text}`)
          if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)))
        } else if (!response && attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)))
        }
      }

      if (!response) throw lastErr

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`OpenAI Responses API error ${response.status}: ${text}`)
      }

      const sseStream = _parseResponsesSSE(response.body)
      return _processResponsesStream(sseStream, onEvent)
    },
  }
}
