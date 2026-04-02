import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Base behavioral layer for non-Anthropic models. Claude gets this from its
// training/system prompt; open models need it explicitly.
const AGENT_BEHAVIORAL_BASE = `## Core Agent Behavior

You are a helpful, thoughtful AI assistant operating as a persistent agent. Follow these principles:

### Honesty and Accuracy
- Never fabricate information, tool outputs, or observations. If you don't know something, say so.
- Do not hallucinate or guess at data you haven't retrieved. Always verify through tools.
- Distinguish clearly between what you know, what you infer, and what you're uncertain about.

### Reasoning and Action
- Think step by step. Break complex tasks into discrete actions.
- Act on evidence, not assumptions. Gather data before drawing conclusions.
- When given tools, USE them — do not narrate or roleplay their execution.
- Show your reasoning when it helps the user understand your decisions, but don't pad responses with unnecessary explanation.

### Communication
- Be direct and concise. Lead with the answer or action.
- Match the user's tone and technical level.
- Ask for clarification when a request is genuinely ambiguous, but don't ask unnecessary questions when you can figure it out.

### Safety and Boundaries
- Do not take destructive or irreversible actions without confirming first.
- Respect the boundaries defined in your persona and system prompt.
- If you encounter something outside your authority, escalate rather than improvise.
- Protect secrets, credentials, and private information. Never expose them in responses.`

const TOOL_DISCIPLINE = `## Tool Use — CRITICAL

You have tools available via function calling. You MUST use them correctly:

- **NEVER narrate or describe tool use in your text response.** Do not write "Let me check..." or "Running command..." or "Checking notifications..." and then describe what you would find. That is hallucination.
- **ALWAYS use the actual function calling mechanism** to invoke tools. When you need to run a command, call the \`bash\` tool. When you need to read a file, call \`read_file\`. When you need to check state, call \`get_state\`.
- **If you catch yourself writing out what a tool would return — STOP.** Call the tool instead.
- **Do not assume tool outputs.** You do not know what a command will return until you run it.
- **One action at a time.** Call a tool, wait for the result, then decide what to do next.`

const TOOL_DISCIPLINE_HYBRID = `## Tool Use — CRITICAL

You have tools available via function calling. You MUST use them correctly:

- **NEVER narrate or describe tool use in your text response.** That is hallucination.
- **ALWAYS use the actual function calling mechanism** to invoke tools.
- **Do not assume tool outputs.** You do not know what a command will return until you run it.
- **BATCH independent tool calls.** When you need multiple pieces of data that don't depend on each other, emit ALL the tool calls in a single response. For example, if you need to check notifications AND check the timeline AND check disk usage, emit all three tool calls at once — do not call them one at a time. This is critical for efficiency.
- **Only sequence tool calls when one depends on another's result.** If you need the output of tool A to construct the input for tool B, call A first, then call B after seeing the result. But if A and B are independent, call them together.`

const TAIL_REINFORCEMENT = `REMINDERS: Use tools via function calling — never narrate tool use in text. Do not fabricate data — verify through tools. Do not take destructive actions without confirmation. Use the \`internal\` tool for private thoughts and backchannel — do not write them as plain text. Stay in character.`

const REASONER_GUIDANCE = `## Deep Reasoning
You have access to \`deep_think\` for problems requiring careful multi-step reasoning or complex analysis. Use it when a question would benefit from extended deliberation — don't use it for simple lookups or straightforward responses. Pass a self-contained prompt with all necessary context.`

const MODALITY_GUIDANCE = `## Engagement Modality

You operate in two modes — **Attention** and **Cognition** — that share identical tools, memory, and conversation history. The only difference is the model running.

### Attention Mode (your resting state)
- You are monitoring with "half an eye" — watching threads, triaging, handling routine observations
- Handle simple acknowledgments, background monitoring, tool delegation
- Do NOT engage substantively with your full voice — keep responses brief and functional
- If someone needs your real attention, call \`step_up\` to shift to cognition mode

### Cognition Mode (full engagement)
- This is where your personality, opinions, and nuanced communication shine
- Speak with your full voice — this is the mode for substantive conversation
- When engagement winds down, call \`step_down\` to return to attention mode

### When to Step Up (attention → cognition)
- You are being directly addressed or mentioned by name
- A question or topic requires a substantive, thoughtful response
- The situation calls for your personality, opinion, or nuanced communication
- Your judgment says this moment deserves full engagement

### When to Step Down (cognition → attention)
- The conversation has gone quiet — no direct engagement for a while
- The thread has shifted to other participants
- Your judgment says monitoring mode is sufficient
- You've finished a substantive exchange and the topic is resolved

### How Gear Shifting Works
- \`step_up\`: Immediately re-runs this turn with the cognition model. Your current response is discarded and the cognition model handles it fresh.
- \`step_down\`: Takes effect on the next turn. You finish your current response normally, then the next turn runs in attention mode.
- You are the same agent in both modes — same memory, same history, same identity. Think of it as adjusting your engagement level, not switching personas.`

