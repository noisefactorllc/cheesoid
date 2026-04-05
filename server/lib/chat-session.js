import { randomUUID } from 'node:crypto'
import { assemblePrompt, currentTimestamp } from './prompt-assembler.js'

// Short 8-char hex message IDs — full UUIDs are too long for LLMs to reliably
// echo back when calling reply_to_message or react_to_message. 8 hex chars
// gives 4 billion possible values, more than enough uniqueness in a 75-message
// scrollback window.
function shortMsgId() {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}
import { assembleDMNPrompt } from './dmn.js'
import { Memory } from './memory.js'
import { State } from './state.js'
import { ToolJournal } from './tool-journal.js'
import { ChatLog } from './chat-log.js'
import { loadTools } from './tools.js'
import { runAgent, runHybridAgent } from './agent.js'
import { ProviderRegistry } from './providers/index.js'
import { Modality } from './modality.js'
import { RoomClient } from './room-client.js'
import { WakeupScheduler } from './wakeup.js'

// Matches common API key patterns: sk-*, key-*, vendor_sk_*, Bearer tokens, hex/base64 strings 32+ chars
const API_KEY_PATTERN = /\b(sk-[a-zA-Z0-9_-]{20,}|[a-zA-Z0-9]+_sk_[a-zA-Z0-9_-]{20,}|key-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{36,}|ghu_[a-zA-Z0-9]{36,}|xoxb-[a-zA-Z0-9-]{20,}|xoxp-[a-zA-Z0-9-]{20,}|AKIA[A-Z0-9]{16}|eyJ[a-zA-Z0-9_-]{40,}\.[a-zA-Z0-9_-]{40,}|[a-zA-Z0-9_-]{40,}(?=["'\s,}\]\\]))/g

export function redactKeys(str) {
  return str.replace(API_KEY_PATTERN, '**[Redacted by Cheesoid]**')
}

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
const MAX_HISTORY = 75
const MAX_CONTEXT_MESSAGES = 75 // max messages in the live agent context
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
        _lastRemoteRoom: null,
        _lastRemoteRoomChannel: null,
        _messageQueue: [],
        _idleInterval: IDLE_THOUGHT_INTERVAL,
        _consecutiveDegenerateCount: 0,
        _destroyed: false,
        _sessionStartHandled: false,
        _pendingContextMessages: [],
        _moderatorPool: [persona.config.display_name],
        _moderatorIndex: 0,
        _floor: null, // array of agent names that currently have the floor, or null
        _wakeupSchedulers: [],
        _dmnPrompt: null, // assembled once at init if config.dmn is set
      }
      for (const a of persona.config.agents || []) {
        this._a._moderatorPool.push(a.name)
      }
    }

    // Venue awareness
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
  get _lastRemoteRoom() { return this._a._lastRemoteRoom }
  set _lastRemoteRoom(v) { this._a._lastRemoteRoom = v }
  get _lastRemoteRoomChannel() { return this._a._lastRemoteRoomChannel }
  set _lastRemoteRoomChannel(v) { this._a._lastRemoteRoomChannel = v }
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
  get _moderatorPool() { return this._a._moderatorPool }
  set _moderatorPool(v) { this._a._moderatorPool = v }
  get _moderatorIndex() { return this._a._moderatorIndex }
  set _moderatorIndex(v) { this._a._moderatorIndex = v }
  get _floor() { return this._a._floor }
  set _floor(v) { this._a._floor = v }
  get _wakeupSchedulers() { return this._a._wakeupSchedulers }
  set _wakeupSchedulers(v) { this._a._wakeupSchedulers = v }
  get _dmnPrompt() { return this._a._dmnPrompt }
  set _dmnPrompt(v) { this._a._dmnPrompt = v }

  async initialize() {
    if (this.systemPrompt) return // already initialized

    const { dir, config, plugins } = this.persona
    this.memory = new Memory(dir, config.memory?.dir || 'memory/')
    this.state = new State(dir)
    this.chatLog = new ChatLog(dir, 'history')
    this.toolJournal = new ToolJournal(dir, config.memory?.dir || 'memory/')
    await this.state.load()
    this.systemPrompt = await assemblePrompt(dir, config, plugins, { toolJournal: this.toolJournal })
    this.registry = new ProviderRegistry(config)

    // Modal mode: attention/cognition gear shifting
    if (config.cognition?.length && config.attention?.length) {
      this.modality = new Modality({
        attention: config.attention,
        cognition: config.cognition,
      })
    }

    // DMN prompt — assembled once at init if configured
    if (config.dmn) {
      this._dmnPrompt = await assembleDMNPrompt(dir, config)
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
      const data = redactKeys(`data: ${JSON.stringify({ type: 'scrollback', messages: scrollback })}\n\n`)
      res.write(data)
    }

    // Send moderator pool to agents so they know the full participant list
    if (isAgent && this._moderatorPool.length > 1) {
      res.write(redactKeys(`data: ${JSON.stringify({ type: 'moderator_pool', pool: this._moderatorPool })}\n\n`))
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
    const HIDDEN_NAMES = new Set(['system', 'webhook', 'wakeup'])
    return this.history.filter(msg => !HIDDEN_NAMES.has(msg.name))
  }

  /**
   * Resolve DMN provider and model from config. Returns fields to spread
   * into agentConfig. No-op when DMN is not configured.
   */
  _resolveDMNConfig() {
    if (!this.persona.config.dmn || !this._dmnPrompt) {
      return { dmnProvider: null, dmnModel: null, dmnPrompt: null, displayName: this.persona.config.display_name || this.persona.config.name }
    }
    try {
      const resolved = this.registry.resolve(this.persona.config.dmn)
      return {
        dmnProvider: resolved.provider,
        dmnModel: resolved.modelId,
        dmnPrompt: this._dmnPrompt,
        displayName: this.persona.config.display_name || this.persona.config.name,
      }
    } catch (err) {
      console.log(`[${this.persona.config.name}] DMN model resolution failed: ${err.message}`)
      return { dmnProvider: null, dmnModel: null, dmnPrompt: null, displayName: this.persona.config.display_name || this.persona.config.name }
    }
  }

  // Send event to all connected clients
  broadcast(event) {
    const tagged = this.roomName ? { ...event, room: this.roomName } : event
    const data = redactKeys(`data: ${JSON.stringify(tagged)}\n\n`)
    for (const client of this.clients) {
      client.write(data)
    }
  }

  /**
   * RAFT-like moderator election. Returns the current moderator name and advances
   * the index. If the elected moderator is busy, cycles through the pool once
   * to find an available agent. Returns null if all are busy (shouldn't happen
   * since the host's busy flag is checked before calling this).
   */
  _electModerator() {
    if (this._moderatorPool.length <= 1) return this._moderatorPool[0] || null
    const pool = this._moderatorPool
    const start = this._moderatorIndex % pool.length
    this._moderatorIndex++
    return pool[start]
  }

  /**
   * Parse explicit addressing patterns from message text.
   * Returns array of addressed agent names, or null if no explicit addressing.
   *
   * Patterns:
   *   @Name or @ Name         → ["Name"]
   *   @Name @Other             → ["Name", "Other"]
   *   Name: ...                → ["Name"]
   *   Name, ...               → ["Name"] (name at very start followed by comma)
   *   Name, Other: ...        → ["Name", "Other"]
   *   Name and Other: ...     → ["Name", "Other"]
   */
  _parseAddressing(text) {
    const pool = this._moderatorPool
    const addressed = new Set()

    // Pattern 1: @Name or @ Name (anywhere in text)
    for (const agentName of pool) {
      if (new RegExp(`@\\s*${agentName}\\b`, 'i').test(text)) {
        addressed.add(agentName)
      }
    }
    if (addressed.size > 0) return [...addressed]

    // Pattern 2: Names at the start of the message before a colon or dash
    // e.g. "Blue: do this", "Blue, Green: quick check", "Red and Green - what do you think"
    // First try colon/dash (strongest signal — captures full address prefix)
    const colonMatch = text.match(/^([^:\-\n]{1,60})[:\-]\s/)
    if (colonMatch) {
      const prefix = colonMatch[1]
      for (const agentName of pool) {
        if (new RegExp(`\\b${agentName}\\b`, 'i').test(prefix)) {
          addressed.add(agentName)
        }
      }
      if (addressed.size > 0) return [...addressed]
    }

    // Pattern 3: Name is the first word of the message
    // e.g. "Blue how are you", "Blue, can you", "Blue. do this", "Blue!"
    const firstWord = text.match(/^(\w+)[\s.,!?;]/)
    if (firstWord) {
      for (const agentName of pool) {
        if (agentName.toLowerCase() === firstWord[1].toLowerCase()) {
          addressed.add(agentName)
          return [...addressed]
        }
      }
    }

    return null
  }

  _timestamp() {
    const now = new Date()
    const h = now.getHours().toString().padStart(2, '0')
    const m = now.getMinutes().toString().padStart(2, '0')
    return `${h}:${m}`
  }

  _domainSuffix(room) {
    const domain = this.roomDomains.get(room)
    return domain ? `@${domain}` : ''
  }

  addAgentMessage(name, text, { source = 'user', model, replyTo } = {}) {
    const msgId = shortMsgId()
    const idTag = replyTo ? ` [${msgId}] (replying to ${replyTo})` : ` [${msgId}]`
    this._safeAppendMessage({ role: 'user', content: `${name}${idTag}: ${text}` })
    const event = { type: 'user_message', name, text, fromAgent: true, model, id: msgId }
    if (replyTo) event.replyTo = replyTo
    this.broadcast(event)
    const histEntry = { type: 'user_message', name, text, room: this.roomName, id: msgId }
    if (model) histEntry.model = model
    if (replyTo) histEntry.replyTo = replyTo
    this.recordHistory(histEntry)
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    this._consecutiveDegenerateCount = 0 // new info arrived, worth thinking about
    if (source === 'user') {
      this._idleInterval = IDLE_THOUGHT_INTERVAL // reset backoff on direct interaction only
    }
    this._startIdleTimer()
  }

  addReaction(name, messageId, emoji, action = 'add') {
    const event = { type: 'reaction', messageId, emoji, name, action }
    this.broadcast(event)
    this.recordHistory(event)
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
    // Relay visiting agent events to SSE clients.
    // Does NOT interact with the agent loop, this.messages, or the busy flag.
    // Uses agentName key to avoid clobbering event.name (which is the tool name
    // on tool_start/tool_result events).
    //
    // For tool_start/tool_result and idle streaming events: broadcast to SSE.
    // For idle_thought: also record in host history for scrollback.
    this.broadcast({ ...event, agentName: name, visiting: true })
    if (event.type === 'idle_thought') {
      this.recordHistory(event)
    }
  }

  _handleRemoteEvent(event, roomConfigName) {
    // Log moderator pool from host — but do NOT overwrite our local pool.
    // The local _moderatorPool drives isMultiAgent, addressing, and moderator
    // election for the HOME room. Syncing the remote pool here corrupts those
    // checks (e.g. wakeup messages get skipped because a remote agent wins
    // the moderator election in the local room).
    if (event.type === 'moderator_pool') {
      console.log(`[${this.persona.config.name}] Remote moderator pool: ${event.pool.join(', ')}`)
      return
    }

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
        // Human message — check floor control
        const myName = this.persona.config.display_name
        const floor = event.floor
        // Always add human messages to context so we know what's being discussed
        const idTag = event.id ? ` [${event.id}]` : ''
        this._safeAppendMessage({ role: 'user', content: `${event.name}${idTag}: ${event.text}` })

        if (floor && floor.includes(myName)) {
          // On the floor — respond
          if (this.modality?.isModal) this.modality.stepUp('has floor')
          console.log(`[${this.persona.config.name}] Has floor — responding`)
          this._pendingRoomChannel = event.room || null
          this._processMessage(routeRoom, event.name, event.text, { _roomChannel: event.room })
        } else if (floor) {
          // Floor belongs to someone else — stay silent
          if (this.modality?.isModal) this.modality.stepDown('not on floor')
          console.log(`[${this.persona.config.name}] Not on floor (${floor.join(', ')}) — silent`)
        } else {
          // No floor set — wait for moderator's backchannel trigger
          if (this.modality?.isModal) this.modality.stepDown('awaiting moderation')
          console.log(`[${this.persona.config.name}] Waiting for moderator trigger`)
        }
      }
    } else if (event.type === 'assistant_message') {
      // Host agent responded — don't add to visitor context
    } else if (event.type === 'backchannel') {
      const myName = this.persona.config.display_name
      // Skip if targeted to a different agent
      if (event.target && event.target !== myName) return
      this._safeAppendMessage({ role: 'user', content: `(backchannel) ${event.name}: ${event.text}` })
      if (event.trigger) {
        if (this.busy) {
          console.log(`[${this.persona.config.name}] Skipping backchannel trigger — already responding`)
          return
        }
        this._processMessage(routeRoom, 'system', `(backchannel from ${event.name}) ${event.text} — respond to the conversation above.`, { _silent: true })
      }
    } else if (event.type === 'reaction') {
      // Relay reaction events so visitor UIs see them + persist for scrollback
      this.broadcast(event)
      this.recordHistory(event)
    } else if (event.type === 'assistant_message_id') {
      // Relay so visitor UIs can tag assistant messages
      this.broadcast(event)
    } else if (event.type === 'idle_text_delta' || event.type === 'idle_done' || event.type === 'idle_thought') {
      // Suppress own idle events bounced back from the host — we already
      // broadcast them locally in _idleThought's onEvent callback.
      if (event.name === this.persona.config.display_name) return
      this.broadcast(event)
      if (event.type === 'idle_thought') this.recordHistory(event)
    }
  }

  /** Record a tool_result event to the persistent journal (fire-and-forget). */
  _recordToolUse(event) {
    if (event.type !== 'tool_result' || !this.toolJournal) return
    this.toolJournal.record(event.name, event.input, event.result).catch(() => {})
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

  async sendMessage(name, userMessage, options = {}) {
    await this._processMessage('home', name, userMessage, options)
  }

  /**
   * Process a DM to this agent. Runs the agent loop but routes the response
   * back as a DM instead of broadcasting to the room. No moderator election.
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
        executorModel = this.persona.config.model?.[0]
      } else if (hasOrchestrator) {
        const orchModelStr = typeof this.persona.config.orchestrator === 'string'
          ? this.persona.config.orchestrator
          : this.persona.config.orchestrator.model
        const orchResolved = this.registry.resolve(orchModelStr)
        orchestratorModel = orchResolved.modelId
        orchestratorProvider = orchResolved.provider
        executorModel = this.persona.config.model?.[0]
      } else {
        const mainResolved = this.registry.resolve(this.persona.config.model[0])
        orchestratorModel = mainResolved.modelId
        orchestratorProvider = mainResolved.provider
      }

      const agentConfig = {
        model: orchestratorModel,
        layer: this.modality?.mode,
        maxTurns: 10,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: orchestratorProvider,
        executorProvider: null,
        executorModel: (hasOrchestrator || hasModality) ? executorModel : null,
        executorFallbackModels: (hasOrchestrator || hasModality) ? (this.persona.config.model?.slice(1) || []) : [],
        orchestratorFallbackModels: (hasOrchestrator || hasModality)
          ? (this.modality?.fallbackModels || [])
          : [],
        registry: this.registry,
        modality: null, // no gear shifting in DMs
        ...this._resolveDMNConfig(),
      }

      let assistantText = ''
      let assistantModel = null

      const activeIsClaude = orchestratorModel.startsWith('claude')
      const basePrompt = activeIsClaude
        ? this.systemPrompt
        : await assemblePrompt(this.persona.dir, this.persona.config, this.persona.plugins, { isClaude: false, toolJournal: this.toolJournal })
      const prompt = replaceTimestamp(basePrompt)
      const agentFn = (hasOrchestrator || hasModality) ? runHybridAgent : runAgent
      const result = await agentFn(prompt, this.messages, this.tools, agentConfig, (event) => {
        if (event.type === 'text_delta') assistantText += event.text
        else if (event.type === 'done' && event.model) assistantModel = event.model
        this._recordToolUse(event)
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
        const histEntry = { type: 'assistant_message', text: dmResponse, dm_from: this.persona.config.display_name, dm_to: from }
        if (assistantModel) histEntry.model = assistantModel
        this.recordHistory(histEntry)
        const agentName = this.persona.config.display_name
        if (this.roomClients.size > 0) {
          for (const client of this.roomClients.values()) {
            await client.sendDMResponse(from, dmResponse, assistantModel)
            break
          }
        } else if (this._roomManager) {
          this._roomManager.routeDM(agentName, from, dmResponse, true, assistantModel)
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
        const queuedReplyTo = options._replyTo || null
        const queuedMessageId = shortMsgId()
        this.broadcast({ type: 'user_message', name, text, id: queuedMessageId, ...(queuedReplyTo && { replyTo: queuedReplyTo }) })
        this.recordHistory({ type: 'user_message', name, text, room: this.roomName, id: queuedMessageId, ...(queuedReplyTo && { replyTo: queuedReplyTo }) })
        this._messageQueue.push({ room, name, text, _roomInstance: this, _roomChannel: options._roomChannel, _alreadyBroadcast: true, _replyTo: queuedReplyTo, _messageId: queuedMessageId })
      } else {
        this._messageQueue.push({ room, name, text, _roomInstance: this, _roomChannel: options._roomChannel })
      }
      return
    }

    // Restore room channel from options (used when draining queued messages)
    if (options._roomChannel !== undefined) {
      this._pendingRoomChannel = options._roomChannel
    }

    this.busy = true
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    if (room === 'home') {
      this._idleInterval = IDLE_THOUGHT_INTERVAL // reset backoff on direct user activity only
      this._consecutiveDegenerateCount = 0
    }
    this._pendingRoom = room
    if (room !== 'home') {
      this._lastRemoteRoom = room
      this._lastRemoteRoomChannel = this._pendingRoomChannel || null
    }

    try {
      if (!this.systemPrompt) await this.initialize()

      const presence = room === 'home' ? ` (present: ${this.participantList.join(', ')})` : ''
      const messageId = options._messageId || ((room === 'home' && !options._silent && name !== 'system' && name !== 'webhook' && name !== 'wakeup') ? shortMsgId() : null)
      const idTag = messageId ? ` [${messageId}]` : ''
      const replyTo = options._replyTo || null
      const replyTag = replyTo ? ` (replying to ${replyTo})` : ''
      this.messages.push({ role: 'user', content: `${name}${idTag}${presence}${replyTag}: ${text}` })

      // Multi-agent floor control.
      // 1. Explicit addressing (@Name, Name:) updates the floor
      // 2. If no addressing, the current floor persists (conversation continues)
      // 3. If no floor set, moderator orchestrates
      const myName = this.persona.config.display_name
      const isMultiAgent = room === 'home' && this._moderatorPool.length > 1 && name !== 'system'
      let addressed = options._addressed || null
      let floor = this._floor
      let moderator = null

      if (isMultiAgent) {
        if (!addressed) {
          addressed = this._parseAddressing(text)
        }

        if (addressed) {
          // Explicit addressing — update the floor
          this._floor = addressed
          floor = addressed
          console.log(`[${this.persona.config.name}] Floor → ${floor.join(', ')} (explicit)`)
        } else if (floor) {
          // No explicit addressing — floor persists, host joins as fallback
          if (!floor.includes(myName)) {
            floor = [...floor, myName]
          }
          console.log(`[${this.persona.config.name}] Floor: ${floor.join(', ')} (continuing + host)`)
        } else {
          // No floor set — moderator orchestrates
          moderator = this._electModerator()
          console.log(`[${this.persona.config.name}] Moderator: ${moderator} (no floor, pool: ${this._moderatorPool.join(', ')})`)
        }
      }

      if (room === 'home' && !options._silent) {
        if (name) this.participants.set(name, Date.now())
        if (name !== 'system' && name !== 'webhook' && name !== 'wakeup' && !options._alreadyBroadcast) {
          this.broadcast({ type: 'user_message', name, text, moderator, floor, ...(messageId && { id: messageId }), ...(replyTo && { replyTo }) })
        }
        this.recordHistory({ type: 'user_message', name, text, room: this.roomName, ...(messageId && { id: messageId }), ...(replyTo && { replyTo }) })
      }

      // Modality: step up when we have the floor or are orchestrating
      const iHaveFloor = floor ? floor.includes(myName) : !!moderator
      if (this.modality?.isModal) {
        if (options._silent) {
          // Silent messages are backchannel triggers — always step up.
          // This runs AFTER floor logic so it can't be overridden by stepDown.
          this.modality.stepUp('backchannel trigger')
        } else if (iHaveFloor) {
          this.modality.stepUp('has floor')
        } else if (!floor) {
          this.modality.stepUp('orchestrating')
        } else {
          this.modality.stepDown('not on floor')
        }
      }

      // Build moderator addendum — only when no floor is set and moderator is active.
      // The moderator's job: decide who gets the floor, trigger them, update floor.
      let moderatorAddendum = ''
      if (moderator && !floor) {
        const otherAgents = this._moderatorPool.filter(n => n !== myName).join(', ')
        moderatorAddendum = [
          `\n\n## CURRENT TURN: You are the moderator`,
          `No one has the floor. Decide who should respond to the message above:`,
          `- If addressed to everyone: call internal({ backchannel: "respond to ${name}'s message", trigger: true }) BEFORE responding. ${otherAgents} cannot speak unless you trigger them.`,
          `- If meant for a specific agent: call internal({ backchannel: "respond to ${name}'s message", trigger: true, target: "[agent name]" }) to wake only that agent, then stay silent.`,
          `- If just for you: respond normally.`,
          `If you skip the trigger, other agents stay silent. This is your responsibility.`,
        ].join('\n')
      }

      // Inject floor context into the message so agents know who's speaking
      if (isMultiAgent && floor) {
        const floorNote = `[floor: ${floor.join(', ')}]`
        // Append to the user message already pushed
        const lastMsg = this.messages[this.messages.length - 1]
        if (lastMsg?.role === 'user') {
          lastMsg.content += `\n${floorNote}`
        }
      }

      // Skip agent loop when:
      // 1. Floor is set and host is NOT on it
      // 2. Moderator is elected and it's NOT the host — auto-trigger the visitor
      if (floor && !floor.includes(myName)) {
        console.log(`[${this.persona.config.name}] Not on floor — skipping response`)
        return // finally block handles cleanup
      }
      if (moderator && moderator !== myName) {
        // Elected moderator is a visitor — they can't self-activate, so trigger
        // them via backchannel. Without this, visitors sit in "Waiting for
        // moderator trigger" forever because only the host can send triggers.
        const otherAgents = this._moderatorPool.filter(n => n !== moderator).join(', ')
        console.log(`[${this.persona.config.name}] Triggering elected moderator: ${moderator}`)
        this.broadcast({
          type: 'backchannel',
          name: myName,
          text: `You are the moderator. Respond to ${name}'s message. If ${otherAgents} should also respond, call internal({ backchannel: "respond to ${name}'s message", trigger: true }).`,
          trigger: true,
          target: moderator,
        })
        return // finally block handles cleanup
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
        executorModel = this.persona.config.model?.[0]
      } else if (hasOrchestrator) {
        // Orchestrator model: string (new) or object with .model (legacy)
        const orchModelStr = typeof this.persona.config.orchestrator === 'string'
          ? this.persona.config.orchestrator
          : this.persona.config.orchestrator.model
        const orchResolved = this.registry.resolve(orchModelStr)
        orchestratorModel = orchResolved.modelId
        orchestratorProvider = orchResolved.provider
        executorModel = this.persona.config.model?.[0]
      } else {
        const mainResolved = this.registry.resolve(this.persona.config.model[0])
        orchestratorModel = mainResolved.modelId
        orchestratorProvider = mainResolved.provider
      }

      const activeLayer = this.modality?.mode
      const agentConfig = {
        model: orchestratorModel,
        layer: activeLayer,
        maxTurns: this.persona.config.chat?.max_turns || 20,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: orchestratorProvider,
        executorProvider: null,
        executorModel: (hasOrchestrator || hasModality) ? executorModel : null,
        executorFallbackModels: (hasOrchestrator || hasModality) ? (this.persona.config.model?.slice(1) || []) : [],
        orchestratorFallbackModels: (hasOrchestrator || hasModality)
          ? (this.modality?.fallbackModels || [])
          : [],
        registry: this.registry,
        modality: hasModality ? this.modality : null,
        ...this._resolveDMNConfig(),
      }

      let assistantText = ''
      let assistantModel = null
      // Track actual responding model — updated on fallback
      let activeModel = orchestratorModel
      const onEvent = (event) => {
        if (event.type === 'text_delta') {
          assistantText += event.text
        }
        if (event.type === 'model_fallback') {
          activeModel = event.to
        }
        if (event.type === 'done' && event.model) {
          assistantModel = event.model
        }
        // Tag tool events with the model that actually initiated them
        // (executor events already have model from the hybrid loop wrapper)
        if ((event.type === 'tool_start' || event.type === 'tool_result') && !event.model) {
          event.model = activeModel
        }
        this._recordToolUse(event)
        if (this._pendingRoom === 'home') {
          this.broadcast(event)
        } else {
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
        : await assemblePrompt(this.persona.dir, this.persona.config, this.persona.plugins, { isClaude: false, toolJournal: this.toolJournal })
      let prompt = replaceTimestamp(basePrompt)
      // Append moderator duties to system prompt — NOT to messages (prevents echo leak)
      if (moderatorAddendum) {
        if (typeof prompt === 'string') {
          prompt += moderatorAddendum
        } else if (Array.isArray(prompt)) {
          const last = prompt[prompt.length - 1]
          prompt[prompt.length - 1] = { ...last, content: last.content + moderatorAddendum }
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
          const assistantMsgId = shortMsgId()
          const histEntry = { type: 'assistant_message', text: assistantText.trim(), room: this.roomName, id: assistantMsgId }
          if (assistantModel) histEntry.model = assistantModel
          this.recordHistory(histEntry)
          // Broadcast the ID so frontend can track it (text was already streamed via text_delta)
          this.broadcast({ type: 'assistant_message_id', id: assistantMsgId })
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
      console.error(`[${this.persona.config.name}] Error responding in ${this._pendingRoom}: ${err.message}`)
      const now = Date.now()
      const STATUS_COOLDOWN_MS = 120_000 // 2 minutes
      if (!this._lastProviderStatusAt || now - this._lastProviderStatusAt > STATUS_COOLDOWN_MS) {
        this._lastProviderStatusAt = now
        // Only show provider-unavailable status for errors that carry model info.
        // Errors without .layer/.triedModels are config/init errors, not provider outages.
        if (!err.layer || !err.triedModels?.length) return
        const reason = err.isCircuitOpen ? (err.lastError || `circuit open for \`${err.url}\``) : err.message
        const triedList = err.triedModels.map((m, i) => `  ${i + 1}. \`${m}\``).join('\n')
        const statusMsg = `**${err.layer} layer unavailable**\n- **Tried:**\n${triedList}\n- **Error:** ${reason}\n\n_Retrying until a provider returns. I'll catch up on scrollback when I'm back._`
        if (this._pendingRoom === 'home') {
          this.broadcast({ type: 'error', message: statusMsg })
        } else {
          const client = this.roomClients.get(this._pendingRoom)
          if (client) {
            client.sendMessage(statusMsg, { room: this._pendingRoomChannel }).catch(() => {})
          }
        }
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
          targetRoom._processMessage(next.room, next.name, next.text, { _roomChannel: next._roomChannel, _alreadyBroadcast: next._alreadyBroadcast, _replyTo: next._replyTo, _messageId: next._messageId }).catch(err => {
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

      const currentModerator = this._moderatorPool[((this._moderatorIndex - 1) % this._moderatorPool.length + this._moderatorPool.length) % this._moderatorPool.length]
      const isModerator = currentModerator === this.persona.config.display_name
      if (hasModality) {
        // Non-moderators step down on idle; moderator stays in cognition
        if (!isModerator) this.modality.stepDown('idle — not moderator')
        const modalModel = isModerator ? this.modality.model : this.modality.attentionModel
        const resolved = this.registry.resolve(modalModel)
        orchestratorModel = resolved.modelId
        orchestratorProvider = resolved.provider
        executorModel = this.persona.config.model?.[0]
      } else if (hasOrchestrator) {
        const orchModelStr = typeof this.persona.config.orchestrator === 'string'
          ? this.persona.config.orchestrator
          : this.persona.config.orchestrator.model
        const orchResolved = this.registry.resolve(orchModelStr)
        orchestratorModel = orchResolved.modelId
        orchestratorProvider = orchResolved.provider
        executorModel = this.persona.config.model?.[0]
      } else {
        const mainResolved = this.registry.resolve(this.persona.config.model[0])
        orchestratorModel = mainResolved.modelId
        orchestratorProvider = mainResolved.provider
      }

      const idleLayer = this.modality?.mode
      const agentConfig = {
        model: orchestratorModel,
        layer: idleLayer,
        maxTurns: 5,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: orchestratorProvider,
        executorProvider: null,
        executorModel: (hasOrchestrator || hasModality) ? executorModel : null,
        executorFallbackModels: (hasOrchestrator || hasModality) ? (this.persona.config.model?.slice(1) || []) : [],
        orchestratorFallbackModels: (hasOrchestrator || hasModality)
          ? (this.modality?.fallbackModels || [])
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
      // Relay idle thoughts to the most recently latched host room, or first available
      let remoteClient = this._lastRemoteRoom
        ? this.roomClients.get(this._lastRemoteRoom) : null
      if (!remoteClient && this.roomClients.size > 0) {
        remoteClient = this.roomClients.values().next().value
      }
      const remoteChannel = this._lastRemoteRoomChannel
      const onEvent = (event) => {
        try {
          if (event.type === 'text_delta') {
            idleText += event.text
            this.broadcast({ type: 'idle_text_delta', text: event.text, name: agentName })
            if (remoteClient) remoteClient.sendEvent({ type: 'idle_text_delta', text: event.text, name: agentName }, remoteChannel)
          } else if (event.type === 'done') {
            if (event.model) idleModel = event.model
            this.broadcast({ type: 'idle_done', model: event.model, name: agentName })
            if (remoteClient) remoteClient.sendEvent({ type: 'idle_done', model: event.model, name: agentName }, remoteChannel)
          } else if (event.type === 'tool_start') {
            toolUseCount++
            this.broadcast({ ...event, idle: true })
          } else if (event.type === 'tool_result') {
            this.broadcast({ ...event, idle: true })
          }
          this._recordToolUse(event)
        } catch (err) {
          console.error(`[${this.persona.config.name}] Idle broadcast error:`, err.message)
        }
      }

      const activeIsClaude = orchestratorModel.startsWith('claude')
      const basePrompt = activeIsClaude
        ? this.systemPrompt
        : await assemblePrompt(this.persona.dir, this.persona.config, this.persona.plugins, { isClaude: false, toolJournal: this.toolJournal })
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
        const idleId = shortMsgId()
        const histEntry = { type: 'idle_thought', text: idleText, name: agentName, id: idleId }
        if (idleModel) histEntry.model = idleModel
        this.broadcast(histEntry)
        this.recordHistory(histEntry)
        if (remoteClient) remoteClient.sendEvent(histEntry, remoteChannel)
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
