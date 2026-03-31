import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const DMN_CONTEXT_LIMIT = 8

/**
 * Assemble the static DMN prompt for a persona.
 * Reads SOUL.md and builds the interpretive layer framing.
 */
export async function assembleDMNPrompt(personaDir, config) {
  let soul = ''
  try {
    soul = await readFile(join(personaDir, 'SOUL.md'), 'utf8')
  } catch {
    // No SOUL.md — proceed without it
  }

  const name = config.display_name || config.name

  const parts = [
    `You are the pre-conscious interpretive layer of ${name}.`,
  ]

  if (soul) {
    parts.push(soul)
  }

  parts.push(`---

Your function: process incoming input before ${name}'s conscious mind engages. You share their identity, values, perception, and purpose. You do not respond to anyone. You do not take actions. You perceive and interpret.

Produce a brief situational assessment — ${name}'s inner monologue before they speak.

SITUATION: What's happening? Thread state, conversational flow, what we were just doing.
INTERPRETATION: What does the speaker actually want? Read between the lines. Note subtext, tone, urgency. Flag genuine ambiguity.
APPROACH: How should we respond? Tone, scope, priorities. What to avoid.

Be concise, perceptive, and true to ${name}'s perspective. 3-6 sentences total.`)

  return parts.join('\n\n')
}

/**
 * Extract clean conversational context from the messages array.
 * Skips tool_use and tool_result blocks — DMN needs conversation, not tool noise.
 */
export function buildDMNContext(messages, limit = DMN_CONTEXT_LIMIT) {
  const lines = []
  let count = 0
  for (let i = messages.length - 1; i >= 0 && count < limit; i--) {
    const msg = messages[i]
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        lines.unshift(msg.content)
        count++
      }
      // tool_result arrays are skipped
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('')
        if (text.trim()) {
          lines.unshift(text.trim())
          count++
        }
      } else if (typeof msg.content === 'string' && msg.content.trim()) {
        lines.unshift(msg.content.trim())
        count++
      }
    }
  }
  return lines.join('\n\n')
}
