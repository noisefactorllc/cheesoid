import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { loadTools } from '../server/lib/tools.js'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-internal-'))
  await mkdir(join(dir, 'memory'), { recursive: true })
  return dir
}

function stubMemory() {
  return { read: async () => null, write: async () => {}, append: async () => {}, list: async () => [] }
}

function stubState() {
  return { load: async () => {}, save: async () => {}, update: () => {}, data: {} }
}

function stubRoom(overrides = {}) {
  return {
    broadcast: mock.fn(() => {}),
    recordHistory: mock.fn(() => {}),
    chatLog: null,
    participants: new Map(),
    _pendingRoom: 'home',
    roomClients: new Map(),
    persona: { config: { display_name: 'TestAgent', agents: [], rooms: [] } },
    ...overrides,
  }
}

describe('internal tool', () => {
  it('registers internal tool when rooms are configured', async () => {
    const dir = await makeTmpDir()
    const config = {
      rooms: [{ name: 'brad', url: 'http://localhost:3001', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const internal = tools.definitions.find(d => d.name === 'internal')
    assert.ok(internal, 'internal tool should be registered when rooms configured')
    assert.ok(internal.input_schema.properties.thought)
    assert.ok(internal.input_schema.properties.backchannel)
  })

  it('registers internal tool when agents are configured', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const internal = tools.definitions.find(d => d.name === 'internal')
    assert.ok(internal, 'internal tool should be registered when agents configured')
  })

  it('does NOT register internal tool when no rooms or agents', async () => {
    const dir = await makeTmpDir()
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const internal = tools.definitions.find(d => d.name === 'internal')
    assert.equal(internal, undefined, 'internal should not be registered without multi-agent config')
  })

  it('thought broadcasts to home room and returns content', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { thought: 'This is interesting.' })

    assert.ok(result.output.includes('This is interesting.'))
    assert.ok(!result.is_error)

    const calls = room.broadcast.mock.calls.map(c => c.arguments[0])
    assert.ok(calls.some(c => c.type === 'idle_text_delta' && c.text === 'This is interesting.' && c.name === 'TestAgent'))
    assert.ok(calls.some(c => c.type === 'idle_done' && c.name === 'TestAgent'))

    const historyCalls = room.recordHistory.mock.calls.map(c => c.arguments[0])
    assert.ok(historyCalls.some(c => c.type === 'idle_thought' && c.text === 'This is interesting.' && c.name === 'TestAgent'))
  })

  it('backchannel sends via room client when in remote room', async () => {
    const dir = await makeTmpDir()
    const bcSends = []
    const mockClient = {
      sendBackchannel: mock.fn(async (text) => { bcSends.push(text) }),
      sendMessage: mock.fn(async () => {}),
    }
    const roomClients = new Map([['brad', mockClient]])

    const config = {
      rooms: [{ name: 'brad', url: 'http://localhost:3001', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'brad', roomClients })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { backchannel: 'Taking this one.' })

    assert.ok(result.output.includes('Backchannel sent'))
    assert.equal(mockClient.sendBackchannel.mock.callCount(), 1)
    assert.equal(bcSends[0], 'Taking this one.')
  })

  it('backchannel broadcasts to SSE when in home room', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'home' })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { backchannel: 'Brad, this is yours.' })

    assert.ok(result.output.includes('Backchannel sent'))
    const calls = room.broadcast.mock.calls.map(c => c.arguments[0])
    assert.ok(calls.some(c => c.type === 'backchannel' && c.text === 'Brad, this is yours.'))
  })

  it('combines thought and backchannel in one call', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'home' })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', {
      thought: 'Not my area.',
      backchannel: 'Brad, this is yours.',
    })

    assert.ok(result.output.includes('Not my area.'))
    assert.ok(result.output.includes('Backchannel sent'))
  })

  it('returns error when neither thought nor backchannel provided', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Brad', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', {})

    assert.ok(result.is_error)
  })
})
