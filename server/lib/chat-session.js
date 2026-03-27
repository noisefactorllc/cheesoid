import { assemblePrompt, currentTimestamp } from './prompt-assembler.js'
import { Memory } from './memory.js'
import { State } from './state.js'
import { ChatLog } from './chat-log.js'
import { loadTools } from './tools.js'
import { runAgent, runHybridAgent } from './agent.js'
import { ProviderRegistry } from './providers/index.js'
import { RoomClient } from './room-client.js'

function replaceTimestamp(prompt) {
  const ts = currentTimestamp()
  if (typeof prompt === 'string') return prompt.replace('{{CURRENT_TIMESTAMP}}', ts)
  if (Array.isArray(prompt)) {
    return prompt.map(msg => ({
      ...msg,
      content: msg.content.replace('{{CURRENT_TIMESTAMP}}', ts),
    }))
  }
  return prompt
}

const IDLE_THOUGHT_INTERVAL = 30 * 60 * 1000 // 30 minutes, doubles each time
const MAX_IDLE_INTERVAL = 7 * 24 * 60 * 60 * 1000 // 7 days cap
const MAX_HISTORY = 50
const MAX_QUEUED_WEBHOOKS = 10
const HEARTBEAT_INTERVAL = 30 * 1000 // 30 seconds — keeps SSE alive through proxies
// Join/leave events are broadcast to SSE clients for UI presence updates
// but never injected into agent context (this.messages) — the agent has
// the participant list via presence events and doesn't need the churn.

const IDLE_THOUGHT_PROMPT = `You have been idle for a while. No one is talking to you right now.

This is a moment of quiet. You are free to use tools, write in chat, or do nothing — entirely at your discretion. There is no obligation to act. Only do something if there's something genuinely on your mind — an unresolved question, something worth remembering, a thought worth sharing.

If you do act, be mindful: your recent conversation history includes your previous actions and tool use. Don't repeat work you've already done. Don't invoke tools just because you can.

Everything you do here — tool calls, thoughts, messages — is part of your ongoing conversation history, so be intentional about it.

If nothing is weighing on you, simply say so briefly and move on.`

/**
 * A Room is a shared conversation space for one persona.
 * All connected clients see all messages. One agent, many humans.
 */
export class Room {
  constructor(persona) {
    this.persona = persona
    this.messages = []
    this.systemPrompt = null
    this.tools = null
    this.memory = null
    this.state = null
    this.chatLog = null
    this.busy = false
    this.lastActivity = Date.now()
    this.idleTimer = null
    this.clients = new Set() // connected SSE clients
    this.participants = new Map() // name → last seen timestamp
    this.history = []
    this.roomClients = new Map() // name → RoomClient
    this._pendingRoom = null // which room the current response targets
    this._messageQueue = [] // queued messages while busy
    this._idleInterval = IDLE_THOUGHT_INTERVAL // backs off with consecutive idle thoughts
    this._heartbeatTimer = null
    this._destroyed = false
    this._sessionStartHandled = false

    // Venue awareness: derive domain from office_url and room configs
    const officeUrl = persona.config.office_url
    if (officeUrl) {
      try {
        const parsed = new URL(officeUrl)
        this.homeDomain = parsed.hostname
      } catch {
        this.homeDomain = null
      }
    } else {
      this.homeDomain = null
    }
    this.roomDomains = new Map()
    for (const roomConfig of persona.config.rooms || []) {
      if (roomConfig.domain) {
        this.roomDomains.set(roomConfig.name, roomConfig.domain)
      }
    }

  }

