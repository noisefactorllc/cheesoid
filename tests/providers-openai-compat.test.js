import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatProvider, _processStream, _parseSSE } from '../server/lib/providers/openai-compat.js'

describe('createOpenAICompatProvider', () => {
  it('throws when base_url is missing', () => {
    assert.throws(
      () => createOpenAICompatProvider({ api_key: 'key' }),
      /base_url/,
    )
  })

  it('throws when api_key is missing', () => {
    assert.throws(
      () => createOpenAICompatProvider({ base_url: 'http://localhost' }),
      /api_key/,
    )
  })

  it('returns an object with streamMessage method', () => {
    const provider = createOpenAICompatProvider({
      base_url: 'http://localhost:8080/v1',
      api_key: 'test-key',
    })
    assert.equal(typeof provider.streamMessage, 'function')
  })
})

// Helper: create an async iterable of parsed chunks (simulates what _processStream receives)
function makeChunks(deltas) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) {
        yield { choices: [{ delta, finish_reason: null }] }
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    },
  }
}

function makeToolChunks(toolDeltas) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of toolDeltas) {
        yield { choices: [{ delta, finish_reason: null }] }
      }
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    },
  }
}

describe('_processStream', () => {
  it('accumulates text deltas', async () => {
    const events = []
    const stream = makeChunks([
      { content: 'Hello' },
      { content: ' world' },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 1)
    assert.equal(result.contentBlocks[0].type, 'text')
    assert.equal(result.contentBlocks[0].text, 'Hello world')
    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 })
    assert.deepEqual(events, [
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
    ])
  })

  it('captures reasoning_content as thinking blocks', async () => {
    const events = []
    const stream = makeChunks([
      { reasoning_content: 'Let me think...' },
      { reasoning_content: ' yes.' },
      { content: 'The answer.' },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 2)
    assert.equal(result.contentBlocks[0].type, 'thinking')
    assert.equal(result.contentBlocks[0].thinking, 'Let me think... yes.')
    assert.equal(result.contentBlocks[1].type, 'text')
    assert.equal(result.contentBlocks[1].text, 'The answer.')
  })
})

describe('_processStream tool calls', () => {
  it('accumulates a single tool call across deltas', async () => {
    const events = []
    const stream = makeToolChunks([
      { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] },
      { tool_calls: [{ index: 0, function: { arguments: ':"/tmp/x"}' } }] },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 1)
    assert.equal(result.contentBlocks[0].type, 'tool_use')
    assert.equal(result.contentBlocks[0].name, 'read_file')
    assert.deepEqual(result.contentBlocks[0].input, { path: '/tmp/x' })
    assert.equal(result.stopReason, 'tool_use')
    assert.deepEqual(events[0], { type: 'tool_start', name: 'read_file' })
  })

  it('handles multiple interleaved tool calls', async () => {
    const events = []
    const stream = makeToolChunks([
      { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] },
      { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'bash', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"path":"/a"}' } }] },
      { tool_calls: [{ index: 1, function: { arguments: '{"cmd":"ls"}' } }] },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 2)
    assert.equal(result.contentBlocks[0].name, 'read_file')
    assert.deepEqual(result.contentBlocks[0].input, { path: '/a' })
    assert.equal(result.contentBlocks[1].name, 'bash')
    assert.deepEqual(result.contentBlocks[1].input, { cmd: 'ls' })
  })
})

describe('_parseSSE', () => {
  it('parses SSE data lines into JSON objects', async () => {
    const text = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    const encoder = new TextEncoder()
    const body = {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode(text)
      },
    }
    const chunks = []
    for await (const chunk of _parseSSE(body)) {
      chunks.push(chunk)
    }
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].choices[0].delta.content, 'hi')
  })

  it('handles data split across multiple byte chunks', async () => {
    const encoder = new TextEncoder()
    const body = {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode('data: {"cho')
        yield encoder.encode('ices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n')
      },
    }
    const chunks = []
    for await (const chunk of _parseSSE(body)) {
      chunks.push(chunk)
    }
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].choices[0].delta.content, 'x')
  })

  it('ignores comment lines and empty lines', async () => {
    const text = ': keepalive\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
    const encoder = new TextEncoder()
    const body = {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode(text)
      },
    }
    const chunks = []
    for await (const chunk of _parseSSE(body)) {
      chunks.push(chunk)
    }
    assert.equal(chunks.length, 1)
  })
})
