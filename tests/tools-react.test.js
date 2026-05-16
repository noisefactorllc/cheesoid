import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { loadTools } from '../server/lib/tools.js'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-react-'))
  await mkdir(join(dir, 'memory'), { recursive: true })
  return dir
}

const stubMemory = () => ({ read: async () => null, write: async () => {}, append: async () => {}, list: async () => [] })
const stubState = () => ({ load: async () => {}, save: async () => {}, update: () => {}, data: {} })

function stubRoom(overrides = {}) {
  return {
    broadcast: mock.fn(() => {}),
    recordHistory: mock.fn(() => {}),
    addReaction: mock.fn(() => {}),
    chatLog: null,
    participants: new Map(),
    messages: null, // isKnownMessageId falls back to true when null
    _pendingRoom: 'home',
    roomClients: new Map(),
    persona: { config: { display_name: 'TestAgent', agents: [], rooms: [] } },
    ...overrides,
  }
}

describe('react_to_message tool', () => {
  it('returns _endTurn: true on local success', async () => {
    const dir = await makeTmpDir()
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('react_to_message', { messageId: 'abcd1234', emoji: '👍' })

    assert.equal(result._endTurn, true, 'success result must set _endTurn so the orchestrator loop breaks')
    assert.ok(!result.is_error, 'success result must not be flagged as error')
    assert.equal(room.addReaction.mock.callCount(), 1)
  })

  it('returns _endTurn: true on visitor-relay success', async () => {
    const dir = await makeTmpDir()
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const sendReactionMock = mock.fn(async () => {})
    const roomClients = new Map([['alice', { sendReaction: sendReactionMock }]])
    const room = stubRoom({ _pendingRoom: 'alice', roomClients })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('react_to_message', { messageId: 'abcd1234', emoji: '👍' })

    assert.equal(result._endTurn, true, 'visitor-relay success must set _endTurn')
    assert.ok(!result.is_error)
    assert.equal(sendReactionMock.mock.callCount(), 1)
  })

  it('does NOT set _endTurn on missing-input error', async () => {
    const dir = await makeTmpDir()
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('react_to_message', { messageId: 'abcd1234' /* no emoji */ })

    assert.equal(result.is_error, true)
    assert.equal(result._endTurn, undefined, 'error returns must not set _endTurn — model must be able to recover')
  })

  it('does NOT set _endTurn on unknown-messageId error', async () => {
    const dir = await makeTmpDir()
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    // Set messages to an empty array so isKnownMessageId returns false (not the
    // null-fallback path which auto-accepts).
    const room = stubRoom({ messages: [] })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('react_to_message', { messageId: 'deadbeef', emoji: '👍' })

    assert.equal(result.is_error, true)
    assert.equal(result._endTurn, undefined)
  })

  it('does NOT set _endTurn when visitor relay has no room client', async () => {
    const dir = await makeTmpDir()
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const room = stubRoom({ _pendingRoom: 'alice', roomClients: new Map() /* empty — no client for "alice" */ })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('react_to_message', { messageId: 'abcd1234', emoji: '👍' })

    assert.equal(result.is_error, true)
    assert.equal(result._endTurn, undefined)
  })
})
