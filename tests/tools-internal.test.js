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
      rooms: [{ name: 'alice', url: 'http://localhost:3001', secret: 's' }],
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
      agents: [{ name: 'Alice', secret: 's' }],
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
      agents: [{ name: 'Alice', secret: 's' }],
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
    const roomClients = new Map([['alice', mockClient]])

    const config = {
      rooms: [{ name: 'alice', url: 'http://localhost:3001', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'alice', roomClients })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { backchannel: 'Taking this one.' })

    assert.ok(result.output.includes('Backchannel sent'))
    assert.equal(mockClient.sendBackchannel.mock.callCount(), 1)
    assert.equal(bcSends[0], 'Taking this one.')
  })

  it('backchannel broadcasts to SSE when in home room', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Alice', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'home' })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { backchannel: 'Alice, this is yours.' })

    assert.ok(result.output.includes('Backchannel sent'))
    const calls = room.broadcast.mock.calls.map(c => c.arguments[0])
    assert.ok(calls.some(c => c.type === 'backchannel' && c.text === 'Alice, this is yours.'))
  })

  it('during an idle turn, thought streams live but defers history + idle_done to post-emit', async () => {
    // Regression: gpt-5.4 (and other multi-output models) commonly emit BOTH
    // text and `internal({thought:...})` in the same idle cycle. The tool used
    // to broadcast idle_done and recordHistory on every thought, so the live
    // stream closed prematurely (subsequent text_delta opened a second div)
    // AND the post-emit also recorded its own idle_thought — two entries per
    // cycle in alice/history/*.jsonl (one no-id from tool, one id-tagged from
    // post-emit). Confirmed 2026-05-13 in alice's history. _idleToolThoughts
    // signals an active idle turn — the tool parks the thought there for the
    // unified post-emit and skips its own idle_done/history.
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Alice', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const idleToolThoughts = []
    const room = stubRoom({ _idleToolThoughts: idleToolThoughts })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    await tools.execute('internal', { thought: 'mid-turn aside' })

    const calls = room.broadcast.mock.calls.map(c => c.arguments[0])
    assert.ok(calls.some(c => c.type === 'idle_text_delta' && c.text === 'mid-turn aside'),
      'idle_text_delta must still fire so the live UI streams the thought')
    assert.ok(!calls.some(c => c.type === 'idle_done'),
      'idle_done must NOT fire during an idle turn — agent done event finalizes the stream')
    assert.equal(room.recordHistory.mock.callCount(), 0,
      'recordHistory must NOT fire during an idle turn — post-emit writes the unified entry')
    assert.deepEqual(idleToolThoughts, ['mid-turn aside'],
      'thought must be parked in _idleToolThoughts for the post-emit to fold in')
  })

  it('combines thought and backchannel in one call', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Alice', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'home' })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', {
      thought: 'Not my area.',
      backchannel: 'Alice, this is yours.',
    })

    assert.ok(result.output.includes('Not my area.'))
    assert.ok(result.output.includes('Backchannel sent'))
  })

  it('returns error when neither thought nor backchannel provided', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Alice', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', {})

    assert.ok(result.is_error)
  })

  it('trigger-only call (no backchannel text) wakes target via synthesized default', async () => {
    // Regression: the moderator prompt tells the model to call
    // internal({trigger:true, target:"<host>"}) with no backchannel text when
    // routing a user message to the host. The old code rejected that shape
    // with is_error, so the trigger was silently lost and the host never woke
    // up — the room stayed dead silent on moderator-routes-to-host.
    const dir = await makeTmpDir()
    const bcSends = []
    const mockClient = {
      sendBackchannel: mock.fn(async (text, opts) => { bcSends.push({ text, opts }) }),
      sendMessage: mock.fn(async () => {}),
    }
    const roomClients = new Map([['alice', mockClient]])
    const config = {
      rooms: [{ name: 'alice', url: 'http://localhost:3001', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'alice', roomClients })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { trigger: true, target: 'Alice' })

    assert.equal(result.is_error, undefined, 'trigger-only must succeed, not is_error')
    assert.equal(mockClient.sendBackchannel.mock.callCount(), 1, 'sendBackchannel must fire exactly once')
    assert.ok(bcSends[0].text.length > 0, 'synthesized backchannel text must be non-empty')
    assert.equal(bcSends[0].opts.trigger, true, 'trigger flag must propagate')
    assert.equal(bcSends[0].opts.target, 'Alice', 'target must propagate')
  })

  it('trigger-only broadcast (no target) fires home-room backchannel', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Blue', secret: 's' }, { name: 'Green', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'home' })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    const result = await tools.execute('internal', { trigger: true })

    assert.equal(result.is_error, undefined, 'trigger-only group broadcast must succeed')
    const calls = room.broadcast.mock.calls.map(c => c.arguments[0])
    const bcEvent = calls.find(c => c.type === 'backchannel' && c.trigger === true)
    assert.ok(bcEvent, 'home-room backchannel event must be broadcast')
    assert.ok(bcEvent.text.length > 0, 'synthesized text must be non-empty')
  })

  it('internal with no args at all still rejects', async () => {
    const dir = await makeTmpDir()
    const config = { agents: [{ name: 'Blue', secret: 's' }], memory: { dir: 'memory/', auto_read: [] } }
    const room = stubRoom()
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)
    const result = await tools.execute('internal', {})
    assert.ok(result.is_error, 'zero-arg call must still be rejected')
  })

  it('same-target trigger retry returns is_error + _endTurn to break loop', async () => {
    const dir = await makeTmpDir()
    const config = {
      agents: [{ name: 'Blue', secret: 's' }, { name: 'Green', secret: 's' }],
      memory: { dir: 'memory/', auto_read: [] },
    }
    const room = stubRoom({ _pendingRoom: 'home' })
    const tools = await loadTools(dir, config, stubMemory(), stubState(), room, null)

    // First trigger to Blue — allowed
    const first = await tools.execute('internal', { backchannel: 'Blue, say ready', trigger: true, target: 'Blue' })
    assert.equal(first.is_error, undefined, 'first trigger to Blue should succeed')

    // Second trigger to Blue — must be blocked AND end the turn, otherwise
    // gemini-2.5-pro loops forever retrying the same call after seeing
    // is_error alone (reproduced in test-cluster 2026-04-18).
    const second = await tools.execute('internal', { backchannel: 'Blue again', trigger: true, target: 'Blue' })
    assert.equal(second.is_error, true, 'duplicate target should be blocked')
    assert.equal(second._endTurn, true, 'duplicate target must set _endTurn to stop the loop')
    assert.match(second.output, /Already triggered Blue/)

    // Different target on the same turn — still allowed (not a loop)
    const third = await tools.execute('internal', { backchannel: 'Green, you too', trigger: true, target: 'Green' })
    assert.equal(third.is_error, undefined, 'different target on same turn should be allowed')
  })
})
