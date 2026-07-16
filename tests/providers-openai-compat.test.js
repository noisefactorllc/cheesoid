import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatProvider, _processStream, _parseSSE } from '../server/lib/providers/openai-compat.js'
import circuitBreaker from '../server/lib/circuit-breaker.js'
import { CircuitOpenError } from '../server/lib/circuit-breaker.js'

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

  it('captures reasoning (Kimi format) as thinking blocks', async () => {
    const events = []
    const stream = makeChunks([
      { reasoning: 'Thinking about it...' },
      { reasoning: ' done.' },
      { content: 'Here you go.' },
    ])
    const result = await _processStream(stream, e => events.push(e))
    assert.equal(result.contentBlocks.length, 2)
    assert.equal(result.contentBlocks[0].type, 'thinking')
    assert.equal(result.contentBlocks[0].thinking, 'Thinking about it... done.')
    assert.equal(result.contentBlocks[1].type, 'text')
    assert.equal(result.contentBlocks[1].text, 'Here you go.')
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

describe('circuit breaker integration', () => {
  it('throws CircuitOpenError after repeated failures without making more fetches', async () => {
    const deadUrl = 'http://dead-provider-cb-test.test:1234'
    const provider = createOpenAICompatProvider({
      base_url: deadUrl,
      api_key: 'test-key',
    })

    // Mock fetch to always reject with a network error
    let fetchCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      fetchCount++
      throw new Error('connect ECONNREFUSED')
    }

    const call = () => provider.streamMessage({
      model: 'test',
      maxTokens: 100,
      system: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      serverTools: [],
    }, () => {})

    try {
      // Prime the breaker directly — avoids coupling the test to the singleton's
      // threshold or the provider's internal retry/delay schedule (otherwise this
      // test takes 10s+ per streamMessage call due to exponential backoff).
      for (let i = 0; i < 50 && !circuitBreaker.isOpen(deadUrl); i++) {
        circuitBreaker.recordFailure(deadUrl, 'primed for test')
      }
      assert.ok(circuitBreaker.isOpen(deadUrl), 'breaker should be open after priming')

      // With the circuit open, one streamMessage call should make zero fetches
      // and surface CircuitOpenError.
      await assert.rejects(
        call,
        (err) => {
          assert.ok(err instanceof CircuitOpenError, 'should be CircuitOpenError')
          assert.ok(err.isCircuitOpen, 'should have isCircuitOpen flag')
          return true
        },
      )
      assert.equal(fetchCount, 0, 'should NOT have made any fetch attempts when circuit is open')
    } finally {
      globalThis.fetch = originalFetch
      // Clean up circuit breaker state for this URL
      circuitBreaker.recordSuccess(deadUrl)
    }
  })
})

// Stub fetch and capture the outgoing request body, replying with a minimal
// valid SSE stream so streamMessage runs to completion.
function stubFetchCapturingBody() {
  const captured = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    captured.url = url
    captured.body = JSON.parse(opts.body)
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
      'data: [DONE]\n\n'
    const bytes = new TextEncoder().encode(sse)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      body: {
        async *[Symbol.asyncIterator]() { yield bytes },
        cancel: async () => {},
      },
    }
  }
  return { captured, restore: () => { globalThis.fetch = originalFetch } }
}

describe('openai-compat thinking budget', () => {
  const callWith = async (config, thinkingBudget) => {
    const provider = createOpenAICompatProvider(config)
    const { captured, restore } = stubFetchCapturingBody()
    try {
      await provider.streamMessage({
        model: 'test-model',
        maxTokens: 100,
        system: 'sys',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        serverTools: [],
        thinkingBudget,
      }, () => {})
    } finally {
      restore()
      circuitBreaker.recordSuccess(config.base_url.replace(/\/$/, ''))
    }
    return captured.body
  }

  it('sends reasoning.max_tokens when the backend declares supports_reasoning_budget', async () => {
    const body = await callWith({
      base_url: 'https://openrouter.test/api/v1',
      api_key: 'k',
      supports_reasoning_budget: true,
    }, 16000)

    assert.deepEqual(body.reasoning, { max_tokens: 16000 })
  })

  it('omits reasoning when the backend does not declare support (protects strict backends)', async () => {
    const body = await callWith({
      base_url: 'https://strict-backend.test/v1',
      api_key: 'k',
    }, 16000)

    assert.equal(body.reasoning, undefined, 'must not send reasoning to a backend that never opted in')
  })

  it('omits reasoning when no thinking budget is requested', async () => {
    const body = await callWith({
      base_url: 'https://openrouter2.test/api/v1',
      api_key: 'k',
      supports_reasoning_budget: true,
    }, null)

    assert.equal(body.reasoning, undefined)
  })
})
