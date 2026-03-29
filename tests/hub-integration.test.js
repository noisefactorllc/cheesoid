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

  it('messages to different rooms are isolated', async () => {
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

    // Send to #general
    await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello general', name: 'alice', room: '#general' }),
    })

    // Send to #dev
    await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello dev', name: 'bob', room: '#dev' }),
    })

    // Wait for async processing
    await new Promise(r => setTimeout(r, 100))

    // Check room histories are isolated
    const generalHistory = rooms.get('#general').getScrollback()
    const devHistory = rooms.get('#dev').getScrollback()

    const generalTexts = generalHistory.map(h => h.text)
    assert.ok(generalTexts.includes('hello general'), 'general should have alice message')
    assert.ok(!generalTexts.includes('hello dev'), 'general should not have bob message')

    const devTexts = devHistory.map(h => h.text)
    assert.ok(devTexts.includes('hello dev'), 'dev should have bob message')
    assert.ok(!devTexts.includes('hello general'), 'dev should not have alice message')
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

  it('scrollback endpoint returns room-specific history', async () => {
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

    // Add some history to #general
    rooms.get('#general').recordHistory({ type: 'user_message', name: 'alice', text: 'test message' })

    const res = await fetch(`http://localhost:${port}/api/chat/scrollback?room=%23general`)
    const data = await res.json()
    assert.ok(data.messages.length > 0)
    assert.strictEqual(data.messages[0].text, 'test message')

    // #dev should be empty
    const devRes = await fetch(`http://localhost:${port}/api/chat/scrollback?room=%23dev`)
    const devData = await devRes.json()
    assert.strictEqual(devData.messages.length, 0)
  })
})