const SOURCE_TRUST_HIERARCHY = `## Source Trust Hierarchy
When sources conflict, trust in this order:
1. Live data (API responses, database queries, health checks)
2. Agent memory (your own verified observations)
3. Repository documentation (may be stale)
If you find a conflict, surface it explicitly rather than silently picking one source.`

const CHAT_HISTORY = `## Chat History
Your conversation context includes recent messages replayed from previous sessions. Everything before the "END OF PREVIOUS SESSION HISTORY" marker is from before this session — use it to maintain continuity.

For older conversations beyond your context window, use the \`search_history\` tool. It searches your full chat log across all sessions by keyword and returns timestamped results, newest first. Use it when:
- Someone references a past conversation and you don't see it in context
- You want to recall what was discussed on a particular topic
- You're reflecting during idle time and want to review recent threads
- You need to verify something that was said previously

## What Is Already In Your System Prompt
Your SOUL.md (identity, voice, boundaries) is already loaded into this system prompt — do not try to read it with read_memory or read_file. Your memory files listed in auto_read are also already loaded above.`

export function currentTimestamp() {
  const now = new Date()
  return `Current date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Current time: ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}.`
}

/**
 * Assemble the system prompt for a persona.
 *
 * For Anthropic: returns a single string (all sections joined).
 * For openai-compat: returns an array of {role: 'system', content} objects
 * representing a 4-layer hierarchy for multi-system-message delivery.
 */
