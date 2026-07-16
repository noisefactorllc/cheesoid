import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { loadPlugins } from './plugins.js'
import { resolveModel } from './providers/resolve.js'

// persona.yaml keys accepted here for operator readability but not read by any
// code path in server/ (grep-verified) — false-confidence guardrails that look
// enforced but aren't. `path` is the dotted lookup into the parsed config.
const DECORATIVE_CONFIG_KEYS = [
  { path: ['max_budget_usd'], label: 'max_budget_usd' },
  { path: ['chat', 'idle_timeout_minutes'], label: 'chat.idle_timeout_minutes' },
]

function warnDecorativeKeys(config) {
  const name = config.name || 'unknown'
  for (const { path, label } of DECORATIVE_CONFIG_KEYS) {
    const value = path.reduce((obj, key) => obj?.[key], config)
    if (value !== undefined) {
      console.log(`[${name}] WARN: ${label} is set but not enforced by the framework`)
    }
  }
}

// Tier config key -> the name operators use for it in persona.yaml.
// normalizeTierLists() folds `execution` into `model`, so map it back.
const TIER_LABELS = [
  ['attention', 'attention'],
  ['cognition', 'cognition'],
  ['reasoner', 'reasoner'],
  ['model', 'execution'],
]

/**
 * Whether a provider forwards chat.thinking_budget to its backend.
 * anthropic and gemini honor it natively. openai-compat can, but only against a
 * backend that understands OpenRouter-style `reasoning.max_tokens` — so it must
 * opt in. openai-responses cannot: OpenAI's reasoning param takes an effort
 * level, not a token budget.
 */
function providerHonorsThinkingBudget(providerName, config) {
  if (providerName === 'anthropic') return true
  const providerConfig = config.providers?.[providerName]
  if (!providerConfig) return false
  const type = providerConfig.type || 'openai-compat'
  if (type === 'anthropic' || type === 'gemini') return true
  if (type === 'openai-compat') return providerConfig.supports_reasoning_budget === true
  return false
}

/**
 * Resolve each tier's active model to the provider name that will serve it.
 * @returns {Map<string, string[]>} provider name -> tier labels it serves
 */
function providersByTier(config) {
  const knownProviders = new Set([...Object.keys(config.providers || {}), 'anthropic'])
  const defaultProvider = config.provider && config.provider !== 'anthropic' ? config.provider : 'anthropic'
  const byProvider = new Map()
  for (const [key, label] of TIER_LABELS) {
    const activeModel = config[key]?.[0]
    if (!activeModel) continue
    const { providerName } = resolveModel(activeModel, knownProviders)
    const resolved = providerName || defaultProvider
    if (!byProvider.has(resolved)) byProvider.set(resolved, [])
    byProvider.get(resolved).push(label)
  }
  return byProvider
}

/**
 * Only the anthropic provider implements native server_tools; openai-compat
 * endpoints drop them. web-search.js can fill the gap via OpenRouter's plugin,
 * but only for a provider that opts in with `web_search`. Declaring the tool
 * without either of those means the model never gets it — silently.
 */
function warnUnsuppliedWebSearch(config) {
  const declared = (config.server_tools || []).find(
    t => String(t.type || '').startsWith('web_search') || t.name === 'web_search',
  )
  if (!declared) return
  if (Object.values(config.providers || {}).some(p => p.web_search)) return

  const name = config.name || 'unknown'
  const dropped = [...providersByTier(config).keys()].filter(p => p !== 'anthropic')
  if (!dropped.length) return // every tier is native anthropic — server_tools work

  console.log(
    `[${name}] WARN: server_tools declares web_search but no provider supplies it, and ` +
    `${dropped.map(p => `"${p}"`).join(', ')} cannot serve it natively — the model gets no web search. ` +
    `Set web_search: true on an openai-compat provider to back it with OpenRouter's web plugin`,
  )
}

/**
 * chat.thinking_budget is documented as an extended-thinking token budget, but
 * whether it reaches the backend depends on which provider serves each tier.
 * Warn per-provider rather than letting a tier silently reason unbounded.
 */
function warnUnhonoredThinkingBudget(config) {
  const budget = config.chat?.thinking_budget
  if (!budget) return

  const name = config.name || 'unknown'
  const offenders = [...providersByTier(config)]
    .filter(([providerName]) => !providerHonorsThinkingBudget(providerName, config))

  for (const [providerName, tiers] of offenders) {
    const type = providerName === 'anthropic'
      ? 'anthropic'
      : (config.providers?.[providerName]?.type || 'openai-compat')
    const hint = type === 'openai-compat'
      ? ' — set supports_reasoning_budget: true on it if the backend accepts reasoning.max_tokens'
      : ''
    console.log(
      `[${name}] WARN: chat.thinking_budget is set but provider "${providerName}" (${type}) drops it, ` +
      `so these tiers reason unbounded: ${tiers.join(', ')}${hint}`,
    )
  }
}

export async function loadPersona(personaDir) {
  const configPath = join(personaDir, 'persona.yaml')
  let raw
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (err) {
    throw new Error(`Could not read persona.yaml at ${configPath}: ${err.message}`)
  }

  const config = loadYaml(raw)
  resolveEnvVars(config)
  normalizeTierLists(config)
  warnDecorativeKeys(config)
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

  warnUnhonoredThinkingBudget(config)
  warnUnsuppliedWebSearch(config)

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
