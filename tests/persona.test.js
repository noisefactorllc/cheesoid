import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadPersona } from '../server/lib/persona.js'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('loadPersona', () => {
  async function makePersona(yaml) {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-persona-'))
    await mkdir(join(dir, 'memory'), { recursive: true })
    await writeFile(join(dir, 'persona.yaml'), yaml)
    await writeFile(join(dir, 'SOUL.md'), 'Test soul.')
    return dir
  }

  it('loads and parses persona.yaml', async () => {
    const dir = await makePersona(`
name: test
display_name: "Test Agent"
model: claude-sonnet-4-6
max_budget_usd: 3

chat:
  prompt: prompts/system.md
  thinking_budget: 8000
  max_turns: 10
  idle_timeout_minutes: 15

memory:
  dir: memory/
  auto_read:
    - MEMORY.md
`)

    const persona = await loadPersona(dir)
    assert.equal(persona.config.name, 'test')
    assert.equal(persona.config.model, 'claude-sonnet-4-6')
    assert.equal(persona.config.chat.thinking_budget, 8000)
    assert.equal(persona.dir, dir)
  })

  it('resolves ${ENV_VAR} references in config values', async () => {
    process.env.TEST_SECRET = 'my-secret-value'
    const dir = await makePersona(`
name: test
agents:
  - name: Brad
    secret: \${TEST_SECRET}
rooms:
  - url: http://localhost:3001
    secret: \${TEST_SECRET}
`)
    const persona = await loadPersona(dir)
    assert.equal(persona.config.agents[0].secret, 'my-secret-value')
    assert.equal(persona.config.rooms[0].secret, 'my-secret-value')
    delete process.env.TEST_SECRET
  })

  it('throws on missing persona.yaml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-empty-'))
    await assert.rejects(() => loadPersona(dir), /persona\.yaml/)
  })

  it('validates orchestrator config with anthropic provider and preserves fields', async () => {
    const dir = await makePersona(`
name: test-hybrid
model: claude-haiku-3-5
orchestrator:
  provider: anthropic
  model: claude-opus-4-5
`)
    const persona = await loadPersona(dir)
    assert.equal(persona.config.orchestrator.provider, 'anthropic')
    assert.equal(persona.config.orchestrator.model, 'claude-opus-4-5')
  })

  it('validates orchestrator defaults provider to anthropic when not set', async () => {
    const dir = await makePersona(`
name: test-hybrid-default
model: claude-haiku-3-5
orchestrator:
  model: claude-opus-4-5
`)
    const persona = await loadPersona(dir)
    assert.equal(persona.config.orchestrator.provider, 'anthropic')
  })

  it('throws when orchestrator uses openai-compat but missing base_url', async () => {
    const dir = await makePersona(`
name: test-hybrid-bad
model: claude-haiku-3-5
orchestrator:
  provider: openai-compat
  model: gpt-4o
  api_key: sk-test
`)
    await assert.rejects(() => loadPersona(dir), /orchestrator with openai-compat requires base_url/)
  })

  it('parses reasoner model string from config', async () => {
    const dir = await makePersona(`
name: test-reasoner
model: claude-sonnet-4-6
reasoner: claude-opus-4-6
`)
    const persona = await loadPersona(dir)
    assert.equal(persona.config.reasoner, 'claude-opus-4-6')
  })

  it('parses reasoner_fallback_models from config', async () => {
    const dir = await makePersona(`
name: test-reasoner-fallback
model: claude-sonnet-4-6
reasoner: claude-opus-4-6
reasoner_fallback_models:
  - claude-sonnet-4-6
`)
    const persona = await loadPersona(dir)
    assert.deepEqual(persona.config.reasoner_fallback_models, ['claude-sonnet-4-6'])
  })

  it('parses orchestrator_fallback_models from config', async () => {
    const dir = await makePersona(`
name: test-orch-fallback
model: claude-sonnet-4-6
orchestrator: claude-opus-4-6
orchestrator_fallback_models:
  - claude-sonnet-4-6
`)
    const persona = await loadPersona(dir)
    assert.equal(persona.config.orchestrator, 'claude-opus-4-6')
    assert.deepEqual(persona.config.orchestrator_fallback_models, ['claude-sonnet-4-6'])
  })

  it('logs reasoner config when present', async () => {
    const dir = await makePersona(`
name: test-reasoner-log
model: claude-sonnet-4-6
orchestrator: claude-opus-4-6
reasoner: claude-opus-4-6
`)
    const persona = await loadPersona(dir)
    assert.equal(persona.config.reasoner, 'claude-opus-4-6')
  })

  it('validates cognition + attention config', async () => {
    const dir = await makePersona(`
name: test-modal
model: gpt-4.1-nano:openai
cognition: claude-sonnet-4-6
attention: claude-haiku-4-5
`)
    const persona = await loadPersona(dir)
    assert.equal(persona.config.cognition, 'claude-sonnet-4-6')
    assert.equal(persona.config.attention, 'claude-haiku-4-5')
  })

  it('rejects cognition without attention', async () => {
    const dir = await makePersona(`
name: test-modal-bad
model: gpt-4.1-nano:openai
cognition: claude-sonnet-4-6
`)
    await assert.rejects(() => loadPersona(dir), /cognition requires attention/)
  })

  it('rejects attention without cognition', async () => {
    const dir = await makePersona(`
name: test-modal-bad
model: gpt-4.1-nano:openai
attention: claude-haiku-4-5
`)
    await assert.rejects(() => loadPersona(dir), /attention requires cognition/)
  })

  it('rejects modal config with orchestrator', async () => {
    const dir = await makePersona(`
name: test-modal-conflict
model: gpt-4.1-nano:openai
cognition: claude-sonnet-4-6
attention: claude-haiku-4-5
orchestrator: claude-opus-4-6
`)
    await assert.rejects(() => loadPersona(dir), /cannot use both orchestrator and cognition\/attention/)
  })
})
