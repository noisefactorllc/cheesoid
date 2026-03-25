import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAnthropicProvider } from '../server/lib/providers/anthropic.js'

describe('createAnthropicProvider', () => {
  it('throws when ANTHROPIC_API_KEY is not set', () => {
    const original = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      assert.throws(() => createAnthropicProvider({}), /ANTHROPIC_API_KEY/)
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original
    }
  })

  it('returns an object with streamMessage method', () => {
    const original = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-key'
    try {
      const provider = createAnthropicProvider({})
      assert.equal(typeof provider.streamMessage, 'function')
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })
})
