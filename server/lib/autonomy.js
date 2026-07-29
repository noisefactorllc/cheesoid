/**
 * Autonomy gate — how much initiative the agent may take on turns nobody
 * asked for (idle thoughts, sleep cycles, scheduled wakeups).
 *
 * User-originated turns are never gated: if a person asked, the agent may
 * act. The gate only applies to self-directed activity, and the prompt
 * doctrine tells the agent what its level permits so refusals are rare
 * rather than mysterious.
 */

export const AUTONOMY_LEVELS = ['low', 'medium', 'high']

// Tools that represent the agent acting on its own initiative. Anything not
// listed is always allowed (memory, wiki, search, state — upkeep is a duty,
// not a liberty).
const GATED = {
  // medium+: the agent may run background work and manage its own calendar,
  // and may speak unprompted. "Speaking" covers every way the agent puts words
  // in front of others on its own initiative — a plain message, a reply that
  // revives a thread, a reaction, or an `internal` backchannel that wakes a
  // peer. All are held to the same bar as send_chat_message.
  task_start: 'medium',
  spawn_subagent: 'medium',
  schedule_create: 'medium',
  send_chat_message: 'medium',
  reply_to_message: 'medium',
  react_to_message: 'medium',
  internal: 'medium',
  shell: 'medium',
  // high only: changing the active model is the deepest self-directed control
  // still exposed to the agent, and fetch_url is an unbounded data-exfiltration
  // channel (the network policy filters destinations, not payload) that would
  // otherwise run on self-directed turns with no human present. Network
  // topology is human-only.
  fetch_url: 'high',
  set_model: 'high',
}

export function createAutonomy(config) {
  const level = AUTONOMY_LEVELS.includes(config.autonomy) ? config.autonomy : 'medium'
  const rank = AUTONOMY_LEVELS.indexOf(level)

  return {
    level,
    /**
     * @param {string} toolName
     * @param {string} origin 'user' | 'idle' | 'wakeup' | 'sleep' | 'task' | 'webhook'
     * @returns {{ allowed: boolean, reason?: string }}
     */
    gate(toolName, origin) {
      const required = GATED[toolName]
      if (!required) return { allowed: true }
      // A person (or an external system a person pointed at us) is driving.
      if (origin === 'user' || origin === 'webhook') return { allowed: true }
      if (rank >= AUTONOMY_LEVELS.indexOf(required)) return { allowed: true }
      return {
        allowed: false,
        reason: `autonomy level "${level}" does not permit ${toolName} on a self-directed turn ` +
          `(requires "${required}"). Note it in memory and raise it with your operator instead.`,
      }
    },
    describe() {
      const lines = [`Your autonomy level is "${level}".`]
      if (rank >= 1) {
        lines.push('On self-directed turns (idle, sleep, scheduled) you may start background tasks, spawn subagents, manage your schedules, and speak on your own initiative — a message, a reply, a reaction, or a backchannel — when you have something worth saying.')
      } else {
        lines.push('On self-directed turns, observe and maintain memory only; do not start work, and do not send messages, replies, or reactions unprompted.')
      }
      if (rank >= 2) {
        lines.push('You may also adjust your own model within the allowed list — your judgment is trusted.')
      }
      return lines.join(' ')
    },
  }
}
