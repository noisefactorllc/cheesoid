// server/lib/room-manager.js
import { Room } from './chat-session.js'

/**
 * Manages multiple named rooms for hub personas,
 * or a single default room for legacy single-room personas.
 */
export class RoomManager {
  constructor(persona) {
    this.persona = persona
    this._rooms = new Map()
    this._defaultRoom = null

    const hostedRooms = persona.config.hosted_rooms || []
    if (hostedRooms.length > 0) {
      for (const name of hostedRooms) {
        this._rooms.set(name, new Room(persona))
      }
    } else {
      // Legacy single-room mode
      this._defaultRoom = new Room(persona)
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

  /**
   * Get room by name, falling back to default for legacy mode.
   * For hub mode, returns first room if no name given.
   */
  resolve(name) {
    if (this.isHub) {
      return name ? this._rooms.get(name) : this._rooms.values().next().value
    }
    return this._defaultRoom
  }

  async initialize() {
    if (this.isHub) {
      for (const room of this._rooms.values()) {
        await room.initialize()
      }
    } else {
      await this._defaultRoom.initialize()
    }
  }

  /** All rooms as an iterable */
  rooms() {
    if (this.isHub) return this._rooms.values()
    return [this._defaultRoom][Symbol.iterator]()
  }

  /** Aggregated participants across all rooms */
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
