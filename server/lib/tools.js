import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildSharedWorkspaceTools } from './shared-workspace.js'
import { buildWebSearchTools } from './web-search.js'
import { buildHarnessTools } from './tools-harness.js'
import { MEMORY_COMPACT_WARN_BYTES, MEMORY_READ_CAP_BYTES, validateMemoryFilename } from './memory.js'
import { isLegacyPeerLifecycleEntry } from './peering.js'

// The read-mostly subset a subagent gets: enough to research and report,
// nothing that mutates the parent agent's world or spawns further workers.
const SUBAGENT_TOOLS = new Set([
  'read_memory', 'list_memory', 'search_memory',
  'wiki_read', 'wiki_list', 'wiki_search',
  'read_shared', 'list_shared',
  'web_search', 'fetch_url',
])

/**
 * Build the full tool set for a persona: memory tools + persona-specific tools.
 * Returns { definitions: [...], execute: async (name, input) => result }
 */
export async function loadTools(personaDir, config, memory, state, room, registry, modality, deps = {}) {
  const memoryTools = buildMemoryTools(memory, state)
  const sharedTools = buildSharedWorkspaceTools(process.env.SHARED_WORKSPACE_PATH || '/shared')
  const roomTools = buildRoomTools(room, config)
  const webSearchTools = buildWebSearchTools(config, deps)
  const harness = deps.harness || null
  const harnessTools = harness
    ? buildHarnessTools(harness, room, config, memory)
    : { definitions: [], handles: () => false, execute: async () => ({ output: 'harness not available', is_error: true }) }
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

  const staticDefinitions = [...memoryTools.definitions, ...sharedTools.definitions, ...roomTools.definitions, ...webSearchTools.definitions, ...harnessTools.definitions, ...personaTools.definitions]

  async function execute(name, input, options) {
    let result
    if (memoryTools.handles(name)) {
      result = await memoryTools.execute(name, input, options)
    } else if (sharedTools.handles(name)) {
      result = await sharedTools.execute(name, input, options)
    } else if (roomTools.handles(name)) {
      result = await roomTools.execute(name, input, options)
    } else if (webSearchTools.handles(name)) {
      result = await webSearchTools.execute(name, input, options)
    } else if (harnessTools.handles(name)) {
      result = await harnessTools.execute(name, input, options)
    } else if (modalityTools.handles(name)) {
      result = await modalityTools.execute(name, input, options)
    } else {
      result = await personaTools.execute(name, input, options)
    }
    return harness?.secrets?.redactDeep
      ? harness.secrets.redactDeep(result)
      : result
  }

  const toolset = {
    // Dynamic: modality tools change based on current mode
    get definitions() { return [...staticDefinitions, ...modalityTools.definitions] },
    execute,
  }

  // Register the subagent tool subset on the harness: same executors, filtered
  // surface, and no spawn_subagent (the depth guard is structural).
  if (harness) {
    harness._subagentTools = () => ({
      definitions: staticDefinitions.filter(d => SUBAGENT_TOOLS.has(d.name)),
      execute: async (name, input, options) => {
        if (!SUBAGENT_TOOLS.has(name)) {
          return { output: `Tool ${name} is not available to subagents.`, is_error: true }
        }
        return execute(name, input, options)
      },
    })
  }

  return toolset
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

  // Validate that a messageId is real. Context scan first (cheap, covers
  // what the agent just saw), then in-memory history, then the full JSONL
  // store — an id learned from read_thread or a reply quote is as valid as
  // one on screen. Only ids that resolve NOWHERE are rejected: those are
  // fabricated, and the store is the authority on that.
  async function isKnownMessageId(messageId) {
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
    if ((room.history || []).some(h => h.id === messageId)) return true
    if (room.chatLog?.findById) {
      try {
        if (await room.chatLog.findById(messageId)) return true
      } catch { }
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

  async function execute(name, input, options) {
    switch (name) {
      case 'send_chat_message': {
        const chatMsgId = shortMsgId()
        const agentName = room.persona.config.display_name
        // Include name on the broadcast so visitors can attribute the chat
        // when they receive it via SSE. Recorded history entries omit name
        // (existing convention — scrollback distinguishes host vs visiting
        // agent on `name` presence; the host's own messages stay nameless).
        const event = { type: 'assistant_message', text: input.text, id: chatMsgId, name: agentName }
        // Carry the LLM's addressing intent (from internal({trigger,target})
        // calls earlier in this turn) onto the chat event so visitors can
        // route via structured data, not text scraping.
        const triggers = room._triggerTargetsThisTurn ? [...room._triggerTargetsThisTurn] : []
        const addressedNames = triggers.filter(t => t !== '__broadcast__')
        if (addressedNames.length > 0) event.addressed_to = addressedNames
        if (triggers.includes('__broadcast__')) event.addressed_all = true
        room.broadcast(event)
        room.recordHistory({ type: 'assistant_message', text: input.text, id: chatMsgId, room: room.roomName })
        // Flush any backchannel triggers queued earlier this turn now that
        // the chat broadcast has gone out — visitors receive chat first,
        // wake second, never the other way.
        if (typeof room._flushPendingBackchannels === 'function') {
          room._flushPendingBackchannels()
        }
        // Do NOT push to room.messages here — the agent loop manages its own
        // message array. Pushing an assistant message mid-tool-execution corrupts
        // the tool_use/tool_result sequence and causes API 400 errors.
        return { output: 'Message sent to chat room.' }
      }
      case 'search_history': {
        if (!room.chatLog) return { output: 'Chat log not available', is_error: true }
        const results = (await room.chatLog.search(input.query, { limit: input.limit }))
          .filter(entry => !isLegacyPeerLifecycleEntry(entry))
        if (results.length === 0) return { output: 'No matching history entries found.' }
        const formatted = results.map(e => {
          const prefix = e.name ? `[${e.timestamp}] ${e.name}` : `[${e.timestamp}]`
          return `${prefix} (${e.type}): ${e.text}`
        }).join('\n')
        return { output: formatted }
      }
      case 'internal': {
        if (!input.thought && !input.backchannel && !input.trigger) {
          return { output: 'Must provide at least one of: thought, backchannel, trigger', is_error: true }
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

        // Code-level block: no repeat-triggering the SAME target in one turn.
        // Different targets are allowed (moderator may legitimately delegate to
        // multiple visitors: "Blue, Green — each say ready"). Same-target loops
        // are blocked — some models (gemini-2.5-pro) retry the identical call.
        // Broadcast-to-all (no target) counts as its own slot.
        if (input.trigger) {
          if (!room._triggerTargetsThisTurn) room._triggerTargetsThisTurn = new Set()
          const targetKey = input.target || '__broadcast__'
          if (room._triggerTargetsThisTurn.has(targetKey)) {
            return {
              output: `Already triggered ${targetKey === '__broadcast__' ? 'the group' : targetKey} this turn. Do not repeat.`,
              is_error: true,
              _endTurn: true,
            }
          }
        }

        const parts = []

        if (input.thought) {
          const agentName = room.persona.config.display_name
          const activeModel = options?.model || null
          room.broadcast({ type: 'idle_text_delta', text: input.thought, name: agentName, model: activeModel })
          if (Array.isArray(room._idleToolThoughts)) {
            // Inside an idle turn — _idleThought finalizes the live stream
            // (via the agent's `done` event) and writes ONE unified
            // idle_thought to history at end-of-turn. Emitting idle_done
            // or recordHistory here creates a duplicate entry and prematurely
            // closes the live stream so subsequent text_delta from continued
            // model output opens a second idle div.
            room._idleToolThoughts.push(input.thought)
          } else {
            room.broadcast({ type: 'idle_done', name: agentName, model: activeModel })
            const entry = { type: 'idle_thought', text: input.thought, name: agentName }
            if (activeModel) entry.model = activeModel
            room.recordHistory(entry)
          }
          parts.push(`Thought: ${input.thought}`)
        }

        // A trigger-only call (no explicit backchannel text) happens when the
        // moderator routes a user's message to another agent as a pure
        // handoff — the recipient doesn't need an inline context blob, only
        // a wake signal. Synthesize a minimal text so the backchannel path
        // fires. Without this, trigger-only calls error out and the target
        // agent never gets woken (the room stays silent).
        const backchannelText = input.backchannel || (input.trigger ? 'moderator handoff' : null)
        if (backchannelText) {
          const pendingRoom = room._pendingRoom
          if (pendingRoom && pendingRoom !== 'home') {
            const client = room.roomClients.get(pendingRoom)
            if (client) {
              await client.sendBackchannel(backchannelText, { trigger: !!input.trigger, target: input.target || null })
            }
          } else {
            const event = { type: 'backchannel', name: room.persona.config.display_name, text: backchannelText, trigger: !!input.trigger, target: input.target || null }
            // Defer trigger broadcasts until after the host's own chat goes
            // out this turn (flush points: _handleAssistantTextTurn,
            // send_chat_message, _processMessage finally, _idleThought
            // finally). The model commonly fires internal({trigger,target})
            // EARLIER in the orchestrator loop than the chat that gives the
            // wake context — without deferral the visitor wakes ungrounded
            // and responds before knowing what was said. Non-trigger
            // backchannels (pure context messages, no wake) still broadcast
            // immediately because there is no race to resolve.
            const isHomeTurn = pendingRoom === 'home' && room.busy === true
            if (event.trigger && isHomeTurn && typeof room._queueBackchannel === 'function') {
              room._queueBackchannel(event)
            } else {
              room.broadcast(event)
            }
          }
          if (input.trigger) {
            // Track this target so we don't re-trigger the same agent in one turn.
            if (!room._triggerTargetsThisTurn) room._triggerTargetsThisTurn = new Set()
            const targetKey = input.target || '__broadcast__'
            room._triggerTargetsThisTurn.add(targetKey)
            parts.push('Backchannel sent (triggered). If you need to trigger a DIFFERENT agent too, call internal again with a different target; otherwise respond with your own brief text or end the turn.')
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
        if (!(await isKnownMessageId(input.messageId))) {
          const recent = recentMessageIds()
          const hint = recent.length > 0 ? ` Recent valid message IDs: ${recent.join(', ')}.` : ''
          return { output: `The id "${input.messageId}" did not come from this conversation — copy ids exactly as they appear in [brackets] next to sender names; do not invent them.${hint}`, is_error: true }
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
        // Quote the referenced message on the event so the UI shows it.
        let ref = (room.history || []).find(h => h.id === input.messageId)
        if (!ref && room.chatLog) {
          try { ref = await room.chatLog.findById(input.messageId) } catch {}
        }
        if (ref) {
          event.replyToPreview = {
            name: ref.name || room.persona.config.display_name,
            text: String(ref.text || '').slice(0, 200),
            timestamp: ref.timestamp || null,
          }
        }
        event.threadId = ref?.threadId || ref?.id || input.messageId
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
        if (!(await isKnownMessageId(input.messageId))) {
          const recent = recentMessageIds()
          const hint = recent.length > 0 ? ` Recent valid message IDs: ${recent.join(', ')}.` : ''
          console.log(`[${agentName}] react_to_message rejected: unknown messageId. Recent valid: ${recent.join(', ')}`)
          return { output: `The id "${input.messageId}" did not come from this conversation — copy ids exactly as they appear in [brackets] next to sender names; do not invent them.${hint}`, is_error: true }
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
            return { output: successOutput, _endTurn: true }
          }
          console.log(`[${agentName}] react_to_message: no room client for ${pendingRoom}`)
          return { output: 'Cannot reach host room to deliver reaction.', is_error: true }
        }
        room.addReaction(agentName, input.messageId, input.emoji, 'add')
        console.log(`[${agentName}] react_to_message succeeded`)
        return { output: successOutput, _endTurn: true }
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
      description: 'CALL THIS TOOL to persist information across sessions. Writes or overwrites a memory file on disk. Whenever a user asks you to remember, save, note, record, or persist something — and an existing memory file does not already cover it — call this tool. Typing "I will remember that" or "noted" in your text response does NOT save anything; only this tool does. Prefer append_memory when adding to an existing file. Do not write to SOUL.md.',
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
      description: 'CALL THIS TOOL to add a new fact/observation to an existing memory file on disk. Whenever a user asks you to remember, save, note, or persist something and an appropriate memory file already exists (e.g. MEMORY.md), call this tool — do not just acknowledge the request in text. Typing "I will remember" in chat persists nothing; only this tool does.',
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
      description: 'List all available memory files with their sizes. Files flagged as over the read/preload cap should be compacted into topic files.',
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
        try {
          const filename = validateMemoryFilename(input.filename)
          const content = await memory.readCapped(filename)
          return content !== null
            ? { output: content }
            : { output: `File not found: ${filename}`, is_error: true }
        } catch (err) {
          return { output: err.message, is_error: true }
        }
      }
      case 'write_memory': {
        try {
          const filename = validateMemoryFilename(input.filename)
          if (filename === 'SOUL.md') {
            return { output: 'Cannot modify SOUL.md — it is immutable.', is_error: true }
          }
          await memory.write(filename, input.content)
          return { output: `Written: ${filename}` }
        } catch (err) {
          return { output: err.message, is_error: true }
        }
      }
      case 'append_memory': {
        try {
          const filename = validateMemoryFilename(input.filename)
          if (filename === 'SOUL.md') {
            return { output: 'Cannot modify SOUL.md — it is immutable.', is_error: true }
          }
          await memory.append(filename, input.content)
          const size = await memory.sizeOf(filename)
          const pressure = size != null && size > MEMORY_COMPACT_WARN_BYTES
            ? ` (file is ${Math.ceil(size / 1024)}KB — consider compacting into topic files)`
            : ''
          return { output: `Appended to: ${filename}${pressure}` }
        } catch (err) {
          return { output: err.message, is_error: true }
        }
      }
      case 'list_memory': {
        const files = await memory.listWithSizes()
        if (files.length === 0) return { output: '(no memory files)' }
        const capKB = Math.floor(MEMORY_READ_CAP_BYTES / 1024)
        const lines = files.map(({ filename, bytes }) => {
          const kb = Math.ceil(bytes / 1024)
          return bytes > MEMORY_READ_CAP_BYTES
            ? `${filename} (${kb}KB — over the ${capKB}KB read/preload cap; compact into topic files)`
            : `${filename} (${kb}KB)`
        })
        return { output: lines.join('\n') }
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
