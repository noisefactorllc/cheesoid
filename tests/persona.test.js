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
    assert.deepEqual(persona.config.model, ['claude-sonnet-4-6'])
    assert.equal(persona.config.chat.thinking_budget, 8000)
    assert.equal(persona.dir, dir)
  })

  it('resolves ${ENV_VAR} references in config values', async () => {
    process.env.TEST_SECRET = 'my-secret-value'
    const dir = await makePersona(`
name: test
agents:
  - name: Alice
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
    assert.deepEqual(persona.config.reasoner, ['claude-opus-4-6'])
  })

  it('merges legacy reasoner_fallback_models into reasoner array', async () => {
    const dir = await makePersona(`
name: test-reasoner-fallback
model: claude-sonnet-4-6
reasoner: claude-opus-4-6
reasoner_fallback_models:
  - claude-sonnet-4-6
`)
    const persona = await loadPersona(dir)
    assert.deepEqual(persona.config.reasoner, ['claude-opus-4-6', 'claude-sonnet-4-6'])
    assert.equal(persona.config.reasoner_fallback_models, undefined, 'legacy field removed after normalize')
  })

  it('accepts reasoner as array for explicit fallback chain', async () => {
    const dir = await makePersona(`
name: test-reasoner-array
model: claude-sonnet-4-6
reasoner:
  - gpt-5.4:openai
  - claude-opus-4-6
`)
    const persona = await loadPersona(dir)
    assert.deepEqual(persona.config.reasoner, ['gpt-5.4:openai', 'claude-opus-4-6'])
  })

  it('logs reasoner config when present', async () => {
    const dir = await makePersona(`
name: test-reasoner-log
model: claude-sonnet-4-6
orchestrator: claude-opus-4-6
reasoner: claude-opus-4-6
`)
    const persona = await loadPersona(dir)
    assert.deepEqual(persona.config.reasoner, ['claude-opus-4-6'])
  })

  it('validates cognition + attention config', async () => {
    const dir = await makePersona(`
name: test-modal
model: gpt-4.1-nano:openai
cognition: claude-sonnet-4-6
attention: claude-haiku-4-5
`)
    const persona = await loadPersona(dir)
    assert.deepEqual(persona.config.cognition, ['claude-sonnet-4-6'])
    assert.deepEqual(persona.config.attention, ['claude-haiku-4-5'])
  })

  it('merges legacy cognition_fallback_models into cognition array', async () => {
    const dir = await makePersona(`
name: test-cognition-fallback
model: gpt-4.1-nano:openai
cognition: claude-sonnet-4-6
cognition_fallback_models:
  - gpt-5.4:openai
attention: claude-haiku-4-5
`)
    const persona = await loadPersona(dir)
    assert.deepEqual(persona.config.cognition, ['claude-sonnet-4-6', 'gpt-5.4:openai'])
    assert.equal(persona.config.cognition_fallback_models, undefined, 'legacy field removed after normalize')
  })

  it('normalizes execution tier to config.model array', async () => {
    const dir = await makePersona(`
name: test-execution
execution:
  - gpt-5.4:openai
  - claude-haiku-4-5
`)
    const persona = await loadPersona(dir)
    assert.deepEqual(persona.config.model, ['gpt-5.4:openai', 'claude-haiku-4-5'])
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

  it('warns about decorative config keys that the framework does not enforce', async () => {
    const dir = await makePersona(`
name: test-decorative
model: claude-sonnet-4-6
max_budget_usd: 6

chat:
  prompt: prompts/system.md
  idle_timeout_minutes: 30
`)
    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }
    try {
      await loadPersona(dir)
    } finally {
      console.log = origLog
    }
    assert.ok(logs.some(l => l === '[test-decorative] WARN: max_budget_usd is set but not enforced by the framework'))
    assert.ok(logs.some(l => l === '[test-decorative] WARN: chat.idle_timeout_minutes is set but not enforced by the framework'))
  })

  it('warns when thinking_budget is set but the tier provider silently drops it', async () => {
    const dir = await makePersona(`
name: test-tb-drop
providers:
  orx:
    type: openai-compat
    base_url: https://orx.test/v1
    api_key: k
attention: some-model:orx
cognition: claude-sonnet-4-6

chat:
  prompt: prompts/system.md
  thinking_budget: 16000
`)
    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }
    try {
      await loadPersona(dir)
    } finally {
      console.log = origLog
    }
    const warn = logs.find(l => l.includes('thinking_budget') && l.includes('WARN'))
    assert.ok(warn, `expected a thinking_budget warning, got:\n${logs.join('\n')}`)
    assert.ok(warn.includes('orx'), 'warning should name the offending provider')
    assert.ok(warn.includes('attention'), 'warning should name the affected tier')
    assert.ok(!warn.includes('cognition'), 'must not blame tiers whose provider honors the budget')
  })

  it('does not warn about thinking_budget when the openai-compat backend opts in', async () => {
    const dir = await makePersona(`
name: test-tb-optin
providers:
  router:
    type: openai-compat
    base_url: https://openrouter.test/api/v1
    api_key: k
    supports_reasoning_budget: true
attention: some-model:router
cognition: some-model:router

chat:
  prompt: prompts/system.md
  thinking_budget: 16000
`)
    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }
    try {
      await loadPersona(dir)
    } finally {
      console.log = origLog
    }
    assert.ok(!logs.some(l => l.includes('thinking_budget') && l.includes('WARN')))
  })

  it('does not warn about thinking_budget when every tier honors it', async () => {
    const dir = await makePersona(`
name: test-tb-native
model: claude-sonnet-4-6

chat:
  prompt: prompts/system.md
  thinking_budget: 16000
`)
    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }
    try {
      await loadPersona(dir)
    } finally {
      console.log = origLog
    }
    assert.ok(!logs.some(l => l.includes('thinking_budget') && l.includes('WARN')))
  })

  it('does not warn when decorative keys are absent', async () => {
    const dir = await makePersona(`
name: test-clean
model: claude-sonnet-4-6

chat:
  prompt: prompts/system.md
`)
    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }
    try {
      await loadPersona(dir)
    } finally {
      console.log = origLog
    }
    assert.ok(!logs.some(l => l.includes('not enforced by the framework')))
  })
})
