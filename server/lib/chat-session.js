import { assemblePrompt, currentTimestamp } from './prompt-assembler.js'
import { Memory } from './memory.js'
import { State } from './state.js'
import { ChatLog } from './chat-log.js'
import { loadTools } from './tools.js'
import { runAgent, runHybridAgent } from './agent.js'
import { ProviderRegistry } from './providers/index.js'
import { Modality } from './modality.js'
import { RoomClient } from './room-client.js'
import { WakeupScheduler } from './wakeup.js'

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
const MAX_HISTORY = 250
const MAX_CONTEXT_MESSAGES = 250 // max messages in the live agent context
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
  constructor(persona, options = {}) {
    this.persona = persona
    this.roomName = options.roomName || null

    this._heartbeatTimer = null

    // Agent state — single thread of awareness.
    // All rooms share one _a object. Scalars, arrays, everything on _a
    // is visible to all rooms because they hold the same reference.
    if (options.agent) {
      this._a = options.agent
    } else {
      this._a = {
        messages: [],
        systemPrompt: null,
        tools: null,
        memory: null,
        state: null,
        chatLog: null,
        registry: null,
        modality: null,
        busy: false,
        lastActivity: Date.now(),
        idleTimer: null,
        clients: new Set(),
        participants: new Map(),
        history: [],
        roomClients: new Map(),
        _pendingRoom: null,
        _messageQueue: [],
        _idleInterval: IDLE_THOUGHT_INTERVAL,
        _consecutiveDegenerateCount: 0,
        _destroyed: false,
        _sessionStartHandled: false,
        _pendingContextMessages: [],
        _leaderPool: [persona.config.display_name],
        _leaderIndex: 0,
        _wakeupSchedulers: [],
      }
      for (const a of persona.config.agents || []) {
        this._a._leaderPool.push(a.name)
      }
    }

    // Venue awareness
    const officeUrl = persona.config.office_url
    if (officeUrl) {
      try {
        this.homeDomain = new URL(officeUrl).hostname
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

  // Agent state accessors — all rooms see the same values
  get clients() { return this._a.clients }
  set clients(v) { this._a.clients = v }
  get participants() { return this._a.participants }
  set participants(v) { this._a.participants = v }
  get messages() { return this._a.messages }
  set messages(v) { this._a.messages = v }
  get systemPrompt() { return this._a.systemPrompt }
  set systemPrompt(v) { this._a.systemPrompt = v }
  get tools() { return this._a.tools }
  set tools(v) { this._a.tools = v }
  get memory() { return this._a.memory }
  set memory(v) { this._a.memory = v }
  get state() { return this._a.state }
  set state(v) { this._a.state = v }
  get chatLog() { return this._a.chatLog }
  set chatLog(v) { this._a.chatLog = v }
  get registry() { return this._a.registry }
  set registry(v) { this._a.registry = v }
  get modality() { return this._a.modality }
  set modality(v) { this._a.modality = v }
  get busy() { return this._a.busy }
  set busy(v) { this._a.busy = v }
  get lastActivity() { return this._a.lastActivity }
  set lastActivity(v) { this._a.lastActivity = v }
  get idleTimer() { return this._a.idleTimer }
  set idleTimer(v) { this._a.idleTimer = v }
  get history() { return this._a.history }
  set history(v) { this._a.history = v }
  get roomClients() { return this._a.roomClients }
  set roomClients(v) { this._a.roomClients = v }
  get _pendingRoom() { return this._a._pendingRoom }
  set _pendingRoom(v) { this._a._pendingRoom = v }
  get _messageQueue() { return this._a._messageQueue }
  set _messageQueue(v) { this._a._messageQueue = v }
  get _idleInterval() { return this._a._idleInterval }
  set _idleInterval(v) { this._a._idleInterval = v }
  get _consecutiveDegenerateCount() { return this._a._consecutiveDegenerateCount }
  set _consecutiveDegenerateCount(v) { this._a._consecutiveDegenerateCount = v }
  get _destroyed() { return this._a._destroyed }
  set _destroyed(v) { this._a._destroyed = v }
  get _sessionStartHandled() { return this._a._sessionStartHandled }
  set _sessionStartHandled(v) { this._a._sessionStartHandled = v }
  get _pendingContextMessages() { return this._a._pendingContextMessages }
  set _pendingContextMessages(v) { this._a._pendingContextMessages = v }
  get _leaderPool() { return this._a._leaderPool }
  set _leaderPool(v) { this._a._leaderPool = v }
  get _leaderIndex() { return this._a._leaderIndex }
  set _leaderIndex(v) { this._a._leaderIndex = v }
  get _wakeupSchedulers() { return this._a._wakeupSchedulers }
  set _wakeupSchedulers(v) { this._a._wakeupSchedulers = v }

  async initialize() {
    if (this.systemPrompt) return // already initialized

    const { dir, config, plugins } = this.persona
    this.memory = new Memory(dir, config.memory?.dir || 'memory/')
    this.state = new State(dir)
    this.chatLog = new ChatLog(dir, 'history')
    await this.state.load()
    this.systemPrompt = await assemblePrompt(dir, config, plugins)
    this.registry = new ProviderRegistry(config)

    // Modal mode: attention/cognition gear shifting
    if (config.cognition && config.attention) {
      this.modality = new Modality({
        attention: config.attention,
        cognition: config.cognition,
      })
    }

    this.tools = await loadTools(dir, config, this.memory, this.state, this, this.registry, this.modality)

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
          const prefix = entry.name || 'anon'
          this.messages.push({ role: 'user', content: `${prefix}: ${entry.text}` })
        } else if (entry.type === 'system') {
          this.messages.push({ role: 'user', content: `* ${entry.text}` })
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
      const configName = roomConfig.name
      const client = new RoomClient(roomConfig, {
        agentName: config.display_name,
        onMessage: (event) => this._handleRemoteEvent(event, configName),
      })
      this.roomClients.set(configName, client)
      client.connect()
    }

    this._startIdleTimer()

    // Start wakeup schedulers if configured
    const wakeupConfigs = this.persona.config.wakeups
      || (this.persona.config.wakeup ? [this.persona.config.wakeup] : [])
    this._wakeupSchedulers = wakeupConfigs.map(wakeupConfig => {
      const scheduler = new WakeupScheduler(this.persona, wakeupConfig, async (prompt) => {
        const ownerName = this.persona.config.display_name || this.persona.config.name
        const label = wakeupConfig.name ? `${ownerName} (${wakeupConfig.name})` : ownerName
        const message = `[wakeup round] Scheduled wakeup for ${label}.\n\n${prompt}`
        await this.sendMessage('wakeup', message)
      })
      scheduler.start()
      return scheduler
    })
  }

  // Register an SSE client for broadcast
  addClient(res, name, isAgent = false) {
    this.clients.add(res)
    if (name) {
      this.participants.set(name, Date.now())
      this.broadcast({ type: 'presence', participants: this.participantList })
    }
    // Send scrollback — one history, one send
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
    const tagged = this.roomName ? { ...event, room: this.roomName } : event
    const data = `data: ${JSON.stringify(tagged)}\n\n`
    for (const client of this.clients) {
      client.write(data)
    }
  }

  /**
   * RAFT-like leader election. Returns the current leader name and advances
   * the index. If the elected leader is busy, cycles through the pool once
   * to find an available agent. Returns null if all are busy (shouldn't happen
   * since the host's busy flag is checked before calling this).
   */
  _electLeader() {
    if (this._leaderPool.length <= 1) return this._leaderPool[0] || null
    const pool = this._leaderPool
    const start = this._leaderIndex % pool.length
    this._leaderIndex++
    return pool[start]
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

  addAgentMessage(name, text, { source = 'user', model } = {}) {
    this._safeAppendMessage({ role: 'user', content: `${name}: ${text}` })
    this.broadcast({ type: 'user_message', name, text, fromAgent: true, model })
    const histEntry = { type: 'user_message', name, text, room: this.roomName }
    if (model) histEntry.model = model
    this.recordHistory(histEntry)
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    this._consecutiveDegenerateCount = 0 // new info arrived, worth thinking about
    if (source === 'user') {
      this._idleInterval = IDLE_THOUGHT_INTERVAL // reset backoff on direct interaction only
    }
    this._startIdleTimer()
  }

  addBackchannelMessage(name, text, options = {}) {
    this._safeAppendMessage({ role: 'user', content: `(backchannel) ${name}: ${text}` })

    if (options.trigger) {
      // Trigger processing with a nudge — the original message is already in context,
      // the backchannel just wakes the agent up to respond to what's there.
      // Use _silent flag to prevent broadcasting/recording the trigger message.
      this._processMessage('home', 'system', `(backchannel from ${name}) ${text} — respond to the conversation above.`, { _silent: true }).catch(err => {
        console.error(`[${this.persona.config.name}] Triggered backchannel error:`, err.message)
      })
    }
  }

  _autoNudgeMentionedAgents(publicText) {
    if (!publicText) return

    // Home room: nudge visiting agents (config.agents)
    if (this._pendingRoom === 'home') {
      const knownAgents = (this.persona.config.agents || []).map(a => a.name)
      for (const agentName of knownAgents) {
        const mentionPattern = new RegExp(`\\b${agentName}\\b`, 'i')
        if (!mentionPattern.test(publicText)) continue
        this.addBackchannelMessage('system', `Hey ${agentName}, you were just addressed in chat.`)
      }
    }

    // Remote room: nudge the room's agent via room client
    if (this._pendingRoom && this._pendingRoom !== 'home') {
      const roomName = this._pendingRoom
      const client = this.roomClients.get(roomName)
      if (!client) return

      const mentionPattern = new RegExp(`\\b${roomName}\\b`, 'i')
      if (!mentionPattern.test(publicText)) return
      client.sendBackchannel(`Hey ${roomName}, you were just addressed in chat.`)
    }
  }

  relayAgentEvent(name, event) {
    // Relay visiting agent tool events to SSE clients.
    // Does NOT interact with the agent loop, this.messages, or the busy flag.
    // Uses agentName key to avoid clobbering event.name (which is the tool name
    // on tool_start/tool_result events).
    //
    // Only tool_start/tool_result are relayed — text_delta/done are NOT forwarded
    // to avoid duplicate messages. The final public text arrives separately via
    // addAgentMessage after the agent loop completes.
    this.broadcast({ ...event, agentName: name, visiting: true })
  }

  _handleRemoteEvent(event, roomConfigName) {
    // Skip all host scrollback — visitor has own history from initialize()
    if (event.scrollback) return

    // Ignore DM user_message events — they're handled via dm_request
    if (event.to && event.type === 'user_message') return

    // DM requests are always processed regardless of room
    if (event.type === 'dm_request') {
      const myName = this.persona.config.display_name
      if (event.to === myName) {
        console.log(`[${this.persona.config.name}] Processing DM from ${event.from}`)
        this.processDM(event.from, event.text).catch(err => {
          console.error(`[${this.persona.config.name}] DM error:`, err.message)
        })
      }
      return
    }

    // Use the room config name for routing (e.g. 'red-room'), NOT the
    // host's channel tag ('#general'). The channel tag is preserved in
    // _pendingRoomChannel so the response is routed to the correct channel.
    const routeRoom = roomConfigName || event.room

    if (event.type === 'user_message') {
      if (event.fromAgent) {
        // Another agent spoke — don't add to context, don't trigger
        return
      } else {
        // Human message — check turn-taking leader + modality shift
        const myName = this.persona.config.display_name
        if (this.modality?.isModal) {
          if (event.leader === myName) {
            this.modality.stepUp('elected leader')
          } else {
            this.modality.stepDown('not leader')
          }
        }
        const mentionedByName = new RegExp(`\\b${myName}\\b`, 'i').test(event.text)
        if (mentionedByName) {
          if (this.modality?.isModal) this.modality.stepUp('addressed by name')
          console.log(`[${this.persona.config.name}] Mentioned by name — responding`)
          this._pendingRoomChannel = event.room || null
          this._processMessage(routeRoom, event.name, event.text)
        } else if (event.leader && event.leader !== myName) {
          // Not our turn — don't add to context, don't process
          console.log(`[${this.persona.config.name}] Deferring to ${event.leader}`)
        } else {
          console.log(`[${this.persona.config.name}] Taking the floor`)
          this._pendingRoomChannel = event.room || null
          this._processMessage(routeRoom, event.name, event.text)
        }
      }
    } else if (event.type === 'assistant_message') {
      // Host agent responded — don't add to visitor context
    } else if (event.type === 'backchannel') {
      this._safeAppendMessage({ role: 'user', content: `(backchannel) ${event.name}: ${event.text}` })
      if (event.trigger) {
        this._processMessage(routeRoom, 'system', `(backchannel from ${event.name}) ${event.text} — respond to the conversation above.`, { _silent: true })
      }
    } else if (event.type === 'idle_text_delta' || event.type === 'idle_done') {
      // Relay visiting agent idle thoughts to the host's SSE clients
      this.broadcast(event)
    } else if (event.type === 'idle_thought') {
      // Scrollback idle thought from visitor — record in host history
      this.recordHistory(event)
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

  /**
   * Process a DM to this agent. Runs the agent loop but routes the response
   * back as a DM instead of broadcasting to the room. No leader election.
   */
  async processDM(from, text) {
    if (this.busy) {
      this._messageQueue.push({ room: 'dm', name: from, text })
      return
    }

    this.busy = true
    try {
      if (!this.systemPrompt) await this.initialize()

      this.messages.push({ role: 'user', content: `${from}: ${text}` })
      this.recordHistory({ type: 'user_message', name: from, text, dm_from: from, dm_to: this.persona.config.display_name })

      const hasModality = this.modality?.isModal
      const hasOrchestrator = !hasModality && this.persona.config.orchestrator != null
      let orchestratorModel, orchestratorProvider, executorModel

      // DMs always use cognition if modal
      if (hasModality) {
        if (this.modality) this.modality.stepUp('direct message')
        const modalModel = this.modality.model
        const resolved = this.registry.resolve(modalModel)
        orchestratorModel = resolved.modelId
        orchestratorProvider = resolved.provider
        executorModel = this.persona.config.model
      } else if (hasOrchestrator) {
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
        maxTurns: 10,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: orchestratorProvider,
        executorProvider: null,
        executorModel: (hasOrchestrator || hasModality) ? executorModel : null,
        executorFallbackModels: (hasOrchestrator || hasModality) ? (this.persona.config.fallback_models || []) : [],
        orchestratorFallbackModels: (hasOrchestrator || hasModality)
          ? (this.persona.config.orchestrator_fallback_models || this.persona.config.cognition_fallback_models || [])
          : [],
        registry: this.registry,
        modality: null, // no gear shifting in DMs
      }

      let assistantText = ''
      const onEvent = () => {} // DMs don't stream to room

      const activeIsClaude = orchestratorModel.startsWith('claude')
      const basePrompt = activeIsClaude
        ? this.systemPrompt
        : await assemblePrompt(this.persona.dir, this.persona.config, this.persona.plugins, { isClaude: false })
      const prompt = replaceTimestamp(basePrompt)
      const agentFn = (hasOrchestrator || hasModality) ? runHybridAgent : runAgent
      const result = await agentFn(prompt, this.messages, this.tools, agentConfig, (event) => {
        if (event.type === 'text_delta') assistantText += event.text
      })
      this.messages = result.messages
      // Trim context to prevent unbounded growth
      if (this.messages.length > MAX_CONTEXT_MESSAGES) {
        this.messages = this.messages.slice(-MAX_CONTEXT_MESSAGES)
      }

      // Route response back as a DM — strip any DM prefix the agent may have echoed
      let dmResponse = assistantText.trim()
      // Strip all (DM ...) prefixes the agent may have echoed
      while (/^\(DM[^)]*\)\s*/i.test(dmResponse)) {
        dmResponse = dmResponse.replace(/^\(DM[^)]*\)\s*/i, '')
      }
      if (dmResponse) {
        this.recordHistory({ type: 'assistant_message', text: dmResponse, dm_from: this.persona.config.display_name, dm_to: from })
        const agentName = this.persona.config.display_name
        if (this.roomClients.size > 0) {
          for (const client of this.roomClients.values()) {
            await client.sendDMResponse(from, dmResponse)
            break
          }
        } else if (this._roomManager) {
          this._roomManager.routeDM(agentName, from, dmResponse, true)
        }
      }
    } catch (err) {
      console.error(`[${this.persona.config.name}] DM error:`, err.message)
    } finally {
      this.busy = false
      if (this._pendingContextMessages && this._pendingContextMessages.length > 0) {
        for (const msg of this._pendingContextMessages) {
          this.messages.push(msg)
        }
        this._pendingContextMessages = []
      }
      this._startIdleTimer()

      // Drain queued messages on correct Room instance
      if (this._messageQueue.length > 0) {
        const next = this._messageQueue.shift()
        const targetRoom = next._roomInstance || this
        if (next.room === 'dm') {
          targetRoom.processDM(next.name, next.text).catch(err => {
            console.error(`[${this.persona.config.name}] Queued DM error:`, err.message)
          })
        } else {
          targetRoom._processMessage(next.room, next.name, next.text).catch(err => {
            console.error(`[${this.persona.config.name}] Queued message error:`, err.message)
          })
        }
      }
    }
  }

  async _processMessage(room, name, text, options = {}) {
    if (this.busy) {
      if (room === 'home' && name === 'webhook') {
        const webhookCount = this._messageQueue.filter(m => m.name === 'webhook').length
        if (webhookCount >= MAX_QUEUED_WEBHOOKS) {
          console.warn(`[${this.persona.config.name}] Webhook queue full (${MAX_QUEUED_WEBHOOKS}), dropping webhook`)
          return
        }
        this._messageQueue.push({ room, name, text })
      } else if (room === 'home' && name !== 'system') {
        // Queue human messages — broadcast immediately so they appear in chat
        this.broadcast({ type: 'user_message', name, text })
        this.recordHistory({ type: 'user_message', name, text, room: this.roomName })
        this._messageQueue.push({ room, name, text, _roomInstance: this })
      } else {
        this._messageQueue.push({ room, name, text, _roomInstance: this })
      }
      return
    }

    this.busy = true
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    if (room === 'home') {
      this._idleInterval = IDLE_THOUGHT_INTERVAL // reset backoff on direct user activity only
      this._consecutiveDegenerateCount = 0
    }
    this._pendingRoom = room

    try {
      if (!this.systemPrompt) await this.initialize()

      const presence = room === 'home' ? ` (present: ${this.participantList.join(', ')})` : ''
      this.messages.push({ role: 'user', content: `${name}${presence}: ${text}` })

      // Multi-agent turn-taking: check for direct address, else rotate
      // Skip leader election for system/backchannel-triggered messages
      let leader = null
      const isMultiAgent = room === 'home' && this._leaderPool.length > 1 && name !== 'system'
      if (isMultiAgent) {
        // If the message mentions a specific agent by name, they get the floor
        for (const agentName of this._leaderPool) {
          if (new RegExp(`\\b${agentName}\\b`, 'i').test(text)) {
            leader = agentName
            break
          }
        }
        if (!leader) {
          leader = this._electLeader()
        }
        console.log(`[${this.persona.config.name}] Turn leader: ${leader} (pool: ${this._leaderPool.join(', ')})`)
      }

      if (room === 'home' && !options._silent) {
        if (name) this.participants.set(name, Date.now())
        this.broadcast({ type: 'user_message', name, text, leader })
        this.recordHistory({ type: 'user_message', name, text, room: this.roomName })
      }

      // Modality gear shift on leader election: leader steps up, others step down
      const myName = this.persona.config.display_name
      if (leader && this.modality?.isModal) {
        if (leader === myName) {
          this.modality.stepUp('elected leader')
        } else {
          this.modality.stepDown('not leader')
        }
      }

      // If another agent is the leader for this turn, defer — don't respond
      if (leader && leader !== myName) {
        console.log(`[${this.persona.config.name}] Deferring to ${leader}`)
        if (room === 'home') {
          this.broadcast({ type: 'done', model: null, deferred: true })
        }
        return // skip agent loop — finally block handles cleanup
      }

      // Build leader duties addendum for the system prompt (not injected into messages)
      let leaderAddendum = ''
      if (leader && leader === myName) {
        const otherAgents = this._leaderPool.filter(n => n !== myName).join(', ')
        leaderAddendum = [
          `\n\n## CURRENT TURN: You are the leader`,
          `Decide who should respond to the message above:`,
          `- If addressed to everyone: call internal({ backchannel: "All agents respond", trigger: true }) BEFORE responding. ${otherAgents} cannot speak unless you trigger them.`,
          `- If meant for another agent: call internal({ backchannel: "This is for you", trigger: true }) to hand off.`,
          `- If just for you: respond normally.`,
          `If you skip the trigger, other agents stay silent. This is your responsibility.`,
        ].join('\n')
      }

      // Determine mode: modal (attention/cognition), hybrid (orchestrator), or direct
      const hasModality = this.modality?.isModal
      const hasOrchestrator = !hasModality && this.persona.config.orchestrator != null
      let orchestratorModel, orchestratorProvider, executorModel

      if (hasModality) {
        // Modal mode — resolve model from current modality state
        const modalModel = this.modality.model
        const resolved = this.registry.resolve(modalModel)
        orchestratorModel = resolved.modelId
        orchestratorProvider = resolved.provider
        executorModel = this.persona.config.model
      } else if (hasOrchestrator) {
        // Orchestrator model: string (new) or object with .model (legacy)
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
        maxTurns: this.persona.config.chat?.max_turns || 20,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: orchestratorProvider,
        executorProvider: null,
        executorModel: (hasOrchestrator || hasModality) ? executorModel : null,
        executorFallbackModels: (hasOrchestrator || hasModality) ? (this.persona.config.fallback_models || []) : [],
        orchestratorFallbackModels: (hasOrchestrator || hasModality)
          ? (this.persona.config.orchestrator_fallback_models || this.persona.config.cognition_fallback_models || [])
          : [],
        registry: this.registry,
        modality: hasModality ? this.modality : null,
      }

      let assistantText = ''
      let assistantModel = null
      // Emit the model name immediately so the UI can label all messages from the start
      if (this._pendingRoom === 'home') {
        this.broadcast({ type: 'response_model', model: orchestratorModel })
      }
      const onEvent = (event) => {
        if (event.type === 'text_delta') {
          assistantText += event.text
        }
        if (event.type === 'done' && event.model) {
          assistantModel = event.model
        }
        // Tag all tool events with the model that initiated them
        // (executor events already have model from the hybrid loop wrapper)
        if ((event.type === 'tool_start' || event.type === 'tool_result') && !event.model) {
          event.model = orchestratorModel
        }
        if (this._pendingRoom === 'home') {
          this.broadcast(event)
        } else if (event.type === 'tool_start' || event.type === 'tool_result') {
          // Forward tool events to remote office so visitors can see what we're doing.
          // text_delta/done are NOT forwarded — the final public text arrives via
          // sendMessage() after the agent loop completes.
          const client = this.roomClients.get(this._pendingRoom)
          if (client) client.sendEvent(event, this._pendingRoomChannel)
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

      // Non-Claude models get the hierarchical soul corpus, assembled fresh
      const activeIsClaude = orchestratorModel.startsWith('claude')
      const basePrompt = activeIsClaude
        ? this.systemPrompt
        : await assemblePrompt(this.persona.dir, this.persona.config, this.persona.plugins, { isClaude: false })
      let prompt = replaceTimestamp(basePrompt)
      // Append leader duties to system prompt — NOT to messages (prevents echo leak)
      if (leaderAddendum) {
        if (typeof prompt === 'string') {
          prompt += leaderAddendum
        } else if (Array.isArray(prompt)) {
          const last = prompt[prompt.length - 1]
          prompt[prompt.length - 1] = { ...last, content: last.content + leaderAddendum }
        }
      }
      const agentFn = (hasOrchestrator || hasModality) ? runHybridAgent : runAgent
      const result = await agentFn(prompt, this.messages, this.tools, agentConfig, onEvent)
      this.messages = result.messages
      // Trim context to prevent unbounded growth
      if (this.messages.length > MAX_CONTEXT_MESSAGES) {
        this.messages = this.messages.slice(-MAX_CONTEXT_MESSAGES)
      }

      // Route response — freeform text is always public
      if (this._pendingRoom === 'home') {
        if (assistantText.trim()) {
          const histEntry = { type: 'assistant_message', text: assistantText.trim(), room: this.roomName }
          if (assistantModel) histEntry.model = assistantModel
          this.recordHistory(histEntry)
        }
        this._autoNudgeMentionedAgents(assistantText)
      } else {
        const client = this.roomClients.get(this._pendingRoom)
        if (client && assistantText.trim()) {
          // Include the host's room name so the response routes to the correct channel
          await client.sendMessage(assistantText.trim(), { model: assistantModel, room: this._pendingRoomChannel })
        }
        // Record remote interactions in own history for continuity across restarts
        this.recordHistory({ type: 'user_message', name, text })
        if (assistantText.trim()) {
          const histEntry = { type: 'assistant_message', text: assistantText.trim() }
          if (assistantModel) histEntry.model = assistantModel
          this.recordHistory(histEntry)
        }
        this._autoNudgeMentionedAgents(assistantText)
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
        // Process on the correct Room instance (may differ from current Room)
        const targetRoom = next._roomInstance || this
        if (next.room === 'dm') {
          targetRoom.processDM(next.name, next.text).catch(err => {
            console.error(`[${this.persona.config.name}] Queued DM processing error:`, err.message)
          })
        } else {
          targetRoom._processMessage(next.room, next.name, next.text).catch(err => {
            console.error(`[${this.persona.config.name}] Queue processing error:`, err.message)
          })
        }
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

      const hasModality = this.modality?.isModal
      const hasOrchestrator = !hasModality && this.persona.config.orchestrator != null
      let orchestratorModel, orchestratorProvider, executorModel

      if (hasModality) {
        // Non-leaders step down on idle; leader stays in cognition
        const currentLeader = this._leaderPool[((this._leaderIndex - 1) % this._leaderPool.length + this._leaderPool.length) % this._leaderPool.length]
        const isLeader = currentLeader === this.persona.config.display_name
        if (!isLeader) this.modality.stepDown('idle — not leader')
        const modalModel = isLeader ? this.modality.model : this.modality.attentionModel
        const resolved = this.registry.resolve(modalModel)
        orchestratorModel = resolved.modelId
        orchestratorProvider = resolved.provider
        executorModel = this.persona.config.model
      } else if (hasOrchestrator) {
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
        executorModel: (hasOrchestrator || hasModality) ? executorModel : null,
        executorFallbackModels: (hasOrchestrator || hasModality) ? (this.persona.config.fallback_models || []) : [],
        orchestratorFallbackModels: (hasOrchestrator || hasModality)
          ? (this.persona.config.orchestrator_fallback_models || this.persona.config.cognition_fallback_models || [])
          : [],
        registry: this.registry,
        modality: null, // idle thoughts don't get gear-shifting
      }

      // Wrap events as idle thoughts for the UI — broadcast errors must not
      // abort the agent call, so catch them individually
      let idleText = ''
      let idleModel = null
      let toolUseCount = 0
      const agentName = this.persona.config.display_name
      const onEvent = (event) => {
        try {
          if (event.type === 'text_delta') {
            idleText += event.text
            this.broadcast({ type: 'idle_text_delta', text: event.text, name: agentName })
          } else if (event.type === 'done') {
            if (event.model) idleModel = event.model
            this.broadcast({ type: 'idle_done', model: event.model, name: agentName })
          } else if (event.type === 'tool_start') {
            toolUseCount++
            this.broadcast({ ...event, idle: true })
          } else if (event.type === 'tool_result') {
            this.broadcast({ ...event, idle: true })
          }
        } catch (err) {
          console.error(`[${this.persona.config.name}] Idle broadcast error:`, err.message)
        }
      }

      const activeIsClaude = orchestratorModel.startsWith('claude')
      const basePrompt = activeIsClaude
        ? this.systemPrompt
        : await assemblePrompt(this.persona.dir, this.persona.config, this.persona.plugins, { isClaude: false })
      const prompt = replaceTimestamp(basePrompt)
      const agentFn = (hasOrchestrator || hasModality) ? runHybridAgent : runAgent
      const result = await agentFn(prompt, idleMessages, this.tools, agentConfig, onEvent)

      // Degenerate detection: discard if output is trivial with no real work
      const outputTokens = (result.usage?.output_tokens || 0)
      const isDegenerate = outputTokens <= 50
        && toolUseCount === 0
        && (!idleText || !idleText.trim())

      if (isDegenerate) {
        console.log(`[${this.persona.config.name}] Idle thought degenerate (${outputTokens} tokens, ${toolUseCount} tools, text=${!!idleText?.trim()}) — discarded`)
        return 'degenerate'
      }

      this.messages = result.messages
      // Trim context to prevent unbounded growth
      if (this.messages.length > MAX_CONTEXT_MESSAGES) {
        this.messages = this.messages.slice(-MAX_CONTEXT_MESSAGES)
      }
      if (idleText) {
        const histEntry = { type: 'idle_thought', text: idleText, name: agentName }
        if (idleModel) histEntry.model = idleModel
        this.recordHistory(histEntry)
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
          if (completed === 'degenerate') {
            this._idleInterval = Math.min(this._idleInterval * 2, MAX_IDLE_INTERVAL)
            this._consecutiveDegenerateCount++

            if (this._consecutiveDegenerateCount >= 5) {
              console.log(`[${this.persona.config.name}] idle thoughts suspended after 5 consecutive degenerate results`)
              return // don't reschedule
            }
          } else if (completed === true) {
            this._idleInterval = Math.min(this._idleInterval * 2, MAX_IDLE_INTERVAL)
            this._consecutiveDegenerateCount = 0
          } else {
            // completed === false (error/skipped) — don't change interval
            this._consecutiveDegenerateCount = 0
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
    if (this._wakeupSchedulers) this._wakeupSchedulers.forEach(s => s.destroy())
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
