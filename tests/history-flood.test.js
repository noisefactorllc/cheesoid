import { test } from 'node:test'
import assert from 'node:assert/strict'

function mockPersona() {
  return {
    dir: '/tmp/fake-persona',
    config: { name: 'test', display_name: 'Test', model: 'claude-sonnet-4-6', memory: { dir: 'memory/' } },
  }
}

async function makeRoom() {
  const { Room, HISTORY_FLOOD_LIMIT } = await import('../server/lib/chat-session.js')
  const room = new Room(mockPersona())
  let appends = 0
  room.chatLog = { append: async () => { appends++ } }
  return { room, HISTORY_FLOOD_LIMIT, appends: () => appends }
}

test('suppresses a flood of identical consecutive entries at the limit', async () => {
  const { room, HISTORY_FLOOD_LIMIT, appends } = await makeRoom()
  for (let i = 0; i < 200; i++) {
    room.recordHistory({ type: 'user_message', name: 'wakeup', text: 'morning rounds' })
  }
  // Exactly HISTORY_FLOOD_LIMIT entries persist; the other ~150 are dropped.
  assert.equal(appends(), HISTORY_FLOOD_LIMIT)
})

test('distinct entries are never suppressed', async () => {
  const { room, appends } = await makeRoom()
  for (let i = 0; i < 200; i++) {
    room.recordHistory({ type: 'user_message', name: 'u', text: `msg-${i}` })
  }
  assert.equal(appends(), 200)
})

test('the repeat counter resets when a different entry breaks the run', async () => {
  const { room, HISTORY_FLOOD_LIMIT, appends } = await makeRoom()
  const n = HISTORY_FLOOD_LIMIT - 1
  for (let i = 0; i < n; i++) room.recordHistory({ type: 'user_message', name: 'a', text: 'same' })
  room.recordHistory({ type: 'user_message', name: 'b', text: 'different' }) // breaks the run
  for (let i = 0; i < n; i++) room.recordHistory({ type: 'user_message', name: 'a', text: 'same' })
  // No run reached the limit, so nothing is suppressed.
  assert.equal(appends(), n + 1 + n)
})
