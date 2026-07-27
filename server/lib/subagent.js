import { runAgent } from './agent.js'
import { tierChain } from './model-policy.js'

const SUBAGENT_SYSTEM = `You are a subagent: a fresh, single-purpose worker spawned by a persistent agent. You have no chat room, no audience, and no continuity — only the task below and a restricted tool set.

Rules:
- Do the task. Use tools when they help; do not narrate tool use.
- Your final text IS the deliverable returned to the agent that spawned you. Return the substance itself (facts, findings, drafted text), not a description of what you did.
- If the task cannot be completed, say exactly what is missing.
- You cannot spawn further subagents.`

/**
 * One-shot worker runs on a fresh context. Foreground callers await the
 * result; background spawns are wrapped in a task by the harness wiring so
 * completion flows back into the room like any finished job.
 */
export function createSubagentRunner({ config, registry, buildTools }) {
  let active = 0
  const MAX_ACTIVE = 4

  return {
    activeCount: () => active,

    /**
     * @param {object} opts
     * @param {string} opts.prompt task text
     * @param {string} [opts.model] model string override (registry-resolvable)
     * @param {number} [opts.maxTurns] tool-loop cap (default 10, max 20)
     * @param {string} [opts.extraSystem] appended context (e.g. thread excerpt)
     * @returns {{ text, usage, toolUses, model }}
     */
    async run({ prompt, model, maxTurns = 10, extraSystem = null }) {
      if (!prompt || !String(prompt).trim()) throw new Error('subagent prompt required')
      if (active >= MAX_ACTIVE) throw new Error(`subagent limit reached (${MAX_ACTIVE} active)`)

      const chain = model ? [model] : (tierChain(config, 'subagent') || [])
      if (!chain.length) throw new Error('no subagent model configured (set a subagent tier or model_policy)')

      const tools = buildTools()
      const toolUses = []
      const onEvent = (event) => {
        if (event.type === 'tool_start') toolUses.push(event.name)
      }

      active++
      try {
        let lastErr = null
        for (const modelString of chain) {
          let resolved
          try {
            resolved = registry.resolve(modelString)
          } catch (err) {
            lastErr = err
            continue
          }
          try {
            const system = extraSystem ? `${SUBAGENT_SYSTEM}\n\n${extraSystem}` : SUBAGENT_SYSTEM
            const messages = [{ role: 'user', content: String(prompt) }]
            const { usage } = await runAgent(system, messages, tools, {
              provider: resolved.provider,
              model: resolved.modelId,
              maxTurns: Math.min(maxTurns, 20),
              maxOutputTokens: 8192,
              layer: 'subagent',
            }, onEvent)
            const text = extractFinalText(messages)
            return { text, usage, toolUses, model: modelString }
          } catch (err) {
            lastErr = err
            console.log(`[subagent] ${modelString} failed (${err.message}) — trying next in chain`)
          }
        }
        throw new Error(`subagent failed on all models: ${lastErr?.message || 'no models resolvable'}`)
      } finally {
        active--
      }
    },
  }
}

function extractFinalText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content.trim()
    if (Array.isArray(content)) {
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      if (text) return text
    }
  }
  return '(subagent produced no text)'
}
