// Native Gemini provider using Google's Generative Language API.
//
// Why native instead of the OpenAI-compat shim: Gemini's compat endpoint
// inlines thinking tokens into the `content` field with no way to
// distinguish them server-side, which causes reasoning dumps in chat. The
// native API exposes thinking as separate `parts` flagged with
// `thought: true`, so we can route them to `thinking_delta` events the
// same way Anthropic's thinking blocks are routed.
//
// Endpoint shape:
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
//   Header: x-goog-api-key: <GEMINI_API_KEY>
//
// Response stream: SSE lines of `data: {json}`, each a partial
//   candidate with `content.parts[]` containing text / thought / functionCall parts.

import circuitBreaker, { CircuitOpenError } from '../circuit-breaker.js'

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

const STOP_REASON_MAP = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  // Gemini uses STOP for tool calls too; we override based on content.
}

/**
 * Translate our Anthropic-style message list into Gemini's `contents`
 * array. Roles are 'user'/'model'. Tool results are expressed as
 * `functionResponse` parts on a user-role turn.
 */
export function _translateMessages(system, messages) {
  const contents = []

  for (const msg of messages) {
    if (msg.role === 'system') continue // handled via systemInstruction

    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts = []

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text })
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input || {},
            },
          })
        } else if (block.type === 'tool_result') {
          // Unpack string content into a structured response shape Gemini expects.
          let response
          if (typeof block.content === 'string') {
            response = { content: block.content }
          } else if (Array.isArray(block.content)) {
            // Flatten text content blocks into a single string
            const text = block.content
              .filter(b => b.type === 'text')
              .map(b => b.text)
              .join('\n')
            response = { content: text }
          } else {
            response = { content: String(block.content ?? '') }
          }
          parts.push({
            functionResponse: {
              name: block._toolName || 'tool',
              response,
            },
          })
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return contents
}

/**
 * Annotate tool_result blocks with their tool name by looking back at the
 * preceding assistant message. Gemini requires the name on
 * `functionResponse`, but our Anthropic-style tool_result only carries
 * the `tool_use_id`. This mutation is local to translation.
 */
function _annotateToolResults(messages) {
  const idToName = new Map()
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          idToName.set(block.id, block.name)
        }
      }
    }
  }
  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg
    const content = msg.content.map(block => {
      if (block.type === 'tool_result' && block.tool_use_id && idToName.has(block.tool_use_id)) {
        return { ...block, _toolName: idToName.get(block.tool_use_id) }
      }
      return block
    })
    return { ...msg, content }
  })
}

/**
 * Translate our tool definitions (Anthropic-style `input_schema`) into
 * Gemini's `functionDeclarations` with `parameters`.
 */
export function _translateTools(tools) {
  if (!tools || tools.length === 0) return []
  const functionDeclarations = tools.map(t => {
    const decl = {
      name: t.name,
      description: t.description || '',
    }
    if (t.input_schema && typeof t.input_schema === 'object') {
      decl.parameters = _sanitizeSchema(t.input_schema)
    }
    return decl
  })
  return [{ functionDeclarations }]
}

/**
 * Gemini rejects some JSON Schema keywords. Strip the unsupported ones
 * and pass through the rest. Recursive for nested objects.
 */
