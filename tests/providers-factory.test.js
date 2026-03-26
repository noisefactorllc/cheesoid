import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getProvider } from '../server/lib/providers/index.js'

describe('getProvider', () => {
  it('returns anthropic provider by default', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const provider = getProvider({})
      assert.equal(typeof provider.streamMessage, 'function')
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })

  it('returns anthropic provider when provider is "anthropic"', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const provider = getProvider({ provider: 'anthropic' })
      assert.equal(typeof provider.streamMessage, 'function')
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })

  it('returns openai-compat provider when configured', () => {
    const provider = getProvider({
      provider: 'openai-compat',
      base_url: 'http://localhost:8080/v1',
      api_key: 'test-key',
    })
    assert.equal(typeof provider.streamMessage, 'function')
  })

  it('throws for unknown provider', () => {
    assert.throws(() => getProvider({ provider: 'nope' }), /Unknown provider/)
  })

  it('creates orchestrator provider from config.orchestrator (anthropic)', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const config = {
      provider: 'openai-compat',
      base_url: 'http://localhost:8080/v1',
      api_key: 'test',
      model: 'test-model',
      orchestrator: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    }
    const provider = getProvider(config)
    const orchestrator = getProvider(config.orchestrator)
    assert.equal(typeof provider.streamMessage, 'function')
    assert.equal(typeof orchestrator.streamMessage, 'function')
    assert.equal(provider.supportsIntentRouting, true)
    assert.equal(orchestrator.supportsIntentRouting, undefined)
    delete process.env.ANTHROPIC_API_KEY
  })

  it('creates orchestrator provider from config.orchestrator (openai-compat)', () => {
    const config = {
      provider: 'anthropic',
      orchestrator: {
        provider: 'openai-compat',
        base_url: 'http://localhost:9090/v1',
        api_key: 'orch-key',
        model: 'smart-model',
      },
    }
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const orchestrator = getProvider(config.orchestrator)
    assert.equal(typeof orchestrator.streamMessage, 'function')
    assert.equal(orchestrator.supportsIntentRouting, true)
    delete process.env.ANTHROPIC_API_KEY
  })
})
