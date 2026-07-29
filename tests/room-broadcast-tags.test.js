// tests/room-broadcast-tags.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Room } from '../server/lib/chat-session.js'

describe('Room broadcast tagging', () => {
  it('broadcast includes room name when set', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: 'claude-sonnet-4-6',
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const room = new Room(persona, { roomName: '#general' })
    const received = []
    const mockClient = { write: (data) => received.push(JSON.parse(data.replace('data: ', '').trim())) }
    room.clients.add(mockClient)

    room.broadcast({ type: 'system', text: 'hello' })

    assert.strictEqual(received.length, 1)
    assert.strictEqual(received[0].room, '#general')
    assert.strictEqual(received[0].type, 'system')
  })

  it('broadcast omits room tag when no room name (legacy)', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'solo',
        display_name: 'Solo',
        model: 'claude-sonnet-4-6',
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const room = new Room(persona)
    const received = []
    const mockClient = { write: (data) => received.push(JSON.parse(data.replace('data: ', '').trim())) }
    room.clients.add(mockClient)

    room.broadcast({ type: 'system', text: 'hello' })

    assert.strictEqual(received.length, 1)
    assert.strictEqual(received[0].room, undefined)
  })

  it('never exposes a secret split across streaming chunks', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'solo',
        display_name: 'Solo',
        model: 'claude-sonnet-4-6',
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const room = new Room(persona)
    room.harness = {
      secrets: {
        hasAny: () => true,
        values: () => ['super-secret-value'],
        redactDeep(value) {
          if (typeof value === 'string') return value.replaceAll('super-secret-value', '[redacted]')
          if (Array.isArray(value)) return value.map(item => this.redactDeep(item))
          if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactDeep(item)]))
          }
          return value
        },
      },
    }
    const received = []
    room.clients.add({ write: data => received.push(JSON.parse(data.replace('data: ', '').trim())) })

    room.broadcast({ type: 'text_delta', text: 'super-' })
    room.broadcast({ type: 'text_delta', text: 'secret-value' })
    room.broadcast({ type: 'assistant_message', text: 'super-secret-value' })

    assert.deepStrictEqual(received, [{ type: 'assistant_message', text: '[redacted]' }])
  })
})
