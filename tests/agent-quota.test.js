import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { isQuotaExhaustedError, inferProviderLabel, runHybridAgent } from '../server/lib/agent.js'

describe('isQuotaExhaustedError', () => {
  it('matches OpenAI insufficient_quota', () => {
    assert.ok(isQuotaExhaustedError(new Error('You exceeded your current quota, please check your plan')))
    assert.ok(isQuotaExhaustedError({ message: 'insufficient_quota' }))
  })

  it('matches Gemini RESOURCE_EXHAUSTED + credits depleted', () => {
    assert.ok(isQuotaExhaustedError({ message: 'RESOURCE_EXHAUSTED' }))
    assert.ok(isQuotaExhaustedError({ message: 'Your prepayment credits are depleted.' }))
  })

  it('ignores unrelated errors', () => {
    assert.equal(isQuotaExhaustedError(new Error('connection refused')), false)
    assert.equal(isQuotaExhaustedError(new Error('429 Too Many Requests')), false)
    assert.equal(isQuotaExhaustedError(null), false)
    assert.equal(isQuotaExhaustedError({}), false)
  })
})

describe('inferProviderLabel', () => {
  it('maps model prefixes to provider labels', () => {
    assert.equal(inferProviderLabel('gpt-5.4'), 'OpenAI')
    assert.equal(inferProviderLabel('o4-mini'), 'OpenAI')
    assert.equal(inferProviderLabel('claude-sonnet-4-6'), 'Anthropic')
    assert.equal(inferProviderLabel('gemini-2.5-pro'), 'Gemini')
  })

  it('returns null for unknown providers', () => {
    assert.equal(inferProviderLabel('SecuredTEE/gemma4-31b'), null)
    assert.equal(inferProviderLabel(''), null)
    assert.equal(inferProviderLabel(null), null)
  })
})

describe('runHybridAgent quota emission', () => {
  it('emits provider_quota_exhausted when primary orchestrator hits quota', async () => {
    let callIndex = 0
    const fallbackProvider = {
      streamMessage: mock.fn(async () => ({
        contentBlocks: [{ type: 'text', text: 'fallback ok' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      })),
    }
    const primaryProvider = {
      streamMessage: mock.fn(async () => {
        if (callIndex++ === 0) {
          const err = new Error('You exceeded your current quota, please check your plan')
          throw err
        }
        return {
          contentBlocks: [{ type: 'text', text: 'should not reach' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }),
    }
    const events = []
    const config = {
      provider: primaryProvider,
      model: 'gpt-5.4',
      layer: 'attention',
      orchestratorFallbackModels: ['claude-sonnet-4-6'],
      registry: { resolve: () => ({ modelId: 'claude-sonnet-4-6', provider: fallbackProvider }) },
    }
    const tools = { definitions: [], execute: mock.fn() }

    await runHybridAgent('sys', [{ role: 'user', content: 'hi' }], tools, config, (e) => events.push(e))

    const quotaEvents = events.filter(e => e.type === 'provider_quota_exhausted')
    assert.equal(quotaEvents.length, 1)
    assert.equal(quotaEvents[0].provider, 'OpenAI')
    assert.equal(quotaEvents[0].model, 'gpt-5.4')
  })

  it('does not emit on non-quota errors', async () => {
    const fallbackProvider = {
      streamMessage: mock.fn(async () => ({
        contentBlocks: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5 },
      })),
    }
    const primaryProvider = {
      streamMessage: mock.fn(async () => {
        throw new Error('connection reset')
      }),
    }
    const events = []
    const config = {
      provider: primaryProvider,
      model: 'gpt-5.4',
      layer: 'attention',
      orchestratorFallbackModels: ['claude-sonnet-4-6'],
      registry: { resolve: () => ({ modelId: 'claude-sonnet-4-6', provider: fallbackProvider }) },
    }
    const tools = { definitions: [], execute: mock.fn() }

    await runHybridAgent('sys', [{ role: 'user', content: 'hi' }], tools, config, (e) => events.push(e))

    assert.equal(events.filter(e => e.type === 'provider_quota_exhausted').length, 0)
  })
})
