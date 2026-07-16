import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildWebSearchTools } from '../server/lib/web-search.js'
import { loadTools } from '../server/lib/tools.js'
import { Memory } from '../server/lib/memory.js'

// A persona that declares web_search as a server tool and routes through a
// provider with the OpenRouter web plugin enabled.
function personaConfig(overrides = {}) {
  return {
    name: 'testbot',
    server_tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    providers: {
      openrouter: {
        type: 'openai-compat',
        base_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-test',
        web_search: true,
      },
    },
    model: ['google/gemma-4-31b-it:openrouter'],
    ...overrides,
  }
}

// Minimal stub of the OpenRouter /chat/completions response.
function okResponse(annotations, content = '') {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content, annotations } }] }
    },
  }
}

function citation(url, title, content) {
  return { type: 'url_citation', url_citation: { url, title, content } }
}

describe('buildWebSearchTools', () => {
  it('registers nothing when the persona declares no server_tools', () => {
    const tools = buildWebSearchTools(personaConfig({ server_tools: undefined }))
    assert.deepEqual(tools.definitions, [])
    assert.equal(tools.handles('web_search'), false)
  })

  it('registers nothing when no provider enables the web plugin', () => {
    const config = personaConfig()
    config.providers.openrouter.web_search = false
    const tools = buildWebSearchTools(config)
    assert.deepEqual(tools.definitions, [])
    assert.equal(tools.handles('web_search'), false)
  })

  it('registers web_search when declared and a provider enables the web plugin', () => {
    const tools = buildWebSearchTools(personaConfig())
    assert.equal(tools.definitions.length, 1)
    assert.equal(tools.definitions[0].name, 'web_search')
    assert.equal(tools.handles('web_search'), true)
    assert.equal(tools.handles('read_memory'), false)
    assert.ok(tools.definitions[0].input_schema.required.includes('query'))
  })

  it('requests the OpenRouter web plugin without paying for a synthesized answer', async () => {
    let captured = null
    const fetchImpl = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body), headers: opts.headers }
      return okResponse([citation('https://example.com', 'Example', 'snippet')])
    }
    const tools = buildWebSearchTools(personaConfig(), { fetchImpl })

    await tools.execute('web_search', { query: 'caddy latest release' })

    assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions')
    assert.deepEqual(captured.body.plugins, [{ id: 'web', max_results: 5 }])
    // max_tokens 1: the plugin runs the search and returns annotations. We read
    // the sources directly, so generating prose here would be pure waste.
    assert.equal(captured.body.max_tokens, 1)
    assert.equal(captured.body.messages[0].content, 'caddy latest release')
    assert.equal(captured.headers.Authorization, 'Bearer sk-test')
  })

  it('honors a configured max_results to bound per-search cost', async () => {
    let captured = null
    const fetchImpl = async (_url, opts) => {
      captured = JSON.parse(opts.body)
      return okResponse([citation('https://a.com', 'A', 'x')])
    }
    const config = personaConfig()
    config.providers.openrouter.web_search = { max_results: 2 }
    const tools = buildWebSearchTools(config, { fetchImpl })

    await tools.execute('web_search', { query: 'anything' })

    assert.deepEqual(captured.plugins, [{ id: 'web', max_results: 2 }])
  })

  it('derives the search model from the execution tier, stripping the provider suffix', async () => {
    let captured = null
    const fetchImpl = async (_url, opts) => {
      captured = JSON.parse(opts.body)
      return okResponse([citation('https://a.com', 'A', 'x')])
    }
    const tools = buildWebSearchTools(personaConfig(), { fetchImpl })

    await tools.execute('web_search', { query: 'anything' })

    assert.equal(captured.model, 'google/gemma-4-31b-it')
  })

  it('returns each source url, title and snippet from the annotations', async () => {
    const fetchImpl = async () => okResponse([
      citation('https://github.com/caddyserver/caddy/releases/tag/v2.11.4', 'v2.11.4', 'Release notes for v2.11.4'),
      citation('https://caddyserver.com/docs', 'Caddy Docs', 'Documentation home'),
    ])
    const tools = buildWebSearchTools(personaConfig(), { fetchImpl })

    const result = await tools.execute('web_search', { query: 'caddy release' })

    assert.equal(result.is_error, undefined)
    assert.match(result.output, /v2\.11\.4/)
    assert.match(result.output, /https:\/\/github\.com\/caddyserver\/caddy\/releases\/tag\/v2\.11\.4/)
    assert.match(result.output, /Release notes for v2\.11\.4/)
    assert.match(result.output, /Caddy Docs/)
    assert.match(result.output, /Documentation home/)
  })

  it('reports no results rather than an empty string when the search finds nothing', async () => {
    const fetchImpl = async () => okResponse([])
    const tools = buildWebSearchTools(personaConfig(), { fetchImpl })

    const result = await tools.execute('web_search', { query: 'zzzznotathing' })

    assert.match(result.output, /no results/i)
  })

  it('reports an error when the query is missing', async () => {
    const tools = buildWebSearchTools(personaConfig(), { fetchImpl: async () => okResponse([]) })

    const result = await tools.execute('web_search', {})

    assert.equal(result.is_error, true)
    assert.match(result.output, /query/i)
  })

  it('surfaces an upstream HTTP failure as a tool error instead of throwing', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 502,
      async text() { return 'bad gateway' },
    })
    const tools = buildWebSearchTools(personaConfig(), { fetchImpl })

    const result = await tools.execute('web_search', { query: 'anything' })

    assert.equal(result.is_error, true)
    assert.match(result.output, /502/)
  })

  it('surfaces a network failure as a tool error instead of throwing', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
    const tools = buildWebSearchTools(personaConfig(), { fetchImpl })

    const result = await tools.execute('web_search', { query: 'anything' })

    assert.equal(result.is_error, true)
    assert.match(result.output, /ECONNREFUSED/)
  })

  it('rejects an unknown tool name', async () => {
    const tools = buildWebSearchTools(personaConfig(), { fetchImpl: async () => okResponse([]) })

    const result = await tools.execute('not_a_tool', {})

    assert.equal(result.is_error, true)
  })
})

