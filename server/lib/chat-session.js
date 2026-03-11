import { assemblePrompt } from './prompt-assembler.js'
import { Memory } from './memory.js'
import { State } from './state.js'
import { loadTools } from './tools.js'
import { runAgent } from './agent.js'
import { RoomClient } from './room-client.js'

const IDLE_THOUGHT_INTERVAL = 5 * 60 * 1000 // 5 minutes, doubles each time
const MAX_IDLE_INTERVAL = 8 * 60 * 60 * 1000 // 8 hours cap
const MAX_HISTORY = 50
const HEARTBEAT_INTERVAL = 30 * 1000 // 30 seconds — keeps SSE alive through proxies
// Join/leave events are broadcast to SSE clients for UI presence updates
// but never injected into agent context (this.messages) — the agent has
// the participant list via presence events and doesn't need the churn.

const IDLE_THOUGHT_PROMPT = `You have been idle for a while. No one is talking to you right now.

This is a moment of quiet. Use it to:
- Reflect on your recent conversations
- Notice anything worth remembering that you haven't saved yet
- Think about open threads or unresolved questions
- Update your state (mood, focus, energy)

If you have something worth noting, write it to memory. If not, that's fine too.
Keep any response brief — this is internal reflection, not performance.`

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
  }

  async initialize() {
    if (this.systemPrompt) return // already initialized

    const { dir, config } = this.persona
    this.memory = new Memory(dir, config.memory?.dir || 'memory/')
    this.state = new State(dir)
    await this.state.load()
    this.systemPrompt = await assemblePrompt(dir, config)
    this.tools = await loadTools(dir, config, this.memory, this.state, this)

    // Announce startup
    const startupMsg = `${config.display_name} has started.`
    this.messages.push({ role: 'user', content: `[${this._timestamp()}] * ${startupMsg}` })
    this.recordHistory({ type: 'system', text: startupMsg })
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

  addAgentMessage(name, text) {
    const taggedMessage = `[${this._timestamp()}][${name}]: ${text}`
    this.messages.push({ role: 'user', content: taggedMessage })
    this.broadcast({ type: 'user_message', name, text, fromAgent: true })
    this.recordHistory({ type: 'user_message', name, text })
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    this._startIdleTimer()
  }

  addBackchannelMessage(name, text) {
    const taggedMessage = `[${this._timestamp()}][backchannel/${name}]: ${text}`
    this.messages.push({ role: 'user', content: taggedMessage })
    // No broadcast, no history — agents only
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
    if (event.type === 'user_message') {
      if (event.scrollback) {
        // Historical context from remote room — don't trigger agent
        const tag = `[${event.room}/${event.name}]`
        this.messages.push({ role: 'user', content: `${tag}: ${event.text}` })
      } else {
        this._processMessage(event.room, event.name, event.text)
      }
    } else if (event.type === 'assistant_message') {
      // Another room's agent responded — add context only, don't trigger
      const tag = `[${event.room}/assistant]`
      this.messages.push({ role: 'user', content: `${tag}: ${event.text}` })
    } else if (event.type === 'backchannel') {
      // Agent-only coordination message — add to conversation log, no UI
      const tag = `[${this._timestamp()}][backchannel/${event.room}/${event.name}]`
      this.messages.push({ role: 'user', content: `${tag}: ${event.text}` })
    }
  }

  async sendMessage(name, userMessage) {
    await this._processMessage('home', name, userMessage)
  }

  async _processMessage(room, name, text) {
    if (this.busy) {
      if (room === 'home') {
        // Don't queue — user can resend with up-arrow after agent finishes
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
      const tag = room === 'home' ? `[${ts}][${name}]` : `[${ts}][${room}/${name}]`
      const presence = room === 'home' ? ` (room: ${this.participantList.join(', ')})` : ''
      this.messages.push({ role: 'user', content: `${tag}${presence}: ${text}` })

      if (room === 'home') {
        if (name) this.participants.set(name, Date.now())
        this.broadcast({ type: 'user_message', name, text })
        this.recordHistory({ type: 'user_message', name, text })
      }

      const config = {
        model: this.persona.config.model,
        maxTurns: this.persona.config.chat?.max_turns || 20,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
      }

      let assistantText = ''
      const onEvent = (event) => {
        if (event.type === 'text_delta') {
          assistantText += event.text
        }
        if (this._pendingRoom === 'home') {
          this.broadcast(event)
        }
      }

      const result = await runAgent(this.systemPrompt, this.messages, this.tools, config, onEvent)
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
      this._startIdleTimer()

      if (this._messageQueue.length > 0) {
        const next = this._messageQueue.shift()
        this._processMessage(next.room, next.name, next.text).catch(err => {
          console.error(`[${this.persona.config.name}] Queue processing error:`, err.message)
        })
      }
    }
  }

  async _idleThought() {
    if (this.busy || this.messages.length === 0) {
      this._startIdleTimer() // restart timer even on skip, preserving current backoff
      return
    }

    this.busy = true
    console.log(`[${this.persona.config.name}] Idle thought triggered, ${this.clients.size} clients connected`)

    try {
      const idleMessages = [{ role: 'user', content: IDLE_THOUGHT_PROMPT }]

      const config = {
        model: this.persona.config.model,
        maxTurns: 5,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
      }

      // Wrap events as idle thoughts for the UI
      let idleText = ''
      const onEvent = (event) => {
        if (event.type === 'text_delta') {
          idleText += event.text
          this.broadcast({ type: 'idle_text_delta', text: event.text })
        } else if (event.type === 'done') {
          this.broadcast({ type: 'idle_done' })
        } else if (event.type === 'tool_start' || event.type === 'tool_result') {
          this.broadcast({ ...event, idle: true })
        }
      }

      await runAgent(this.systemPrompt, idleMessages, this.tools, config, onEvent)
      if (idleText) {
        this.recordHistory({ type: 'idle_thought', text: idleText })
      }

      if (this.state) {
        this.state.update({ last_idle_thought: new Date().toISOString() })
        await this.state.save()
      }
    } catch (err) {
      console.error(`[${this.persona.config.name}] Idle thought error:`, err.message)
    } finally {
      this.busy = false
      this._idleInterval = Math.min(this._idleInterval * 2, MAX_IDLE_INTERVAL)
      console.log(`[${this.persona.config.name}] Next idle thought in ${Math.round(this._idleInterval / 1000)}s`)
      this._startIdleTimer()
    }
  }

  _startIdleTimer() {
    this._clearIdleTimer()
    this.idleTimer = setTimeout(() => this._idleThought(), this._idleInterval)
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

  reset() {
    this._clearIdleTimer()
    this.messages = []
    this.history = []
    this._messageQueue = []
    this._pendingRoom = null
    this.systemPrompt = null
    this.broadcast({ type: 'reset' })
  }

  destroy() {
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
