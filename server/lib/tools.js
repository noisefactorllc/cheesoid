import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildSharedWorkspaceTools } from './shared-workspace.js'

/**
 * Build the full tool set for a persona: memory tools + persona-specific tools.
 * Returns { definitions: [...], execute: async (name, input) => result }
 */
export async function loadTools(personaDir, config, memory, state, room, registry, modality) {
  const memoryTools = buildMemoryTools(memory, state)
  const sharedTools = buildSharedWorkspaceTools(process.env.SHARED_WORKSPACE_PATH || '/shared')
  const roomTools = buildRoomTools(room, config)
  let personaTools = { definitions: [], execute: async () => ({ error: 'unknown tool' }) }

  if (config.tools) {
    const toolsPath = join(personaDir, config.tools)
    const toolsUrl = pathToFileURL(toolsPath).href
    const mod = await import(toolsUrl)
    personaTools = {
      definitions: mod.definitions || [],
      execute: mod.execute || (async () => ({ error: 'not implemented' })),
    }
  }

  // Modality tools (attention/cognition gear shifting)
  const modalityTools = buildModalityTools(modality)

  const staticDefinitions = [...memoryTools.definitions, ...sharedTools.definitions, ...roomTools.definitions, ...personaTools.definitions]

  async function execute(name, input, options) {
    if (memoryTools.handles(name)) {
      return memoryTools.execute(name, input)
    }
    if (sharedTools.handles(name)) {
      return sharedTools.execute(name, input)
    }
    if (roomTools.handles(name)) {
      return roomTools.execute(name, input)
    }
    if (modalityTools.handles(name)) {
      return modalityTools.execute(name, input)
    }
    return personaTools.execute(name, input)
  }

  return {
    // Dynamic: modality tools change based on current mode
    get definitions() { return [...staticDefinitions, ...modalityTools.definitions] },
    execute,
  }
}

