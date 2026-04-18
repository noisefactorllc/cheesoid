// Regression tests for the dual-lane output contract (cheesoid):
//   1. Thought must be shown.
//   2. Chat must be shown.
//   3. Chat content must not be nested inside thought tags.
//   4. Thought content must not be inlined into chat.
//   5. No message may be silently dropped (no "all-narration" retry-discard).
//   6. Raw narration tags must not appear in either lane's output.
//   7. Same as #6.
//   8. Tags aren't stripped silently — they route content to visible lanes.
//   9. No model-emitted text may be invisible to the user.
//
// These tests exercise Room._handleAssistantTextTurn end-to-end: given a text
// string with narration wrappers, both an assistant_message (chat lane) and
// an assistant_thought (thought lane) must be recorded, neither can contain
// raw tags, neither can drop content.

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Room } from '../server/lib/chat-session.js'

function makeRoom() {
  const persona = { config: { name: 'test', display_name: 'Tester', agents: [], rooms: [] } }
  const room = new Room(persona, { agent: {
    messages: [], systemPrompt: null, tools: null, memory: null, state: null,
    chatLog: null, registry: null, modality: null, clients: new Set(),
    participants: new Map(), busy: false, lastActivity: Date.now(), idleTimer: null,
    history: [], roomClients: new Map(), _pendingRoom: 'home', _messageQueue: [],
    _idleInterval: 3600000, _consecutiveDegenerateCount: 0, _destroyed: false,
    _sessionStartHandled: false, _pendingContextMessages: [],
    _moderatorPool: ['Tester'], _moderatorIndex: 0, _floor: null, _wakeupSchedulers: [],
  } })
  room.broadcast = mock.fn(() => {})
  return room
}

describe('dual-lane output — _handleAssistantTextTurn', () => {
  it('records BOTH chat and thought entries when input has narration', () => {
    const room = makeRoom()
    room._handleAssistantTextTurn('before<thinking>reasoning goes here</thinking>after', 'test-model')
    const history = room.history
    const thoughtEntry = history.find(h => h.type === 'assistant_thought')
    const chatEntry = history.find(h => h.type === 'assistant_message')
    assert.ok(thoughtEntry, 'thought entry must be recorded')
    assert.ok(chatEntry, 'chat entry must be recorded')
    assert.equal(thoughtEntry.text, 'reasoning goes here', 'thought lane content preserved without tags')
    assert.equal(chatEntry.text, 'beforeafter', 'chat lane content preserved without tags')
    // Raw tags must not appear in either lane
    assert.ok(!thoughtEntry.text.includes('<'), 'no raw tags in thought')
    assert.ok(!chatEntry.text.includes('<'), 'no raw tags in chat')
    // turnId pairs them
    assert.equal(thoughtEntry.turnId, chatEntry.turnId, 'shared turnId links chat and thought')
  })

  it('records thought only when turn is entirely narration', () => {
    const room = makeRoom()
    room._handleAssistantTextTurn('<thinking>private reasoning, no chat reply</thinking>', 'test-model')
    const thoughtEntry = room.history.find(h => h.type === 'assistant_thought')
    const chatEntry = room.history.find(h => h.type === 'assistant_message')
    assert.ok(thoughtEntry, 'thought must be recorded even when chat is empty (ban: not showing thought)')
    assert.equal(chatEntry, undefined, 'chat entry must not be fabricated out of nothing')
    assert.equal(thoughtEntry.text, 'private reasoning, no chat reply')
    // Regression: the old code would retry-discard this turn and the user would see nothing.
    // New code must preserve the thought lane.
  })

  it('records chat only when turn is entirely plain chat', () => {
    const room = makeRoom()
    room._handleAssistantTextTurn('hello world, here is my reply', 'test-model')
    const thoughtEntry = room.history.find(h => h.type === 'assistant_thought')
    const chatEntry = room.history.find(h => h.type === 'assistant_message')
    assert.equal(thoughtEntry, undefined, 'no thought entry for pure-chat turn')
    assert.ok(chatEntry, 'chat entry recorded')
    assert.equal(chatEntry.text, 'hello world, here is my reply')
  })

  it('preserves content across unbalanced tags (no drop)', () => {
    const room = makeRoom()
    room._handleAssistantTextTurn('reply starts here<thinking>unclosed reasoning', 'test-model')
    const thoughtEntry = room.history.find(h => h.type === 'assistant_thought')
    const chatEntry = room.history.find(h => h.type === 'assistant_message')
    assert.equal(chatEntry.text, 'reply starts here', 'chat-lane prefix preserved')
    assert.equal(thoughtEntry.text, 'unclosed reasoning', 'post-open content routed to thought, not dropped')
  })

  it('routes JSON reasoning blobs to thought lane, preserves chat after', () => {
    const room = makeRoom()
    const leading = '{"thought":"I should greet the user"}'
    room._handleAssistantTextTurn(`${leading}\nHi there!`, 'test-model')
    const thoughtEntry = room.history.find(h => h.type === 'assistant_thought')
    const chatEntry = room.history.find(h => h.type === 'assistant_message')
    assert.ok(thoughtEntry, 'JSON thought blob must land in thought lane, not dropped')
    assert.ok(thoughtEntry.text.includes('should greet the user'), 'JSON blob content preserved in thought')
    assert.ok(chatEntry, 'chat after the blob must survive')
    assert.match(chatEntry.text, /Hi there!/, 'chat content preserved')
  })

  it('handles all of the narration tag names', () => {
    const tags = ['thinking', 'internal', 'execute_protocol', 'inner_voice', 'reasoning', 'thought', 'tool_code', 'parameter']
    for (const tag of tags) {
      const room = makeRoom()
      room._handleAssistantTextTurn(`chat-before<${tag}>thought-here</${tag}>chat-after`, 'test-model')
      const chatEntry = room.history.find(h => h.type === 'assistant_message')
      const thoughtEntry = room.history.find(h => h.type === 'assistant_thought')
      assert.ok(chatEntry, `chat must record for tag <${tag}>`)
      assert.ok(thoughtEntry, `thought must record for tag <${tag}>`)
      assert.equal(chatEntry.text, 'chat-beforechat-after', `chat preserved for <${tag}>`)
      assert.equal(thoughtEntry.text, 'thought-here', `thought preserved for <${tag}>`)
      assert.ok(!chatEntry.text.includes('<'), `no raw tag <${tag}> in chat`)
      assert.ok(!thoughtEntry.text.includes('<'), `no raw tag <${tag}> in thought`)
    }
  })

  it('<chat> escape inside narration promotes inner content to chat lane', () => {
    const room = makeRoom()
    room._handleAssistantTextTurn('<thinking>reasoning x<chat>promoted chat</chat> more reasoning</thinking>', 'test-model')
    const chatEntry = room.history.find(h => h.type === 'assistant_message')
    const thoughtEntry = room.history.find(h => h.type === 'assistant_thought')
    assert.ok(chatEntry, 'escape produces a chat entry')
    assert.match(chatEntry.text, /promoted chat/, 'promoted content reaches chat lane')
    assert.ok(!thoughtEntry.text.includes('promoted chat'), 'escape content must not stay in thought too')
  })

  it('broadcasts assistant_thought_id and assistant_message_id events', () => {
    const room = makeRoom()
    room._handleAssistantTextTurn('plain <thinking>reason</thinking> tail', 'test-model')
    const calls = room.broadcast.mock.calls.map(c => c.arguments[0])
    const thoughtIdEvent = calls.find(e => e.type === 'assistant_thought_id')
    const msgIdEvent = calls.find(e => e.type === 'assistant_message_id')
    assert.ok(thoughtIdEvent, 'thought id event broadcast')
    assert.ok(msgIdEvent, 'message id event broadcast')
    assert.equal(thoughtIdEvent.turnId, msgIdEvent.turnId, 'turnId consistent')
  })
})