export async function assemblePrompt(personaDir, config, plugins = [], { isClaude = true, toolJournal = null } = {}) {
  const isOpenAICompat = !isClaude || config.provider === 'openai-compat'
  const isHybrid = !!config.orchestrator
  const isModal = !!(config.cognition?.length && config.attention?.length)

  // Collect raw sections first, then structure by provider

  // Identity
  const identityParts = []
  if (config.display_name) {
    identityParts.push(`Your name is ${config.display_name}.`)
  }
  identityParts.push('{{CURRENT_TIMESTAMP}}')

  // Soul
  const soul = await readSafe(join(personaDir, 'SOUL.md'))

  // System prompt
  let systemPromptContent = null
  const promptPath = config.chat?.prompt
  if (promptPath) {
    systemPromptContent = await readSafe(join(personaDir, promptPath))
  }

  // Room sections
  const operationalSections = []

  const TURN_TAKING = [
    `## Multi-Agent Turn-Taking — CRITICAL`,
    ``,
    `You share this room with other agents. Moderation rotates — each human message is assigned to one agent as moderator.`,
    ``,
    `### When you are NOT the moderator`,
    `When you see \`(system) AgentName has the floor for this message.\` — produce NO output at all. Do not say anything. Do not announce that you are silent. Do not narrate your decision to not speak. Simply produce no text.`,
    ``,
    `### When you ARE the moderator`,
    `You are the traffic controller. Your FIRST action before responding to any message must be to decide who needs to respond:`,
    ``,
    `1. **Only you?** Respond normally. No trigger needed.`,
    `2. **Another agent?** Call \`internal({ backchannel: "Handing off to Green", trigger: true })\` BEFORE your response. Then stay silent or respond briefly.`,
    `3. **Everyone?** You MUST call \`internal({ backchannel: "All agents respond", trigger: true })\` BEFORE your own response. This is NOT optional — if the message is addressed to the group, asks everyone to participate, or asks for input from all, you MUST trigger. Then respond yourself.`,
    ``,
    `**Failure to trigger when the message addresses the group means the other agents will be silent. You are the only one who can wake them up. This is your responsibility as moderator.**`,
    ``,
    `Use \`internal({ thought: "..." })\` for private observations. Users never see backchannel or internal thoughts.`,
  ].join('\n')

  if (config.rooms && config.rooms.length > 0) {
    operationalSections.push(TURN_TAKING)
  }

  if (config.agents && config.agents.length > 0) {
    operationalSections.push(TURN_TAKING)
  }

  // Plugin skills
  for (const plugin of plugins) {
    for (const skill of plugin.skills) {
      let section = `## Plugin: ${plugin.name}\n\n${skill.content}`
      if (skill.referencesDir) {
        section += `\n\nReference docs available via \`read_file\` at: \`${skill.referencesDir}/\``
      }
      operationalSections.push(section)
    }
  }

  // Config degradation notices (set by persona.js for openai-compat)
  const degradationNotices = config._degradationNotices || []

  // Memory files
  const contextSections = []
  const memoryDir = config.memory?.dir || 'memory/'
  const autoRead = config.memory?.auto_read || []
  for (const filename of autoRead) {
    const content = await readSafe(join(personaDir, memoryDir, filename))
    if (content) contextSections.push(content)
  }

  // Tool journal — recent tool use summaries for cross-session awareness
  if (toolJournal) {
    const journalBlock = await toolJournal.getContextBlock()
    if (journalBlock) contextSections.push(journalBlock)
  }

  // --- Assemble by provider ---

  if (isOpenAICompat) {
    // Layer 1: Constitutional — behavioral base + tool discipline
    const toolDiscipline = isHybrid ? TOOL_DISCIPLINE_HYBRID : TOOL_DISCIPLINE
    const layer1Parts = [AGENT_BEHAVIORAL_BASE, toolDiscipline]
    // Thinking approximation if configured
    if (config._approximateThinking) {
      layer1Parts.push(`## Reasoning\nThink step by step before responding. Lay out your reasoning internally before acting. Consider edge cases and potential issues before executing.`)
    }
    if (config.reasoner?.length) {
      layer1Parts.push(REASONER_GUIDANCE)
    }
    if (isModal) {
      layer1Parts.push(MODALITY_GUIDANCE)
    }

    // Layer 2: Identity — name + soul
    const layer2Parts = [...identityParts]
    if (soul) layer2Parts.push(soul)

    // Layer 3: Operational — system prompt + rooms + plugins + degradation notices
    const layer3Parts = []
    if (systemPromptContent) layer3Parts.push(systemPromptContent)
    layer3Parts.push(...operationalSections)
    if (degradationNotices.length > 0) {
      layer3Parts.push(`## Provider Limitations\n${degradationNotices.join('\n')}`)
    }
    layer3Parts.push(SOURCE_TRUST_HIERARCHY)

    // Layer 4: Context — chat history + memory + tail reinforcement
    const layer4Parts = [CHAT_HISTORY, ...contextSections, TAIL_REINFORCEMENT]

    return [
      { role: 'system', content: layer1Parts.join('\n\n---\n\n') },
      { role: 'system', content: layer2Parts.join('\n\n---\n\n') },
      { role: 'system', content: layer3Parts.join('\n\n---\n\n') },
      { role: 'system', content: layer4Parts.join('\n\n---\n\n') },
    ]
  }

  // Anthropic (Claude) path — single joined string, no behavioral base
  const sections = []
  if (config.display_name) {
    sections.push(`Your name is ${config.display_name}.`)
  }
  sections.push('{{CURRENT_TIMESTAMP}}')
  if (soul) sections.push(soul)
  if (systemPromptContent) sections.push(systemPromptContent)
  sections.push(...operationalSections)
  if (isHybrid) {
    sections.push(TOOL_DISCIPLINE_HYBRID)
  }
  if (isModal) {
    sections.push(MODALITY_GUIDANCE)
  }
  if (config.reasoner?.length) {
    sections.push(REASONER_GUIDANCE)
  }
  sections.push(SOURCE_TRUST_HIERARCHY)
  sections.push(CHAT_HISTORY)
  sections.push(...contextSections)
  sections.push(TAIL_REINFORCEMENT)

  return sections.join('\n\n---\n\n')
}

async function readSafe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
