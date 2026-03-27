import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

function mockPersona() {
  return {
    dir: '/tmp/fake-persona',
    config: {
      name: 'test',
      display_name: 'Test',
      model: 'claude-sonnet-4-6',
      chat: { max_turns: 5 },
      memory: { dir: 'memory/' },
    },
  }
}

describe('Room history', () => {
  it('records user messages to history', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())

    room.recordHistory({ type: 'user_message', name: 'alice', text: 'hello' })
    assert.equal(room.history.length, 1)
    assert.equal(room.history[0].type, 'user_message')
    assert.equal(room.history[0].name, 'alice')
    assert.equal(room.history[0].text, 'hello')
    assert.ok(room.history[0].timestamp)
  })

  it('records assistant messages to history', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())

    room.recordHistory({ type: 'assistant_message', text: 'hi there' })
    assert.equal(room.history.length, 1)
    assert.equal(room.history[0].type, 'assistant_message')
    assert.equal(room.history[0].text, 'hi there')
  })

  it('caps history at 50 entries', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())

    for (let i = 0; i < 60; i++) {
      room.recordHistory({ type: 'user_message', name: 'alice', text: `msg ${i}` })
    }
    assert.equal(room.history.length, 50)
    assert.equal(room.history[0].text, 'msg 10')
    assert.equal(room.history[49].text, 'msg 59')
  })

  it('getScrollback returns history array', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())

    room.recordHistory({ type: 'user_message', name: 'alice', text: 'hello' })
    room.recordHistory({ type: 'assistant_message', text: 'hi' })
    const scrollback = room.getScrollback()
    assert.equal(scrollback.length, 2)
  })
})
