// tests/hub-integration.test.js
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'
import { RoomManager } from '../server/lib/room-manager.js'
import { createAuthMiddleware } from '../server/lib/auth.js'
import chatRouter from '../server/routes/chat.js'
import healthRouter from '../server/routes/health.js'

async function createHubPersona() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-hub-'))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), 'You are Hub.')
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
  const config = {
    name: 'hub',
    display_name: 'Hub',
    model: 'claude-sonnet-4-6',
    hosted_rooms: ['#general', '#dev'],
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
  }
  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)
  return dir
}

describe('Hub integration', () => {
  const servers = []
  const managers = []

  after(() => {
    for (const m of managers) m.destroy()
    for (const s of servers) s.close()
  })

  function track(rooms, server) {
    managers.push(rooms)
    servers.push(server)
  }

  it('presence returns hosted_rooms list', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    app.use(healthRouter)
    const server = app.listen(0)
    track(rooms, server)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/presence`)
    const data = await res.json()
    assert.deepStrictEqual(data.hosted_rooms, ['#general', '#dev'])
  })

  it('messages tagged with their originating room in shared history', async () => {
    // Architecture: "Agent awareness is singular — one messages array, one
    // history" (see RoomManager docstring). History is shared across rooms,
    // but each entry carries a `room` field identifying where it arrived.
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    app.use(healthRouter)
    const server = app.listen(0)
    track(rooms, server)
    const port = server.address().port

    await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello general', name: 'alice', room: '#general' }),
    })
    await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello dev', name: 'bob', room: '#dev' }),
    })

    // Poll rather than fixed-sleep: first-message room initialization does
    // real I/O (memory, chat log, harness stores) and a fixed 100ms loses
    // races under full-suite parallel load.
    let history = []
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      history = rooms.get('#general').getScrollback()
      if (history.find(h => h.text === 'hello general') && history.find(h => h.text === 'hello dev')) break
      await new Promise(r => setTimeout(r, 50))
    }
    const general = history.find(h => h.text === 'hello general')
    const dev = history.find(h => h.text === 'hello dev')
    assert.ok(general, 'general message in shared history')
    assert.ok(dev, 'dev message in shared history')
    assert.equal(general.room, '#general', 'general message tagged with #general')
    assert.equal(dev.room, '#dev', 'dev message tagged with #dev')
  })

  it('DMs are routed to both participants', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    const server = app.listen(0)
    track(rooms, server)
    const port = server.address().port

    // Register DM clients for alice and bob
    const aliceEvents = []
    const bobEvents = []

    const aliceClient = { write: (data) => aliceEvents.push(data) }
    const bobClient = { write: (data) => bobEvents.push(data) }
    rooms.addDMClient(aliceClient, 'alice')
    rooms.addDMClient(bobClient, 'bob')

    // Send DM from alice to bob
    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hey bob', name: 'alice', to: 'bob' }),
    })
    assert.strictEqual(res.status, 200)

    // Both should receive the DM
    assert.strictEqual(aliceEvents.length, 1, 'alice should receive DM')
    assert.strictEqual(bobEvents.length, 1, 'bob should receive DM')

    const aliceEvent = JSON.parse(aliceEvents[0].replace('data: ', '').trim())
    assert.strictEqual(aliceEvent.from, 'alice')
    assert.strictEqual(aliceEvent.to, 'bob')
    assert.strictEqual(aliceEvent.text, 'hey bob')
  })

  it('scrollback endpoint returns shared history regardless of room', async () => {
    // History is shared across rooms on a single agent. The endpoint still
    // accepts a `room` query param for routing the request to a valid room,
    // but the returned messages are the agent's shared history.
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.locals.authMiddleware = createAuthMiddleware(null)
    app.use(chatRouter)
    const server = app.listen(0)
    track(rooms, server)
    const port = server.address().port

    rooms.get('#general').recordHistory({ type: 'user_message', name: 'alice', text: 'test message', room: '#general' })

    const res = await fetch(`http://localhost:${port}/api/chat/scrollback?room=%23general`)
    const data = await res.json()
    assert.ok(data.messages.some(m => m.text === 'test message'))

    const devRes = await fetch(`http://localhost:${port}/api/chat/scrollback?room=%23dev`)
    const devData = await devRes.json()
    assert.ok(devData.messages.some(m => m.text === 'test message'),
      'shared history means #dev sees the same entries')
  })
})