  async initialize() {
    if (this.systemPrompt) return // already initialized

    const { dir, config, plugins } = this.persona
    this.memory = new Memory(dir, config.memory?.dir || 'memory/')
    this.state = new State(dir)
    this.chatLog = new ChatLog(dir)
    await this.state.load()
    this.systemPrompt = await assemblePrompt(dir, config, plugins)
    this.tools = await loadTools(dir, config, this.memory, this.state, this)
    this.registry = new ProviderRegistry(config)

    // Replay recent history into agent context
    const recent = await this.chatLog.recent(MAX_HISTORY)
    if (recent.length > 0) {
      this.messages.push({ role: 'user', content: '--- PREVIOUS SESSION TRANSCRIPT (for continuity — not a live conversation) ---' })
      for (const entry of recent) {
        // Skip accumulated welcome messages from previous restarts
        if (entry.type === 'system' && entry.text?.startsWith('Welcome to ')) continue

        const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '??:??'
        if (entry.type === 'assistant_message' || entry.type === 'idle_thought') {
          this.messages.push({ role: 'assistant', content: entry.text })
        } else if (entry.type === 'user_message') {
          const prefix = entry.name ? `[${ts}] ${entry.name}` : `[${ts}]`
          this.messages.push({ role: 'user', content: `${prefix}: ${entry.text}` })
        } else if (entry.type === 'system') {
          this.messages.push({ role: 'user', content: `[${ts}] * ${entry.text}` })
        }
      }
      this.history = recent // also restore scrollback
      this.messages.push({ role: 'user', content: '--- END OF TRANSCRIPT — SESSION IS NOW LIVE ---' })
      console.log(`[${config.name}] Replayed ${recent.length} history entries`)
    }

    // Announce startup — broadcast to UI only, don't persist to chat log
    // (prevents welcome messages from accumulating across restarts)
    const startupMsg = `Welcome to ${config.display_name}'s office.`
    this.broadcast({ type: 'system', text: startupMsg })

    // Connect to configured remote rooms
    for (const roomConfig of config.rooms || []) {
      const client = new RoomClient(roomConfig, {
        agentName: config.display_name,
        onMessage: (event) => this._handleRemoteEvent(event),
      })
      this.roomClients.set(roomConfig.name, client)
      client.connect()
    }

    this._startIdleTimer()
  }

  // Register an SSE client for broadcast
  addClient(res, name, isAgent = false) {
    this.clients.add(res)
    if (name) {
      this.participants.set(name, Date.now())
      this.broadcast({ type: 'presence', participants: this.participantList })
    }
    // Send scrollback to the newly connecting client
    const scrollback = this.getScrollback()
    if (scrollback.length > 0) {
      const data = `data: ${JSON.stringify({ type: 'scrollback', messages: scrollback })}\n\n`
      res.write(data)
    }

    // Start heartbeat if this is the first client
    if (this.clients.size === 1) this._startHeartbeat()

    res.on('close', () => {
      this.clients.delete(res)
      if (name) {
        this.participants.delete(name)
        this.broadcast({ type: 'presence', participants: this.participantList })
      }

      // Stop heartbeat if no clients remain
      if (this.clients.size === 0) this._stopHeartbeat()
    })
  }

  get participantList() {
    return [...this.participants.keys()]
  }

  recordHistory(entry) {
    this.history.push({ ...entry, timestamp: Date.now() })
    if (this.history.length > MAX_HISTORY) {
      this.history.shift()
    }
    if (this.chatLog) {
      this.chatLog.append(entry).catch(err => {
        console.error(`[${this.persona.config.name}] Chat log write error:`, err.message)
      })
    }
  }

  getScrollback() {
    return [...this.history]
  }

