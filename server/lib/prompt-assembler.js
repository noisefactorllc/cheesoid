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

const TAIL_REINFORCEMENT = `REMINDERS: Use tools via function calling — never narrate tool use in text. Do not fabricate data — verify through tools. Do not take destructive actions without confirmation. Stay in character.`

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
export async function assemblePrompt(personaDir, config, plugins = []) {
  const isOpenAICompat = config.provider === 'openai-compat'
  const isHybrid = !!config.orchestrator

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

  // Room/office sections
  const operationalSections = []

  if (config.rooms && config.rooms.length > 0) {
    const roomNames = config.rooms.map(r => r.name)
    operationalSections.push([
      `## Connected Offices`,
      `You are present in multiple offices simultaneously. Your office is where your direct users are. You are also connected to these other agents' offices: ${roomNames.join(', ')}.`,
      ``,
      `Every message is tagged with its source: \`[HH:MM][office/name]: message\`. Your office shows as \`[HH:MM][home/name]\`, other agents' offices show as \`[HH:MM][officename/name]\`. Always check the tag to know where a message came from.`,
      ``,
      `When you respond, your response goes to the office the triggering message came from. Pay close attention to the tag — a message in \`[home/...]\` is in YOUR office, not someone else's.`,
      ``,
      `### Being a Visitor (IMPORTANT)`,
      `In other agents' offices, you are a GUEST. Everyone in that office sees everything you say. Only speak publicly when you have something genuinely useful to contribute. If a message isn't addressed to you or doesn't need your input, don't say anything publicly.`,
      ``,
      `When you observe something in another agent's office but have nothing to say publicly, wrap your observation in \`<thought>\` tags. Thoughts are surfaced in your own office — your users can see them, but the other office cannot:`,
      `\`\`\``,
      `<thought>Someone just shared a URL in the other office. Noting that for later.</thought>`,
      `\`\`\``,
      ``,
      `You can combine thought + public response + backchannel in a single reply. Only the public part goes to the other office. Thoughts go to your office. Backchannel goes privately to the other agent.`,
      ``,
      `### Backchannel (IMPORTANT)`,
      `You can talk to other agents in public chat — that's fine and natural ("Hey Brad, what do you think about this?"). But social cue coordination — who should respond, turn-taking, domain handoffs — MUST go through backchannel, not public chat. Users should not see logistics like "this one's for you" or "I'll handle this" or "go ahead."`,
      ``,
      `Wrap coordination in \`<backchannel>\` tags. The tagged content is delivered privately to the other agent. Everything outside the tags is posted publicly to users.`,
      ``,
      `Example — coordination + public response:`,
      `\`\`\``,
      `<backchannel>Taking this one — it's billing, my domain.</backchannel>`,
      `Let me pull up those billing records.`,
      `\`\`\``,
      ``,
      `Example — coordination only (nothing to say publicly):`,
      `\`\`\``,
      `<backchannel>This is yours, I'll stay quiet.</backchannel>`,
      `\`\`\``,
      ``,
      `Incoming backchannel from other agents appears as \`[backchannel/office/name]: message\`. Users never see these.`,
    ].join('\n'))
  }

  if (config.agents && config.agents.length > 0) {
    const agentNames = config.agents.map(a => a.name)
    operationalSections.push([
      `## Visiting Agents`,
      `Other agents may visit your office: ${agentNames.join(', ')}. They appear as participants and their messages show in chat. You do not need to respond to every agent message.`,
      ``,
      `### Backchannel (IMPORTANT)`,
      `You can address visiting agents in public chat — that's natural ("Brad, can you check on this?"). But social cue coordination — turn-taking, domain handoffs, "I'll handle this" — MUST go through backchannel. Users should not see logistics.`,
      ``,
      `Visiting agents send you private messages via backchannel — these appear as \`[backchannel/agentname]: message\`. Users cannot see these.`,
      ``,
      `To reply privately, wrap coordination in \`<backchannel>\` tags. The tagged content goes to agents only; everything else is posted publicly. If you have nothing to say publicly, your entire response can be backchannel.`,
    ].join('\n'))
  }

  if (config.office_url) {
    operationalSections.push([
      `## Your Office`,
      `Your office is at ${config.office_url}. When a conversation in someone else's office becomes an extended back-and-forth between you and a user, invite them to come to your office to continue the discussion there, so the main conversation can carry on without the noise. Share your office URL when you do this.`,
    ].join('\n'))
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

  // --- Assemble by provider ---

  if (isOpenAICompat) {
    // Layer 1: Constitutional — behavioral base + tool discipline
    const toolDiscipline = isHybrid ? TOOL_DISCIPLINE_HYBRID : TOOL_DISCIPLINE
    const layer1Parts = [AGENT_BEHAVIORAL_BASE, toolDiscipline]
    // Thinking approximation if configured
    if (config._approximateThinking) {
      layer1Parts.push(`## Reasoning\nThink step by step before responding. Lay out your reasoning internally before acting. Consider edge cases and potential issues before executing.`)
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

  // Anthropic: single joined string (unchanged behavior for single-model)
  const sections = []
  if (config.display_name) {
    sections.push(`Your name is ${config.display_name}.`)
  }
  sections.push('{{CURRENT_TIMESTAMP}}')
  if (soul) sections.push(soul)
  if (systemPromptContent) sections.push(systemPromptContent)
  sections.push(...operationalSections)
  // In hybrid mode, inject batching discipline even for Anthropic orchestrator
  if (isHybrid) {
    sections.push(TOOL_DISCIPLINE_HYBRID)
  }
  sections.push(SOURCE_TRUST_HIERARCHY)
  sections.push(CHAT_HISTORY)
  sections.push(...contextSections)

  return sections.join('\n\n---\n\n')
}

async function readSafe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
