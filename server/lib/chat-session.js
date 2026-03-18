import { assemblePrompt, currentTimestamp } from './prompt-assembler.js'
import { Memory } from './memory.js'
import { State } from './state.js'
import { ChatLog } from './chat-log.js'
import { loadTools } from './tools.js'
import { runAgent } from './agent.js'
import { RoomClient } from './room-client.js'

const IDLE_THOUGHT_INTERVAL = 30 * 60 * 1000 // 30 minutes, doubles each time
const MAX_IDLE_INTERVAL = 7 * 24 * 60 * 60 * 1000 // 7 days cap
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
  }

  async initialize() {
    if (this.systemPrompt) return // already initialized

    const { dir, config } = this.persona
    this.memory = new Memory(dir, config.memory?.dir || 'memory/')
    this.state = new State(dir)
    this.chatLog = new ChatLog(dir)
    await this.state.load()
    this.systemPrompt = await assemblePrompt(dir, config)
    this.tools = await loadTools(dir, config, this.memory, this.state, this)

    // Replay recent history into agent context
    const recent = await this.chatLog.recent(MAX_HISTORY)
    if (recent.length > 0) {
      for (const entry of recent) {
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
      this.messages.push({ role: 'user', content: '--- END OF PREVIOUS SESSION HISTORY ---' })
      console.log(`[${config.name}] Replayed ${recent.length} history entries`)
    }

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

  addAgentMessage(name, text) {
    const taggedMessage = `[${this._timestamp()}][home/${name}]: ${text}`
    this.messages.push({ role: 'user', content: taggedMessage })
    this.broadcast({ type: 'user_message', name, text, fromAgent: true })
    this.recordHistory({ type: 'user_message', name, text })
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    this._idleInterval = IDLE_THOUGHT_INTERVAL // reset backoff on any activity
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
        this._safeAppendMessage({ role: 'user', content: `${tag}: ${event.text}` })
      } else {
        this._processMessage(event.room, event.name, event.text)
      }
    } else if (event.type === 'assistant_message') {
      // Another room's agent responded — add context only, don't trigger
      const tag = `[${event.room}/assistant]`
      this._safeAppendMessage({ role: 'user', content: `${tag}: ${event.text}` })
    } else if (event.type === 'backchannel') {
      // Agent-only coordination message — add to conversation log, no UI
      const tag = `[${this._timestamp()}][backchannel/${event.room}/${event.name}]`
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
      const roomLabel = room === 'home' ? 'home' : room
      const tag = `[${ts}][${roomLabel}/${name}]`
      const presence = room === 'home' ? ` (present: ${this.participantList.join(', ')})` : ''
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

      const prompt = this.systemPrompt.replace('{{CURRENT_TIMESTAMP}}', currentTimestamp())
      const result = await runAgent(prompt, this.messages, this.tools, config, onEvent)
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
      return false // skipped — timer wrapper handles restart
    }

    this.busy = true
    console.log(`[${this.persona.config.name}] Idle thought triggered, ${this.clients.size} clients connected`)

    try {
      const idleMessages = [
        ...this.messages,
        { role: 'user', content: IDLE_THOUGHT_PROMPT },
      ]

      const config = {
        model: this.persona.config.model,
        maxTurns: 5,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
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

      const prompt = this.systemPrompt.replace('{{CURRENT_TIMESTAMP}}', currentTimestamp())
      await runAgent(prompt, idleMessages, this.tools, config, onEvent)
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
