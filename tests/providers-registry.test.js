// tests/providers-registry.test.js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderRegistry } from '../server/lib/providers/registry.js'

describe('ProviderRegistry', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
  })

  it('creates registry from new-style providers block', () => {
    const registry = new ProviderRegistry({
      providers: {
        blueocean: {
          type: 'openai-compat',
          base_url: 'http://blue.test/v1',
          api_key: 'blue-key',
        },
      },
    })
    assert.ok(registry)
  })

  it('creates registry from legacy provider fields', () => {
    const registry = new ProviderRegistry({
      provider: 'openai-compat',
      base_url: 'http://legacy.test/v1',
      api_key: 'legacy-key',
      model: 'test-model',
    })
    assert.ok(registry)
  })

  it('creates registry with no provider config (anthropic default)', () => {
    const registry = new ProviderRegistry({})
    assert.ok(registry)
  })

  it('resolve() with explicit suffix returns correct provider', () => {
    const registry = new ProviderRegistry({
      providers: {
        blueocean: {
          type: 'openai-compat',
          base_url: 'http://blue.test/v1',
          api_key: 'blue-key',
        },
      },
    })
    const { modelId, provider } = registry.resolve('AltFast/Maverick:blueocean')
    assert.equal(modelId, 'AltFast/Maverick')
    assert.equal(typeof provider.streamMessage, 'function')
    assert.equal(provider.supportsIntentRouting, true)
  })

  it('resolve() auto-detects claude as anthropic', () => {
    const registry = new ProviderRegistry({})
    const { modelId, provider } = registry.resolve('claude-sonnet-4-6')
    assert.equal(modelId, 'claude-sonnet-4-6')
    assert.equal(typeof provider.streamMessage, 'function')
  })

  it('resolve() with bare model uses default provider', () => {
    const registry = new ProviderRegistry({
      provider: 'openai-compat',
      base_url: 'http://legacy.test/v1',
      api_key: 'legacy-key',
    })
    const { modelId, provider } = registry.resolve('AltFast/Llama-3.3-70B')
    assert.equal(modelId, 'AltFast/Llama-3.3-70B')
    assert.equal(typeof provider.streamMessage, 'function')
    assert.equal(provider.supportsIntentRouting, true) // openai-compat
  })

  it('resolve() with bare model defaults to anthropic when no default set', () => {
    const registry = new ProviderRegistry({})
    const { modelId, provider } = registry.resolve('some-model')
    assert.equal(modelId, 'some-model')
    assert.equal(typeof provider.streamMessage, 'function')
  })

  it('get() caches provider instances (same object on repeat calls)', () => {
    const registry = new ProviderRegistry({
      providers: {
        blueocean: {
          type: 'openai-compat',
          base_url: 'http://blue.test/v1',
          api_key: 'blue-key',
        },
      },
    })
    const first = registry.get('blueocean')
    const second = registry.get('blueocean')
    assert.equal(first, second)
  })

  it('get() throws for unknown provider name', () => {
    const registry = new ProviderRegistry({})
    assert.throws(() => registry.get('nonexistent'), /Unknown provider.*nonexistent/)
  })

  it('legacy orchestrator object creates provider via registry', () => {
    const registry = new ProviderRegistry({
      provider: 'openai-compat',
      base_url: 'http://exec.test/v1',
      api_key: 'exec-key',
      orchestrator: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    })
    const { modelId, provider } = registry.resolve('claude-sonnet-4-6:anthropic')
    assert.equal(modelId, 'claude-sonnet-4-6')
    assert.equal(typeof provider.streamMessage, 'function')
  })

  it('mixed: new providers block plus legacy default', () => {
    const registry = new ProviderRegistry({
      provider: 'openai-compat',
      base_url: 'http://default.test/v1',
      api_key: 'default-key',
      providers: {
        fireworks: {
          type: 'openai-compat',
          base_url: 'http://fireworks.test/v1',
          api_key: 'fw-key',
        },
      },
    })
    // Explicit suffix
    const fw = registry.resolve('deepseek:fireworks')
    assert.equal(fw.modelId, 'deepseek')
    assert.equal(typeof fw.provider.streamMessage, 'function')

    // Bare model → legacy default
    const def = registry.resolve('AltFast/Maverick')
    assert.equal(def.modelId, 'AltFast/Maverick')
    assert.equal(typeof def.provider.streamMessage, 'function')

    // Claude → anthropic
    const cl = registry.resolve('claude-haiku-4-5')
    assert.equal(cl.modelId, 'claude-haiku-4-5')
  })
})
