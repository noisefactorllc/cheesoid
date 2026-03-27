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
    host.room._autoNudgeMentionedAgents('Hey Brad, what do you think about this?', '')
    assert.equal(backchannelSends.length, 1)
    assert.ok(backchannelSends[0].text.includes('Brad'))
  })

  it('skips auto-nudge when agent already mentioned in backchannel', async () => {
    const host = servers[servers.length - 1]
    const backchannelSends = []
    host.room.addBackchannelMessage = (name, text, opts) => {
      backchannelSends.push({ name, text, ...opts })
    }

    host.room._pendingRoom = 'home'
    host.room._autoNudgeMentionedAgents('Hey Brad, check this out', 'Brad, this is yours to handle')
    assert.equal(backchannelSends.length, 0, 'should skip — Brad already addressed in backchannel')
  })

  it('does not nudge names that are not known agents', async () => {
    const host = servers[servers.length - 1]
    const backchannelSends = []
    host.room.addBackchannelMessage = (name, text, opts) => {
      backchannelSends.push({ name, text, ...opts })
    }

    host.room._pendingRoom = 'home'
    host.room._autoNudgeMentionedAgents('Hey random person, what do you think?', '')
    assert.equal(backchannelSends.length, 0, 'should not nudge unknown names')
  })
})