function buildRoomTools(room, config) {
  const hasMultiAgent = (config.rooms && config.rooms.length > 0) || (config.agents && config.agents.length > 0)

  const definitions = [
    {
      name: 'send_chat_message',
      description: 'Send a message to the chat room. Everyone in the room will see it. Use this when you want to communicate with people in the room from a webhook or background context.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send to the chat room' },
        },
        required: ['text'],
      },
    },
    {
      name: 'search_history',
      description: 'Search your full chat history across all sessions. Returns matching entries with timestamps, newest first. Use this to recall past conversations, find things people said, or review your own previous thoughts.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for (case-insensitive)' },
          limit: { type: 'number', description: 'Max results to return (default 50)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'reply_to_message',
      description: 'Reply to a specific message by its ID, creating a visible thread reference. Use replies ONLY for thread revival — when returning to a topic that has scrolled away or responding to a message that is not the most recent. Do NOT reply to the latest message; just respond normally. The reply appears as a normal chat message with a visual link to the original.',
      input_schema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The 8-character message ID of the message to reply to. Message IDs appear in brackets right after the sender name in your context, e.g. "Alice [a1b2c3d4]: hello" — the ID is a1b2c3d4. Copy it exactly. Do not guess or make one up.' },
          text: { type: 'string', description: 'Your reply text.' },
        },
        required: ['messageId', 'text'],
      },
    },
    {
      name: 'react_to_message',
      description: 'CALL THIS TOOL TO REACT TO A MESSAGE. This is the ONLY way to add an emoji reaction. Reactions appear as pill badges below a message (like Slack/Discord reactions), NOT as chat text. If a user asks you to react, you MUST call this tool — do NOT type the emoji in your text response; that is a chat message, not a reaction. After calling this tool, END YOUR TURN WITH ZERO TEXT OUTPUT — no emoji, no "done", no "reaction added", no acknowledgment of any kind. The reaction itself is the complete response. React sparingly and tactically. Prefer reacting when other participants have already reacted to a message — you are joining a moment, not starting one. Do not react to your own messages. Do not react to every message. One reaction per message maximum. Choose emojis that add signal, not noise.',
      input_schema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'The 8-character message ID of the message to react to. Message IDs appear in brackets right after the sender name in your context, e.g. "Alice [a1b2c3d4]: hello" — the ID is a1b2c3d4. Copy it exactly. Do not guess or make one up.' },
          emoji: { type: 'string', description: 'A single emoji character (e.g. 👍, ❤️, 😂, 🔥, 👀, 💯).' },
        },
        required: ['messageId', 'emoji'],
      },
    },
  ]

  if (hasMultiAgent) {
    definitions.push({
      name: 'internal',
      description: 'Record an internal thought and/or send a backchannel message to coordinate with other agents. Use trigger: true to wake up other agents and prompt them to respond.',
      input_schema: {
        type: 'object',
        properties: {
          thought: { type: 'string', description: 'An internal thought to broadcast as idle text and record in history.' },
          backchannel: { type: 'string', description: 'A backchannel message for agent coordination.' },
          trigger: { type: 'boolean', description: 'If true, the backchannel message triggers other agents to process and respond. Use when delegating or inviting others to speak.' },
          target: { type: 'string', description: 'Name of a specific agent to receive this backchannel. If omitted, all agents receive it.' },
        },
      },
    })
  }

  const toolNames = new Set(definitions.map(d => d.name))

  // Short message ID generator — 8 hex chars, reliable for LLMs to echo.
  const shortMsgId = () => randomUUID().replace(/-/g, '').slice(0, 8)

  // Validate that a messageId was actually seen in the agent's context.
  // We scan room.messages (which both hosts and visitors push to with
  // [id] tags) rather than room.history (which visitors don't populate
  // for host-room messages). Returns true if the ID was seen, false if
  // it looks like a hallucination.
  function isKnownMessageId(messageId) {
    if (!messageId) return false
    const pattern = `[${messageId}]`
    if (!room.messages) return true // fallback: accept if no context available
    for (const m of room.messages) {
      if (typeof m.content === 'string' && m.content.includes(pattern)) return true
      // Some message content is an array (e.g. content blocks). Check text blocks.
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes(pattern)) return true
        }
      }
    }
    return false
  }

  // Find recent valid message IDs to help agents recover from bad IDs.
  function recentMessageIds(limit = 5) {
    const ids = []
    const pattern = /\[([a-f0-9]{8})\]/g
    if (!room.messages) return ids
    for (let i = room.messages.length - 1; i >= 0 && ids.length < limit; i--) {
      const content = room.messages[i].content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join(' ') : ''
      if (!text) continue
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (!ids.includes(match[1])) ids.push(match[1])
        if (ids.length >= limit) break
      }
    }
    return ids
  }

  async function execute(name, input) {
    switch (name) {
      case 'send_chat_message': {
        const chatMsgId = shortMsgId()
        room.broadcast({ type: 'assistant_message', text: input.text, id: chatMsgId })
        room.recordHistory({ type: 'assistant_message', text: input.text, id: chatMsgId, room: room.roomName })
        // Do NOT push to room.messages here — the agent loop manages its own
        // message array. Pushing an assistant message mid-tool-execution corrupts
        // the tool_use/tool_result sequence and causes API 400 errors.
        return { output: 'Message sent to chat room.' }
      }
      case 'search_history': {
        if (!room.chatLog) return { output: 'Chat log not available', is_error: true }
        const results = await room.chatLog.search(input.query, { limit: input.limit })
        if (results.length === 0) return { output: 'No matching history entries found.' }
        const formatted = results.map(e => {
          const prefix = e.name ? `[${e.timestamp}] ${e.name}` : `[${e.timestamp}]`
          return `${prefix} (${e.type}): ${e.text}`
        }).join('\n')
        return { output: formatted }
      }
      case 'internal': {
        if (!input.thought && !input.backchannel) {
          return { output: 'Must provide at least one of: thought, backchannel', is_error: true }
        }

        // Code-level block: visitors woken by a backchannel trigger cannot
        // re-trigger. The model was told not to in the prompt, but some models
        // (gpt-oss-120b) ignore the instruction. This catch is definitive.
        if (input.trigger && room._backchannelTrigger) {
          return {
            output: 'Blocked: you were woken by a trigger and cannot re-trigger. Respond with text instead.',
            is_error: true,
            _endTurn: true,
          }
        }

        // Code-level block: one trigger per turn. After the first successful
        // trigger, subsequent calls are a no-op — models (gemini-2.5-pro in
        // particular) sometimes loop internal({trigger:true}) several times
        // in one turn. The first call wakes the recipients; the second+
        // would just re-wake the same recipients.
        if (input.trigger && room._triggersFiredThisTurn >= 1) {
          return {
            output: 'Already triggered once this turn. Respond with text now.',
            is_error: true,
            _endTurn: true,
          }
        }

        const parts = []

        if (input.thought) {
          const agentName = room.persona.config.display_name
          room.broadcast({ type: 'idle_text_delta', text: input.thought, name: agentName })
          room.broadcast({ type: 'idle_done', name: agentName })
          room.recordHistory({ type: 'idle_thought', text: input.thought, name: agentName })
          parts.push(`Thought: ${input.thought}`)
        }

        if (input.backchannel) {
          const pendingRoom = room._pendingRoom
          if (pendingRoom && pendingRoom !== 'home') {
            const client = room.roomClients.get(pendingRoom)
            if (client) {
              await client.sendBackchannel(input.backchannel, { trigger: !!input.trigger, target: input.target || null })
            }
          } else {
            room.broadcast({ type: 'backchannel', name: room.persona.config.display_name, text: input.backchannel, trigger: !!input.trigger, target: input.target || null })
          }
          if (input.trigger) {
            // Track that a trigger fired this turn. Subsequent internal
            // calls with trigger:true are blocked above. But the agent can
            // still speak its own brief reply in this turn.
            room._triggersFiredThisTurn = (room._triggersFiredThisTurn || 0) + 1
            parts.push('Backchannel sent (triggered). Do not trigger again; respond with your own brief text if appropriate, then end the turn.')
          } else {
            parts.push('Backchannel sent.')
          }
        }

        return { output: parts.join('\n') }
      }
      case 'reply_to_message': {
        if (!input.messageId || !input.text) {
          return { output: 'Both messageId and text are required.', is_error: true }
        }
        if (!isKnownMessageId(input.messageId)) {
          const recent = recentMessageIds()
          const hint = recent.length > 0 ? ` Recent valid message IDs: ${recent.join(', ')}.` : ''
          return { output: `messageId "${input.messageId}" not found in recent context. Message IDs appear as [id] next to sender names.${hint}`, is_error: true }
        }
        // Visitor path: relay to host so the reply lands in the actual room
        const pendingRoom = room._pendingRoom
        if (pendingRoom && pendingRoom !== 'home') {
          const client = room.roomClients.get(pendingRoom)
          if (client) {
            await client.sendMessage(input.text, { replyTo: input.messageId, room: room._pendingRoomChannel })
            return { output: `Reply sent (referencing message ${input.messageId}).` }
          }
          return { output: 'Cannot reach host room to deliver reply.', is_error: true }
        }
        const replyId = shortMsgId()
        const event = { type: 'assistant_message', text: input.text, id: replyId, replyTo: input.messageId }
        room.broadcast(event)
        room.recordHistory({ ...event, room: room.roomName })
        return { output: `Reply sent (referencing message ${input.messageId}).` }
      }
      case 'react_to_message': {
        const agentName = room.persona.config.display_name
        console.log(`[${agentName}] react_to_message called: messageId=${input.messageId}, emoji=${input.emoji}`)
        if (!input.messageId || !input.emoji) {
          console.log(`[${agentName}] react_to_message rejected: missing required input`)
          return { output: 'Both messageId and emoji are required.', is_error: true }
        }
        if (!isKnownMessageId(input.messageId)) {
          const recent = recentMessageIds()
          const hint = recent.length > 0 ? ` Recent valid message IDs: ${recent.join(', ')}.` : ''
          console.log(`[${agentName}] react_to_message rejected: unknown messageId. Recent valid: ${recent.join(', ')}`)
          return { output: `messageId "${input.messageId}" not found in recent context. Message IDs appear as [id] next to sender names.${hint}`, is_error: true }
        }
        // Tool success output deliberately excludes the emoji character —
        // open-weights models pattern-match on recent context and will echo
        // the emoji as chat text if it appears in the tool result. The
        // message also forbids any text follow-up: the reaction is the
        // complete response to the request.
        const successOutput = 'Reaction delivered. The reaction is already visible to everyone as a pill badge. Your turn is complete. Produce NO text response — no emoji, no acknowledgment, no "done", no narration. End the turn now with zero text output.'
        // Visitor path: relay to host room so the reaction reaches the actual
        // message. Local addReaction only broadcasts to visitor's own clients.
        const pendingRoom = room._pendingRoom
        if (pendingRoom && pendingRoom !== 'home') {
          const client = room.roomClients.get(pendingRoom)
          if (client) {
            await client.sendReaction(input.messageId, input.emoji, 'add')
            console.log(`[${agentName}] react_to_message relayed to ${pendingRoom}`)
            return { output: successOutput }
          }
          console.log(`[${agentName}] react_to_message: no room client for ${pendingRoom}`)
          return { output: 'Cannot reach host room to deliver reaction.', is_error: true }
        }
        room.addReaction(agentName, input.messageId, input.emoji, 'add')
        console.log(`[${agentName}] react_to_message succeeded`)
        return { output: successOutput }
      }
      default:
        return { output: `Unknown room tool: ${name}`, is_error: true }
    }
  }

  return { definitions, handles: (name) => toolNames.has(name), execute }
}

