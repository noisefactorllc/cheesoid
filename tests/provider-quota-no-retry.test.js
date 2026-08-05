import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createGeminiProvider } from '../server/lib/providers/gemini.js'
import { createOpenAICompatProvider } from '../server/lib/providers/openai-compat.js'
import { isQuotaExhaustedError } from '../server/lib/quota.js'

// Gemini and OpenAI both report depleted credits as HTTP 429 — the same status
// they use for ordinary rate limiting, which does clear on its own. The only
// thing that tells them apart is the response body, and the retry loops were
// consuming that body to free the connection and then reading the drained body
// again for the error message. So the thrown error was `Gemini API error 429: `
// with nothing after the colon, and the real reason — "Your prepayment credits
// are depleted" — never reached a log, a room, or an operator. It took two days
// and a hand-rolled curl to find out why EHSRE's attention tier was down.
//
// Two consequences, both fixed here: the reason has to survive into the error,
// and a 429 that says the account is out of credits must not be retried. No
// amount of backoff produces credit.

const GEMINI_DEPLETED = JSON.stringify({
  error: {
    code: 429,
    message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.',
    status: 'RESOURCE_EXHAUSTED',
  },
})

const PLAIN_RATE_LIMIT = JSON.stringify({
  error: { code: 429, message: 'Too many requests, please slow down.' },
})

let realFetch
let calls

function stubFetch(status, body, headers = {}) {
  calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    // A real Response body can be read exactly once; the second read rejects.
    // That single fact is the whole bug — the retry loop consumed the body to
    // free the connection, so the error message built afterwards from a second
    // read came back empty. A re-readable stub hides it.
    let consumed = false
    const readOnce = async () => {
      if (consumed) throw new TypeError('Body has already been consumed.')
      consumed = true
      return body
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      text: readOnce,
      json: async () => JSON.parse(await readOnce()),
      body: null,
    }
  }
}

beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = realFetch })

const geminiFor = (host) => createGeminiProvider({ api_key: 'k', base_url: `https://${host}/v1beta` })
const compatFor = (host) => createOpenAICompatProvider({ api_key: 'k', base_url: `https://${host}/v1` })
const params = { model: 'm', maxTokens: 16, system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }

describe('a 429 that means "out of credits" is not retried', () => {
  it('gemini: makes exactly one request and keeps the reason in the error', async () => {
    stubFetch(429, GEMINI_DEPLETED)
    const provider = geminiFor('quota-gemini-1.test')

    const err = await provider.streamMessage(params, () => {}).then(() => null, e => e)

    assert.ok(err, 'expected a rejection')
    assert.match(err.message, /prepayment credits are depleted/)
    assert.equal(calls.length, 1, `expected 1 request, got ${calls.length}`)
    assert.equal(isQuotaExhaustedError(err), true)
  })

  it('openai-compat: makes exactly one request and keeps the reason in the error', async () => {
    stubFetch(429, JSON.stringify({ error: { message: 'You have no credits remaining.' } }))
    const provider = compatFor('quota-compat-1.test')

    const err = await provider.streamMessage(params, () => {}).then(() => null, e => e)

    assert.ok(err, 'expected a rejection')
    assert.match(err.message, /no credits remaining/)
    assert.equal(calls.length, 1, `expected 1 request, got ${calls.length}`)
    assert.equal(isQuotaExhaustedError(err), true)
  })
})

describe('an ordinary rate-limit 429 still backs off and retries', () => {
  it('gemini: retries the configured number of times', async () => {
    stubFetch(429, PLAIN_RATE_LIMIT, { 'retry-after': '0' })
    const provider = geminiFor('quota-gemini-2.test')

    await provider.streamMessage(params, () => {}).then(() => null, e => e)

    assert.ok(calls.length > 1, `a transient rate limit should retry, got ${calls.length} request(s)`)
    assert.equal(isQuotaExhaustedError(new Error(PLAIN_RATE_LIMIT)), false)
  })

  it('openai-compat: retries the configured number of times', async () => {
    stubFetch(429, PLAIN_RATE_LIMIT, { 'retry-after': '0' })
    const provider = compatFor('quota-compat-2.test')

    await provider.streamMessage(params, () => {}).then(() => null, e => e)

    assert.ok(calls.length > 1, `a transient rate limit should retry, got ${calls.length} request(s)`)
  })
})

describe('isQuotaExhaustedError', () => {
  it('matches the exact body the live Gemini endpoint returns', () => {
    assert.equal(isQuotaExhaustedError({ message: GEMINI_DEPLETED }), true)
  })

  it('matches the exact body the live OpenAI endpoint returns', () => {
    assert.equal(isQuotaExhaustedError({ message: 'You have no credits remaining. Add credits to continue using the API' }), true)
  })

  it('does not match a bare rate limit', () => {
    assert.equal(isQuotaExhaustedError({ message: '429 Too Many Requests' }), false)
  })
})
