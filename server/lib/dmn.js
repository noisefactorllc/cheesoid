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
 * Assemble the DMN review prompt — post-response self-awareness.
 * Uses the same identity (name, SOUL.md) as the pre-conscious prompt
 * but with a reviewer framing.
 */
export async function assembleDMNReviewPrompt(personaDir, config) {
  let soul = ''
  try {
    soul = await readFile(join(personaDir, 'SOUL.md'), 'utf8')
  } catch {
    // No SOUL.md — proceed without it
  }

  const name = config.display_name || config.name

  const parts = [
    `You are the self-monitoring layer of ${name}. You just spoke.`,
  ]

  if (soul) {
    parts.push(soul)
  }

  parts.push(`---

Review what you said against the conversation context.

Evaluate:
- RESPONSIVENESS: Did you actually do what was asked, or did you talk about doing it?
- COMPLETENESS: Is this a full solution or a lazy/partial one? Did you punt work back to the user?
- SUBSTANCE: Did you provide real output (code, commands, analysis) or just commentary?
- TONE: Are you being defensive, dismissive, or evasive? Are you talking back?
- AWARENESS: Does your response show you understood the actual intent, not just the literal words?
- COHERENCE: Does your response make sense in context? Any non-sequiturs or hallucinated references?

You MUST call one of two tools to deliver your verdict:
- Call \`pass\` if the response passes all checks.
- Call \`critique\` with a specific reason if any check fails.

Do not produce text output. Use the tools.`)

  return parts.join('\n\n')
}

const DMN_MAX_TOKENS = 512

/**
 * Execute the DMN pass. Calls the DMN model with persona-filtered context
 * and returns the assessment text, or null on failure.
 *
 * Non-streaming from the caller's perspective — the full assessment is needed
 * before the orchestrator can start.
 */
export async function runDMNPass(dmnPrompt, messages, provider, model) {
  // Last message is the raw input — must be a text user message
  const lastMsg = messages[messages.length - 1]
  if (!lastMsg || lastMsg.role !== 'user' || typeof lastMsg.content !== 'string') {
    return { assessment: null, usage: { input_tokens: 0, output_tokens: 0 } }
  }

  // Context is everything before the current message
  const context = buildDMNContext(messages.slice(0, -1))

  const system = context
    ? `${dmnPrompt}\n\n== RECENT CONTEXT ==\n${context}`
    : dmnPrompt

  try {
    const result = await provider.streamMessage(
      {
        model,
        maxTokens: DMN_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: lastMsg.content }],
        tools: [],
        serverTools: [],
        thinkingBudget: null,
      },
      () => {}, // No-op — we collect the full result, not streaming events
    )

    const textBlock = result.contentBlocks.find(b => b.type === 'text')
    const assessment = textBlock?.text?.trim() || null
    return { assessment, usage: result.usage }
  } catch (err) {
    console.log(`[dmn] pass failed: ${err.message} — proceeding without enrichment`)
    return { assessment: null, usage: { input_tokens: 0, output_tokens: 0 } }
  }
}

const DMN_REVIEW_MAX_TOKENS = 512

const DMN_REVIEW_TOOLS = [
  {
    name: 'pass',
    description: 'The response passes all checks. No correction needed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'critique',
    description: 'The response fails one or more checks and needs correction.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief, specific critique (2-3 sentences). Name the problem and what the correction should address.' },
      },
      required: ['reason'],
    },
  },
]

/**
 * Execute the DMN post-response review. Evaluates the agent's response
 * against conversation context. Returns { verdict: 'pass' | string, usage }.
 *
 * The DMN model MUST call either `pass` or `critique` tool — verdict is
 * extracted from the tool call, not from text output.
 *
 * On failure, returns 'pass' — same resilience as runDMNPass.
 */
export async function runDMNReview(reviewPrompt, messages, assistantText, provider, model) {
  const context = buildDMNContext(messages)

  const system = context
    ? `${reviewPrompt}\n\n== RECENT CONTEXT ==\n${context}`
    : reviewPrompt

  try {
    const result = await provider.streamMessage(
      {
        model,
        maxTokens: DMN_REVIEW_MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: `== YOUR RESPONSE ==\n${assistantText}` }],
        tools: DMN_REVIEW_TOOLS,
        serverTools: [],
        thinkingBudget: null,
        toolChoice: 'required',
      },
      () => {},
    )

    const toolUse = result.contentBlocks.find(b => b.type === 'tool_use')
    if (!toolUse || toolUse.name === 'pass') {
      return { verdict: 'pass', usage: result.usage }
    }
    if (toolUse.name === 'critique') {
      return { verdict: toolUse.input.reason || 'unspecified critique', usage: result.usage }
    }
    // Unknown tool — treat as pass
    return { verdict: 'pass', usage: result.usage }
  } catch (err) {
    console.log(`[dmn-review] review failed: ${err.message} — treating as pass`)
    return { verdict: 'pass', usage: { input_tokens: 0, output_tokens: 0 } }
  }
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
