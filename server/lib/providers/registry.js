import { createAnthropicProvider } from './anthropic.js'
import { createOpenAICompatProvider } from './openai-compat.js'
import { createOpenAIResponsesProvider } from './openai-responses.js'
import { createGeminiProvider } from './gemini.js'
import { resolveModel } from './resolve.js'

// Standing operator policy: no x-ai / grok model, ever. Enforced HARD here
// because resolve() is the one chokepoint every model id — persona tiers,
// model_policy.allow, subagent overrides — must pass through. Matched after
// the provider suffix is split off, so both "x-ai/grok:openrouter" and a bare
// "x-ai/grok" are refused.
const BANNED_MODEL_PATTERN = /^x-ai\//i

/**
 * Build the openai-compat config for a `type: openrouter` provider: OpenRouter
 * defaults (fixed base_url, env api-key fallback, reasoning + web plugin on)
 * merged with the persona's own settings. A persona-supplied base_url is
 * HONORED — e.g. an OpenRouter-compatible proxy — rather than silently forced
 * back to openrouter.ai. Exported for testing the merge precedence.
 */
export function _openrouterCompatConfig(config) {
  return {
    supports_reasoning_budget: true,
    web_search: true,
    ...config,
    type: 'openai-compat',
    base_url: config.base_url || 'https://openrouter.ai/api/v1',
    api_key: config.api_key || process.env.OPENROUTER_API_KEY,
  }
}

/**
 * Registry of named provider configs with lazy instantiation.
 *
 * Supports:
 * - New-style: `providers` block in persona config maps names to configs
 * - Legacy: top-level `provider`/`base_url`/`api_key` creates implicit default
 * - `anthropic` is always available without declaration
 */
export class ProviderRegistry {
  constructor(personaConfig) {
    this._configs = new Map()
    this._instances = new Map()
    this._defaultName = 'anthropic'

    // Register explicit providers block
    if (personaConfig.providers) {
      for (const [name, config] of Object.entries(personaConfig.providers)) {
        this._configs.set(name, config)
      }
    }

    // Auto-register an `openrouter` provider when the key is in the
    // environment and the persona didn't define its own. This is what lets a
    // zero-config persona run on the model-policy defaults with nothing but
    // OPENROUTER_API_KEY set.
    if (!this._configs.has('openrouter') && process.env.OPENROUTER_API_KEY) {
      this._configs.set('openrouter', { type: 'openrouter' })
    }

    // Register legacy top-level provider as default
    if (personaConfig.provider && personaConfig.provider !== 'anthropic') {
      const legacyConfig = {
        type: personaConfig.provider,
        base_url: personaConfig.base_url,
        api_key: personaConfig.api_key,
      }
      // Use provider type as name if not already taken
      const legacyName = personaConfig.provider
      if (!this._configs.has(legacyName)) {
        this._configs.set(legacyName, legacyConfig)
      }
      this._defaultName = legacyName
    }

    // Register legacy orchestrator if it has inline provider config
    if (personaConfig.orchestrator && typeof personaConfig.orchestrator === 'object') {
      const orch = personaConfig.orchestrator
      if (orch.provider === 'openai-compat' && orch.base_url) {
        const orchName = `_orchestratorOpenaiCompat`
        if (!this._configs.has(orchName)) {
          this._configs.set(orchName, {
            type: 'openai-compat',
            base_url: orch.base_url,
            api_key: orch.api_key,
          })
        }
      }
    }
  }

  /**
   * Get or create a provider instance by name.
   * `anthropic` is always available. Named providers come from the registry.
   */
  get(name) {
    if (this._instances.has(name)) {
      return this._instances.get(name)
    }

    let provider
    if (name === 'anthropic') {
      provider = createAnthropicProvider({})
    } else if (this._configs.has(name)) {
      const config = this._configs.get(name)
      const type = config.type || 'openai-compat'
      if (type === 'anthropic') {
        provider = createAnthropicProvider(config)
      } else if (type === 'openrouter') {
        // openai-compat preconfigured for OpenRouter: base_url defaults to the
        // OpenRouter endpoint but honors a persona override, the key falls back
        // to the environment, and capabilities OpenRouter actually supports —
        // reasoning.max_tokens, the web plugin — default on instead of silently
        // dropping (the trap that ate thinking_budget for every openai-compat
        // OpenRouter deployment).
        provider = createOpenAICompatProvider(_openrouterCompatConfig(config))
      } else if (type === 'openai-compat') {
        provider = createOpenAICompatProvider(config)
      } else if (type === 'openai-responses') {
        provider = createOpenAIResponsesProvider(config)
      } else if (type === 'gemini') {
        provider = createGeminiProvider(config)
      } else {
        throw new Error(`Unknown provider type "${type}" for provider "${name}"`)
      }
    } else {
      throw new Error(`Unknown provider "${name}". Available: anthropic, ${[...this._configs.keys()].join(', ')}`)
    }

    this._instances.set(name, provider)
    return provider
  }

  /**
   * Resolve a model string to { modelId, provider }.
   * Uses resolveModel() for parsing, then looks up the provider.
   */
  resolve(modelString) {
    const knownProviders = new Set([...this._configs.keys(), 'anthropic'])
    const { modelId, providerName } = resolveModel(modelString, knownProviders)
    if (BANNED_MODEL_PATTERN.test(modelId)) {
      throw new Error(
        `Refusing to resolve "${modelString}": x-ai / grok models are banned by standing operator policy.`,
      )
    }
    const name = providerName || this._defaultName
    return { modelId, provider: this.get(name) }
  }
}