describe('dual-lane output — ban compliance regression', () => {
  it('does NOT silently discard an all-narration turn (ban #5)', () => {
    const room = makeRoom()
    // The historical failure mode: gemini emits a 16000-token response entirely
    // wrapped in <thinking>...</thinking>. The old code flagged this as
    // "all-narration response" and triggered a retry, discarding the output.
    // The new code must preserve it as an assistant_thought.
    const bigNarration = '<thinking>' + 'a'.repeat(10000) + '</thinking>'
    room._handleAssistantTextTurn(bigNarration, 'gemini-2.5-pro')
    const thoughtEntry = room.history.find(h => h.type === 'assistant_thought')
    assert.ok(thoughtEntry, 'all-narration turn must land in thought lane, never dropped')
    assert.equal(thoughtEntry.text.length, 10000, 'full content preserved (no truncation)')
    assert.ok(!thoughtEntry.text.includes('<'), 'no raw tags in thought lane')
  })

  it('no raw tags leak into chat lane — ban #7', () => {
    const room = makeRoom()
    // Mixed content with multiple narration types
    room._handleAssistantTextTurn(
      'ok so<internal>x</internal>here is<reasoning>y</reasoning>the answer',
      'test-model',
    )
    const chatEntry = room.history.find(h => h.type === 'assistant_message')
    assert.ok(chatEntry)
    assert.ok(!chatEntry.text.includes('<internal>'), 'no <internal>')
    assert.ok(!chatEntry.text.includes('<reasoning>'), 'no <reasoning>')
    assert.ok(!chatEntry.text.includes('</'), 'no closing tag markup')
    assert.match(chatEntry.text, /ok so/)
    assert.match(chatEntry.text, /here is/)
    assert.match(chatEntry.text, /the answer/)
  })
})
