import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { _processStream as processCompat, _parseSSE, SSE_DONE } from '../server/lib/providers/openai-compat.js'
import { _processStream as processGemini } from '../server/lib/providers/gemini.js'
import { _processResponsesStream as processResponses } from '../server/lib/providers/openai-responses.js'
import { _streamOnce as anthropicStreamOnce } from '../server/lib/providers/anthropic.js'
import { TruncatedStreamError, StreamStallError } from '../server/lib/providers/stream-guard.js'
import { runHybridAgent } from '../server/lib/agent.js'

// Brad, 2026-08-01T04:28Z. A user message arrived, the orchestrator opened a
// stream to OpenRouter, and 387 seconds later the provider returned
// `stopReason: null` with `usage {0,0}` and one tool_use block: the connection
// had ended without a finish_reason chunk, without a usage chunk, and without
// [DONE]. Nothing threw, so no fallback engaged. The agent saw a stop reason
// that was not 'tool_use', broke out of the loop before executing the tool, and
// found no text block to emit — so it persisted nothing, said nothing, and
// logged no error. The turn "succeeded" with zero output and the user's message
// was dropped on the floor.
//
// The defect is that a truncated stream is indistinguishable from a complete
// one. Every provider must fail loud on a stream that ends without a terminal
// signal, so the existing retry/fallback path engages instead of a silent
// empty turn reaching the room.

function fromChunks(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function bytes(...strings) {
  const encoder = new TextEncoder()
  return {
    async *[Symbol.asyncIterator]() {
      for (const s of strings) yield encoder.encode(s)
    },
  }
}

describe('truncated streams fail loud', () => {
  describe('openai-compat', () => {
    it('throws when the stream ends mid tool call without finish_reason', async () => {
      // The exact wire shape of the Brad incident: tool_call deltas arrive,
      // then the body ends. No finish_reason, no usage, no [DONE].
      const stream = fromChunks([
        {
          choices: [{
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'schedule_create', arguments: '{"na' } }] },
            finish_reason: null,
          }],
        },
      ])
      await assert.rejects(
        () => processCompat(stream, () => {}),
        (err) => err instanceof TruncatedStreamError && /openai-compat/.test(err.message),
      )
    })

    it('throws when the stream ends after text without finish_reason', async () => {
      const stream = fromChunks([
        { choices: [{ delta: { content: 'half a sent' }, finish_reason: null }] },
      ])
      await assert.rejects(() => processCompat(stream, () => {}), TruncatedStreamError)
    })

    it('throws when the stream yields nothing at all', async () => {
      await assert.rejects(() => processCompat(fromChunks([]), () => {}), TruncatedStreamError)
    })

    it('still returns normally when finish_reason arrives', async () => {
      const stream = fromChunks([
        { choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ])
      const { stopReason, usage } = await processCompat(stream, () => {})
      assert.equal(stopReason, 'end_turn')
      assert.equal(usage.input_tokens, 3)
    })

    // Not every OpenAI-compatible backend sends finish_reason, but [DONE] is
    // the protocol's own end-of-stream marker. Rejecting a response that
    // reached it would take every turn on such a backend offline — the
    // opposite failure from the one being fixed, and a worse one.
    it('accepts a stream that reached [DONE] without a finish_reason', async () => {
      const stream = fromChunks([
        { choices: [{ delta: { content: 'complete answer' }, finish_reason: null }] },
        SSE_DONE,
      ])
      const { stopReason, contentBlocks } = await processCompat(stream, () => {})
      assert.equal(stopReason, 'end_turn')
      assert.equal(contentBlocks[0].text, 'complete answer')
    })

    it('reads tool_use off the content when [DONE] arrives without a finish_reason', async () => {
      const stream = fromChunks([
        {
          choices: [{
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'schedule_create', arguments: '{"name":"x"}' } }] },
            finish_reason: null,
          }],
        },
        SSE_DONE,
      ])
      const { stopReason } = await processCompat(stream, () => {})
      assert.equal(stopReason, 'tool_use')
    })

    it('end-to-end: a [DONE]-terminated body without finish_reason survives parse+process', async () => {
      const parsed = _parseSSE(bytes(
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ))
      const { stopReason } = await processCompat(parsed, () => {})
      assert.equal(stopReason, 'end_turn')
    })

    it('end-to-end: a body that ends without [DONE] or finish_reason throws', async () => {
      const parsed = _parseSSE(bytes(
        'data: {"choices":[{"delta":{"content":"half a sent"},"finish_reason":null}]}\n\n',
      ))
      await assert.rejects(() => processCompat(parsed, () => {}), TruncatedStreamError)
    })
  })

  describe('gemini', () => {
    // Gemini did not go silent — it invented a stop reason for a truncated
    // stream, which is the same corruption wearing a different mask: a partial
    // tool call gets executed, or half an answer is reported as complete.
    it('throws instead of inventing end_turn when finishReason never arrives', async () => {
      const chunks = [{ candidates: [{ content: { parts: [{ text: 'half a sent' }] } }] }]
      await assert.rejects(
        () => processGemini(fromChunks(chunks), () => {}),
        (err) => err instanceof TruncatedStreamError && /gemini/.test(err.message),
      )
    })

    it('throws instead of inventing tool_use when finishReason never arrives', async () => {
      const chunks = [{
        candidates: [{ content: { parts: [{ functionCall: { name: 'read_memory', args: {} } }] } }],
      }]
      await assert.rejects(() => processGemini(fromChunks(chunks), () => {}), TruncatedStreamError)
    })

    it('still returns normally when finishReason arrives', async () => {
      const chunks = [{ candidates: [{ content: { parts: [{ text: 'Hello.' }] }, finishReason: 'STOP' }] }]
      const { stopReason } = await processGemini(fromChunks(chunks), () => {})
      assert.equal(stopReason, 'end_turn')
    })
  })

  describe('openai-responses', () => {
    it('throws when response.completed never arrives', async () => {
      const chunks = [
        { type: 'response.output_text.delta', delta: 'half a sent' },
      ]
      await assert.rejects(
        () => processResponses(fromChunks(chunks), () => {}),
        (err) => err instanceof TruncatedStreamError && /openai-responses/.test(err.message),
      )
    })
  })

  describe('anthropic', () => {
    const clientYielding = (events) => ({
      messages: {
        stream: () => fromChunks(events),
      },
    })

    it('throws when message_delta never arrives', async () => {
      const client = clientYielding([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'half a sent' } },
      ])
      await assert.rejects(
        () => anthropicStreamOnce(client, {}, () => {}),
        (err) => err instanceof TruncatedStreamError && /anthropic/.test(err.message),
      )
    })

    it('still returns normally when message_delta carries a stop reason', async () => {
      const client = clientYielding([
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      ])
      const { stopReason } = await anthropicStreamOnce(client, {}, () => {})
      assert.equal(stopReason, 'end_turn')
    })
  })
})

