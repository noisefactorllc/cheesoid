import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'
import { RoomManager } from '../server/lib/room-manager.js'

async function createTestPersona(name, extras = {}) {
  const dir = await mkdtemp(join(tmpdir(), `cheesoid-${name}-`))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), `You are ${name}.`)
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
  const config = {
    name,
    display_name: name,
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

describe('RoomManager integration', () => {
  it('hub persona creates multiple rooms', async () => {
    const dir = await createTestPersona('hub-test', {
      hosted_rooms: ['#general', '#dev'],
    })
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)
    assert.strictEqual(rooms.isHub, true)
    assert.deepStrictEqual(rooms.roomNames, ['#general', '#dev'])
  })

  it('legacy persona creates single default room', async () => {
    const dir = await createTestPersona('legacy-test')
    const persona = await loadPersona(dir)
    const rooms = new RoomManager(persona)
    assert.strictEqual(rooms.isHub, false)
    assert.ok(rooms.defaultRoom)
  })
})
