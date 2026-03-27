import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assemblePrompt } from '../server/lib/prompt-assembler.js'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('assemblePrompt', () => {
  async function makePersona(files) {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-test-'))
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path)
      await mkdir(join(full, '..'), { recursive: true })
      await writeFile(full, content)
    }
    return dir
  }

  it('assembles identity + SOUL + system prompt + memory in order', async () => {
    const dir = await makePersona({
      'SOUL.md': 'I am the soul.',
      'prompts/system.md': 'System context here.',
      'memory/MEMORY.md': 'I remember things.',
    })

    const result = await assemblePrompt(dir, {
      display_name: 'Test Agent',
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    })

    assert.ok(result.includes('Your name is Test Agent.'))
    assert.ok(result.includes('I am the soul.'))
    assert.ok(result.includes('System context here.'))
    assert.ok(result.includes('I remember things.'))

    // Order: identity → SOUL → system → memory
    const nameIdx = result.indexOf('Your name is Test Agent.')
    const soulIdx = result.indexOf('I am the soul.')
    const systemIdx = result.indexOf('System context here.')
    const memoryIdx = result.indexOf('I remember things.')
    assert.ok(nameIdx < soulIdx)
    assert.ok(soulIdx < systemIdx)
    assert.ok(systemIdx < memoryIdx)
  })

  it('works when memory files are missing', async () => {
    const dir = await makePersona({
      'SOUL.md': 'I am the soul.',
      'prompts/system.md': 'System context.',
    })
    await mkdir(join(dir, 'memory'), { recursive: true })

    const result = await assemblePrompt(dir, {
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    })

    assert.ok(result.includes('I am the soul.'))
    assert.ok(result.includes('System context.'))
  })

  it('reads multiple memory files', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
      'memory/MEMORY.md': 'Core memory.',
      'memory/topics.md': 'Topic notes.',
    })

    const result = await assemblePrompt(dir, {
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md', 'topics.md'] },
    })

    assert.ok(result.includes('Core memory.'))
    assert.ok(result.includes('Topic notes.'))
  })

  it('includes source trust hierarchy before memory', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
      'memory/MEMORY.md': 'Memory content.',
    })

    const result = await assemblePrompt(dir, {
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    })

    assert.ok(result.includes('Source Trust Hierarchy'))
    assert.ok(result.includes('Live data'))

    const trustIdx = result.indexOf('Source Trust Hierarchy')
    const memoryIdx = result.indexOf('Memory content.')
    assert.ok(trustIdx < memoryIdx)
  })

  it('includes plugin skill content after system prompt', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System prompt.',
      'memory/MEMORY.md': 'Memory.',
    })

    const plugins = [{
      name: 'test-plugin',
      skills: [{
        name: 'test-skill',
        content: '# Test Skill\n\nFollow the procedure.',
        referencesDir: '/fake/path/references',
      }],
    }]

    const result = await assemblePrompt(dir, {
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    }, plugins)

    assert.ok(result.includes('# Test Skill'))
    assert.ok(result.includes('Follow the procedure.'))
    assert.ok(result.includes('/fake/path/references'))

    // Plugin content should be after system prompt but before trust hierarchy and memory
    const systemIdx = result.indexOf('System prompt.')
    const pluginIdx = result.indexOf('# Test Skill')
    const trustIdx = result.indexOf('Source Trust Hierarchy')
    const memoryIdx = result.indexOf('Memory.')
    assert.ok(systemIdx < pluginIdx)
    assert.ok(pluginIdx < trustIdx)
    assert.ok(pluginIdx < memoryIdx)
  })

  it('uses office terminology in connected rooms section', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
      'memory/MEMORY.md': 'Memory.',
    })

    const result = await assemblePrompt(dir, {
      display_name: 'Test Agent',
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
      rooms: [{ name: 'other-agent', url: 'http://localhost:3001', secret: 's' }],
    })

    assert.ok(result.includes('your office'))
    assert.ok(result.includes("other agents' offices"))
    assert.ok(!result.includes('home room'))
  })

  it('injects office_url awareness when configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
      'memory/MEMORY.md': 'Memory.',
    })

    const result = await assemblePrompt(dir, {
      display_name: 'Test Agent',
      office_url: 'https://test-agent.example.com',
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    })

    assert.ok(result.includes('https://test-agent.example.com'))
    assert.ok(result.includes('invite them'))
  })

  it('office-invite guard warns against inviting users already in home', async () => {
    const dir = await makePersona({
      'SOUL.md': 'I am the soul.',
      'prompts/system.md': 'System context.',
    })

    const result = await assemblePrompt(dir, {
      display_name: 'Test Agent',
      chat: { prompt: 'prompts/system.md' },
      office_url: 'https://test.example.com',
    })

    assert.ok(result.includes('[home/...]'))
    assert.ok(result.includes('do not invite'))
  })

  it('works when plugins is undefined or empty', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
      'memory/MEMORY.md': 'Memory.',
    })

    const result = await assemblePrompt(dir, {
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    })

    assert.ok(result.includes('Soul.'))
    assert.ok(result.includes('System.'))
  })
})
