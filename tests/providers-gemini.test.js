import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  _translateMessages,
  _translateTools,
  _processStream,
  _parseSSE,
  createGeminiProvider,
} from '../server/lib/providers/gemini.js'

describe('gemini provider — translation', () => {
  it('translates string-content user message to user-role with text part', () => {
    const contents = _translateMessages(null, [
      { role: 'user', content: 'hello' },
    ])
    assert.deepEqual(contents, [
      { role: 'user', parts: [{ text: 'hello' }] },
    ])
  })

  it('translates assistant text block to model-role', () => {
    const contents = _translateMessages(null, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] },
    ])
    assert.equal(contents.length, 2)
    assert.equal(contents[1].role, 'model')
    assert.deepEqual(contents[1].parts, [{ text: 'hello back' }])
  })

  it('translates tool_use block to functionCall part', () => {
    const contents = _translateMessages(null, [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'read_memory', input: { path: 'MEMORY.md' } },
        ],
      },
    ])
    assert.deepEqual(contents[0].parts, [
      { functionCall: { name: 'read_memory', args: { path: 'MEMORY.md' } } },
    ])
  })

  it('translates tool_result to functionResponse with tool name (via _toolName hint)', () => {
    const contents = _translateMessages(null, [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'file contents',
            _toolName: 'read_memory',
          },
        ],
      },
    ])
    assert.deepEqual(contents[0].parts, [
      { functionResponse: { name: 'read_memory', response: { content: 'file contents' } } },
    ])
  })

  it('skips system role in message list (handled via systemInstruction)', () => {
    const contents = _translateMessages('system prompt', [
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'hi' },
    ])
    assert.equal(contents.length, 1)
    assert.equal(contents[0].role, 'user')
  })
})

describe('gemini provider — tool translation', () => {
  it('wraps tool definitions into functionDeclarations', () => {
    const tools = [
      {
        name: 'read_memory',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ]
    const translated = _translateTools(tools)
    assert.equal(translated.length, 1)
    assert.equal(translated[0].functionDeclarations.length, 1)
    assert.equal(translated[0].functionDeclarations[0].name, 'read_memory')
    assert.deepEqual(translated[0].functionDeclarations[0].parameters, {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
  })

  it('strips unsupported JSON Schema keywords (e.g. additionalProperties, $schema)', () => {
    const tools = [
      {
        name: 'x',
        input_schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          properties: { a: { type: 'string' } },
        },
      },
    ]
    const params = _translateTools(tools)[0].functionDeclarations[0].parameters
    assert.equal('$schema' in params, false)
    assert.equal('additionalProperties' in params, false)
    assert.deepEqual(params.properties, { a: { type: 'string' } })
  })

  it('returns empty array when no tools', () => {
    assert.deepEqual(_translateTools([]), [])
    assert.deepEqual(_translateTools(null), [])
  })
})

describe('gemini provider — stream processing', () => {
  async function* fromChunks(chunks) {
    for (const c of chunks) yield c
  }

  it('routes thought:true parts to thinking_delta, text parts to text_delta', async () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: 'thinking about it', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'Hello.' }] }, finishReason: 'STOP' }] },
      { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 5 } },
    ]
    const events = []
    const { contentBlocks, stopReason, usage } = await _processStream(
      fromChunks(chunks),
      e => events.push(e),
    )

    assert.ok(events.some(e => e.type === 'thinking_delta' && e.text === 'thinking about it'))
    assert.ok(events.some(e => e.type === 'text_delta' && e.text === 'Hello.'))
    // Contents include a thinking block and a text block
    assert.ok(contentBlocks.some(b => b.type === 'thinking'))
    assert.ok(contentBlocks.some(b => b.type === 'text' && b.text === 'Hello.'))
    assert.equal(stopReason, 'end_turn')
    assert.equal(usage.input_tokens, 10)
    assert.equal(usage.output_tokens, 7) // candidates + thoughts
  })

  it('routes functionCall parts to tool_use blocks with stopReason=tool_use', async () => {
    const chunks = [
      {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'read_memory', args: { path: 'x.md' } } }] },
          finishReason: 'STOP',
        }],
      },
    ]
    const events = []
    const { contentBlocks, stopReason } = await _processStream(fromChunks(chunks), e => events.push(e))
    assert.equal(stopReason, 'tool_use')
    const toolBlock = contentBlocks.find(b => b.type === 'tool_use')
    assert.ok(toolBlock)
    assert.equal(toolBlock.name, 'read_memory')
    assert.deepEqual(toolBlock.input, { path: 'x.md' })
    assert.ok(events.some(e => e.type === 'tool_start' && e.name === 'read_memory'))
  })

  it('handles mixed text + thinking + tool_use in one response', async () => {
    const chunks = [
      {
        candidates: [{
          content: { parts: [
            { text: 'thinking', thought: true },
            { text: 'calling tool' },
            { functionCall: { name: 'internal', args: { trigger: true } } },
          ] },
          finishReason: 'STOP',
        }],
      },
    ]
    const { contentBlocks, stopReason } = await _processStream(fromChunks(chunks), () => {})
    assert.equal(stopReason, 'tool_use')
    assert.equal(contentBlocks.length, 3)
    const types = contentBlocks.map(b => b.type).sort()
    assert.deepEqual(types, ['text', 'thinking', 'tool_use'])
  })
})

