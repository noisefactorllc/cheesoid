// tests/hub-presence.test.js
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'
import { RoomManager } from '../server/lib/room-manager.js'
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

describe('Hub presence endpoint', () => {
  let server
  let roomsRef

  after(() => {
    if (server) server.close()
    if (roomsRef) roomsRef.destroy()
  })

  it('returns rooms list in hub mode', async () => {
    const dir = await createHubPersona()
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)
    roomsRef = rooms

    const app = express()
    app.use(express.json())
    app.locals.persona = persona
    app.locals.rooms = rooms
    Object.defineProperty(app.locals, 'room', {
      get() { return rooms.resolve() },
    })
    app.use(healthRouter)
    server = app.listen(0)
    const port = server.address().port

    const res = await fetch(`http://localhost:${port}/api/presence`)
    const data = await res.json()

    assert.strictEqual(data.persona, 'Hub')
    assert.ok(data.hosted_rooms)
    assert.deepStrictEqual(data.hosted_rooms, ['#general', '#dev'])
    assert.ok(Array.isArray(data.participants))
  })
})
