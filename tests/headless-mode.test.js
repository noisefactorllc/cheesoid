import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loadPersona } from '../server/lib/persona.js'

async function createHeadlessPersona() {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-headless-'))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(join(memDir, 'MEMORY.md'), '')
  await writeFile(join(dir, 'SOUL.md'), 'You are Headless.')
  const promptsDir = join(dir, 'prompts')
  await mkdir(promptsDir, { recursive: true })
  await writeFile(join(promptsDir, 'system.md'), 'Be brief.')
  const config = {
    name: 'headless',
    display_name: 'Headless',
    model: 'claude-sonnet-4-6',
    headless: true,
    chat: { prompt: 'prompts/system.md', max_turns: 1 },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
  }
  const yaml = Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  await writeFile(join(dir, 'persona.yaml'), yaml)
  return dir
}

describe('Headless mode', () => {
  it('headless persona config has headless: true', async () => {
    const dir = await createHeadlessPersona()
    const persona = await loadPersona(dir)
    assert.strictEqual(persona.config.headless, true)
  })
})
