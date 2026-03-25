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
})
