import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Room } from '../server/lib/chat-session.js'
import { loadPersona } from '../server/lib/persona.js'
import { createAuthMiddleware } from '../server/lib/auth.js'
import chatRouter from '../server/routes/chat.js'

async function createTestPersona(name, displayName, extras = {}) {
  const dir = await mkdtemp(join(tmpdir(), `cheesoid-${name}-`))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), `You are ${displayName}.`)

  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'You are in a chat room. Be brief.')

  const config = {
    name,
    display_name: displayName,
    model: 'claude-sonnet-4-6',
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    ...extras,
  }

  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)

  return dir
}

async function startCheesoid(personaDir, port) {
  const persona = await loadPersona(personaDir)
  const app = express()
  app.use(express.json())
  app.locals.persona = persona
  app.locals.room = new Room(persona)
  app.locals.authMiddleware = createAuthMiddleware(persona.config.agents || null)
  app.use(chatRouter)
  const server = app.listen(port)
  return { app, server, room: app.locals.room }
}

describe('Multi-agent room', () => {
  const servers = []

  after(() => {
    for (const s of servers) {
      s.room.destroy()
      s.server.close()
    }
  })

  it('agent receives messages from remote room via addAgentMessage', async () => {
    // Host room on port 4001 that accepts agent connections
    const hostDir = await createTestPersona('host', 'Host', {
      agents: [{ name: 'Guest', secret: 'test-secret' }],
    })
    const host = await startCheesoid(hostDir, 4001)
    servers.push(host)

    // Simulate an agent posting via bearer auth
    const res = await fetch('http://localhost:4001/api/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret',
      },
      body: JSON.stringify({ message: 'hello from guest', name: 'Guest' }),
    })
    const body = await res.json()
    assert.equal(body.status, 'sent')

    // Verify the message was added to the room's conversation history
    // but did NOT trigger the agent (no assistant response)
    await new Promise(r => setTimeout(r, 100))
    const lastMsg = host.room.messages[host.room.messages.length - 1]
    assert.equal(lastMsg.role, 'user')
    assert.ok(lastMsg.content.includes('Guest'))
    assert.ok(lastMsg.content.includes('hello from guest'))
  })

  it('relayAgentEvent broadcasts tool events with agentName', async () => {
    const host = servers[0]
    // relayAgentEvent is fire-and-forget for tool events — no accumulation
    host.room.relayAgentEvent('Alice', { type: 'tool_start', name: 'read_memory' })
    // Just verify it doesn't throw — broadcast goes to SSE clients
  })

  it('POST /api/chat/event relays visitor tool events', async () => {
    const res = await fetch('http://localhost:4001/api/chat/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-secret',
      },
      body: JSON.stringify({
        name: 'Guest',
        event: { type: 'tool_start', name: 'search_history' },
      }),
    })
    const body = await res.json()
    assert.equal(body.status, 'relayed')
  })

  it('POST /api/chat/event rejects invalid token', async () => {
    const res = await fetch('http://localhost:4001/api/chat/event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-secret',
      },
      body: JSON.stringify({
        name: 'Intruder',
        event: { type: 'text_delta', text: 'nope' },
      }),
    })
    assert.equal(res.status, 401)
  })

  it('POST /api/chat/event requires agent auth', async () => {
    const res = await fetch('http://localhost:4001/api/chat/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'anon',
        event: { type: 'text_delta', text: 'nope' },
      }),
    })
    assert.equal(res.status, 403)
  })

  it('rejects invalid agent token', async () => {
    const res = await fetch('http://localhost:4001/api/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-secret',
      },
      body: JSON.stringify({ message: 'should fail', name: 'Intruder' }),
    })
    assert.equal(res.status, 401)
  })

  it('triggering backchannel wakes the agent via processMessage', async () => {
    const hostDir = await createTestPersona('trigger-host', 'TriggerHost', {
      agents: [{ name: 'Visitor', secret: 'trigger-secret' }],
    })
    const host = await startCheesoid(hostDir, 4010)
    servers.push(host)

    let processMessageCalled = false
    const original = host.room._processMessage.bind(host.room)
    host.room._processMessage = async (...args) => {
      processMessageCalled = true
    }

    const res = await fetch('http://localhost:4010/api/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer trigger-secret',
      },
      body: JSON.stringify({
        message: 'Hey TriggerHost, you were addressed in chat',
        name: 'Visitor',
        backchannel: true,
        trigger: true,
      }),
    })
    assert.equal((await res.json()).status, 'sent')
    await new Promise(r => setTimeout(r, 100))
    assert.ok(processMessageCalled, 'trigger backchannel should call _processMessage')
  })

  it('_silent backchannel trigger bypasses floor-skip even when this agent is not on the floor', async () => {
    // Regression: when the host addressed one agent explicitly ("@Green say hi"),
    // the floor was set to [Green]. If the host later called
    // internal({trigger:true}) to wake another agent, the recipient's
    // _processMessage was reached — but the floor-skip at line 888 fired
    // because floor=[Green] didn't include the recipient. The recipient
    // returned silently. A trigger IS explicit permission to speak, so _silent
    // must bypass the floor gate.
    const dir = await createTestPersona('bc-silent', 'BCSilent')
    const persona = await loadPersona(dir)
    const room = new Room(persona)

    room._moderatorPool = ['BCSilent', 'OtherAgent']
    room._floor = ['OtherAgent']
    room.systemPrompt = 'stub'
    room.initialize = async () => {}

    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }

    let resolveCalled = false
    room.registry = {
      resolve: () => { resolveCalled = true; throw new Error('PAST_SKIP') },
    }

    try {
      await room._processMessage('home', 'system', '(backchannel from host) wake — respond to the conversation above.', { _silent: true })
    } catch { /* stub throws after skip-gate */ }

    console.log = origLog
    assert.ok(!logs.some(l => l.includes('Not on floor — skipping response')),
      '_silent trigger should not log "Not on floor — skipping response"')
    assert.ok(resolveCalled,
      'execution should reach model resolution past the floor-skip gate')
    room.destroy() // clean up idle timers so the test runner can exit
  })

  it('host runs delegation-check when visitor was explicitly addressed (multi-target support)', async () => {
    // When explicit addressing sets floor=[Visitor] but the message implies
    // more targets than the parser caught ("Alpha and Beta, each say ready"),
    // the host must still run a delegation-check turn so its LLM can trigger
    // additional visitors. Skip-gate must NOT fire here.
    const dir = await createTestPersona('bc-deleg', 'BCDeleg')
    const persona = await loadPersona(dir)
    const room = new Room(persona)

    room._moderatorPool = ['BCDeleg', 'Alpha', 'Beta']
    room._floor = ['Alpha']
    room.systemPrompt = 'stub'
    room.initialize = async () => {}

    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }

    let resolveCalled = false
    room.registry = {
      resolve: () => { resolveCalled = true; throw new Error('PAST_SKIP') },
    }

    await room._processMessage('home', 'someHuman', 'Alpha and Beta, say ready', { _addressed: ['Alpha'] })

    console.log = origLog
    assert.ok(!logs.some(l => l.includes('Not on floor — skipping response')),
      'host should NOT skip when visitor was addressed — delegation check runs')
    assert.ok(logs.some(l => l.includes('Host delegation check')),
      'host delegation-check log should fire')
    assert.ok(resolveCalled,
      'execution should reach model resolution (host runs its LLM turn)')
    room.destroy()
  })

  it('system message off-floor still honors the skip-gate', async () => {
    // Control: skip-gate still fires when floor is held by another agent and
    // the caller isn't eligible for the host-delegation-check (system/webhook/
    // wakeup). name='system' bypasses the multi-agent floor-add-host logic,
    // so floor stays without the host, and the skip-gate is what stops us.
    const dir = await createTestPersona('bc-floor-skip', 'BCFloorSkip')
    const persona = await loadPersona(dir)
    const room = new Room(persona)

    room._moderatorPool = ['BCFloorSkip', 'OtherAgent']
    room._floor = ['OtherAgent']
    room.systemPrompt = 'stub'
    room.initialize = async () => {}

    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }

    let resolveCalled = false
    room.registry = {
      resolve: () => { resolveCalled = true; throw new Error('PAST_SKIP') },
    }

    await room._processMessage('home', 'system', 'not from a human', {})

    console.log = origLog
    assert.ok(logs.some(l => l.includes('Not on floor — skipping response')),
      'system off-floor traffic should log the skip')
    assert.ok(!resolveCalled,
      'skipped call must not reach model resolution')
    room.destroy()
  })

  it('floor marker is NOT appended to user messages (would echo back into chat)', async () => {
    // Regression: alice's chat output started with "[floor: Alice]" because the
    // floor note was appended as a suffix to the user message in this.messages.
    // Open-weights executors mimic that suffix straight back into their reply.
    // Same lesson the codebase already learned for moderatorAddendum (line 1293
    // comment: "Append moderator duties to system prompt — NOT to messages
    // (prevents echo leak)") and for DM markers (lines 791-795: "prefixes tend
    // to get mimicked back into the reply"). The floor note must live in the
    // system prompt, not in the user message.
    const dir = await createTestPersona('floor-noecho', 'Alice')
    const persona = await loadPersona(dir)
    const room = new Room(persona)

    room._moderatorPool = ['Alice', 'Alpha']
    room._floor = ['Alice']
    room.systemPrompt = 'stub'
    room.initialize = async () => {}

    // Throw at model resolution so we stop before agent execution but AFTER
    // the floor-injection codepath would have run. The catch in _processMessage
    // swallows non-provider errors silently (no .layer), so no rethrow needed.
    room.registry = {
      resolve: () => { throw new Error('PAST_FLOOR_INJECT') },
    }

    await room._processMessage('home', 'Alex', 'hey alice how is it going')

    const lastUser = [...room.messages].reverse().find(m => m.role === 'user')
    assert.ok(lastUser, 'user message should be in context')
    assert.ok(lastUser.content.includes('hey alice how is it going'),
      'user text should be present')
    assert.ok(!lastUser.content.includes('[floor:'),
      `user message must not carry "[floor: ...]" suffix — got: ${JSON.stringify(lastUser.content)}`)
    room.destroy()
  })

  it('non-triggering backchannel only appends context', async () => {
    const host = servers[servers.length - 1]

    let processMessageCalled = false
    host.room._processMessage = async () => { processMessageCalled = true }

    const msgCountBefore = host.room.messages.length
    const res = await fetch('http://localhost:4010/api/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer trigger-secret',
      },
      body: JSON.stringify({
        message: 'just coordination, no trigger',
        name: 'Visitor',
        backchannel: true,
      }),
    })
    assert.equal((await res.json()).status, 'sent')
    await new Promise(r => setTimeout(r, 100))
    assert.ok(!processMessageCalled, 'non-trigger backchannel should not call _processMessage')
    assert.ok(host.room.messages.length > msgCountBefore, 'message should be appended to context')
  })

  it('host assistant_message is broadcast with name so visitors can attribute it', async () => {
    const hostDir = await createTestPersona('broadcast-host', 'BroadcastHost', {
      agents: [{ name: 'Alice', secret: 'alice-secret' }],
    })
    const host = await startCheesoid(hostDir, 4011)
    servers.push(host)

    const broadcasts = []
    const origBroadcast = host.room.broadcast.bind(host.room)
    host.room.broadcast = (event) => {
      broadcasts.push(event)
      origBroadcast(event)
    }

    host.room._pendingRoom = 'home'
    host.room._handleAssistantTextTurn('Alice, can you take this one?', 'test-model')

    const messages = broadcasts.filter(e => e.type === 'assistant_message')
    assert.equal(messages.length, 1, 'should broadcast assistant_message for visitor consumption')
    assert.equal(messages[0].name, 'BroadcastHost', 'broadcast must include host name')
    assert.ok(messages[0].text.includes('Alice'))
    assert.ok(messages[0].id, 'should carry an id')
  })

  it('visitor receiving host assistant_message appends it to context', async () => {
    const visitorDir = await createTestPersona('visitor-ctx', 'Alice', {
      rooms: [{ name: 'host-room', url: 'http://localhost:4099', secret: 's' }],
    })
    const visitor = await startCheesoid(visitorDir, 4014)
    servers.push(visitor)

    const realClient = visitor.room.roomClients.get('host-room')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('host-room', { sendMessage: async () => {}, sendBackchannel: async () => {}, sendEvent: async () => {}, destroy: () => {} })

    const before = visitor.room.messages.length
    visitor.room._handleRemoteEvent({ type: 'assistant_message', name: 'Host', text: 'Random remark, no addressing.' }, 'host-room')
    const last = visitor.room.messages[visitor.room.messages.length - 1]
    assert.equal(visitor.room.messages.length, before + 1, 'should append host chat to context')
    assert.ok(last.content.includes('Host: Random remark'))
  })

  it('visitor self-triggers when host addresses it by name', async () => {
    const visitorDir = await createTestPersona('visitor-trig', 'Alice', {
      rooms: [{ name: 'host-room', url: 'http://localhost:4099', secret: 's' }],
    })
    const visitor = await startCheesoid(visitorDir, 4016)
    servers.push(visitor)

    const realClient = visitor.room.roomClients.get('host-room')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('host-room', { sendMessage: async () => {}, sendBackchannel: async () => {}, sendEvent: async () => {}, destroy: () => {} })

    const calls = []
    visitor.room._processMessage = async (room, name, text, opts) => {
      calls.push({ room, name, text, opts })
    }

    visitor.room._handleRemoteEvent({ type: 'assistant_message', name: 'Host', text: 'Alice, what do you think?' }, 'host-room')
    await new Promise(r => setTimeout(r, 10))

    assert.equal(calls.length, 1, 'addressed visitor should self-trigger')
    assert.equal(calls[0].room, 'host-room')
    assert.equal(calls[0].name, 'system')
    assert.ok(calls[0].opts._silent, 'trigger must be silent (no broadcast back)')
    assert.ok(calls[0].opts._backchannelTrigger, 'must mark as backchannel-triggered to prevent cascades')
  })

  it('visitor does NOT self-trigger when host chat does not address it', async () => {
    const visitorDir = await createTestPersona('visitor-nontrig', 'Alice', {
      rooms: [{ name: 'host-room', url: 'http://localhost:4099', secret: 's' }],
    })
    const visitor = await startCheesoid(visitorDir, 4017)
    servers.push(visitor)

    const realClient = visitor.room.roomClients.get('host-room')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('host-room', { sendMessage: async () => {}, sendBackchannel: async () => {}, sendEvent: async () => {}, destroy: () => {} })

    let triggered = false
    visitor.room._processMessage = async () => { triggered = true }

    visitor.room._handleRemoteEvent({ type: 'assistant_message', name: 'Host', text: 'Just thinking out loud here.' }, 'host-room')
    await new Promise(r => setTimeout(r, 10))

    assert.ok(!triggered, 'visitor should not respond when not addressed')
  })

  it('visitor ignores host assistant_message when busy', async () => {
    const visitorDir = await createTestPersona('visitor-busy', 'Alice', {
      rooms: [{ name: 'host-room', url: 'http://localhost:4099', secret: 's' }],
    })
    const visitor = await startCheesoid(visitorDir, 4018)
    servers.push(visitor)

    const realClient = visitor.room.roomClients.get('host-room')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('host-room', { sendMessage: async () => {}, sendBackchannel: async () => {}, sendEvent: async () => {}, destroy: () => {} })

    visitor.room.busy = true
    let triggered = false
    visitor.room._processMessage = async () => { triggered = true }

    visitor.room._handleRemoteEvent({ type: 'assistant_message', name: 'Host', text: 'Alice, are you there?' }, 'host-room')
    await new Promise(r => setTimeout(r, 10))

    assert.ok(!triggered, 'busy visitor should defer rather than trigger mid-turn')
    // Context still receives the host text — _safeAppendMessage queues it on
    // _pendingContextMessages while busy, then flushes into messages at the
    // end of the current turn so the visitor sees it on the next response.
    const queued = visitor.room._pendingContextMessages || []
    assert.ok(queued.some(m => m.content && m.content.includes('Alice, are you there?')),
      'queued for next turn so the host chat is not lost')
  })

  it('visitor ignores DM-flagged assistant_message events (not group chat)', async () => {
    const visitorDir = await createTestPersona('visitor-dm-skip', 'Alice', {
      rooms: [{ name: 'host-room', url: 'http://localhost:4099', secret: 's' }],
    })
    const visitor = await startCheesoid(visitorDir, 4019)
    servers.push(visitor)

    const realClient = visitor.room.roomClients.get('host-room')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('host-room', { sendMessage: async () => {}, sendBackchannel: async () => {}, sendEvent: async () => {}, destroy: () => {} })

    const before = visitor.room.messages.length
    visitor.room._handleRemoteEvent({
      type: 'assistant_message', name: 'Host', text: 'Alice, private note', dm_from: 'Host', dm_to: 'Someone',
    }, 'host-room')
    assert.equal(visitor.room.messages.length, before, 'DM responses must not contaminate visitor group context')
  })

  it('auto-nudges mentioned agent via room client when visiting', async () => {
    const visitorDir = await createTestPersona('visitor-nudge', 'VisitorNudge', {
      rooms: [{ name: 'alice', url: 'http://localhost:4099', secret: 's', domain: 'alice.test' }],
    })
    const visitor = await startCheesoid(visitorDir, 4012)
    servers.push(visitor)

    const bcSends = []
    const realClient = visitor.room.roomClients.get('alice')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('alice', {
      sendBackchannel: (text, opts) => { bcSends.push({ text, ...opts }) },
      sendMessage: () => {},
      destroy: () => {},
    })

    visitor.room._pendingRoom = 'alice'
    visitor.room._autoNudgeMentionedAgents('Hey alice, what do you think?')
    assert.equal(bcSends.length, 1)
    assert.ok(bcSends[0].text.includes('alice'))
  })

  it('internal tool delivers thought to home and backchannel to remote room', async () => {
    const visitorDir = await createTestPersona('internal-test', 'InternalTest', {
      rooms: [{ name: 'alice', url: 'http://localhost:4099', secret: 's', domain: 'alice.test' }],
    })
    const visitor = await startCheesoid(visitorDir, 4015)
    servers.push(visitor)

    const bcSends = []
    const mockClient = {
      sendBackchannel: async (text) => { bcSends.push(text) },
      sendMessage: async () => {},
      sendEvent: () => {},
      destroy: () => {},
    }
    // Initialize tools (happens on first message normally)
    // Must happen before setting mock client, as initialize() creates real RoomClients
    if (!visitor.room.tools) await visitor.room.initialize()

    // Override the real RoomClient with our mock after initialization
    const realClient = visitor.room.roomClients.get('alice')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('alice', mockClient)

    // Simulate being in a remote room
    visitor.room._pendingRoom = 'alice'

    // Call internal tool directly (simulating what the agent loop does)
    const result = await visitor.room.tools.execute('internal', {
      thought: 'Not my area of expertise.',
      backchannel: 'Alice, this is your domain.',
    })

    // Thought echoed in result for agent memory
    assert.ok(result.output.includes('Not my area of expertise.'))
    assert.ok(result.output.includes('Backchannel sent'))

    // Backchannel delivered to remote room
    assert.equal(bcSends.length, 1)
    assert.equal(bcSends[0], 'Alice, this is your domain.')
  })

  it('full host→visitor flow: host turn broadcasts assistant_message that the visitor consumes', async () => {
    const hostDir = await createTestPersona('coord-host', 'CoordHost', {
      agents: [{ name: 'Helper', secret: 'helper-secret' }],
    })
    const host = await startCheesoid(hostDir, 4013)
    servers.push(host)

    // Subscribe a fake visitor SSE client — this is what RoomClient does in
    // production. Capture every event the host broadcasts so we can verify
    // the chat actually crosses the SSE boundary.
    const events = []
    const fakeRes = {
      writableEnded: false,
      writable: true,
      on() {},
      end() { fakeRes.writable = false; fakeRes.writableEnded = true },
      write(chunk) {
        const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '))
        for (const line of lines) {
          try { events.push(JSON.parse(line.slice(6))) } catch { /* ignore */ }
        }
        return true
      },
    }
    host.room.addClient(fakeRes, 'Helper', true)

    host.room._pendingRoom = 'home'
    host.room._handleAssistantTextTurn('Helper, can you look into this?', 'test-model')

    const messages = events.filter(e => e.type === 'assistant_message')
    assert.equal(messages.length, 1, 'visitor SSE must receive the host chat')
    assert.equal(messages[0].name, 'CoordHost', 'attributable to the host')
    assert.ok(messages[0].text.includes('Helper, can you look into this?'),
      'full text reaches the visitor — not just an id')
  })

  it('host chat carries addressed_to derived from internal({trigger,target}) calls in same turn', async () => {
    const dir = await createTestPersona('addr-host', 'AddrHost', {
      agents: [{ name: 'Blue', secret: 's' }, { name: 'Green', secret: 's' }],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)

    // Simulate the orchestrator state: a turn populated _triggerTargetsThisTurn
    // by calling internal({trigger,target}) earlier in the same loop.
    room._pendingRoom = 'home'
    room._triggerTargetsThisTurn = new Set(['Blue'])

    const broadcasts = []
    const orig = room.broadcast.bind(room)
    room.broadcast = (event) => { broadcasts.push(event); orig(event) }

    room._handleAssistantTextTurn('Hello, Blue.', 'test-model')

    const chat = broadcasts.find(e => e.type === 'assistant_message')
    assert.ok(chat, 'host chat must broadcast')
    assert.deepEqual(chat.addressed_to, ['Blue'], 'addressing intent travels with the chat event')
    assert.ok(!chat.addressed_all, 'individual target should not set addressed_all')
    room.destroy()
  })

  it('host chat sets addressed_all when host did a broadcast trigger this turn', async () => {
    const dir = await createTestPersona('addr-all', 'AddrAll', {
      agents: [{ name: 'Blue', secret: 's' }],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)

    room._pendingRoom = 'home'
    room._triggerTargetsThisTurn = new Set(['__broadcast__'])

    const broadcasts = []
    const orig = room.broadcast.bind(room)
    room.broadcast = (event) => { broadcasts.push(event); orig(event) }

    room._handleAssistantTextTurn('Everyone, weigh in.', 'test-model')

    const chat = broadcasts.find(e => e.type === 'assistant_message')
    assert.equal(chat.addressed_all, true, 'broadcast trigger surfaces as addressed_all')
    assert.ok(!chat.addressed_to, 'no per-name list when only __broadcast__ triggered')
    room.destroy()
  })

  it('visitor wakes from addressed_to without parser involvement', async () => {
    const visitorDir = await createTestPersona('addr-visitor', 'Blue', {
      rooms: [{ name: 'host-room', url: 'http://localhost:4099', secret: 's' }],
    })
    const visitor = await startCheesoid(visitorDir, 4020)
    servers.push(visitor)

    const realClient = visitor.room.roomClients.get('host-room')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('host-room', { sendMessage: async () => {}, sendBackchannel: async () => {}, sendEvent: async () => {}, destroy: () => {} })

    const triggers = []
    visitor.room._processMessage = async (...args) => { triggers.push(args) }

    // Phrase the parser definitely cannot match — but addressed_to says
    // we are addressed. Visitor should wake on the LLM-provided routing.
    visitor.room._handleRemoteEvent({
      type: 'assistant_message', name: 'Host',
      text: 'Random thought, no vocative pattern at all.',
      addressed_to: ['Blue'],
    }, 'host-room')
    await new Promise(r => setTimeout(r, 10))

    assert.equal(triggers.length, 1, 'addressed_to is authoritative — visitor wakes regardless of phrasing')
  })

  it('visitor wakes from addressed_all (broadcast trigger) regardless of phrasing', async () => {
    const visitorDir = await createTestPersona('addr-all-visitor', 'Blue', {
      rooms: [{ name: 'host-room', url: 'http://localhost:4099', secret: 's' }],
    })
    const visitor = await startCheesoid(visitorDir, 4021)
    servers.push(visitor)

    const realClient = visitor.room.roomClients.get('host-room')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('host-room', { sendMessage: async () => {}, sendBackchannel: async () => {}, sendEvent: async () => {}, destroy: () => {} })

    const triggers = []
    visitor.room._processMessage = async (...args) => { triggers.push(args) }

    visitor.room._handleRemoteEvent({
      type: 'assistant_message', name: 'Host',
      text: 'I have an announcement.',
      addressed_all: true,
    }, 'host-room')
    await new Promise(r => setTimeout(r, 10))

    assert.equal(triggers.length, 1, 'broadcast addressing wakes everyone')
  })

  it('chat event broadcasts BEFORE deferred trigger backchannel — race fix', async () => {
    const dir = await createTestPersona('order-host', 'OrderHost', {
      agents: [{ name: 'Blue', secret: 's' }],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)

    // Active host turn — internal({trigger,target}) will queue, not broadcast
    room.busy = true
    room._pendingRoom = 'home'
    room._triggerTargetsThisTurn = new Set()
    const memDir = await mkdtemp(join(tmpdir(), 'order-tools-'))
    await writeFile(join(memDir, 'MEMORY.md'), '')
    const tools = await (await import('../server/lib/tools.js')).loadTools(memDir, persona.config, null, null, room, null)

    const events = []
    const orig = room.broadcast.bind(room)
    room.broadcast = (event) => { events.push(event); orig(event) }

    // Step 1: model fires internal({trigger,target}) early in the turn
    await tools.execute('internal', { trigger: true, target: 'Blue', backchannel: 'Blue, take this' })

    // Should have queued, not broadcast
    const triggersBeforeChat = events.filter(e => e.type === 'backchannel' && e.trigger)
    assert.equal(triggersBeforeChat.length, 0,
      'trigger broadcast must defer during active home turn — otherwise visitor wakes ungrounded')
    assert.equal(room._pendingBackchannels.length, 1, 'trigger queued for end-of-turn flush')

    // Step 2: model writes chat at later orchestrator turn
    room._handleAssistantTextTurn('Hello, Blue.', 'test-model')

    // Order check: chat event index < backchannel event index
    const chatIdx = events.findIndex(e => e.type === 'assistant_message')
    const trigIdx = events.findIndex(e => e.type === 'backchannel' && e.trigger)
    assert.ok(chatIdx >= 0, 'chat broadcast fires')
    assert.ok(trigIdx >= 0, 'trigger broadcast fires after chat')
    assert.ok(chatIdx < trigIdx, `chat (idx ${chatIdx}) must broadcast BEFORE trigger (idx ${trigIdx})`)
    assert.equal(room._pendingBackchannels.length, 0, 'queue drained after chat broadcast')
    room.destroy()
  })

  it('pure handoff: trigger without chat still flushes at end of turn', async () => {
    const dir = await createTestPersona('handoff-host', 'HandoffHost', {
      agents: [{ name: 'Blue', secret: 's' }],
    })
    const persona = await loadPersona(dir)
    const room = new Room(persona)

    room.busy = true
    room._pendingRoom = 'home'
    room._triggerTargetsThisTurn = new Set()
    const memDir = await mkdtemp(join(tmpdir(), 'handoff-tools-'))
    await writeFile(join(memDir, 'MEMORY.md'), '')
    const tools = await (await import('../server/lib/tools.js')).loadTools(memDir, persona.config, null, null, room, null)

    const events = []
    const orig = room.broadcast.bind(room)
    room.broadcast = (event) => { events.push(event); orig(event) }

    await tools.execute('internal', { trigger: true, target: 'Blue', backchannel: 'over to you' })
    assert.equal(events.filter(e => e.type === 'backchannel').length, 0, 'queued, not broadcast')

    // No chat fires this turn — simulate end-of-turn flush
    room._flushPendingBackchannels()
    const trigs = events.filter(e => e.type === 'backchannel' && e.trigger)
    assert.equal(trigs.length, 1, 'pure-handoff trigger must still fire at end of turn')
    assert.equal(trigs[0].target, 'Blue')
    room.destroy()
  })
})
