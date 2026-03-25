import { translateMessages, translateToolDefs } from './translate.js'

const FINISH_REASON_MAP = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
}

/**
 * Process parsed SSE chunks into normalized content blocks.
 * Accepts an async iterable of parsed JSON objects (one per SSE data line).
 * Exported for testing — not part of the public provider interface.
 */
export async function _processStream(stream, onEvent) {
  const contentBlocks = []
  const toolCalls = new Map() // index -> { id, name, arguments }
  let stopReason = null
  const usage = { input_tokens: 0, output_tokens: 0 }
  let hasText = false
  let hasThinking = false

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0]
    if (!choice) {
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens || 0
        usage.output_tokens = chunk.usage.completion_tokens || 0
      }
      continue
    }

    const delta = choice.delta || {}

    // Text content
    if (delta.content) {
      if (!hasText) {
        contentBlocks.push({ type: 'text', text: '' })
        hasText = true
      }
      const textBlock = contentBlocks.find(b => b.type === 'text')
      textBlock.text += delta.content
      onEvent({ type: 'text_delta', text: delta.content })
    }

    // Reasoning content (DeepSeek R1, etc.)
    if (delta.reasoning_content) {
      if (!hasThinking) {
        contentBlocks.push({ type: 'thinking', thinking: '', signature: '' })
        hasThinking = true
      }
      const thinkingBlock = contentBlocks.find(b => b.type === 'thinking')
      thinkingBlock.thinking += delta.reasoning_content
      onEvent({ type: 'thinking_delta', text: delta.reasoning_content })
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, {
            id: tc.id || `toolu_oai_${idx}_${Date.now()}`,
            name: tc.function?.name || '',
            arguments: '',
          })
          if (tc.function?.name) {
            onEvent({ type: 'tool_start', name: tc.function.name })
          }
        }
        const entry = toolCalls.get(idx)
        if (tc.function?.arguments) {
          entry.arguments += tc.function.arguments
        }
      }
    }

    // Finish reason
    if (choice.finish_reason) {
      stopReason = FINISH_REASON_MAP[choice.finish_reason] || 'end_turn'
    }

    // Usage (may arrive in final chunk)
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens || 0
      usage.output_tokens = chunk.usage.completion_tokens || 0
    }
  }

  // Finalize tool calls into content blocks, sorted by index
  for (const [, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
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
 * Parse an SSE response body into an async iterable of parsed JSON chunks.
 * Handles the `data: [DONE]` sentinel and ignores empty/comment lines.
 * Exported for testing.
 */
export async function* _parseSSE(body) {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (!trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data)
      } catch {
        // skip unparseable lines
      }
    }
  }
}

export function createOpenAICompatProvider(config) {
  if (!config.base_url) throw new Error('openai-compat provider requires base_url in persona config')
  if (!config.api_key) throw new Error('openai-compat provider requires api_key in persona config')

  const baseUrl = config.base_url.replace(/\/$/, '')
  const apiKey = config.api_key

  return {
    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget }, onEvent) {
      const openaiMessages = translateMessages(system, messages)
      const openaiTools = translateToolDefs(tools)

      const body = {
        model,
        max_tokens: maxTokens,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }

      if (openaiTools.length > 0) {
        body.tools = openaiTools
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`OpenAI-compat API error ${response.status}: ${text}`)
      }

      const sseStream = _parseSSE(response.body)
      return _processStream(sseStream, onEvent)
    },
  }
}
