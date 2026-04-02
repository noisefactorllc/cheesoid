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
  normalizeTierLists(config)
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
    console.log(`[${name}] Hybrid mode: orchestrator=${orch}, executor=${config.model?.[0]}`)
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

  console.log(`[${name}] Hybrid mode: orchestrator=${orch.provider}/${orch.model}, executor=${config.provider || 'anthropic'}/${config.model?.[0]}`)
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

  const cog = config.cognition[0]
  const att = config.attention[0]
  const exec = config.model?.[0]
  const cogFallbacks = config.cognition.slice(1)
  console.log(`[${name}] Modal mode: cognition=${cog}, attention=${att}, executor=${exec}${cogFallbacks.length ? `, cognition_fallbacks=${cogFallbacks.join(',')}` : ''}`)
}

function validateReasoner(config) {
  const name = config.name || 'unknown'
  const fallbacks = config.reasoner.slice(1)
  console.log(`[${name}] Reasoner: model=${config.reasoner[0]}${fallbacks.length ? `, fallbacks=${fallbacks.join(',')}` : ''}`)
}

/**
 * Normalize tier config fields to arrays.
 * Accepts string or array for each tier. Merges in any legacy
 * _fallback_models fields, then removes them.
 */
function normalizeTierLists(config) {
  const normalize = (primary, fallbacks) => {
    const list = Array.isArray(primary) ? [...primary] : (primary ? [primary] : [])
    if (Array.isArray(fallbacks)) list.push(...fallbacks)
    return list.length ? list : undefined
  }

  config.model = normalize(config.execution || config.model, config.fallback_models)
  config.cognition = normalize(config.cognition, config.cognition_fallback_models)
  config.attention = normalize(config.attention)
  config.reasoner = normalize(config.reasoner, config.reasoner_fallback_models)

  // Remove legacy fallback fields
  delete config.fallback_models
  delete config.cognition_fallback_models
  delete config.reasoner_fallback_models
  delete config.orchestrator_fallback_models
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
