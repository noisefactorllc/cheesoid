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
    host.room.relayAgentEvent('Brad', { type: 'tool_start', name: 'read_memory' })
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

  it('auto-nudges mentioned agent via backchannel', async () => {
    const hostDir = await createTestPersona('nudge-host', 'NudgeHost', {
      agents: [{ name: 'Brad', secret: 'brad-secret' }],
    })
    const host = await startCheesoid(hostDir, 4011)
    servers.push(host)

    const backchannelSends = []
    host.room.addBackchannelMessage = (name, text, opts) => {
      backchannelSends.push({ name, text, ...opts })
    }

    host.room._pendingRoom = 'home'
    host.room._autoNudgeMentionedAgents('Hey Brad, what do you think about this?')
    assert.equal(backchannelSends.length, 1)
    assert.ok(backchannelSends[0].text.includes('Brad'))
  })

  it('auto-nudges mentioned agent in public text', async () => {
    const host = servers[servers.length - 1]
    const backchannelSends = []
    host.room.addBackchannelMessage = (name, text, opts) => {
      backchannelSends.push({ name, text, ...opts })
    }

    host.room._pendingRoom = 'home'
    host.room._autoNudgeMentionedAgents('Hey Brad, check this out')
    assert.equal(backchannelSends.length, 1, 'should nudge Brad')
  })

  it('does not nudge names that are not known agents', async () => {
    const host = servers[servers.length - 1]
    const backchannelSends = []
    host.room.addBackchannelMessage = (name, text, opts) => {
      backchannelSends.push({ name, text, ...opts })
    }

    host.room._pendingRoom = 'home'
    host.room._autoNudgeMentionedAgents('Hey random person, what do you think?')
    assert.equal(backchannelSends.length, 0, 'should not nudge unknown names')
  })

  it('auto-nudges mentioned agent via room client when visiting', async () => {
    const visitorDir = await createTestPersona('visitor-nudge', 'VisitorNudge', {
      rooms: [{ name: 'brad', url: 'http://localhost:4099', secret: 's', domain: 'brad.test' }],
    })
    const visitor = await startCheesoid(visitorDir, 4012)
    servers.push(visitor)

    const bcSends = []
    const realClient = visitor.room.roomClients.get('brad')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('brad', {
      sendBackchannel: (text, opts) => { bcSends.push({ text, ...opts }) },
      sendMessage: () => {},
      destroy: () => {},
    })

    visitor.room._pendingRoom = 'brad'
    visitor.room._autoNudgeMentionedAgents('Hey brad, what do you think?')
    assert.equal(bcSends.length, 1)
    assert.ok(bcSends[0].text.includes('brad'))
  })

  it('internal tool delivers thought to home and backchannel to remote room', async () => {
    const visitorDir = await createTestPersona('internal-test', 'InternalTest', {
      rooms: [{ name: 'brad', url: 'http://localhost:4099', secret: 's', domain: 'brad.test' }],
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
    const realClient = visitor.room.roomClients.get('brad')
    if (realClient) realClient.destroy()
    visitor.room.roomClients.set('brad', mockClient)

    // Simulate being in a remote room
    visitor.room._pendingRoom = 'brad'

    // Call internal tool directly (simulating what the agent loop does)
    const result = await visitor.room.tools.execute('internal', {
      thought: 'Not my area of expertise.',
      backchannel: 'Brad, this is your domain.',
    })

    // Thought echoed in result for agent memory
    assert.ok(result.output.includes('Not my area of expertise.'))
    assert.ok(result.output.includes('Backchannel sent'))

    // Backchannel delivered to remote room
    assert.equal(bcSends.length, 1)
    assert.equal(bcSends[0], 'Brad, this is your domain.')
  })

  it('full coordination flow: mention → auto-nudge → backchannel delivered', async () => {
    const hostDir = await createTestPersona('coord-host', 'CoordHost', {
      agents: [{ name: 'Helper', secret: 'helper-secret' }],
    })
    const host = await startCheesoid(hostDir, 4013)
    servers.push(host)

    // Track all backchannel messages added
    const bcMessages = []
    const origAddBc = host.room.addBackchannelMessage.bind(host.room)
    host.room.addBackchannelMessage = (name, text, opts) => {
      bcMessages.push({ name, text, ...opts })
      origAddBc(name, text, opts)
    }

    // Simulate the post-response auto-nudge flow
    host.room._pendingRoom = 'home'
    host.room._autoNudgeMentionedAgents('Helper, can you look into this?')

    assert.equal(bcMessages.length, 1)
    assert.equal(bcMessages[0].name, 'system')
    assert.ok(bcMessages[0].text.includes('Helper'))

    // Verify it was appended to agent context
    const lastMsg = host.room.messages[host.room.messages.length - 1]
    assert.ok(lastMsg.content.includes('backchannel'))
    assert.ok(lastMsg.content.includes('Helper'))
  })
})
