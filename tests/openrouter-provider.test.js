import { test } from 'node:test'
import assert from 'node:assert'
import { ProviderRegistry, _openrouterCompatConfig } from '../server/lib/providers/registry.js'
import { buildWebSearchTools, resolveWebSearchProvider } from '../server/lib/web-search.js'
import { providersByTier, warnUnsuppliedWebSearch } from '../server/lib/persona.js'

// --- helpers for the finding-2 web-search tests ---
function withEnv(key, value, fn) {
  const prev = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

function okResponse(annotations = []) {
  return {
    ok: true,
    status: 200,
    async json() { return { choices: [{ message: { content: '', annotations } }] } },
  }
}

function captureLogs() {
  const original = console.log
  const messages = []
  console.log = (...args) => { messages.push(args.map(String).join(' ')) }
  return {
    find: (re) => messages.find(m => re.test(m)),
    restore: () => { console.log = original },
  }
}

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

// Finding 1: the "NO x-ai / grok ever" operator ban is enforced HARD at the
// registry, the one chokepoint every model id passes through. Persona tiers,
// model_policy.allow, and subagent overrides can all name a model — none may
// reach x-ai.
test('resolve() refuses any x-ai / grok model (standing operator ban)', () => {
  const registry = new ProviderRegistry({
    providers: { openrouter: { type: 'openrouter', api_key: 'test-key-not-real' } },
  })
  // With a provider suffix (splits to modelId "x-ai/grok-4.5").
  assert.throws(() => registry.resolve('x-ai/grok-4.5:openrouter'), /x-ai/i)
  // Without a suffix.
  assert.throws(() => registry.resolve('x-ai/grok-4.5'), /x-ai/i)
  // Even when the openrouter suffix cannot be split off (no such known provider).
  assert.throws(() => registry.resolve('x-ai/grok-4.5:nonesuch'), /x-ai/i)
  // A normal model is unaffected.
  const { modelId } = registry.resolve('deepseek/deepseek-v4-flash:openrouter')
  assert.strictEqual(modelId, 'deepseek/deepseek-v4-flash')
})

// Finding 6: a persona-set base_url on a `type: openrouter` provider was forced
// back to openrouter.ai because base_url was assigned AFTER ...config. Honor it
// (e.g. an OpenRouter-compatible proxy) while defaulting when absent.
test('a type: openrouter provider honors a persona-set base_url', () => {
  const merged = _openrouterCompatConfig({ base_url: 'https://proxy.example.com/v1', api_key: 'k' })
  assert.strictEqual(merged.base_url, 'https://proxy.example.com/v1')
  // The other OpenRouter defaults still apply.
  assert.strictEqual(merged.type, 'openai-compat')
  assert.strictEqual(merged.supports_reasoning_budget, true)
  assert.strictEqual(merged.web_search, true)
})

test('a type: openrouter provider defaults base_url to openrouter.ai when unset', () => {
  const merged = _openrouterCompatConfig({ api_key: 'k' })
  assert.strictEqual(merged.base_url, 'https://openrouter.ai/api/v1')
})

test('a type: openrouter provider falls back to OPENROUTER_API_KEY for the key', () => {
  const prev = process.env.OPENROUTER_API_KEY
  process.env.OPENROUTER_API_KEY = 'env-key-not-real'
  try {
    const merged = _openrouterCompatConfig({ base_url: 'https://proxy.example.com/v1' })
    assert.strictEqual(merged.api_key, 'env-key-not-real')
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = prev
  }
})

// ============================================================================
// Finding 2: web_search was dead config for the openrouter provider.
// ============================================================================

// (2a) A `type: openrouter` provider derives base_url/api_key from the
// environment — reading provider.base_url/provider.api_key found them empty.
test('resolveWebSearchProvider resolves a type: openrouter provider from the environment', () => {
  withEnv('OPENROUTER_API_KEY', 'env-key-not-real', () => {
    const config = {
      server_tools: [{ name: 'web_search' }],
      providers: { openrouter: { type: 'openrouter', web_search: true } }, // no base_url / api_key
    }
    const resolved = resolveWebSearchProvider(config)
    assert.ok(resolved, 'a type: openrouter provider is resolvable')
    assert.strictEqual(resolved.baseUrl, 'https://openrouter.ai/api/v1')
    assert.strictEqual(resolved.apiKey, 'env-key-not-real')
  })
})

// (2a) The auto-registered openrouter provider — a zero-config persona has no
// providers block at all, yet OPENROUTER_API_KEY makes web search available.
test('resolveWebSearchProvider backs web search with the auto-registered openrouter provider', () => {
  withEnv('OPENROUTER_API_KEY', 'env-key-not-real', () => {
    const config = { server_tools: [{ name: 'web_search' }] } // no providers block
    const resolved = resolveWebSearchProvider(config)
    assert.ok(resolved, 'the auto-registered openrouter provider backs web search')
    assert.strictEqual(resolved.baseUrl, 'https://openrouter.ai/api/v1')
    assert.strictEqual(resolved.apiKey, 'env-key-not-real')
  })
})

// Without a key there is nothing to back it.
test('resolveWebSearchProvider returns null when nothing can back web search', () => {
  withEnv('OPENROUTER_API_KEY', undefined, () => {
    assert.strictEqual(resolveWebSearchProvider({ server_tools: [{ name: 'web_search' }] }), null)
  })
})

// (2a) End to end: buildWebSearchTools drives a type: openrouter provider with
// env-derived creds — previously the fetch hit "/chat/completions" with
// "Bearer undefined".
test('buildWebSearchTools drives a type: openrouter provider using env-derived creds', async () => {
  await withEnv('OPENROUTER_API_KEY', 'env-key-not-real', async () => {
    let captured = null
    const fetchImpl = async (url, opts) => {
      captured = { url, headers: opts.headers }
      return okResponse([{ url_citation: { url: 'https://ex.com', title: 'Ex', content: 'x' } }])
    }
    const config = {
      name: 'zeroish',
      server_tools: [{ name: 'web_search' }],
      providers: { openrouter: { type: 'openrouter', web_search: true } },
      model: ['deepseek/deepseek-v4-flash:openrouter'],
    }
    const tools = buildWebSearchTools(config, { fetchImpl })
    assert.equal(tools.definitions.length, 1, 'web_search tool is registered')

    await tools.execute('web_search', { query: 'anything' })
    assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.equal(captured.headers.Authorization, 'Bearer env-key-not-real')
  })
})

// (2b) providersByTier must attribute a :openrouter tier to openrouter, not be
// blinded into calling it "anthropic" (which hides a real web-search drop).
test('providersByTier attributes a :openrouter tier to openrouter when the key is present', () => {
  withEnv('OPENROUTER_API_KEY', 'env-key-not-real', () => {
    const byProvider = providersByTier({ model: ['google/gemma-4-31b-it:openrouter'] })
    assert.ok(byProvider.has('openrouter'), 'the openrouter tier is seen as openrouter')
    assert.ok(!byProvider.has('anthropic'), 'it is not misattributed to anthropic')
  })
})

// (2b) The warning fires when a tier routes through openrouter, web_search is
// declared, but no provider actually backs it.
test('warnUnsuppliedWebSearch warns when an openrouter tier has no web-search backing', () => {
  const logs = captureLogs()
  try {
    withEnv('OPENROUTER_API_KEY', 'env-key-not-real', () => {
      warnUnsuppliedWebSearch({
        name: 'dropbot',
        server_tools: [{ name: 'web_search' }],
        providers: { openrouter: { type: 'openrouter' } }, // declared but web_search OFF
        model: ['google/gemma-4-31b-it:openrouter'],
      })
    })
  } finally {
    logs.restore()
  }
  assert.ok(logs.find(/no provider supplies it|no web search/i), 'the silent-drop warning fires')
})

// (2b) But it stays silent when the auto-registered openrouter provider backs it.
test('warnUnsuppliedWebSearch stays silent when auto-registered openrouter backs the tool', () => {
  const logs = captureLogs()
  try {
    withEnv('OPENROUTER_API_KEY', 'env-key-not-real', () => {
      warnUnsuppliedWebSearch({
        name: 'okbot',
        server_tools: [{ name: 'web_search' }],
        model: ['google/gemma-4-31b-it:openrouter'], // no providers block → auto openrouter
      })
    })
  } finally {
    logs.restore()
  }
  assert.strictEqual(logs.find(/no provider supplies it|no web search/i), undefined)
})
