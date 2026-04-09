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

  describe('_handleAssistantTextTurn (per-turn history flushing)', () => {
    // Regression: brad produced a 1527-token acknowledgement then called deep_think.
    // deep_think stalled for 16 minutes. The text streamed live over WebSocket but
    // was never persisted to history because chat-session.js only flushed after the
    // entire orchestrator loop completed. On reconnect the text was gone.
    // Fix: each turn's text must flush to history independently.

    it('writes an assistant_message to history for home-room turns', async () => {
      const { Room } = await import('../server/lib/chat-session.js')
      const room = new Room(mockPersona())
      room._pendingRoom = 'home'
      room.roomName = '#general'

      room._handleAssistantTextTurn('first chunk of text', 'claude-sonnet-4-6')

      assert.equal(room.history.length, 1)
      const entry = room.history[0]
      assert.equal(entry.type, 'assistant_message')
      assert.equal(entry.text, 'first chunk of text')
      assert.equal(entry.model, 'claude-sonnet-4-6')
      assert.equal(entry.room, '#general')
      assert.ok(entry.id, 'entry must have an id for client tagging')
    })

    it('writes a separate history entry per turn (multiple calls)', async () => {
      const { Room } = await import('../server/lib/chat-session.js')
      const room = new Room(mockPersona())
      room._pendingRoom = 'home'
      room.roomName = '#general'

      room._handleAssistantTextTurn('turn 1 text', 'claude-sonnet-4-6')
      room._handleAssistantTextTurn('turn 3 text', 'claude-sonnet-4-6')
      room._handleAssistantTextTurn('turn 7 text', 'claude-sonnet-4-6')

      assert.equal(room.history.length, 3)
      assert.equal(room.history[0].text, 'turn 1 text')
      assert.equal(room.history[1].text, 'turn 3 text')
      assert.equal(room.history[2].text, 'turn 7 text')
      // Each must have a unique id
      const ids = room.history.map(e => e.id)
      assert.equal(new Set(ids).size, 3, 'each flushed turn must have a unique id')
    })

    it('ignores empty or whitespace-only text', async () => {
      const { Room } = await import('../server/lib/chat-session.js')
      const room = new Room(mockPersona())
      room._pendingRoom = 'home'
      room.roomName = '#general'

      room._handleAssistantTextTurn('', 'claude-sonnet-4-6')
      room._handleAssistantTextTurn('   ', 'claude-sonnet-4-6')
      room._handleAssistantTextTurn('\n\n', 'claude-sonnet-4-6')

      assert.equal(room.history.length, 0)
    })

    it('does not flush for non-home rooms (remote DM path keeps existing batch behavior)', async () => {
      const { Room } = await import('../server/lib/chat-session.js')
      const room = new Room(mockPersona())
      room._pendingRoom = 'remote-room-id'
      room.roomName = '#general'

      room._handleAssistantTextTurn('hi from a DM response', 'claude-sonnet-4-6')

      assert.equal(room.history.length, 0, 'remote DM responses are batched at loop-end, not flushed per turn')
    })
  })
})