describe('stalled streams fail loud', () => {
  it('throws when no bytes arrive within the stall window', async () => {
    const body = {
      async *[Symbol.asyncIterator]() {
        await new Promise(resolve => setTimeout(resolve, 50))
        yield new TextEncoder().encode('data: [DONE]\n\n')
      },
    }
    await assert.rejects(async () => {
      for await (const _ of _parseSSE(body, { stallMs: 5 })) { /* drain */ }
    }, StreamStallError)
  })

  it('does not fire while bytes keep arriving', async () => {
    const encoder = new TextEncoder()
    const body = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 4; i++) {
          await new Promise(resolve => setTimeout(resolve, 10))
          yield encoder.encode(`data: {"choices":[{"delta":{"content":"${i}"}}]}\n\n`)
        }
        yield encoder.encode('data: [DONE]\n\n')
      },
    }
    const chunks = []
    for await (const chunk of _parseSSE(body, { stallMs: 60 })) {
      if (chunk !== SSE_DONE) chunks.push(chunk)
    }
    assert.equal(chunks.length, 4)
  })

  it('releases the body when a stall cuts the read short', async () => {
    // Iterating by hand to race the stall budget gave up the automatic close
    // `for await` used to perform. A stalled provider that also leaked its
    // connection would be the same incident with a resource leak attached.
    let closed = false
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}), // never settles
          return: async () => { closed = true; return { done: true } },
        }
      },
    }
    await assert.rejects(async () => {
      for await (const _ of _parseSSE(body, { stallMs: 5 })) { /* drain */ }
    }, StreamStallError)
    assert.equal(closed, true)
  })

  // Run in a child process with nothing else pending, because that is the only
  // condition under which the bug this guards against appears. An unref'd
  // watchdog timer lets the event loop drain while a read is outstanding, so
  // node exits instead of firing it and the awaited read is stranded rather
  // than rejected. Inside the normal suite other handles mask it, which is why
  // it passed locally and cancelled five tests in CI.
  it('fires even when the stalled read is the only thing pending', { timeout: 20_000 }, async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const guard = new URL('../server/lib/providers/stream-guard.js', import.meta.url).href

    const program = `
      const { withStallTimeout, StreamStallError } = await import(${JSON.stringify(guard)})
      try {
        await withStallTimeout(new Promise(() => {}), 50, 'test')
        process.exit(2) // resolved, which cannot happen
      } catch (err) {
        process.exit(err instanceof StreamStallError ? 0 : 3)
      }
    `
    // If the watchdog cannot hold the loop open, node exits 13 here
    // (ERR_UNSETTLED_TOP_LEVEL_AWAIT) or hangs until this test times out.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { timeout: 15_000 },
    ).then(r => r, e => { throw new Error(`child exited ${e.code}: ${e.stderr || e.message}`) })
    assert.equal(stdout, '')
  })

  it('does not fire while draining a connection held open after [DONE]', async () => {
    // Post-[DONE] the generation is over and we are only freeing the socket.
    // A server that dawdles there is not a stalled generation.
    const encoder = new TextEncoder()
    const body = {
      async *[Symbol.asyncIterator]() {
        yield encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
        await new Promise(resolve => setTimeout(resolve, 40))
        yield encoder.encode(': trailing keepalive\n\n')
      },
    }
    const chunks = []
    for await (const chunk of _parseSSE(body, { stallMs: 15 })) {
      if (chunk !== SSE_DONE) chunks.push(chunk)
    }
    assert.equal(chunks.length, 1)
  })
})

