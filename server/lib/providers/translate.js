/**
 * Pure translation functions between Anthropic and OpenAI message/tool formats.
 */

/**
 * Flatten ANY system-prompt shape this codebase produces into a single plain
 * string, for providers whose API takes one system/instruction string.
 *
 * Shapes handled:
 *   - string                              → returned as-is
 *   - { role, content }[]  (openai layers) → contents joined
 *   - { type: 'text', text }[] (Anthropic  → texts joined
 *       native system content blocks, incl. cache_control markers)
 *   - { static, dynamic }  (Claude split)  → the two halves joined
 *
 * A mid-loop orchestrator fallback can hand a Claude-shaped system (block array
 * or { static, dynamic }) to a non-Anthropic provider; without this the old
 * `s.content || s` flatten stringified those blocks to "[object Object]".
 */
export function flattenSystem(system) {
  if (system == null) return system
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map(s => {
        if (typeof s === 'string') return s
        if (s && typeof s === 'object') return s.text ?? s.content ?? ''
        return ''
      })
      .join('\n\n---\n\n')
  }
  if (typeof system === 'object') {
    if (typeof system.static === 'string' || typeof system.dynamic === 'string') {
      return [system.static, system.dynamic].filter(Boolean).join('\n\n---\n\n')
    }
    if (typeof system.content === 'string') return system.content
    if (typeof system.text === 'string') return system.text
  }
  return String(system)
}

/**
 * Convert Anthropic tool definitions to OpenAI function calling format.
 */
export function translateToolDefs(anthropicTools) {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

/**
 * Convert Anthropic-format conversation history to OpenAI message format.
 * System prompt can be a string (single system message) or an array of
 * {role: 'system', content: '...'} objects (hierarchical multi-message).
 */
export function translateMessages(systemPrompt, messages) {
  const result = []

  // System prompt. An openai-compat layered prompt is a { role:'system' }[]
  // hierarchy — keep it as multiple system messages. Anything else (a plain
  // string, an Anthropic { type:'text' }[] block array, or a { static, dynamic }
  // split arriving via mid-loop fallback) flattens to a single system message.
  if (Array.isArray(systemPrompt) && systemPrompt.every(m => m && m.role === 'system')) {
    for (const msg of systemPrompt) {
      result.push({ role: 'system', content: msg.content })
    }
  } else if (systemPrompt != null) {
    result.push({ role: 'system', content: flattenSystem(systemPrompt) })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        // Content blocks — tool_result blocks become tool role messages
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            })
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const textParts = []
        const toolCalls = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })
          }
          // Drop thinking/redacted_thinking: a mid-loop fallback can hand this
          // path a Claude thinking block (signed, model-specific) that must not
          // be replayed to a foreign provider. Also skipped: server_tool_use,
          // web_search_tool_result, signature.
        }

        const content = textParts.join('') || null
        const assistantMsg = { role: 'assistant', content }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
        }
        result.push(assistantMsg)
      }
    }
  }

  return result
}
