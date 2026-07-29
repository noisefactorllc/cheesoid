import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadTools } from '../server/lib/tools.js'
import { createAutonomy } from '../server/lib/autonomy.js'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const stubMemory = () => ({ read: async () => null, write: async () => {}, append: async () => {}, list: async () => [] })
const stubState = () => ({ load: async () => {}, save: async () => {}, update: () => {}, data: {} })

function stubRoom(origin, autonomy, agents) {
  return {
    broadcast: () => {}, recordHistory: () => {}, addReaction: () => {},
    chatLog: null, participants: new Map(), messages: null,
    _pendingRoom: 'home', _turnOrigin: origin, roomClients: new Map(),
    harness: { autonomy: createAutonomy({ autonomy }) },
    persona: { config: { display_name: 'TestAgent', agents, rooms: [] } },
  }
}

async function toolsFor(autonomy, origin, multiAgent = false) {
  const dir = await mkdtemp(join(tmpdir(), 'room-gate-'))
  await mkdir(join(dir, 'memory'), { recursive: true })
  const agents = multiAgent ? [{ name: 'peer' }] : []
  const config = { autonomy, memory: { dir: 'memory/', auto_read: [] }, display_name: 'TestAgent', agents }
  const room = stubRoom(origin, autonomy, agents)
  const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)
  return tools
}

describe('room-tool autonomy gate', () => {
  it('blocks reply_to_message on a low-autonomy self-directed turn', async () => {
    const tools = await toolsFor('low', 'idle')
    const res = await tools.execute('reply_to_message', { replyTo: 'abcd1234', text: 'hi' })
    assert.equal(res.is_error, true)
    assert.match(res.output, /autonomy level "low"/)
  })

  it('blocks send_chat_message on a low-autonomy self-directed turn', async () => {
    const tools = await toolsFor('low', 'idle')
    const res = await tools.execute('send_chat_message', { text: 'hi' })
    assert.equal(res.is_error, true)
  })

  it('allows send_chat_message on a user turn', async () => {
    const tools = await toolsFor('low', 'user')
    const res = await tools.execute('send_chat_message', { text: 'hi' })
    assert.ok(!res.is_error, res.output)
  })

  it('gates a triggering internal but not a thought-only one on a self-directed turn', async () => {
    const tools = await toolsFor('low', 'idle', true)
    const wake = await tools.execute('internal', { backchannel: 'wake up', trigger: true })
    assert.equal(wake.is_error, true, 'a triggering backchannel is speaking, gated')
    assert.match(wake.output, /autonomy level "low"/)
    const thought = await tools.execute('internal', { backchannel: 'note', trigger: false })
    assert.ok(!(thought.output && /autonomy level/.test(thought.output)), 'thought-only backchannel must not be gated')
  })
})