describe('gemini provider — factory', () => {
  it('requires api_key', () => {
    assert.throws(() => createGeminiProvider({}), /api_key/)
  })

  it('accepts valid config', () => {
    const provider = createGeminiProvider({ api_key: 'k' })
    assert.ok(typeof provider.streamMessage === 'function')
  })
})

describe('gemini provider — SSE parsing', () => {
  it('parses data-prefixed JSON lines', async () => {
    const encoder = new TextEncoder()
    async function* body() {
      yield encoder.encode('data: {"x":1}\n\ndata: {"y":2}\n\n')
    }
    const chunks = []
    for await (const c of _parseSSE(body())) chunks.push(c)
    assert.deepEqual(chunks, [{ x: 1 }, { y: 2 }])
  })
})

describe('gemini provider — intent routing', () => {
  it('exposes classifyIntent and supportsIntentRouting=true', () => {
    const p = createGeminiProvider({ api_key: 'k' })
    assert.equal(p.supportsIntentRouting, true)
    assert.equal(typeof p.classifyIntent, 'function')
  })

  function withMockedFetch(responseJson, fn, { status = 200 } = {}) {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null })
      return {
        ok: status === 200,
        status,
        async json() { return responseJson },
        async text() { return JSON.stringify(responseJson) },
      }
    }
    return fn(calls).finally(() => { globalThis.fetch = originalFetch })
  }

  const partsFor = (text) => ({
    candidates: [{ content: { parts: [{ text }] } }],
  })

  it('returns "required" when classifier responds with action=tool', async () => {
    const p = createGeminiProvider({ api_key: 'k' })
    await withMockedFetch(partsFor('{"action":"tool"}'), async () => {
      const out = await p.classifyIntent({
        model: 'gemini-2.5-pro',
        system: null,
        messages: [{ role: 'user', content: 'please remember that the sky is green' }],
        tools: [{ name: 'write_memory', description: 'save info' }],
      })
      assert.equal(out, 'required')
    })
  })

  it('returns "none" when classifier responds with action=text', async () => {
    const p = createGeminiProvider({ api_key: 'k' })
    await withMockedFetch(partsFor('{"action":"text"}'), async () => {
      const out = await p.classifyIntent({
        model: 'gemini-2.5-pro',
        system: null,
        messages: [{ role: 'user', content: 'hi there' }],
        tools: [{ name: 'write_memory' }],
      })
      assert.equal(out, 'none')
    })
  })

  it('falls back to "auto" on non-2xx response', async () => {
    const p = createGeminiProvider({ api_key: 'k' })
    await withMockedFetch({}, async () => {
      const out = await p.classifyIntent({
        model: 'gemini-2.5-pro',
        system: null,
        messages: [{ role: 'user', content: 'anything' }],
        tools: [{ name: 'write_memory' }],
      })
      assert.equal(out, 'auto')
    }, { status: 500 })
  })

  it('returns "auto" when message list is empty (nothing to classify)', async () => {
    const p = createGeminiProvider({ api_key: 'k' })
    // No fetch should be issued since contents is empty
    const originalFetch = globalThis.fetch
    let fetched = false
    globalThis.fetch = async () => { fetched = true; throw new Error('should not be called') }
    try {
      const out = await p.classifyIntent({
        model: 'gemini-2.5-pro',
        system: null,
        messages: [],
        tools: [{ name: 'write_memory' }],
      })
      assert.equal(out, 'auto')
      assert.equal(fetched, false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sends a generateContent request with the classifier prompt in systemInstruction', async () => {
    const p = createGeminiProvider({ api_key: 'k' })
    await withMockedFetch(partsFor('{"action":"tool"}'), async (calls) => {
      await p.classifyIntent({
        model: 'gemini-2.5-pro',
        system: null,
        messages: [{ role: 'user', content: 'please remember X' }],
        tools: [{ name: 'write_memory', description: 'save info' }],
      })
      assert.equal(calls.length, 1)
      assert.match(calls[0].url, /generateContent$/)
      const sys = calls[0].body?.systemInstruction?.parts?.[0]?.text || ''
      assert.match(sys, /strict intent classifier/i)
      assert.match(sys, /remember\/save\/note\/persist/)
    })
  })
})
