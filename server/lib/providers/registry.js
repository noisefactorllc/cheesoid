import { createAnthropicProvider } from './anthropic.js'
import { createOpenAICompatProvider } from './openai-compat.js'
import { createOpenAIResponsesProvider } from './openai-responses.js'
import { resolveModel } from './resolve.js'

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
        const orchName = `_orchestrator_openai_compat`
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
      } else if (type === 'openai-compat') {
        provider = createOpenAICompatProvider(config)
      } else if (type === 'openai-responses') {
        provider = createOpenAIResponsesProvider(config)
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
    const { modelId, providerName } = resolveModel(modelString)
    const name = providerName || this._defaultName
    return { modelId, provider: this.get(name) }
  }
}
