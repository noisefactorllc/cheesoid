// server/lib/room-manager.js
import { Room, redactKeys } from './chat-session.js'

/**
 * Manages multiple named rooms (channels) for a single agent.
 *
 * Rooms are UI channels — separate SSE clients, scrollback, history.
 * Agent awareness is singular — one messages array, one busy flag,
 * one set of tools, one modality. This lives on the RoomManager,
 * not on individual rooms. Rooms reference the shared agent state.
 */
export class RoomManager {
  constructor(persona) {
    this.persona = persona
    this._rooms = new Map()
    this._defaultRoom = null

    this._dmClients = new Map() // name → Set<res>

    // Shared agent state — single thread of awareness
    this.agent = {
      messages: [],
      systemPrompt: null,
      tools: null,
      memory: null,
      state: null,
      chatLog: null,
      registry: null,
      modality: null,
      clients: new Set(),
      participants: new Map(),
      busy: false,
      lastActivity: Date.now(),
      idleTimer: null,
      history: [],
      roomClients: new Map(),
      _pendingRoom: null,
      _messageQueue: [],
      _idleInterval: 30 * 60 * 1000,
      _consecutiveDegenerateCount: 0,
      _destroyed: false,
      _sessionStartHandled: false,
      _pendingContextMessages: [],
      _moderatorPool: [persona.config.display_name],
      _moderatorIndex: 0,
      _floor: null,
      _wakeupSchedulers: [],
    }
    for (const agent of persona.config.agents || []) {
      this.agent._moderatorPool.push(agent.name)
    }

    const hostedRooms = persona.config.hosted_rooms || []
    if (hostedRooms.length > 0) {
      for (const name of hostedRooms) {
        const room = new Room(persona, { roomName: name, agent: this.agent })
        room._roomManager = this
        this._rooms.set(name, room)
      }
      this._defaultRoom = this._rooms.values().next().value
    } else {
      this._defaultRoom = new Room(persona, { agent: this.agent })
      this._defaultRoom._roomManager = this
    }
  }

  addDMClient(res, name) {
    if (!name) return
    if (!this._dmClients.has(name)) {
      this._dmClients.set(name, new Set())
    }
    this._dmClients.get(name).add(res)
    if (res.on) {
      res.on('close', () => {
        const clients = this._dmClients.get(name)
        if (clients) {
          clients.delete(res)
          if (clients.size === 0) this._dmClients.delete(name)
        }
      })
    }
  }

  routeDM(from, to, text, isAgent, model) {
    // Don't process self-DMs
    if (from === to) return

    const event = {
      type: 'user_message',
      from,
      to,
      text,
      timestamp: Date.now(),
    }
    if (model) event.model = model
    const data = redactKeys(`data: ${JSON.stringify(event)}\n\n`)

    for (const name of [from, to]) {
      const clients = this._dmClients.get(name)
      console.log(`[DM] routing to ${name}: ${clients ? clients.size : 0} clients`)
      if (clients) {
        for (const client of clients) {
          client.write(data)
        }
      }
    }

    const agentName = this.persona.config.display_name

    // Record DMs involving visitor agents in host history for scrollback.
    // Host DMs are recorded by processDM — only record non-host DMs here.
    if (from !== agentName && to !== agentName) {
      const histEntry = isAgent
        ? { type: 'assistant_message', text, name: from, dm_from: from, dm_to: to }
        : { type: 'user_message', text, name: from, dm_from: from, dm_to: to }
      if (model) histEntry.model = model
      this._defaultRoom.recordHistory(histEntry)
    }

    if (to === agentName) {
      // DM to the host agent — process and reply via default room
      this._defaultRoom.processDM(from, text).catch(err => {
        console.error(`[${this.persona.config.name}] DM processing error:`, err.message)
      })
    } else {
      // DM to a visitor agent — forward via room broadcast
      const knownAgents = (this.persona.config.agents || []).map(a => a.name)
      if (knownAgents.includes(to)) {
        this._defaultRoom.addBackchannelMessage('system', `${from} sent a DM to ${to}: "${text}"`)
        this._defaultRoom.broadcast({ type: 'dm_request', from, to, text, timestamp: Date.now() })
      }
    }
  }

  get isHub() {
    return this._rooms.size > 0
  }

  get roomNames() {
    return [...this._rooms.keys()]
  }

  get defaultRoom() {
    return this._defaultRoom
  }

  get(name) {
    return this._rooms.get(name)
  }

  resolve(name) {
    if (this.isHub) {
      return name ? this._rooms.get(name) : this._defaultRoom
    }
    return this._defaultRoom
  }

  async initialize() {
    // Initialize agent state via any room — they all share _a,
    // so the guard (if systemPrompt) return prevents double init
    await this._defaultRoom.initialize()
  }

  /** All rooms as an iterable (each is a distinct channel) */
  rooms() {
    if (this.isHub) return this._rooms.values()
    return [this._defaultRoom][Symbol.iterator]()
  }

  /** Aggregated participants across all channels */
  get allParticipants() {
    const names = new Set()
    for (const room of this.rooms()) {
      for (const name of room.participantList) {
        names.add(name)
      }
    }
    return [...names]
  }

  destroy() {
    for (const room of this.rooms()) {
      room.destroy()
    }
  }
}
