import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { translateToolDefs, translateMessages, flattenSystem } from '../server/lib/providers/translate.js'

describe('flattenSystem', () => {
  it('returns a plain string unchanged', () => {
    assert.equal(flattenSystem('hello'), 'hello')
  })

  it('joins a {role,content}[] layered hierarchy', () => {
    assert.equal(
      flattenSystem([{ role: 'system', content: 'A' }, { role: 'system', content: 'B' }]),
      'A\n\n---\n\nB',
    )
  })

  it('joins a native {type:text}[] block array by text, dropping cache_control markers', () => {
    const sys = [
      { type: 'text', text: 'STATIC', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'TAIL' },
    ]
    assert.equal(flattenSystem(sys), 'STATIC\n\n---\n\nTAIL')
  })

  it('joins a { static, dynamic } split', () => {
    assert.equal(flattenSystem({ static: 'CORPUS', dynamic: 'TS' }), 'CORPUS\n\n---\n\nTS')
  })

  it('passes null / undefined through', () => {
    assert.equal(flattenSystem(null), null)
    assert.equal(flattenSystem(undefined), undefined)
  })
})

describe('translateToolDefs', () => {
  it('converts Anthropic tool defs to OpenAI function format', () => {
    const anthropic = [
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ]
    const result = translateToolDefs(anthropic)
    assert.deepEqual(result, [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      },
    ])
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(translateToolDefs([]), [])
  })
})

describe('translateMessages', () => {
  it('passes through simple user string messages', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    const result = translateMessages('You are helpful.', messages)
    assert.deepEqual(result, [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ])
  })

  it('translates assistant tool_use blocks to tool_calls', () => {
    const messages = [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/tmp/x' } },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const assistant = result.find(m => m.role === 'assistant')
    assert.equal(assistant.content, 'Let me read that.')
    assert.equal(assistant.tool_calls.length, 1)
    assert.equal(assistant.tool_calls[0].id, 'toolu_1')
    assert.equal(assistant.tool_calls[0].function.name, 'read_file')
    assert.equal(assistant.tool_calls[0].function.arguments, '{"path":"/tmp/x"}')
  })

  it('translates user tool_result blocks to tool role messages', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"output":"file contents"}' },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const toolMsg = result.find(m => m.role === 'tool')
    assert.equal(toolMsg.tool_call_id, 'toolu_1')
    assert.equal(toolMsg.content, '{"output":"file contents"}')
  })

  it('strips server_tool_use and web_search_tool_result blocks', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is what I found.' },
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
          { type: 'web_search_tool_result', search_results: [] },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const assistant = result.find(m => m.role === 'assistant')
    assert.equal(assistant.content, 'Here is what I found.')
    assert.equal(assistant.tool_calls, undefined)
  })

  it('filters out thinking blocks from assistant messages', () => {
    // A mid-loop fallback can hand this path a Claude thinking block (signed,
    // model-specific); it must not be replayed to a foreign provider. Only the
    // visible text survives translation.
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'The answer.' },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const assistant = result.find(m => m.role === 'assistant')
    assert.equal(assistant.content, 'The answer.')
    assert.equal(assistant.tool_calls, undefined)
  })

  it('filters out thinking and redacted_thinking while keeping tool_use', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'planning', signature: 'sig' },
          { type: 'redacted_thinking', data: 'encrypted-blob' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/x' } },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const assistant = result.find(m => m.role === 'assistant')
    assert.equal(assistant.content, null)
    assert.equal(assistant.tool_calls.length, 1)
    assert.equal(assistant.tool_calls[0].function.name, 'read_file')
  })

  it('yields null content for a thinking-only assistant message', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'deep thought', signature: 'sig' },
        ],
      },
    ]
    const result = translateMessages('sys', messages)
    const assistant = result.find(m => m.role === 'assistant')
    assert.equal(assistant.content, null)
  })

  it('accepts array of system messages', () => {
    const messages = [
      { role: 'user', content: 'hi' },
    ]
    const systemMsgs = [
      { role: 'system', content: 'Layer 1' },
      { role: 'system', content: 'Layer 2' },
    ]
    const result = translateMessages(systemMsgs, messages)
    assert.equal(result[0].role, 'system')
    assert.equal(result[0].content, 'Layer 1')
    assert.equal(result[1].role, 'system')
    assert.equal(result[1].content, 'Layer 2')
    assert.equal(result[2].role, 'user')
    assert.equal(result[2].content, 'hi')
  })

  it('flattens a Claude {type:text}[] block-array system to one system message', () => {
    // A mid-loop orchestrator fallback can hand this openai-compat path a
    // Claude-shaped block-array system; it must collapse to one system message
    // (not stringify blocks to "[object Object]").
    const sys = [
      { type: 'text', text: 'STATIC', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'TAIL' },
    ]
    const result = translateMessages(sys, [{ role: 'user', content: 'hi' }])
    assert.equal(result[0].role, 'system')
    assert.equal(result[0].content, 'STATIC\n\n---\n\nTAIL')
    assert.equal(result[1].role, 'user')
    assert.equal(result[1].content, 'hi')
  })

  it('flattens a { static, dynamic } system into one system message', () => {
    const result = translateMessages({ static: 'CORPUS', dynamic: 'TS' }, [{ role: 'user', content: 'hi' }])
    assert.equal(result[0].role, 'system')
    assert.equal(result[0].content, 'CORPUS\n\n---\n\nTS')
    assert.equal(result[1].role, 'user')
  })
})