describe('runHybridAgent on a truncated orchestrator stream', () => {
  it('surfaces the failure instead of ending the turn silently', async () => {
    // Before the fix the provider resolved with stopReason null, the agent
    // broke before tool execution, emitted no assistant_text_turn, and
    // returned a "successful" empty turn. Brad said nothing at all.
    const provider = {
      streamMessage: async () => { throw new TruncatedStreamError('openai-compat') },
    }
    const tools = { definitions: [], execute: async () => ({ output: '' }) }
    const config = { provider, model: 'google/gemma-4-31b-it' }
    const events = []

    await assert.rejects(
      () => runHybridAgent('system', [{ role: 'user', content: 'we are probably down to 12 months.' }], tools, config, e => events.push(e)),
      TruncatedStreamError,
    )
    assert.equal(events.some(e => e.type === 'assistant_text_turn'), false)
  })

  it('tags the failure with the metadata the room status message requires', async () => {
    // chat-session only posts a status message for errors carrying .layer and
    // .triedModels — anything else is treated as a config error and swallowed.
    // Without these the turn still fails silently from the reader's side, which
    // is the symptom this whole change exists to remove.
    const provider = {
      streamMessage: async () => { throw new TruncatedStreamError('openai-compat') },
    }
    const config = { provider, model: 'google/gemma-4-31b-it', layer: 'attention' }

    const err = await runHybridAgent(
      'system',
      [{ role: 'user', content: 'hi' }],
      { definitions: [], execute: async () => ({ output: '' }) },
      config,
      () => {},
    ).then(() => null, e => e)

    assert.ok(err instanceof TruncatedStreamError)
    assert.equal(err.layer, 'attention')
    assert.deepEqual(err.triedModels, ['google/gemma-4-31b-it'])
  })

  it('carries a retryable status so the fallback chain still runs', async () => {
    // A malformed payload is refused by every provider and must not be retried;
    // that classification keys off a 400/422 status. A severed connection is the
    // opposite — the same request may well succeed on the next model — so it has
    // to stay on the retryable side of that line.
    const err = new TruncatedStreamError('openai-compat')
    assert.equal(err.status, 503)
    assert.notEqual(err.status, 400)
    assert.notEqual(err.status, 422)
  })
})
