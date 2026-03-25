/**
 * Pure translation functions between Anthropic and OpenAI message/tool formats.
 */

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
 * Prepends system prompt as a system message.
 */
export function translateMessages(systemPrompt, messages) {
  const result = [{ role: 'system', content: systemPrompt }]

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
          // Skip: thinking, server_tool_use, web_search_tool_result, signature
        }

        const assistantMsg = { role: 'assistant', content: textParts.join('') || null }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
        }
        result.push(assistantMsg)
      }
    }
  }

  return result
}
