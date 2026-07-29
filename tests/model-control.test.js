import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHarnessTools } from '../server/lib/tools-harness.js'
import { createHarness } from '../server/lib/harness.js'
import { Memory } from '../server/lib/memory.js'

async function makeFixture({ config = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'model-control-'))
  await mkdir(join(dir, 'memory'), { recursive: true })
  await mkdir(join(dir, 'runtime'), { recursive: true })
  await writeFile(join(dir, 'memory', 'MEMORY.md'), 'x\n')
  const fullConfig = { name: 'test', display_name: 'Test', ...config }
  const harness = createHarness({ personaDir: dir, config: fullConfig, registry: { resolve: () => { throw new Error('none') } } })
  const memory = new Memory(dir, 'memory/')
  const room = {
    _turnOrigin: 'user',
    chatLog: { recent: async () => [], threadEntries: async () => null, findById: async () => null },
    roomClients: new Map(),
    persona: { config: fullConfig },
    broadcast() {}, recordHistory() {}, postAgentAttachment() {}, sendMessage: async () => {},
  }
  const tools = buildHarnessTools(harness, room, fullConfig, memory)
  return { dir, harness, tools, config: fullConfig }
}

test('set_model mutates the tier array IN PLACE so a captured Modality reference sees it', async () => {
  const { tools, config } = await makeFixture({
    config: { cognition: ['orig:openrouter', 'fb:openrouter'], model_policy: { allow: ['new:openrouter'] } },
  })
  const captured = config.cognition // Modality holds the array by reference
  const res = await tools.execute('set_model', { tier: 'cognition', model: 'new:openrouter' })
  assert.strictEqual(res.is_error, undefined, res.output)
  assert.strictEqual(config.cognition, captured, 'array reference must be preserved (in-place, not replaced)')
  assert.strictEqual(captured[0], 'new:openrouter', 'the captured reference sees the new primary')
})

test('spawn_subagent rejects a model not on the allow list (x-ai bypass closed)', async () => {
  const { tools } = await makeFixture({ config: { subagent: ['ok:openrouter'] } })
  const res = await tools.execute('spawn_subagent', { prompt: 'x', model: 'x-ai/grok-4.5:openrouter' })
  assert.strictEqual(res.is_error, true)
  assert.match(res.output, /allow list/i)
})

test('task_start (subagent job) rejects a model not on the allow list', async () => {
  const { tools } = await makeFixture({ config: { subagent: ['ok:openrouter'] } })
  const res = await tools.execute('task_start', { prompt: 'x', model: 'x-ai/grok-4.5:openrouter' })
  assert.strictEqual(res.is_error, true)
  assert.match(res.output, /allow list/i)
})

test('applyModelOverrides ignores a __proto__ key in the overrides file (no boot DoS)', async () => {
  const { harness, dir, config } = await makeFixture({
    config: { cognition: ['c1:openrouter', 'c2:openrouter'], model_policy: { allow: ['c2:openrouter'] } },
  })
  const captured = config.cognition
  // JSON.parse turns a "__proto__" key into an OWN property; the old
  // Object.entries loop would hit config['__proto__'] (Object.prototype) and
  // throw on .filter, bricking boot. Value is an allowlisted string so the old
  // code reaches the throwing path.
  await writeFile(
    join(dir, 'runtime', 'model-overrides.json'),
    '{"__proto__":"c2:openrouter","cognition":"c2:openrouter"}',
  )
  await harness.applyModelOverrides() // must not throw
  assert.strictEqual(config.cognition, captured, 'in-place mutation preserves the reference')
  assert.strictEqual(captured[0], 'c2:openrouter', 'the legitimate override still applied')
})
