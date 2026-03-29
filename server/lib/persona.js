import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { loadPlugins } from './plugins.js'

export async function loadPersona(personaDir) {
  const configPath = join(personaDir, 'persona.yaml')
  let raw
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (err) {
    throw new Error(`Could not read persona.yaml at ${configPath}: ${err.message}`)
  }

  const config = yaml.load(raw)
  resolveEnvVars(config)
  validateProviders(config)

  // Validate and degrade gracefully for openai-compat
  if (config.provider === 'openai-compat') {
    validateOpenAICompat(config)
  }

  if (config.orchestrator) {
    validateOrchestrator(config)
  }

  if (config.cognition || config.attention) {
    validateModality(config)
  }

  if (config.reasoner) {
    validateReasoner(config)
  }

  const plugins = await loadPlugins(config.plugins || [])
  return { dir: personaDir, config, plugins }
}

/**
 * Validate persona config for openai-compat provider.
 * Warns about unsupported features and sets approximation flags.
 */
function validateProviders(config) {
  if (!config.providers) return

  const name = config.name || 'unknown'
  for (const [providerName, providerConfig] of Object.entries(config.providers)) {
    const type = providerConfig.type || 'openai-compat'
    if (type === 'openai-compat') {
      if (!providerConfig.base_url) {
        throw new Error(`[${name}] provider "${providerName}" requires base_url`)
      }
      if (!providerConfig.api_key) {
        throw new Error(`[${name}] provider "${providerName}" requires api_key`)
      }
    }
    console.log(`[${name}] Registered provider: ${providerName} (${type})`)
  }
}

function validateOpenAICompat(config) {
  // Skip legacy validation if using new providers block
  if (config.providers) return

  const name = config.name || 'unknown'
  config._degradationNotices = []

  // thinking_budget: approximate via prompt
  if (config.chat?.thinking_budget) {
    console.log(`[${name}] WARN: thinking_budget (${config.chat.thinking_budget}) approximated via prompt — native thinking not available with openai-compat`)
    config._approximateThinking = true
  }

  // server_tools: not available
  if (config.server_tools && config.server_tools.length > 0) {
    for (const tool of config.server_tools) {
      const toolName = tool.name || tool.type || 'unknown'
      console.log(`[${name}] WARN: server_tool ${toolName} not available with openai-compat — added notice to prompt`)
      config._degradationNotices.push(`- ${toolName} is not available with your current provider. Do not attempt to use it.`)
    }
  }
}

function validateOrchestrator(config) {
  const name = config.name || 'unknown'
  const orch = config.orchestrator

  // New style: orchestrator is a model string like "claude-sonnet-4-6:anthropic"
  if (typeof orch === 'string') {
    const fallbacks = config.orchestrator_fallback_models || []
    console.log(`[${name}] Hybrid mode: orchestrator=${orch}, executor=${config.model}${fallbacks.length ? `, orchestrator_fallbacks=${fallbacks.join(',')}` : ''}`)
    return
  }

  if (!orch.provider) {
    orch.provider = 'anthropic'
  }

  if (orch.provider === 'openai-compat') {
    if (!orch.base_url) {
      throw new Error(`[${name}] orchestrator with openai-compat requires base_url`)
    }
    if (!orch.api_key) {
      throw new Error(`[${name}] orchestrator with openai-compat requires api_key`)
    }
  }

  console.log(`[${name}] Hybrid mode: orchestrator=${orch.provider}/${orch.model}, executor=${config.provider || 'anthropic'}/${config.model}`)
}

function validateModality(config) {
  const name = config.name || 'unknown'

  if (config.cognition && !config.attention) {
    throw new Error(`[${name}] cognition requires attention — both must be set for modal operation`)
  }
  if (config.attention && !config.cognition) {
    throw new Error(`[${name}] attention requires cognition — both must be set for modal operation`)
  }
  if (config.orchestrator) {
    throw new Error(`[${name}] cannot use both orchestrator and cognition/attention — modal mode replaces orchestrator`)
  }

  const fallbacks = config.cognition_fallback_models || []
  console.log(`[${name}] Modal mode: cognition=${config.cognition}, attention=${config.attention}, executor=${config.model}${fallbacks.length ? `, cognition_fallbacks=${fallbacks.join(',')}` : ''}`)
}

function validateReasoner(config) {
  const name = config.name || 'unknown'
  const fallbacks = config.reasoner_fallback_models || []
  console.log(`[${name}] Reasoner: model=${config.reasoner}${fallbacks.length ? `, fallbacks=${fallbacks.join(',')}` : ''}`)
}

function resolveEnvVars(obj) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') {
        obj[i] = substituteEnv(obj[i])
      } else if (typeof obj[i] === 'object' && obj[i] !== null) {
        resolveEnvVars(obj[i])
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        obj[key] = substituteEnv(obj[key])
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        resolveEnvVars(obj[key])
      }
    }
  }
}

function substituteEnv(str) {
  return str.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '')
}
