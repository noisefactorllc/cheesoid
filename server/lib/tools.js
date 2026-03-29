import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { buildSharedWorkspaceTools } from './shared-workspace.js'

/**
 * Build the full tool set for a persona: memory tools + persona-specific tools.
 * Returns { definitions: [...], execute: async (name, input) => result }
 */
export async function loadTools(personaDir, config, memory, state, room, registry, modality) {
  const memoryTools = buildMemoryTools(memory, state)
  const sharedTools = buildSharedWorkspaceTools(process.env.SHARED_WORKSPACE_PATH || '/shared')
  const roomTools = buildRoomTools(room, config)
  const reasonerTools = buildReasonerTools(config, registry)
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

  const staticDefinitions = [...memoryTools.definitions, ...sharedTools.definitions, ...roomTools.definitions, ...reasonerTools.definitions, ...personaTools.definitions]

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
    if (reasonerTools.handles(name)) {
      return reasonerTools.execute(name, input, options)
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
        },
      },
    })
  }

  const toolNames = new Set(definitions.map(d => d.name))

  async function execute(name, input) {
    switch (name) {
      case 'send_chat_message': {
        room.broadcast({ type: 'assistant_message', text: input.text })
        room.recordHistory({ type: 'assistant_message', text: input.text })
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

        const parts = []

        if (input.thought) {
          room.broadcast({ type: 'idle_text_delta', text: input.thought })
          room.broadcast({ type: 'idle_done' })
          room.recordHistory({ type: 'idle_thought', text: input.thought })
          parts.push(`Thought: ${input.thought}`)
        }

        if (input.backchannel) {
          const pendingRoom = room._pendingRoom
          if (pendingRoom && pendingRoom !== 'home') {
            const client = room.roomClients.get(pendingRoom)
            if (client) {
              await client.sendBackchannel(input.backchannel, { trigger: !!input.trigger })
            }
          } else {
            room.broadcast({ type: 'backchannel', name: room.persona.config.display_name, text: input.backchannel, trigger: !!input.trigger })
          }
          parts.push(input.trigger ? 'Backchannel sent (triggered).' : 'Backchannel sent.')
        }

        return { output: parts.join('\n') }
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

const REASONER_SYSTEM = 'You are a reasoning assistant. Analyze the given problem carefully and thoroughly. Provide your conclusion.'

function buildReasonerTools(config, registry) {
  if (!config.reasoner || !registry) {
    return { definitions: [], handles: () => false, execute: async () => ({ error: 'unknown tool' }) }
  }

  const definitions = [
    {
      name: 'deep_think',
      description: 'Delegate a problem to a reasoning model for deep analysis. Use when a question requires careful multi-step reasoning, complex analysis, or strategic thinking that benefits from extended deliberation. Pass a self-contained prompt with all necessary context.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The question or problem to reason about, including any relevant context needed to think it through.',
          },
        },
        required: ['prompt'],
      },
    },
  ]

  async function execute(name, input, options) {
    const onEvent = options?.onEvent || (() => {})
    const models = [config.reasoner, ...(config.reasoner_fallback_models || [])]
    let lastErr

    for (const modelString of models) {
      const { modelId, provider } = registry.resolve(modelString)
      try {
        const result = await provider.streamMessage(
          {
            model: modelId,
            maxTokens: 16384,
            system: REASONER_SYSTEM,
            messages: [{ role: 'user', content: input.prompt }],
            tools: [],
            serverTools: [],
            thinkingBudget: config.chat?.thinking_budget || null,
          },
          onEvent,
        )

        const text = result.contentBlocks
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')

        return { output: text, _usage: result.usage, _model: modelId }
      } catch (err) {
        lastErr = err
        console.log(`[reasoner] ${modelId} failed: ${err.message}, trying next`)
      }
    }

    return { output: `Reasoning failed: ${lastErr?.message || 'all models unavailable'}`, is_error: true }
  }

  return { definitions, handles: (name) => name === 'deep_think', execute }
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