function _sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(_sanitizeSchema)
  const out = {}
  // Allowed keywords per Gemini's OpenAPI 3.0 subset
  const allowed = new Set([
    'type', 'format', 'description', 'nullable', 'enum',
    'properties', 'required', 'items', 'minItems', 'maxItems',
    'minimum', 'maximum', 'default',
  ])
  for (const [k, v] of Object.entries(schema)) {
    if (!allowed.has(k)) continue
    if (k === 'properties' && v && typeof v === 'object') {
      const props = {}
      for (const [pk, pv] of Object.entries(v)) {
        props[pk] = _sanitizeSchema(pv)
      }
      out[k] = props
    } else if (k === 'items') {
      out[k] = _sanitizeSchema(v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Parse an SSE response body into an async iterable of parsed JSON chunks.
 * Gemini emits `data: {json}` lines separated by blank lines.
 */
export async function* _parseSSE(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
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

/**
 * Process parsed Gemini chunks into normalized content blocks + events.
 * Each chunk has a `candidates[0].content.parts[]` array; parts with
 * `thought: true` are thinking, otherwise text. `functionCall` parts
 * produce tool_use blocks.
 */
export async function _processStream(stream, onEvent) {
  const contentBlocks = []
  let textBlock = null
  let thinkingBlock = null
  const toolCalls = []
  let stopReason = null
  const usage = { input_tokens: 0, output_tokens: 0 }

  for await (const chunk of stream) {
    const candidate = chunk.candidates?.[0]
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.text !== undefined) {
          if (part.thought) {
            if (!thinkingBlock) {
              thinkingBlock = { type: 'thinking', thinking: '', signature: '' }
              contentBlocks.push(thinkingBlock)
            }
            thinkingBlock.thinking += part.text
            onEvent({ type: 'thinking_delta', text: part.text })
          } else {
            if (!textBlock) {
              textBlock = { type: 'text', text: '' }
              contentBlocks.push(textBlock)
            }
            textBlock.text += part.text
            onEvent({ type: 'text_delta', text: part.text })
          }
        } else if (part.functionCall) {
          const call = {
            type: 'tool_use',
            id: `toolu_gemini_${toolCalls.length}_${Date.now()}`,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          }
          toolCalls.push(call)
          contentBlocks.push(call)
          onEvent({ type: 'tool_start', name: call.name })
        }
      }
    }

    if (candidate?.finishReason) {
      // If tools were emitted this turn, mark stop_reason accordingly
      stopReason = toolCalls.length > 0 ? 'tool_use' : (STOP_REASON_MAP[candidate.finishReason] || 'end_turn')
    }

    if (chunk.usageMetadata) {
      usage.input_tokens = chunk.usageMetadata.promptTokenCount || 0
      usage.output_tokens =
        (chunk.usageMetadata.candidatesTokenCount || 0) +
        (chunk.usageMetadata.thoughtsTokenCount || 0)
    }
  }

  if (!stopReason) stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn'
  return { contentBlocks, stopReason, usage }
}

export function createGeminiProvider(config) {
  if (!config.api_key) throw new Error('gemini provider requires api_key in persona config')

  const baseUrl = (config.base_url || DEFAULT_BASE_URL).replace(/\/$/, '')
  const apiKey = config.api_key
  const thinkingBudgetDefault = config.thinking_budget ?? null

  return {
    // Gemini in AUTO mode freely responds in text when it could have called a
    // tool. For "remember X"-style requests the model narrates "I'll remember
    // that" and never invokes write_memory, which looks like hallucinated tool
    // use. Intent routing forces tool_choice=ANY for action-y requests so the
    // call actually happens. Matches openai-compat's classifier behavior — was
    // lost when gemini moved off that shim to the native provider.
    supportsIntentRouting: true,

    async classifyIntent({ model, system, messages, tools }) {
      const toolSummary = tools.map(t => `- ${t.name}: ${t.description || 'no description'}`).join('\n')

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
        '- If the user is asking the agent to DO something (run a command, check status, look something up, take an action, remember/save/note/persist information), respond: {"action":"tool"}',
        '- If the user is making conversation (greeting, opinion, acknowledgment, question that needs no data), respond: {"action":"text"}',
        '- If tool results were just returned and the task needs MORE tool calls to complete, respond: {"action":"tool"}',
        '- If tool results were just returned and the agent should now summarize or respond to the user, respond: {"action":"text"}',
        hasToolResults ? '\nIMPORTANT: The most recent message contains tool results. The agent just finished a tool call. Decide whether more tools are needed or if it is time to respond.' : '',
        '',
        'Respond with ONLY the JSON object. No explanation, no markdown, no other text.',
      ].join('\n')

      const recentMessages = messages.slice(-6)
      const annotated = _annotateToolResults(recentMessages)
      const contents = _translateMessages(null, annotated)
      if (contents.length === 0) return 'auto'

      try {
        if (circuitBreaker.isOpen(baseUrl)) return 'auto'

        const url = `${baseUrl}/models/${model}:generateContent`
        const body = {
          contents,
          systemInstruction: { parts: [{ text: classifyPrompt }] },
          generationConfig: {
            maxOutputTokens: 32,
            temperature: 0,
            thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
          },
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          await response.text().catch(() => '')
          return 'auto'
        }

        circuitBreaker.recordSuccess(baseUrl)
        const data = await response.json()
        const text = data.candidates?.[0]?.content?.parts
          ?.map(p => p.text || '')
          .join('')
          .trim() || ''
        try {
          const parsed = JSON.parse(text)
          if (parsed.action === 'tool') return 'required'
          if (parsed.action === 'text') return 'none'
        } catch {
          if (text.includes('"tool"')) return 'required'
          if (text.includes('"text"')) return 'none'
        }
      } catch (err) {
        const cause = err.cause ? `: ${err.cause.message || err.cause.code || err.cause}` : ''
        console.log(`[gemini] classifier fetch failed${cause}, falling back to auto`)
        circuitBreaker.recordFailure(baseUrl, `classifier fetch failed${cause}`)
      }
      return 'auto'
    },

    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget, toolChoice }, onEvent) {
      const annotated = _annotateToolResults(messages)
      const contents = _translateMessages(system, annotated)
      const geminiTools = _translateTools(tools || [])

      const body = {
        contents,
        generationConfig: {
          maxOutputTokens: maxTokens || 4096,
        },
      }

      if (system) {
        // The caller may pass a single string (Anthropic path) or an array
        // of {role:'system', content:'...'} objects (openai-compat path, the
        // 4-layer system-message hierarchy). Flatten arrays to one joined
        // string — Gemini's systemInstruction accepts a single Content block.
        const systemText = Array.isArray(system)
          ? system.map(s => (typeof s === 'string' ? s : s.content || '')).join('\n\n---\n\n')
          : String(system)
        body.systemInstruction = { parts: [{ text: systemText }] }
      }

      if (geminiTools.length > 0) {
        body.tools = geminiTools
        const modeMap = { auto: 'AUTO', required: 'ANY', none: 'NONE' }
        body.toolConfig = {
          functionCallingConfig: {
            mode: modeMap[toolChoice] || 'AUTO',
          },
        }
      }

      // Thinking config: emit thoughts as separate parts so we can route
      // them to thinking_delta events. Budget controls how many tokens
      // the model may spend on thinking.
      const effectiveBudget = thinkingBudget ?? thinkingBudgetDefault
      if (effectiveBudget !== null) {
        body.generationConfig.thinkingConfig = {
          thinkingBudget: effectiveBudget,
          includeThoughts: true,
        }
      } else {
        body.generationConfig.thinkingConfig = { includeThoughts: true }
      }

      const url = `${baseUrl}/models/${model}:streamGenerateContent?alt=sse`

      const MAX_RETRIES = 3
      const RETRY_DELAY_MS = 2000
      let response
      let lastErr

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (circuitBreaker.isOpen(baseUrl)) {
          throw new CircuitOpenError(
            baseUrl,
            Math.round(circuitBreaker.remainingCooldown(baseUrl) / 1000),
            circuitBreaker.lastError(baseUrl),
          )
        }
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(body),
          })
        } catch (err) {
          const cause = err.cause ? `: ${err.cause.message || err.cause.code || err.cause}` : ''
          lastErr = new Error(`Gemini fetch failed${cause}`)
          response = null
          console.log(`[gemini] fetch attempt ${attempt + 1}/${MAX_RETRIES} failed${cause}`)
          circuitBreaker.recordFailure(baseUrl, lastErr.message)
        }

        if (response && response.status !== 429 && response.status < 500) {
          circuitBreaker.recordSuccess(baseUrl)
          break
        }

        if (response && response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10)
          const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAY_MS * (attempt + 1)
          await response.text().catch(() => '')
          lastErr = new Error(`Gemini rate limited (429), retrying in ${Math.round(delay / 1000)}s`)
          circuitBreaker.recordFailure(baseUrl, lastErr.message)
        } else if (response && response.status >= 500) {
          const text = await response.text().catch(() => '')
          lastErr = new Error(`Gemini server error ${response.status}: ${text}`)
          circuitBreaker.recordFailure(baseUrl, lastErr.message)
        }

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
        throw new Error(`Gemini API error ${response.status}: ${text}`)
      }

      const stream = _parseSSE(response.body)
      try {
        return await _processStream(stream, onEvent)
      } finally {
        try { await response.body.cancel() } catch {}
      }
    },
  }
}
