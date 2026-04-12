import { translateMessages, translateToolDefs } from './translate.js'
import circuitBreaker, { CircuitOpenError } from '../circuit-breaker.js'

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

    // Reasoning content (DeepSeek uses reasoning_content, Kimi uses reasoning)
    const reasoning = delta.reasoning_content || delta.reasoning
    if (reasoning) {
      if (!hasThinking) {
        contentBlocks.push({ type: 'thinking', thinking: '', signature: '' })
        hasThinking = true
      }
      const thinkingBlock = contentBlocks.find(b => b.type === 'thinking')
      thinkingBlock.thinking += reasoning
      onEvent({ type: 'thinking_delta', text: reasoning })
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
  let done = false

  for await (const bytes of body) {
    if (done) continue // drain remaining bytes to free connection
    buffer += decoder.decode(bytes, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(':')) continue
      if (!trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') { done = true; break }
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
  const useMaxCompletionTokens = config.max_completion_tokens === true
  return {
    supportsIntentRouting: true,

    async classifyIntent({ model, system, messages, tools }) {
      const toolSummary = tools.map(t => `- ${t.name}: ${t.description || 'no description'}`).join('\n')

      // Detect if the last user message contains tool results (post-tool-call state)
      const lastUserMsg = messages[messages.length - 1]
      const hasToolResults = Array.isArray(lastUserMsg?.content) &&
        lastUserMsg.content.some(b => b.type === 'tool_result')

      const classifyPrompt = [
        'You are a strict intent classifier for an AI agent. Determine what the agent should do next.',
        '',
        'Available tools:',
        toolSummary,
        '',
        'Rules:',
        '- If the user is asking the agent to DO something (run a command, check status, look something up, take an action), respond: {"action":"tool"}',
        '- If the user is making conversation (greeting, opinion, acknowledgment, question that needs no data), respond: {"action":"text"}',
        '- If tool results were just returned and the task needs MORE tool calls to complete, respond: {"action":"tool"}',
        '- If tool results were just returned and the agent should now summarize or respond to the user, respond: {"action":"text"}',
        hasToolResults ? '\nIMPORTANT: The most recent message contains tool results. The agent just finished a tool call. Decide whether more tools are needed or if it is time to respond.' : '',
        '',
        'Respond with ONLY the JSON object. No explanation, no markdown, no other text.',
      ].join('\n')

      // Use the last few messages for context, not the full history
      const recentMessages = messages.slice(-6)
      const classifyMessages = translateMessages(classifyPrompt, recentMessages)

      try {
        if (circuitBreaker.isOpen(baseUrl)) return 'auto' // fall back on circuit open

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            [useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: 32,
            messages: classifyMessages,
            temperature: 0,
          }),
        })

        if (!response.ok) {
          await response.text().catch(() => '') // consume body to free connection
          return 'auto'
        }

        circuitBreaker.recordSuccess(baseUrl)
        const data = await response.json()
        const text = data.choices?.[0]?.message?.content?.trim() || ''
        try {
          const parsed = JSON.parse(text)
          if (parsed.action === 'tool') return 'required'
          if (parsed.action === 'text') return 'none'
        } catch {
          // Check for substring match as fallback
          if (text.includes('"tool"')) return 'required'
          if (text.includes('"text"')) return 'none'
        }
      } catch (err) {
        const cause = err.cause ? `: ${err.cause.message || err.cause.code || err.cause}` : ''
        console.log(`[openai-compat] classifier fetch failed${cause}, falling back to auto`)
        circuitBreaker.recordFailure(baseUrl, `classifier fetch failed${cause}`)
      }
      return 'auto'
    },

    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget, toolChoice }, onEvent) {
      const openaiMessages = translateMessages(system, messages)
      const openaiTools = translateToolDefs(tools)

      const body = {
        model,
        [useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }


      if (openaiTools.length > 0) {
        body.tools = openaiTools
        body.tool_choice = toolChoice || 'auto'
      }

      const MAX_RETRIES = 3
      const RETRY_DELAY_MS = 2000
      let response
      let lastErr

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // Circuit breaker check — skip all retries if endpoint is dead
        if (circuitBreaker.isOpen(baseUrl)) {
          throw new CircuitOpenError(baseUrl, Math.round(circuitBreaker.remainingCooldown(baseUrl) / 1000), circuitBreaker.lastError(baseUrl))
        }

        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
          })
        } catch (err) {
          const cause = err.cause ? `: ${err.cause.message || err.cause.code || err.cause}` : ''
          lastErr = new Error(`OpenAI-compat fetch failed${cause}`)
          response = null
          console.log(`[openai-compat] fetch attempt ${attempt + 1}/${MAX_RETRIES} failed${cause}`)
          circuitBreaker.recordFailure(baseUrl, lastErr.message)
        }

        // Retry on network errors and 429/5xx
        if (response && response.status !== 429 && response.status < 500) {
          circuitBreaker.recordSuccess(baseUrl)
          break
        }

        if (response && response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10)
          const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAY_MS * (attempt + 1)
          await response.text().catch(() => '') // consume body to free connection
          lastErr = new Error(`OpenAI-compat rate limited (429), retrying in ${Math.round(delay / 1000)}s`)
          circuitBreaker.recordFailure(baseUrl, lastErr.message)
        } else if (response && response.status >= 500) {
          const text = await response.text().catch(() => '')
          lastErr = new Error(`OpenAI-compat server error ${response.status}: ${text}`)
          circuitBreaker.recordFailure(baseUrl, lastErr.message)
        }

        // Delay before retry (network errors, 429, 5xx all get backoff)
        if (attempt < MAX_RETRIES - 1) {
          const retryAfter = response?.status === 429
            ? parseInt(response.headers.get('retry-after') || '0', 10)
            : 0
          const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAY_MS * (attempt + 1)
          await new Promise(r => setTimeout(r, delay))
        }
      }

      if (!response) throw lastErr

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`OpenAI-compat API error ${response.status}: ${text}`)
      }

      const sseStream = _parseSSE(response.body)
      try {
        return await _processStream(sseStream, onEvent)
      } finally {
        // Ensure the response body is fully consumed/cancelled to free the TCP connection.
        // _parseSSE returns early on [DONE] which leaves the stream open.
        try { await response.body.cancel() } catch {}
      }
    },
  }
}
