import { getClient } from '../ai-client.js'

const SONNET_FALLBACK = 'claude-sonnet-4-6'

function isOpusModel(model) {
  return model && model.includes('opus')
}

// Cheesoid's canonical toolChoice value for "must call a tool" is 'required'
// (OpenAI/Vertex convention). Anthropic only accepts auto|any|tool|none, with
// 'any' being the equivalent of 'required'. Mirrors the modeMap in
// providers/gemini.js.
export function toAnthropicToolChoice(toolChoice) {
  return toolChoice === 'required' ? 'any' : toolChoice
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

const EPHEMERAL = { type: 'ephemeral' }
// Content-block types the API accepts a cache_control marker on. A trailing
// thinking/redacted_thinking block is skipped (the marker walks back to the
// last cacheable block) so we never attach cache_control where it 400s.
const CACHEABLE_BLOCK_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'document'])

// Normalize whatever system shape the caller passed into what the Anthropic API
// wants. A native content-block array (elements are {type:'text', ...}) is
// passed through UNCHANGED so its cache_control breakpoints survive; the
// openai-compat {role,content}[] hierarchy is flattened to one string; a plain
// string is returned as-is.
function _normalizeSystem(system) {
  if (Array.isArray(system)) {
    if (system.length > 0 && system.every(b => b && b.type === 'text')) {
      return system
    }
    return system.map(s => s.content || s).join('\n\n---\n\n')
  }
  return system
}

// Copy-on-write: return a new tools array whose LAST element carries a
// cache_control:ephemeral marker, without mutating the caller's array or any of
// its elements. tools+serverTools render as one block; the marker on the final
// tool caches the whole tool prefix.
function _cacheControlTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools
  const lastIdx = tools.length - 1
  return tools.map((t, i) => (i === lastIdx ? { ...t, cache_control: EPHEMERAL } : t))
}

// Strip any cache_control markers from a message's content blocks. Copy-on-write:
// returns the same object when there is nothing to strip.
function _stripMessageCacheControl(msg) {
  if (!msg || !Array.isArray(msg.content)) return msg
  let changed = false
  const content = msg.content.map(block => {
    if (block && typeof block === 'object' && 'cache_control' in block) {
      changed = true
      const { cache_control, ...rest } = block
      return rest
    }
    return block
  })
  return changed ? { ...msg, content } : msg
}

// Copy-on-write: return a new version of the LAST message with a
// cache_control:ephemeral marker on its last cacheable content block (a bare
// string is promoted to a single text block). Stale markers on this message's
// other blocks are stripped so it never carries more than one.
function _cacheControlLastMessage(msg) {
  if (!msg) return msg
  if (typeof msg.content === 'string') {
    // An empty string has nothing to cache and would become an invalid empty
    // text block — leave it exactly as-is (same behavior as before caching).
    if (msg.content.length === 0) return msg
    return { ...msg, content: [{ type: 'text', text: msg.content, cache_control: EPHEMERAL }] }
  }
  if (!Array.isArray(msg.content) || msg.content.length === 0) return msg
  let markIdx = -1
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const b = msg.content[i]
    if (b && typeof b === 'object' && CACHEABLE_BLOCK_TYPES.has(b.type)) { markIdx = i; break }
  }
  if (markIdx === -1) return _stripMessageCacheControl(msg)
  const content = msg.content.map((block, i) => {
    if (i === markIdx) return { ...block, cache_control: EPHEMERAL }
    if (block && typeof block === 'object' && 'cache_control' in block) {
      const { cache_control, ...rest } = block
      return rest
    }
    return block
  })
  return { ...msg, content }
}

// Copy-on-write incremental prefix caching over the message array: mark the last
// content block of the LAST message and strip stale markers off every older
// message. The caller's messages array persists across turns and must never
// accumulate markers, so a new array (with new objects only where a marker was
// added or removed) is returned; the caller's objects are left untouched.
function _cacheControlMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const lastIdx = messages.length - 1
  return messages.map((msg, i) =>
    i === lastIdx ? _cacheControlLastMessage(msg) : _stripMessageCacheControl(msg),
  )
}

// Build the Anthropic Messages API request params. Exported for unit testing.
// Extended thinking is enabled for any Claude model whenever a thinking budget
// is configured (this provider only ever serves Claude models). Two API
// constraints the request shape can't otherwise express:
//   - budget_tokens must be < max_tokens, and the response needs room for its
//     answer beyond the thinking budget, so max_tokens is raised to at least
//     budget_tokens + 4096.
//   - extended thinking is incompatible with a forced tool choice ('any'/'tool');
//     when both are requested, the forced choice is dropped (leaving 'auto')
//     rather than dropping thinking.
//
// Prompt caching uses 3 of the 4 allowed cache_control breakpoints (GA, no beta
// header): the last tool definition, the system prompt (the caller marks its
// stable block), and the last message each call for incremental prefix caching.
// All message/tool marking is copy-on-write — the caller's arrays never mutate.
export function _buildParams({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget, toolChoice }) {
  const allTools = [...tools, ...(serverTools || [])]

  const params = {
    model,
    max_tokens: maxTokens,
    system: _normalizeSystem(system),
    messages: _cacheControlMessages(messages),
    tools: _cacheControlTools(allTools),
    stream: true,
  }

  if (toolChoice && params.tools.length > 0) {
    params.tool_choice = { type: toAnthropicToolChoice(toolChoice) }
  }

  if (thinkingBudget) {
    params.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
    params.max_tokens = Math.max(maxTokens, thinkingBudget + 4096)
    if (params.tool_choice && (params.tool_choice.type === 'any' || params.tool_choice.type === 'tool')) {
      console.warn(`[anthropic] extended thinking active — dropping tool_choice '${params.tool_choice.type}' (incompatible with thinking)`)
      delete params.tool_choice
    }
  }

  return params
}

export function createAnthropicProvider(_config) {
  return {
    async streamMessage({ model, maxTokens, system, messages, tools, serverTools, thinkingBudget, toolChoice }, onEvent) {
      const client = getClient()
      const activeModel = model

      const params = _buildParams({ model: activeModel, maxTokens, system, messages, tools, serverTools, thinkingBudget, toolChoice })

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
