// tests/room-manager.test.js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoomManager } from '../server/lib/room-manager.js'

describe('RoomManager', () => {
  it('initializes rooms from hosted_rooms config', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: 'claude-sonnet-4-6',
        hosted_rooms: ['#general', '#dev'],
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)
    assert.deepStrictEqual(manager.roomNames, ['#general', '#dev'])
    assert.ok(manager.get('#general'))
    assert.ok(manager.get('#dev'))
    assert.strictEqual(manager.get('#nonexistent'), undefined)
  })

  it('falls back to single unnamed room when no hosted_rooms', () => {
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
    const manager = new RoomManager(persona)
    assert.deepStrictEqual(manager.roomNames, [])
    assert.ok(manager.defaultRoom)
  })

  it('isHub returns true when hosted_rooms configured', () => {
    const persona = {
      dir: '/tmp/test',
      config: {
        name: 'hub',
        display_name: 'Hub',
        model: 'claude-sonnet-4-6',
        hosted_rooms: ['#general'],
        chat: { prompt: 'prompts/system.md' },
        memory: { dir: 'memory/', auto_read: [] },
      },
      plugins: [],
    }
    const manager = new RoomManager(persona)
    assert.strictEqual(manager.isHub, true)
  })
})
