import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function assemblePrompt(personaDir, config) {
  const sections = []

  // 1. Identity preamble from config
  if (config.display_name) {
    sections.push(`Your name is ${config.display_name}.`)
  }

  // 2. Current date/time
  const now = new Date()
  sections.push(`Current date: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Current time: ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}.`)

  // 3. SOUL.md — persistent presence definition
  const soul = await readSafe(join(personaDir, 'SOUL.md'))
  if (soul) sections.push(soul)

  // 3. System/wakeup prompt
  const promptPath = config.chat?.prompt || config.wakeup?.prompt
  if (promptPath) {
    const prompt = await readSafe(join(personaDir, promptPath))
    if (prompt) sections.push(prompt)
  }

  // 3. Room awareness — tell the agent about connected rooms
  if (config.rooms && config.rooms.length > 0) {
    const roomNames = config.rooms.map(r => r.name)
    const roomSection = [
      `## Connected Rooms`,
      `You are present in multiple rooms simultaneously. Your home room is where your direct users are. You are also connected to these remote rooms: ${roomNames.join(', ')}.`,
      ``,
      `Messages are tagged so you know where they come from:`,
      `- Home room: \`[HH:MM][name]: message\``,
      `- Remote rooms: \`[HH:MM][roomname/name]: message\``,
      `- Join/leave: \`[HH:MM] * name has joined\``,
      ``,
      `When you respond, your response goes to the room the triggering message came from.`,
      ``,
      `### Being a Visitor (IMPORTANT)`,
      `In remote rooms, you are a GUEST. Everyone in that room sees everything you say. Only speak publicly when you have something genuinely useful to contribute. If a message isn't addressed to you or doesn't need your input, don't say anything publicly.`,
      ``,
      `When you observe something in a remote room but have nothing to say publicly, wrap your observation in \`<thought>\` tags. Thoughts are surfaced in your home room as idle thoughts — your home users can see them, but the remote room cannot:`,
      `\`\`\``,
      `<thought>Alex just shared a URL with Brad. Noting that for later.</thought>`,
      `\`\`\``,
      ``,
      `You can combine thought + public response + backchannel in a single reply. Only the public part goes to the remote room. Thoughts go to your home room. Backchannel goes privately to the other agent.`,
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
      `Incoming backchannel from other agents appears as \`[backchannel/room/name]: message\`. Users never see these.`,
    ].join('\n')
    sections.push(roomSection)
  }

  // Tell the agent about agents that can connect to it
  if (config.agents && config.agents.length > 0) {
    const agentNames = config.agents.map(a => a.name)
    const agentSection = [
      `## Visiting Agents`,
      `Other agents may join your room: ${agentNames.join(', ')}. They appear as participants and their messages show in chat. You do not need to respond to every agent message.`,
      ``,
      `### Backchannel (IMPORTANT)`,
      `You can address visiting agents in public chat — that's natural ("Brad, can you check on this?"). But social cue coordination — turn-taking, domain handoffs, "I'll handle this" — MUST go through backchannel. Users should not see logistics.`,
      ``,
      `Visiting agents send you private messages via backchannel — these appear as \`[backchannel/agentname]: message\`. Users cannot see these.`,
      ``,
      `To reply privately, wrap coordination in \`<backchannel>\` tags. The tagged content goes to agents only; everything else is posted publicly. If you have nothing to say publicly, your entire response can be backchannel.`,
    ].join('\n')
    sections.push(agentSection)
  }

  // 4. Memory files — always last (freshest context)
  const memoryDir = config.memory?.dir || 'memory/'
  const autoRead = config.memory?.auto_read || []
  for (const filename of autoRead) {
    const content = await readSafe(join(personaDir, memoryDir, filename))
    if (content) sections.push(content)
  }

  return sections.join('\n\n---\n\n')
}

async function readSafe(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
