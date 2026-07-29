import { resolveModel } from './providers/resolve.js'

// Default result count per search. OpenRouter bills the web plugin per result,
// so this number is a direct cost lever — raise it deliberately.
const DEFAULT_MAX_RESULTS = 5

/**
 * Resolve the provider that backs web search via OpenRouter's `web` plugin,
 * together with the base_url and api_key needed to reach it.
 *
 * A `type: openrouter` provider — and the auto-registered openrouter provider
 * a zero-config persona runs on — derive base_url/api_key from the environment
 * (see registry.js / voice.js). Reading provider.base_url / provider.api_key
 * directly finds them empty, so the search silently POSTs to "/chat/completions"
 * with "Bearer undefined". This resolves them the same way voice.js does.
 *
 * @param {object} config the loaded persona config
 * @returns {{ webCfg: object, baseUrl: string, apiKey: string } | null}
 */
export function resolveWebSearchProvider(config) {
  for (const p of Object.values(config.providers || {})) {
    if (!p.web_search) continue
    const type = p.type || 'openai-compat'
    const webCfg = p.web_search === true ? {} : p.web_search
    if (type === 'openrouter') {
      const apiKey = p.api_key || process.env.OPENROUTER_API_KEY
      if (apiKey) return { webCfg, baseUrl: 'https://openrouter.ai/api/v1', apiKey }
      continue
    }
    const baseUrl = String(p.base_url || '').replace(/\/$/, '')
    if (baseUrl && p.api_key) return { webCfg, baseUrl, apiKey: p.api_key }
  }
  // The auto-registered openrouter provider: present when OPENROUTER_API_KEY is
  // set and the persona declared no openrouter provider of its own. It defaults
  // web_search on (registry.js), so a declared web_search server tool is backed
  // by it even though it never appears in config.providers.
  if (!config.providers?.openrouter && process.env.OPENROUTER_API_KEY) {
    return { webCfg: {}, baseUrl: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY }
  }
  return null
}

/**
 * Web search as a model-invoked tool, backed by OpenRouter's `web` plugin.
 *
 * Only the anthropic provider implements native server_tools; every
 * openai-compat endpoint silently drops them. Personas that declare
 * `server_tools: web_search` but route through openai-compat would therefore
 * lose web search with no error and no log line.
 *
 * OpenRouter's plugin cannot simply be switched on to fill the gap: it runs a
 * search on *every* request, billed per result, whether or not the turn has
 * anything to look up. Exposing it as a tool instead keeps the decision with
 * the model and the cost proportional to actual use.
 *
 * The search itself is the product, not the prose about it — the plugin returns
 * its sources as annotations, so the request caps generation at a single token
 * and hands the raw sources to the calling model.
 *
 * Enable per provider:
 *   providers:
 *     openrouter:
 *       type: openai-compat
 *       base_url: https://openrouter.ai/api/v1
 *       api_key: ${OPENROUTER_API_KEY}
 *       web_search: true              # or: { max_results: 3, model: <id> }
 *
 * @param {object} config — the loaded persona config
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {{ definitions: object[], handles: (name: string) => boolean, execute: Function }}
 */
export function buildWebSearchTools(config, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch
  const empty = { definitions: [], handles: () => false, execute: async () => ({ output: 'Unknown tool', is_error: true }) }

  const declared = (config.server_tools || []).find(
    t => String(t.type || '').startsWith('web_search') || t.name === 'web_search',
  )
  if (!declared) return empty

  const resolved = resolveWebSearchProvider(config)
  if (!resolved) return empty

  const { webCfg, baseUrl, apiKey } = resolved
  const maxResults = webCfg.max_results || DEFAULT_MAX_RESULTS
  const toolName = declared.name || 'web_search'

  // The plugin does the searching, so the model here only has to be a valid
  // vehicle for the request. Reuse the execution tier — the persona's cheapest.
  const searchModel = webCfg.model || resolveModel(config.model?.[0] || '').modelId

  const definitions = [{
    name: toolName,
    description: 'Search the web for current information and return the matching sources with snippets. Use this when a question depends on facts you do not already know, or on anything that may have changed recently — versions, releases, news, prices, documentation. Each result includes a URL you can cite.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, phrased as a search query.' },
      },
      required: ['query'],
    },
  }]

  async function execute(name, input) {
    if (name !== toolName) return { output: `Unknown web search tool: ${name}`, is_error: true }
    if (!input?.query) return { output: 'A query is required to search the web.', is_error: true }

    let response
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: searchModel,
          max_tokens: 1,
          plugins: [{ id: 'web', max_results: maxResults }],
          messages: [{ role: 'user', content: input.query }],
        }),
      })
    } catch (err) {
      return { output: `Web search failed: ${err.message}`, is_error: true }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return { output: `Web search failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`, is_error: true }
    }

    let data
    try {
      data = await response.json()
    } catch (err) {
      return { output: `Web search returned an unreadable response: ${err.message}`, is_error: true }
    }

    const annotations = data.choices?.[0]?.message?.annotations || []
    const sources = annotations
      .filter(a => a.url_citation)
      .map(a => a.url_citation)
    if (sources.length === 0) {
      return { output: `No results found for "${input.query}".` }
    }

    const formatted = sources.map((s, i) => {
      const parts = [`[${i + 1}] ${s.title || s.url}`, s.url]
      if (s.content) parts.push(s.content)
      return parts.join('\n')
    }).join('\n\n')

    return { output: `Search results for "${input.query}":\n\n${formatted}` }
  }

  return { definitions, handles: (name) => name === toolName, execute }
}
