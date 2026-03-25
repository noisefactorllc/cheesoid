import { createAnthropicProvider } from './anthropic.js'
import { createOpenAICompatProvider } from './openai-compat.js'

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