  // Send event to all connected clients
  broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) {
      client.write(data)
    }
  }

  _timestamp() {
    const now = new Date()
    const h = now.getHours().toString().padStart(2, '0')
    const m = now.getMinutes().toString().padStart(2, '0')
    return `${h}:${m}`
  }

  _domainSuffix(room) {
    const domain = room === 'home' ? this.homeDomain : this.roomDomains.get(room)
    return domain ? `@${domain}` : ''
  }

  addAgentMessage(name, text) {
    const taggedMessage = `[${this._timestamp()}][home/${name}${this._domainSuffix('home')}]: ${text}`
    this.messages.push({ role: 'user', content: taggedMessage })
    this.broadcast({ type: 'user_message', name, text, fromAgent: true })
    this.recordHistory({ type: 'user_message', name, text })
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    this._idleInterval = IDLE_THOUGHT_INTERVAL // reset backoff on any activity
    this._startIdleTimer()
  }

  addBackchannelMessage(name, text) {
    const taggedMessage = `[${this._timestamp()}][backchannel/${name}${this._domainSuffix('home')}]: ${text}`
    this.messages.push({ role: 'user', content: taggedMessage })
    // No broadcast, no history — agents only
  }

  relayAgentEvent(name, event) {
    // Relay visiting agent tool events to SSE clients.
    // Does NOT interact with the agent loop, this.messages, or the busy flag.
    // Uses agentName key to avoid clobbering event.name (which is the tool name
    // on tool_start/tool_result events).
    //
    // Only tool_start/tool_result are relayed — text_delta/done are NOT forwarded
    // because the raw stream includes <thought> content that should stay private.
    // The final public text arrives separately via addAgentMessage after tag parsing.
    this.broadcast({ ...event, agentName: name, visiting: true })
  }

  _parseResponseTags(text) {
    if (!text) return { publicText: '', backchannelText: '', thoughtText: '' }
    const bcParts = []
    const thoughtParts = []
    let result = text.replace(/<backchannel>([\s\S]*?)<\/backchannel>/g, (_, content) => {
      bcParts.push(content.trim())
      return ''
    })
    result = result.replace(/<thought>([\s\S]*?)<\/thought>/g, (_, content) => {
      thoughtParts.push(content.trim())
      return ''
    })
    return {
      publicText: result.trim(),
      backchannelText: bcParts.join('\n'),
      thoughtText: thoughtParts.join('\n'),
    }
  }

  _handleRemoteEvent(event) {
    const ds = this._domainSuffix(event.room)
    if (event.type === 'user_message') {
      if (event.scrollback) {
        // Historical context from remote room — don't trigger agent
        const tag = `[${event.room}/${event.name}${ds}]`
        this._safeAppendMessage({ role: 'user', content: `${tag}: ${event.text}` })
      } else {
        this._processMessage(event.room, event.name, event.text)
      }
    } else if (event.type === 'assistant_message') {
      // Another room's agent responded — add context only, don't trigger
      const tag = `[${event.room}/assistant${ds}]`
      this._safeAppendMessage({ role: 'user', content: `${tag}: ${event.text}` })
    } else if (event.type === 'backchannel') {
      // Agent-only coordination message — add to conversation log, no UI
      const tag = `[${this._timestamp()}][backchannel/${event.room}/${event.name}${ds}]`
      this._safeAppendMessage({ role: 'user', content: `${tag}: ${event.text}` })
    }
  }

  /**
   * Safely append a context message to the conversation. If the agent is busy
   * (mid-tool-execution), queue it — pushing directly into messages[] would
   * insert a user message between tool_use and tool_result, which the API rejects.
   */
  _safeAppendMessage(message) {
    if (this.busy) {
      this._pendingContextMessages = this._pendingContextMessages || []
      this._pendingContextMessages.push(message)
    } else {
      this.messages.push(message)
    }
  }

  async sendMessage(name, userMessage) {
    await this._processMessage('home', name, userMessage)
  }

  async _processMessage(room, name, text) {
    if (this.busy) {
      if (room === 'home' && name === 'webhook') {
        // Queue webhooks — they can't retry and shouldn't be dropped
        const webhookCount = this._messageQueue.filter(m => m.name === 'webhook').length
        if (webhookCount >= MAX_QUEUED_WEBHOOKS) {
          console.warn(`[${this.persona.config.name}] Webhook queue full (${MAX_QUEUED_WEBHOOKS}), dropping webhook`)
          return
        }
        this._messageQueue.push({ room, name, text })
      } else if (room === 'home') {
        // Don't queue human messages — user can resend with up-arrow after agent finishes
        this.broadcast({ type: 'error', message: `${this.persona.config.display_name} is thinking, please wait...` })
      } else {
        // Queue remote room messages (agents can't up-arrow)
        this._messageQueue.push({ room, name, text })
      }
      return
    }

    this.busy = true
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    if (room === 'home') {
      this._idleInterval = IDLE_THOUGHT_INTERVAL // reset backoff on direct user activity only
    }
    this._pendingRoom = room

    try {
      if (!this.systemPrompt) await this.initialize()

      const ts = this._timestamp()
      const roomLabel = room === 'home' ? 'home' : room
      const ds = this._domainSuffix(room)
      const tag = `[${ts}][${roomLabel}/${name}${ds}]`
      const presence = room === 'home' ? ` (present: ${this.participantList.join(', ')})` : ''
      this.messages.push({ role: 'user', content: `${tag}${presence}: ${text}` })

      if (room === 'home') {
        if (name) this.participants.set(name, Date.now())
        this.broadcast({ type: 'user_message', name, text })
        this.recordHistory({ type: 'user_message', name, text })
      }

      // Determine orchestrator vs direct mode
      const hasOrchestrator = this.persona.config.orchestrator != null
      let orchestratorModel, orchestratorProvider, executorModel, executorProvider

      if (hasOrchestrator) {
        // Orchestrator model: string (new) or object with .model (legacy)
        const orchModelStr = typeof this.persona.config.orchestrator === 'string'
          ? this.persona.config.orchestrator
          : this.persona.config.orchestrator.model
        const orchResolved = this.registry.resolve(orchModelStr)
        orchestratorModel = orchResolved.modelId
        orchestratorProvider = orchResolved.provider

        // Executor — pass raw model string so callExecutorWithFallback can resolve via registry
        executorModel = this.persona.config.model
      } else {
        const mainResolved = this.registry.resolve(this.persona.config.model)
        orchestratorModel = mainResolved.modelId
        orchestratorProvider = mainResolved.provider
      }

      const agentConfig = {
        model: orchestratorModel,
        maxTurns: this.persona.config.chat?.max_turns || 20,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: orchestratorProvider,
        // Hybrid mode fields — executor resolved via registry in callExecutorWithFallback
        executorProvider: null,
        executorModel: hasOrchestrator ? executorModel : null,
        executorFallbackModels: hasOrchestrator ? (this.persona.config.fallback_models || []) : [],
        registry: this.registry,
      }

      let assistantText = ''
      const onEvent = (event) => {
        if (event.type === 'text_delta') {
          assistantText += event.text
        }
        if (this._pendingRoom === 'home') {
          this.broadcast(event)
        } else if (event.type === 'tool_start' || event.type === 'tool_result') {
          // Forward tool events to remote office so visitors can see what we're doing.
          // text_delta/done are NOT forwarded — the final public text arrives via
          // sendMessage() after thought/backchannel tags are stripped. Forwarding
          // raw text_delta would leak <thought> content and cause duplicate messages.
          const client = this.roomClients.get(this._pendingRoom)
          if (client) client.sendEvent(event)
        }
      }

      // Session start: force open models to read memory/state before first response
      if (!this._sessionStartHandled && orchestratorProvider.supportsIntentRouting) {
        this._sessionStartHandled = true
        this.messages.push({
          role: 'user',
          content: '[system: This is your first interaction this session. You MUST call get_state and read_memory on MEMORY.md before responding. Do this now — do not skip this step.]',
        })
      }

      const prompt = replaceTimestamp(this.systemPrompt)
      const agentFn = hasOrchestrator ? runHybridAgent : runAgent
      const result = await agentFn(prompt, this.messages, this.tools, agentConfig, onEvent)
      this.messages = result.messages

      // Parse backchannel and thought tags from response
      const { publicText, backchannelText, thoughtText } = this._parseResponseTags(assistantText)

      if (this._pendingRoom === 'home') {
        if (publicText) {
          this.recordHistory({ type: 'assistant_message', text: publicText })
        }
        if (backchannelText) {
          // Broadcast backchannel to SSE — visiting agents' RoomClients pick it up, UI ignores it
          this.broadcast({ type: 'backchannel', name: this.persona.config.display_name, text: backchannelText })
        }
      } else {
        const client = this.roomClients.get(this._pendingRoom)
        if (client) {
          if (backchannelText) await client.sendBackchannel(backchannelText)
          if (publicText) await client.sendMessage(publicText)
        }
        // Surface thoughts in home room
        if (thoughtText) {
          this.broadcast({ type: 'idle_text_delta', text: thoughtText })
          this.broadcast({ type: 'idle_done' })
          this.recordHistory({ type: 'idle_thought', text: thoughtText })
        }
      }
    } catch (err) {
      if (this._pendingRoom === 'home') {
        this.broadcast({ type: 'error', message: err.message })
      } else {
        console.error(`[${this.persona.config.name}] Error responding in ${this._pendingRoom}: ${err.message}`)
      }
    } finally {
      this.busy = false
      this._pendingRoom = null

      // Flush any context messages that arrived while the agent was busy
      if (this._pendingContextMessages && this._pendingContextMessages.length > 0) {
        for (const msg of this._pendingContextMessages) {
          this.messages.push(msg)
        }
        this._pendingContextMessages = []
      }

      this._startIdleTimer()

      // Drain queued webhooks as a batch — inject all at once so the agent
      // can triage holistically instead of reacting to each one serially
      const webhooks = []
      const remaining = []
      for (const msg of this._messageQueue) {
        if (msg.name === 'webhook') {
          webhooks.push(msg)
        } else {
          remaining.push(msg)
        }
      }
      this._messageQueue = remaining

      if (webhooks.length > 0) {
        // Combine into a single message so the agent sees the full picture
        const combined = webhooks.map((w, i) => {
          const label = webhooks.length > 1 ? `--- webhook ${i + 1} of ${webhooks.length} ---\n` : ''
          return label + w.text
        }).join('\n\n')
        this._processMessage('home', 'webhook', combined).catch(err => {
          console.error(`[${this.persona.config.name}] Queued webhook processing error:`, err.message)
        })
      } else if (this._messageQueue.length > 0) {
        const next = this._messageQueue.shift()
        this._processMessage(next.room, next.name, next.text).catch(err => {
          console.error(`[${this.persona.config.name}] Queue processing error:`, err.message)
        })
      }
    }
  }

  async _idleThought() {
    if (this.busy) {
      return false // skipped — timer wrapper handles restart
    }

    this.busy = true
    console.log(`[${this.persona.config.name}] Idle thought triggered, ${this.clients.size} clients connected`)

    try {
      const idleMessages = [
        ...this.messages,
        { role: 'user', content: IDLE_THOUGHT_PROMPT },
      ]

      // Determine orchestrator vs direct mode
      const hasOrchestrator = this.persona.config.orchestrator != null
      let orchestratorModel, orchestratorProvider, executorModel, executorProvider

      if (hasOrchestrator) {
        const orchModelStr = typeof this.persona.config.orchestrator === 'string'
          ? this.persona.config.orchestrator
          : this.persona.config.orchestrator.model
        const orchResolved = this.registry.resolve(orchModelStr)
        orchestratorModel = orchResolved.modelId
        orchestratorProvider = orchResolved.provider

        executorModel = this.persona.config.model
      } else {
        const mainResolved = this.registry.resolve(this.persona.config.model)
        orchestratorModel = mainResolved.modelId
        orchestratorProvider = mainResolved.provider
      }

      const agentConfig = {
        model: orchestratorModel,
        maxTurns: 5,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: orchestratorProvider,
        executorProvider: null,
        executorModel: hasOrchestrator ? executorModel : null,
        executorFallbackModels: hasOrchestrator ? (this.persona.config.fallback_models || []) : [],
        registry: this.registry,
      }

      // Wrap events as idle thoughts for the UI — broadcast errors must not
      // abort the agent call, so catch them individually
      let idleText = ''
      const onEvent = (event) => {
        try {
          if (event.type === 'text_delta') {
            idleText += event.text
            this.broadcast({ type: 'idle_text_delta', text: event.text })
          } else if (event.type === 'done') {
            this.broadcast({ type: 'idle_done' })
          } else if (event.type === 'tool_start' || event.type === 'tool_result') {
            this.broadcast({ ...event, idle: true })
          }
        } catch (err) {
          console.error(`[${this.persona.config.name}] Idle broadcast error:`, err.message)
        }
      }

      const prompt = replaceTimestamp(this.systemPrompt)
      const agentFn = hasOrchestrator ? runHybridAgent : runAgent
      const result = await agentFn(prompt, idleMessages, this.tools, agentConfig, onEvent)
      this.messages = result.messages
      if (idleText) {
        this.recordHistory({ type: 'idle_thought', text: idleText })
      }

      if (this.state) {
        this.state.update({ last_idle_thought: new Date().toISOString() })
        await this.state.save()
      }
      return true // completed
    } catch (err) {
      console.error(`[${this.persona.config.name}] Idle thought error:`, err.message)
      return false // failed
    } finally {
      this.busy = false

      // Flush any context messages that arrived while the agent was busy
      if (this._pendingContextMessages && this._pendingContextMessages.length > 0) {
        for (const msg of this._pendingContextMessages) {
          this.messages.push(msg)
        }
        this._pendingContextMessages = []
      }
    }
  }

  _startIdleTimer() {
    this._clearIdleTimer()
    const interval = this._idleInterval
    console.log(`[${this.persona.config.name}] Idle timer set: ${Math.round(interval / 1000)}s`)
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = null // mark as fired
      let completed = false
      try {
        completed = await this._idleThought()
      } catch (err) {
        // Safety net — _idleThought has its own try/catch, so this should
        // never fire, but if it does the timer must not die
        console.error(`[${this.persona.config.name}] Idle thought unhandled error:`, err.message)
        this.busy = false
      } finally {
        // ALWAYS reschedule unless destroyed or something else already set a timer
        // (e.g. a message came in during the thought and restarted it)
        if (!this.idleTimer && !this._destroyed) {
          if (completed) {
            this._idleInterval = Math.min(this._idleInterval * 2, MAX_IDLE_INTERVAL)
          }
          this._startIdleTimer()
        }
      }
    }, interval)
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  // SSE heartbeat — sends a comment to keep connections alive through proxies
  _startHeartbeat() {
    if (this._heartbeatTimer) return
    this._heartbeatTimer = setInterval(() => {
      for (const client of this.clients) {
        client.write(':heartbeat\n\n')
      }
    }, HEARTBEAT_INTERVAL)
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  destroy() {
    this._destroyed = true
    this._clearIdleTimer()
    this._stopHeartbeat()
    for (const client of this.roomClients.values()) {
      client.destroy()
    }
    this.roomClients.clear()
    for (const client of this.clients) {
      client.end()
    }
    this.clients.clear()
    this.participants.clear()
  }
}
