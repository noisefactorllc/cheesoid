import { translateMessages, translateToolDefs } from './translate.js'
import circuitBreaker, { CircuitOpenError } from '../circuit-breaker.js'
import { abortableDelay } from '../abort.js'
import { assertStreamComplete, withStallTimeout, STREAM_STALL_MS } from './stream-guard.js'

const FINISH_REASON_MAP = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
}

/**
 * Yielded by _parseSSE when it reads the `data: [DONE]` sentinel.
 *
 * `[DONE]` is the protocol's own end-of-stream marker, so reaching it proves
 * the response finished — separately from whether the backend bothered to send
 * a `finish_reason`. Not every OpenAI-compatible backend does. Distinguishing
 * "finished, reason unstated" from "the socket died mid-response" is the whole
 * point: only the second is a truncation, and treating the first as one would
 * take every turn on such a backend offline.
 */
export const SSE_DONE = Symbol('openai-compat.sse-done')

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
  let sawTerminator = false

  for await (const chunk of stream) {
    if (chunk === SSE_DONE) { sawTerminator = true; continue }
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

  // A backend that closed with [DONE] but never named a finish_reason still
  // finished. Read the reason off what it actually emitted rather than
  // rejecting a complete response — the stream is not in doubt here, only the
  // label for it.
  if (!stopReason && sawTerminator) {
    stopReason = contentBlocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
  }
  assertStreamComplete(stopReason, 'openai-compat')
  return { contentBlocks, stopReason, usage }
}

/**
 * Parse an SSE response body into an async iterable of parsed JSON chunks.
 * Handles the `data: [DONE]` sentinel and ignores empty/comment lines.
 * Exported for testing.
 */
export async function* _parseSSE(body, { stallMs = STREAM_STALL_MS } = {}) {
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  // Iterated by hand rather than with `for await` so each read can be raced
  // against the stall budget. `for await` would have closed the body iterator
  // on our behalf when the loop exits early; the finally below does it instead,
  // so a stall or an abandoned generator still releases the connection.
  const iterator = body[Symbol.asyncIterator]()

  try {
    while (true) {
      // The stall budget covers the live generation only. Once [DONE] has
      // landed we are just draining bytes to free the socket, and a server that
      // dawdles there is not a stalled generation — timing it out would turn a
      // completed turn into a failed one.
      const read = done
        ? await iterator.next()
        : await withStallTimeout(iterator.next(), stallMs, 'openai-compat')
      if (read.done) break
      const bytes = read.value
      if (done) continue // drain remaining bytes to free connection
      buffer += decoder.decode(bytes, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (!trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') { done = true; yield SSE_DONE; break }
        try {
          yield JSON.parse(data)
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    // Best-effort close. A body that is already finished or cancelled throws
    // here, and that must never mask the error that got us out of the loop.
    try { await iterator.return?.() } catch { /* already closed */ }
  }
}

export function createOpenAICompatProvider(config) {
  if (!config.base_url) throw new Error('openai-compat provider requires base_url in persona config')
  if (!config.api_key) throw new Error('openai-compat provider requires api_key in persona config')

  const baseUrl = config.base_url.replace(/\/$/, '')
  const apiKey = config.api_key
  const useMaxCompletionTokens = config.max_completion_tokens === true
  const reasoningEffort = config.reasoning_effort || null
  // Opt-in: `reasoning` is an OpenRouter extension, not part of the OpenAI
  // schema. Strict backends reject unknown top-level keys, so a provider has
  // to declare support before a thinking budget is forwarded.
  const supportsReasoningBudget = config.supports_reasoning_budget === true
  return {
    supportsIntentRouting: true,

    async transcribeAudio({ buffer, format, model, prompt, signal, timeoutMs = 45_000 }) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: combinedSignal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format } },
            ],
          }],
          max_tokens: 4000,
        }),
      })
      const json = await response.json()
      if (!response.ok || json.error) {
        throw new Error(json.error?.message || `transcription HTTP ${response.status}`)
      }
      return { text: json.choices?.[0]?.message?.content || '' }
    },

    async classifyIntent({ model, system, messages, tools, signal }) {
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
          signal,
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
        signal?.throwIfAborted()
        const cause = err.cause ? `: ${err.cause.message || err.cause.code || err.cause}` : ''
        console.log(`[openai-compat] classifier fetch failed${cause}, falling back to auto`)
        circuitBreaker.recordFailure(baseUrl, `classifier fetch failed${cause}`)
      }
      return 'auto'
    },

    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget, toolChoice, signal }, onEvent) {
      const openaiMessages = translateMessages(system, messages)
      const openaiTools = translateToolDefs(tools)

      const body = {
        model,
        [useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }

      // Passthrough reasoning_effort when configured (e.g., Gemini's
      // OpenAI-compat endpoint supports 'none'|'low'|'medium'|'high' to
      // control thinking-token output; keeping it low prevents reasoning
      // from leaking into the visible content stream).
      if (reasoningEffort) {
        body.reasoning_effort = reasoningEffort
      }

      // chat.thinking_budget reaches openai-compat as thinkingBudget but has
      // no OpenAI-schema equivalent, so it was dropped on the floor. Backends
      // that declare support take it as a reasoning token allowance.
      if (supportsReasoningBudget && thinkingBudget) {
        body.reasoning = { max_tokens: thinkingBudget }
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
        signal?.throwIfAborted()
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
            signal,
          })
        } catch (err) {
          signal?.throwIfAborted()
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
          await abortableDelay(delay, signal)
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