function stubState() {
  return { load: async () => {}, save: async () => {}, update: () => {}, data: {} }
}

function stubRoom() {
  return {
    broadcast: () => {},
    recordHistory: () => {},
    chatLog: null,
    participants: new Map(),
    _pendingRoom: 'home',
    roomClients: new Map(),
    persona: { config: { display_name: 'TestAgent', agents: [], rooms: [] } },
  }
}

async function emptyPersonaDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-websearch-'))
  await mkdir(join(dir, 'memory'), { recursive: true })
  return dir
}

describe('web_search via loadTools', () => {
  it('exposes web_search alongside the memory tools when the persona enables it', async () => {
    const dir = await emptyPersonaDir()
    const config = personaConfig({ memory: { dir: 'memory/', auto_read: [] } })
    const tools = await loadTools(dir, config, new Memory(dir, 'memory/'), stubState(), stubRoom(), null)

    const names = tools.definitions.map(d => d.name)
    assert.ok(names.includes('web_search'), 'web_search is registered')
    assert.ok(names.includes('read_memory'), 'memory tools are still registered')
  })

  it('does not expose web_search when no provider enables the web plugin', async () => {
    const dir = await emptyPersonaDir()
    const config = personaConfig({ memory: { dir: 'memory/', auto_read: [] } })
    config.providers.openrouter.web_search = false
    const tools = await loadTools(dir, config, new Memory(dir, 'memory/'), stubState(), stubRoom(), null)

    assert.equal(tools.definitions.some(d => d.name === 'web_search'), false)
  })

  it('routes a web_search call through to the tool rather than the persona fallback', async () => {
    const dir = await emptyPersonaDir()
    const config = personaConfig({ memory: { dir: 'memory/', auto_read: [] } })
    const fetchImpl = async () => okResponse([citation('https://example.com', 'Example', 'snippet')])
    const tools = await loadTools(dir, config, new Memory(dir, 'memory/'), stubState(), stubRoom(), null, null, { fetchImpl })

    const result = await tools.execute('web_search', { query: 'example' })

    assert.match(result.output, /Example/)
    assert.match(result.output, /https:\/\/example\.com/)
  })
})