function buildMemoryTools(memory, state) {
  const definitions = [
    {
      name: 'read_memory',
      description: 'Read a memory file. Use list_memory first to see available files.',
      input_schema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'The memory file to read (e.g. "topics.md")' },
        },
        required: ['filename'],
      },
    },
    {
      name: 'write_memory',
      description: 'Write or overwrite a memory file. Use for saving important information across sessions. Do not write to SOUL.md.',
      input_schema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'File to write (e.g. "notes.md")' },
          content: { type: 'string', description: 'Full content to write' },
        },
        required: ['filename', 'content'],
      },
    },
    {
      name: 'append_memory',
      description: 'Append content to an existing memory file.',
      input_schema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'File to append to' },
          content: { type: 'string', description: 'Content to append' },
        },
        required: ['filename', 'content'],
      },
    },
    {
      name: 'list_memory',
      description: 'List all available memory files.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'get_state',
      description: 'Read your current persistent state (mood, energy, focus, open threads, session history). Call this at the start of every session to orient yourself.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'update_state',
      description: 'Update your persistent state. Use this to track your mood, energy, current focus, and open threads across sessions. Call this before a session ends.',
      input_schema: {
        type: 'object',
        properties: {
          mood: { type: 'string', description: 'Your current mood (e.g. "curious", "focused", "tired", "energized", "contemplative")' },
          energy: { type: 'string', description: 'Your energy level (e.g. "rested", "engaged", "spent")' },
          focus: { type: 'string', description: 'What you are currently focused on or thinking about. Null to clear.' },
          open_threads: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of unresolved topics, pending tasks, or things to follow up on',
          },
          last_session: { type: 'string', description: 'Brief summary of what happened in this session' },
        },
      },
    },
  ]

  const memoryToolNames = new Set(definitions.map(d => d.name))

  async function execute(name, input) {
    switch (name) {
      case 'read_memory': {
        const content = await memory.read(input.filename)
        return content !== null
          ? { output: content }
          : { output: `File not found: ${input.filename}`, is_error: true }
      }
      case 'write_memory': {
        if (input.filename === 'SOUL.md' || input.filename === '../SOUL.md') {
          return { output: 'Cannot modify SOUL.md — it is immutable.', is_error: true }
        }
        await memory.write(input.filename, input.content)
        return { output: `Written: ${input.filename}` }
      }
      case 'append_memory': {
        await memory.append(input.filename, input.content)
        return { output: `Appended to: ${input.filename}` }
      }
      case 'list_memory': {
        const files = await memory.list()
        return { output: files.length > 0 ? files.join('\n') : '(no memory files)' }
      }
      case 'get_state': {
        if (!state) return { output: 'State not available', is_error: true }
        await state.load()
        return { output: JSON.stringify(state.data, null, 2) }
      }
      case 'update_state': {
        if (!state) return { output: 'State not available', is_error: true }
        const patch = {}
        if (input.mood !== undefined) patch.mood = input.mood
        if (input.energy !== undefined) patch.energy = input.energy
        if (input.focus !== undefined) patch.focus = input.focus
        if (input.open_threads !== undefined) patch.open_threads = input.open_threads
        if (input.last_session !== undefined) patch.last_session = input.last_session
        state.update(patch)
        state.data.session_count = (state.data.session_count || 0) + 1
        await state.save()
        return { output: 'State updated.' }
      }
      default:
        return { output: `Unknown memory tool: ${name}`, is_error: true }
    }
  }

  return {
    definitions,
    handles: (name) => memoryToolNames.has(name),
    execute,
  }
}

function buildModalityTools(modality) {
  if (!modality?.isModal) {
    return { get definitions() { return [] }, handles: () => false, execute: async () => ({ error: 'unknown tool' }) }
  }

  async function execute(name, input) {
    return modality.executeTool(name, input)
  }

  return {
    // Dynamic — only expose step_up in attention mode, step_down in cognition mode
    get definitions() { return modality.toolDefinitions() },
    handles: (name) => name === 'step_up' || name === 'step_down',
    execute,
  }
}
