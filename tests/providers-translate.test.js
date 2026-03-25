import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { translateToolDefs, translateMessages } from '../server/lib/providers/translate.js'

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

  it('strips thinking blocks from assistant messages', () => {
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
})
