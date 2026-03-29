// tests/chat-routes-hub.test.js
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

function setupApp(persona, rooms) {
  const app = express()
  app.use(express.json())
  app.locals.persona = persona
  app.locals.rooms = rooms
  Object.defineProperty(app.locals, 'room', {
    get() { return rooms.resolve() },
  })
  app.locals.authMiddleware = createAuthMiddleware(null)
  app.use(chatRouter)
  return app
}

describe('Chat routes — hub mode', () => {
  const servers = []
  const managers = []

  after(() => {
    for (const s of servers) s.close()
    for (const m of managers) m.destroy()
  })

  it('POST /api/chat/send with room field routes to correct room', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)
    managers.push(rooms)
    const app = setupApp(persona, rooms)
    const server = app.listen(0)
    servers.push(server)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', name: 'alice', room: '#general' }),
    })
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.status, 'sent')
  })

  it('POST /api/chat/send without room field uses default (first) room in hub mode', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)
    managers.push(rooms)
    const app = setupApp(persona, rooms)
    const server = app.listen(0)
    servers.push(server)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', name: 'alice' }),
    })
    assert.strictEqual(res.status, 200)
  })

  it('POST /api/chat/send returns 404 for unknown room', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)
    managers.push(rooms)
    const app = setupApp(persona, rooms)
    const server = app.listen(0)
    servers.push(server)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello', name: 'alice', room: '#nonexistent' }),
    })
    assert.strictEqual(res.status, 404)
  })
})
