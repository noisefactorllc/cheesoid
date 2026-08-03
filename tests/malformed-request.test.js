import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runHybridAgent, isMalformedRequestError } from '../server/lib/agent.js'
import { _providerStatusMessage } from '../server/lib/chat-session.js'

// A malformed request is deterministic: the payload is wrong, so every model
// and every provider rejects it identically. Treating it as provider
// unavailability burns the whole fallback chain, sleeps through exponential
// backoff, and then tells the user "retrying until a provider returns" about a
// condition no retry can clear. ask-agent shipped a duplicate `web_search` tool
// and spent days looking like a flaky attention layer because of this.
//
// The opposite mistake is already in the regression record: classifying every
// 400 non-retryable took the cognition layer offline on a credit-balance error,
// which a cross-provider fallback would have absorbed (agent-hybrid.test.js).
// So the predicate is an allowlist — anything it does not positively recognize
// as a payload-shape failure keeps today's fall-back-and-retry behavior.
describe('isMalformedRequestError', () => {
  const apiError = (message, status = 400) => {
    // Shape the Anthropic SDK actually throws: "<status> <json body>".
    const err = new Error(
      `${status} ${JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message }, request_id: 'req_x' })}`,
    )
    err.status = status
    return err
  }

  it('recognizes the duplicate-tool-name 400 that took ask-agent down', () => {
    assert.equal(isMalformedRequestError(apiError('tools: Tool names must be unique.')), true)
  })

  it('recognizes a field-path validation failure on any request field', () => {
    assert.equal(isMalformedRequestError(apiError('messages.0.content.1: unexpected block type')), true)
    assert.equal(isMalformedRequestError(apiError('tools.3.custom.name: String should match pattern')), true)
    assert.equal(isMalformedRequestError(apiError('max_tokens: must be greater than thinking.budget_tokens')), true)
  })

  it('reads a structured SDK error body as well as a flat message', () => {
    const err = new Error('Request failed')
    err.status = 400
    err.error = { type: 'error', error: { type: 'invalid_request_error', message: 'tools: Tool names must be unique.' } }
    assert.equal(isMalformedRequestError(err), true)
  })

  // The credit-balance regression: provider-scoped, and a fallback to a
  // different provider is exactly the right response. Must NOT match.
  it('does not match a billing 400 — a cross-provider fallback fixes those', () => {
    assert.equal(
      isMalformedRequestError(apiError('Your credit balance is too low to access the Anthropic API.')),
      false,
    )
  })

  it('does not match auth, rate-limit, overload or server errors', () => {
    assert.equal(isMalformedRequestError(apiError('invalid x-api-key', 401)), false)
    assert.equal(isMalformedRequestError(apiError('rate_limit_error', 429)), false)
    assert.equal(isMalformedRequestError(apiError('Overloaded', 529)), false)
    assert.equal(isMalformedRequestError(apiError('Internal server error', 500)), false)
  })

  it('does not match an unrecognized 400 — unknown errors keep retrying', () => {
    assert.equal(isMalformedRequestError(apiError('something we have never seen')), false)
  })

  it('tolerates null, plain and non-HTTP errors', () => {
    assert.equal(isMalformedRequestError(null), false)
    assert.equal(isMalformedRequestError(new Error('boom')), false)
    assert.equal(isMalformedRequestError({ status: 400 }), false)
  })
})

describe('malformed requests skip the fallback chain', () => {
  function malformedProvider() {
    return {
      streamMessage: mock.fn(async () => {
        const err = new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"tools: Tool names must be unique."}}',
        )
        err.status = 400
        throw err
      }),
    }
  }

  const makeTools = () => ({ definitions: [], execute: mock.fn(async () => ({ output: 'x' })) })

  it('does not try fallback models when the payload itself is rejected', async () => {
    const primary = malformedProvider()
    const fallback = malformedProvider()
    const config = {
      provider: primary,
      model: 'claude-haiku-4-5',
      layer: 'attention',
      orchestratorFallbackModels: ['gpt-5.4:openai'],
      registry: { resolve: () => ({ modelId: 'gpt-5.4', provider: fallback }) },
    }

    const err = await runHybridAgent('system', [{ role: 'user', content: 'hi' }], makeTools(), config, () => {})
      .then(() => null, e => e)

    assert.ok(err, 'expected the malformed request to throw')
    assert.equal(err.isMalformedRequest, true)
    // The whole point: the backup provider is never dialed.
    assert.equal(fallback.streamMessage.mock.callCount(), 0)
    assert.equal(primary.streamMessage.mock.callCount(), 1)
    // Still carries routing context so the UI can name the layer and model.
    assert.equal(err.layer, 'attention')
    assert.deepEqual(err.triedModels, ['claude-haiku-4-5'])
  })
})

describe('_providerStatusMessage', () => {
  // Verbatim from the ask-agent failure that started this.
  const askAgentError = () => {
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"tools: Tool names must be unique."},"request_id":"req_011CdbJ14dKQtzPdHQN1hsyN"}',
    )
    err.status = 400
    err.layer = 'attention'
    err.triedModels = ['claude-haiku-4-5']
    err.isMalformedRequest = true
    return err
  }

  it('does not promise retries for a malformed request', () => {
    const msg = _providerStatusMessage(askAgentError())
    assert.ok(!/Retrying until a provider returns/.test(msg), `still promises retries:\n${msg}`)
    assert.ok(!/unavailable/.test(msg), `still blames availability:\n${msg}`)
    assert.match(msg, /needs a config or code fix/)
  })

  it('surfaces the API message, not the serialized envelope', () => {
    const msg = _providerStatusMessage(askAgentError())
    assert.match(msg, /tools: Tool names must be unique\./)
    assert.ok(!/request_id/.test(msg), `leaks the raw JSON body:\n${msg}`)
    assert.match(msg, /`claude-haiku-4-5`/)
  })

  it('classifies from the error itself when the flag is absent (non-hybrid path)', () => {
    const err = askAgentError()
    delete err.isMalformedRequest
    assert.match(_providerStatusMessage(err), /needs a config or code fix/)
  })

  it('still reports a genuine outage as unavailable and retrying', () => {
    const err = new Error('Overloaded')
    err.status = 529
    err.layer = 'cognition'
    err.triedModels = ['claude-sonnet-4-6', 'gpt-5.4']
    const msg = _providerStatusMessage(err)
    assert.match(msg, /\*\*cognition layer unavailable\*\*/)
    assert.match(msg, /Retrying until a provider returns/)
    assert.match(msg, /1\. `claude-sonnet-4-6`/)
    assert.match(msg, /2\. `gpt-5\.4`/)
  })

  it('still reports an open circuit with its url', () => {
    const err = new Error('wrapped')
    err.isCircuitOpen = true
    err.url = 'https://example.test/v1'
    err.layer = 'execution'
    err.triedModels = ['some-model']
    const msg = _providerStatusMessage(err)
    assert.match(msg, /circuit open for/)
    assert.match(msg, /Retrying until a provider returns/)
  })
})
