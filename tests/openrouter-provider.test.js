import { test } from 'node:test'
import assert from 'node:assert'
import { ProviderRegistry } from '../server/lib/providers/registry.js'

test('openrouter type resolves as a preconfigured openai-compat provider', () => {
  const registry = new ProviderRegistry({
    providers: { openrouter: { type: 'openrouter', api_key: 'test-key-not-real' } },
  })
  const { modelId, provider } = registry.resolve('deepseek/deepseek-v4-flash:openrouter')
  assert.strictEqual(modelId, 'deepseek/deepseek-v4-flash')
  assert.ok(provider)
  // OpenRouter honors reasoning budgets and can serve intent routing
  assert.strictEqual(provider.supportsIntentRouting, true)
})

test('auto-registers openrouter from the environment when persona omits it', () => {
  const prev = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'env-key-not-real'
  try {
    const registry = new ProviderRegistry({})
    const { provider } = registry.resolve('xiaomi/mimo-v2.5:openrouter')
    assert.ok(provider)
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = prev
  }
})

test('no env key and no declaration: suffix stays part of the model id (legacy heuristic)', () => {
  const prev = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    // Without a registered `openrouter` provider the ":openrouter" suffix is
    // not split off — same guard that keeps "gemma-3:27b" a model id. The
    // string falls through to the default provider unchanged.
    const registry = new ProviderRegistry({})
    const { modelId } = registry.resolve('foo:openrouter')
    assert.strictEqual(modelId, 'foo:openrouter')
  } finally {
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev
  }
})

test('persona-declared openrouter provider wins over the auto-registered one', () => {
  const prev = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'env-key-not-real'
  try {
    const registry = new ProviderRegistry({
      providers: { openrouter: { type: 'openai-compat', base_url: 'https://openrouter.ai/api/v1', api_key: 'persona-key', supports_reasoning_budget: true } },
    })
    const { provider } = registry.resolve('z-ai/glm-5.2:openrouter')
    assert.ok(provider)
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = prev
  }
})
