/**
 * Model policy — evaluated tier defaults over OpenRouter.
 *
 * Defaults chosen by live evaluation (2026-07-27) of 21 tool-capable models
 * across four suites: agentic tool-loop fidelity (simulated environment),
 * strict-JSON routing, planted-fact compaction, and interactive latency,
 * plus a speech-transcription suite. Method, data, and rationale live in
 * docs/models.md. Re-run guidance is there too — these picks are a snapshot
 * of a moving market, not doctrine.
 *
 * The policy fills tiers a persona left empty. It never overrides an
 * explicit persona tier, so existing deployments load byte-identical.
 */

// Element 0 is the active model, the rest are the fallback chain —
// same convention as persona tier lists.
//
// Primaries for attention/cognition/reasoner/executor are operator-directed
// (2026-07-27): inkling for cognition, kimi for reasoner, mimo for executor,
// gemma for attention. Eval numbers for every entry are in docs/models.md.
// x-ai models are excluded as a standing operator policy — do not add them.
export const TIER_DEFAULTS = {
  // Ambient monitoring, delegation checks, lane routing. 18/18 agentic,
  // 9/12 router with clean JSON, 114ms median, $0.14/M in.
  attention: [
    'google/gemma-4-31b-it:openrouter',
    'xiaomi/mimo-v2.5:openrouter',
    'deepseek/deepseek-v4-flash:openrouter',
  ],
  // Engaged reasoning and the main tool loop. 18/18 agentic in 2.3s,
  // 174ms median latency, 1M context, text+image+audio input, $1/$4.05.
  cognition: [
    'thinkingmachines/inkling:openrouter',
    'anthropic/claude-sonnet-5:openrouter',
    'openai/gpt-5.6-terra:openrouter',
  ],
  // Escalation for genuinely hard problems.
  reasoner: [
    'moonshotai/kimi-k3:openrouter',
    'anthropic/claude-opus-5:openrouter',
    'openai/gpt-5.6-sol:openrouter',
  ],
  // Executor: tool-chain follow-through. Perfect agentic score, vision
  // input for media-bearing turns, $0.14/M in.
  model: [
    'xiaomi/mimo-v2.5:openrouter',
    'nvidia/nemotron-3-super-120b-a12b:openrouter',
    'z-ai/glm-4.7-flash:openrouter',
  ],
  // Sleep-cycle reflection and digest writing. 1M context, near-free.
  reflection: [
    'deepseek/deepseek-v4-flash:openrouter',
    'xiaomi/mimo-v2.5:openrouter',
    'qwen/qwen3.6-flash:openrouter',
  ],
  // Voice transcription. Best proper-noun fidelity of the cheap
  // audio-input models; $0.0001-0.0002 per utterance.
  transcription: [
    'google/gemini-3.5-flash-lite:openrouter',
    'openai/gpt-audio-mini:openrouter',
  ],
  // Default subagent worker.
  subagent: [
    'xiaomi/mimo-v2.5:openrouter',
    'deepseek/deepseek-v4-flash:openrouter',
    'anthropic/claude-haiku-4.5:openrouter',
  ],
}

const CORE_TIERS = ['model', 'attention', 'cognition', 'reasoner']
const EXTENDED_TIERS = ['reflection', 'transcription', 'subagent']

/**
 * Fill empty tiers from policy defaults.
 *
 * - `model_policy: none` disables all filling.
 * - Core tiers (attention/cognition/reasoner/model) are filled only when the
 *   persona configured NO models at all — the zero-config case. A persona
 *   with any explicit model keeps exactly the loop behavior it configured.
 * - Extended tiers (reflection/transcription/subagent) are new; they fill
 *   whenever absent so new harness features work without config changes.
 * - Filling requires an OpenRouter key (defaults are :openrouter models).
 *
 * @param {object} config parsed persona config, after normalizeTierLists
 * @param {object} [opts]
 * @param {boolean} [opts.hasOpenRouter] override env detection (tests)
 * @returns {string[]} names of tiers that were filled
 */
export function applyModelPolicy(config, opts = {}) {
  if (config.model_policy === 'none') return []
  const hasOpenRouter = opts.hasOpenRouter ?? Boolean(process.env.OPENROUTER_API_KEY)

  const policy = (typeof config.model_policy === 'object' && config.model_policy !== null)
    ? config.model_policy
    : {}
  const explicitDefaults = config.model_policy === 'default'
  const filled = []

  // Whether the persona configured any loop model itself — measured before
  // model_policy overrides, so overriding one tier through the policy still
  // means "fill the rest from defaults" rather than "manual mode".
  const coreAbsent = CORE_TIERS.every(t => !config[t]) && !config.orchestrator

  const applyOverrides = () => {
    for (const tier of [...CORE_TIERS, ...EXTENDED_TIERS]) {
      const key = tier === 'model' ? 'executor' : tier
      const override = policy[key] ?? (tier === 'model' ? policy.model : undefined)
      if (override !== undefined) {
        config[tier] = Array.isArray(override) ? [...override] : [override]
      }
    }
  }

  if (!hasOpenRouter) {
    applyOverrides()
    if (coreAbsent && CORE_TIERS.every(t => !config[t])) {
      console.log(
        `[${config.name || 'unknown'}] WARN: no models configured and no OPENROUTER_API_KEY — ` +
        `set one or configure tiers in persona.yaml`,
      )
    }
    return filled
  }

  if (coreAbsent) {
    for (const tier of CORE_TIERS) {
      config[tier] = [...TIER_DEFAULTS[tier]]
      filled.push(tier === 'model' ? 'executor' : tier)
    }
  }

  if (coreAbsent || explicitDefaults) {
    for (const tier of EXTENDED_TIERS) {
      if (!config[tier]) {
        config[tier] = [...TIER_DEFAULTS[tier]]
        filled.push(tier)
      }
    }
  }

  applyOverrides()

  if (filled.length) {
    config._modelPolicy = { filled, source: 'eval-2026-07-27', defaultsEnabled: true }
    console.log(`[${config.name || 'unknown'}] Model policy filled tiers: ${filled.join(', ')}`)
  }
  return filled
}

export function shouldEnableSleep(config) {
  if (config.sleep === false) return false
  if (Object.prototype.hasOwnProperty.call(config, 'sleep')) return true
  return config._modelPolicy?.defaultsEnabled === true
}

/**
 * Resolve the model chain for an extended-tier feature, falling back through
 * sensible existing tiers so features degrade instead of crashing when a
 * persona opted out of the policy.
 */
export function tierChain(config, tier) {
  switch (tier) {
    case 'reflection':
      return config.reflection || config.attention || config.model || config.cognition || null
    case 'transcription':
      return config.transcription || null
    case 'subagent':
      return config.subagent || config.model || config.attention || null
    default:
      return config[tier] || null
  }
}
