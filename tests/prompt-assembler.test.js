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

  it('includes moderation instructions when agents are configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
    })

    const prompt = await assemblePrompt(dir, {
      name: 'host',
      display_name: 'Host',
      chat: { prompt: 'prompts/system.md' },
      agents: [{ name: 'Brad', secret: 's' }],
    }, [])
    assert.ok(prompt.includes('Multi-Agent Turn-Taking'))
    assert.ok(prompt.includes('moderator'))
  })

  it('includes social cue backchannel instructions when rooms are configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
    })

    const prompt = await assemblePrompt(dir, {
      name: 'visitor',
      display_name: 'Visitor',
      chat: { prompt: 'prompts/system.md' },
      rooms: [{ name: 'brad', url: 'http://localhost:9999', secret: 's' }],
    }, [])
    assert.ok(prompt.includes('internal'))
    assert.ok(prompt.includes('backchannel'))
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

  it('rooms section references internal tool instead of thought/backchannel tags', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
    })
    const result = await assemblePrompt(dir, {
      display_name: 'Test',
      chat: { prompt: 'prompts/system.md' },
      rooms: [{ name: 'brad', url: 'http://localhost:3001', secret: 's' }],
    })

    assert.ok(result.includes('internal'), 'should reference internal tool')
    assert.ok(!result.includes('<thought>'), 'should not contain <thought> tag examples')
    assert.ok(!result.includes('<backchannel>'), 'should not contain <backchannel> tag examples')
  })

  it('agents section references internal tool instead of backchannel tags', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
    })
    const result = await assemblePrompt(dir, {
      display_name: 'Host',
      chat: { prompt: 'prompts/system.md' },
      agents: [{ name: 'Brad', secret: 's' }],
    })

    assert.ok(result.includes('internal'), 'should reference internal tool')
    assert.ok(!result.includes('<backchannel>'), 'should not contain <backchannel> tag examples')
  })

  it('tail reinforcement mentions internal tool', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Soul.',
      'prompts/system.md': 'System.',
    })
    const result = await assemblePrompt(dir, {
      display_name: 'Test',
      chat: { prompt: 'prompts/system.md' },
    })

    assert.ok(result.includes('internal'))
  })

  it('includes reasoner gear in modality guidance when reasoner is configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Test soul.',
      'prompts/system.md': 'System prompt.',
    })
    const result = await assemblePrompt(dir, {
      display_name: 'Test',
      chat: { prompt: 'prompts/system.md' },
      attention: ['claude-haiku-4-5'],
      cognition: ['claude-sonnet-4-6'],
      reasoner: ['claude-opus-4-6'],
      memory: { dir: 'memory/', auto_read: [] },
    })

    assert.ok(result.includes('Reasoner'))
    assert.ok(result.includes('three gears'))
  })

  it('excludes reasoner gear from modality guidance when only two tiers configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Test soul.',
      'prompts/system.md': 'System prompt.',
    })
    const result = await assemblePrompt(dir, {
      display_name: 'Test',
      chat: { prompt: 'prompts/system.md' },
      attention: ['claude-haiku-4-5'],
      cognition: ['claude-sonnet-4-6'],
      memory: { dir: 'memory/', auto_read: [] },
    })

    assert.ok(result.includes('two gears'))
    assert.ok(!result.includes('Reasoner (deep analysis)'))
  })

  it('includes reasoner gear in openai-compat mode when configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Test soul.',
      'prompts/system.md': 'System prompt.',
    })
    const result = await assemblePrompt(dir, {
      display_name: 'Test',
      provider: 'openai-compat',
      chat: { prompt: 'prompts/system.md' },
      attention: ['claude-haiku-4-5'],
      cognition: ['claude-sonnet-4-6'],
      reasoner: ['claude-opus-4-6'],
      memory: { dir: 'memory/', auto_read: [] },
    })

    assert.ok(Array.isArray(result))
    const allContent = result.map(s => s.content).join('\n')
    assert.ok(allContent.includes('Reasoner'))
    assert.ok(allContent.includes('three gears'))
  })

  it('does not include any deep_think references (tool removed)', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Test soul.',
      'prompts/system.md': 'System prompt.',
    })
    const result = await assemblePrompt(dir, {
      display_name: 'Test',
      chat: { prompt: 'prompts/system.md' },
      attention: ['claude-haiku-4-5'],
      cognition: ['claude-sonnet-4-6'],
      reasoner: ['claude-opus-4-6'],
      memory: { dir: 'memory/', auto_read: [] },
    })

    assert.ok(!result.includes('deep_think'))
  })

  it('includes modality section when cognition and attention configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Test soul.',
      'prompts/system.md': 'System prompt.',
      'memory/.keep': '',
    })

    const config = {
      name: 'test',
      display_name: 'Test',
      cognition: 'claude-sonnet-4-6',
      attention: 'claude-haiku-4-5',
      model: 'gpt-4.1-nano:openai',
      provider: 'openai-compat',
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: [] },
    }

    const result = await assemblePrompt(dir, config, [])
    assert.ok(Array.isArray(result))
    const prompt = result.map(s => s.content).join('\n')
    assert.ok(prompt.includes('Attention (resting state)'), 'should include attention mode docs')
    assert.ok(prompt.includes('Cognition (full engagement)'), 'should include cognition mode docs')
    assert.ok(prompt.includes('step_up'), 'should mention step_up tool')
    assert.ok(prompt.includes('step_down'), 'should mention step_down tool')
  })

  it('includes modality section in anthropic mode when cognition and attention configured', async () => {
    const dir = await makePersona({
      'SOUL.md': 'Test soul.',
      'prompts/system.md': 'System prompt.',
      'memory/.keep': '',
    })

    const config = {
      name: 'test',
      display_name: 'Test',
      cognition: 'claude-sonnet-4-6',
      attention: 'claude-haiku-4-5',
      chat: { prompt: 'prompts/system.md' },
      memory: { dir: 'memory/', auto_read: [] },
    }

    const result = await assemblePrompt(dir, config, [])
    assert.ok(typeof result === 'string')
    assert.ok(result.includes('Attention (resting state)'), 'should include attention mode docs')
    assert.ok(result.includes('Cognition (full engagement)'), 'should include cognition mode docs')
    assert.ok(result.includes('step_up'), 'should mention step_up tool')
    assert.ok(result.includes('step_down'), 'should mention step_down tool')
  })
})
