import { createAnthropicProvider } from './anthropic.js'
import { createOpenAICompatProvider } from './openai-compat.js'

export { ProviderRegistry } from './registry.js'
export { resolveModel } from './resolve.js'

/**
 * Legacy provider factory — still works for direct provider creation.
 * New code should use ProviderRegistry instead.
 */
export function getProvider(personaConfig) {
  const providerType = personaConfig.provider || 'anthropic'

  switch (providerType) {
    case 'anthropic':
      return createAnthropicProvider(personaConfig)
    case 'openai-compat':
      return createOpenAICompatProvider(personaConfig)
    default:
      throw new Error(`Unknown provider: ${providerType}`)
  }
}
