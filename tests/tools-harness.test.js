import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHarnessTools } from '../server/lib/tools-harness.js'
import { createHarness } from '../server/lib/harness.js'
import { Memory } from '../server/lib/memory.js'

async function makeFixture({ config = {}, origin = 'user' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'harness-tools-'))
  await mkdir(join(dir, 'memory'), { recursive: true })
  await writeFile(join(dir, 'memory', 'MEMORY.md'), 'The renewal is on 2026-09-14.\nPriya owns it.\n')
  const fullConfig = { name: 'test', display_name: 'Test', ...config }
  const harness = createHarness({ personaDir: dir, config: fullConfig, registry: { resolve: () => { throw new Error('none') } } })
  const memory = new Memory(dir, 'memory/')
  const room = {
    _turnOrigin: origin,
    chatLog: { recent: async () => [], threadEntries: async () => null, findById: async () => null },
    roomClients: new Map(),
    persona: { config: fullConfig },
    broadcast: () => {},
    recordHistory: () => {},
    postAgentAttachment: () => {},
    sendMessage: async () => {},
  }
  const tools = buildHarnessTools(harness, room, fullConfig, memory)
  return { dir, harness, room, tools, config: fullConfig }
}

test('definitions include the harness surface and honor builtin_tools', async () => {
  const { tools } = await makeFixture()
  const names = tools.definitions.map(d => d.name)
  for (const expected of ['task_start', 'task_list', 'schedule_create', 'spawn_subagent', 'wiki_write', 'search_memory', 'read_thread', 'list_peers', 'join_room', 'share_media', 'list_secrets', 'set_model', 'fetch_url']) {
    assert.ok(names.includes(expected), `missing ${expected}`)
  }
  assert.ok(!names.includes('shell'), 'shell must be opt-in')

  const { tools: withShell } = await makeFixture({ config: { builtin_tools: ['shell'] } })
  assert.ok(withShell.definitions.map(d => d.name).includes('shell'))
})

test('autonomy gates self-directed turns but not user turns', async () => {
  const { tools } = await makeFixture({ config: { autonomy: 'low' }, origin: 'idle' })
  const blocked = await tools.execute('task_start', { command: 'echo hi' })
  assert.strictEqual(blocked.is_error, true)
  assert.match(blocked.output, /autonomy level "low"/)

  const { tools: userTools, harness } = await makeFixture({ config: { autonomy: 'low' }, origin: 'user' })
  const ok = await userTools.execute('task_start', { command: 'echo gated-check' })
  assert.strictEqual(ok.is_error, undefined)
  assert.match(ok.output, /Task [a-f0-9]{8} started/)
  // allow completion so the test process exits cleanly
  await new Promise(r => setTimeout(r, 400))
  const list = await harness.tasks.list()
  assert.strictEqual(list[0].status, 'done')
})

test('task_start validates inputs', async () => {
  const { tools } = await makeFixture()
  const neither = await tools.execute('task_start', {})
  assert.strictEqual(neither.is_error, true)
  const both = await tools.execute('task_start', { command: 'x', prompt: 'y' })
  assert.strictEqual(both.is_error, true)
})

test('wiki tools round-trip through the group and search_memory unifies sources', async () => {
  const { tools } = await makeFixture()
  const write = await tools.execute('wiki_write', { slug: 'renewals', content: '# Renewals\n\nFastmail renews 2026-09-14. See [[people-priya]].' })
  assert.match(write.output, /written/)
  assert.match(write.output, /people-priya/) // broken-link notice

  const search = await tools.execute('search_memory', { query: 'renew' })
  assert.match(search.output, /memory\/MEMORY\.md/)
  assert.match(search.output, /wiki\/renewals/)
})

test('wiki_delete removes pages for compaction and errors on missing slugs', async () => {
  const { tools } = await makeFixture()
  await tools.execute('wiki_write', { slug: 'stale-topic', content: 'Superseded notes.' })
  const removed = await tools.execute('wiki_delete', { slug: 'stale-topic' })
  assert.match(removed.output, /deleted/)
  const gone = await tools.execute('wiki_read', { slug: 'stale-topic' })
  assert.strictEqual(gone.is_error, true)
  const missing = await tools.execute('wiki_delete', { slug: 'never-existed' })
  assert.strictEqual(missing.is_error, true)
})

test('set_model enforces the allow list and pins the tier head', async () => {
  const { tools, config } = await makeFixture({
    config: { cognition: ['a:openrouter', 'b:openrouter'], attention: ['c:openrouter'], model_policy: { allow: ['b:openrouter'] } },
  })
  const bad = await tools.execute('set_model', { tier: 'cognition', model: 'evil:openrouter' })
  assert.strictEqual(bad.is_error, true)
  assert.match(bad.output, /not on your allow list/)

  const good = await tools.execute('set_model', { tier: 'cognition', model: 'b:openrouter' })
  assert.strictEqual(good.is_error, undefined)
  assert.deepStrictEqual(config.cognition, ['b:openrouter', 'a:openrouter'])
})

test('fetch_url refuses private hosts and bad protocols', async () => {
  const { tools } = await makeFixture()
  const local = await tools.execute('fetch_url', { url: 'http://127.0.0.1:9/x' })
  assert.strictEqual(local.is_error, true)
  assert.match(local.output, /private|loopback/i)
  const ftp = await tools.execute('fetch_url', { url: 'ftp://example.com/x' })
  assert.strictEqual(ftp.is_error, true)
})

test('schedule_create + schedule_list + schedule_delete integrate with the store', async () => {
  const { tools, harness } = await makeFixture()
  const created = await tools.execute('schedule_create', { name: 'weekly review', cron: '0 9 * * 1', prompt: 'Review the week.' })
  assert.match(created.output, /Schedule [a-f0-9]{8} created/)
  const id = created.output.match(/Schedule ([a-f0-9]{8})/)[1]
  const listed = await tools.execute('schedule_list', {})
  assert.match(listed.output, /weekly review/)
  const removed = await tools.execute('schedule_delete', { id })
  assert.match(removed.output, /deleted/)
  harness.schedules.stop()
})

test('read_thread rejects fabricated ids by blaming the id, not the store', async () => {
  const { tools } = await makeFixture()
  const res = await tools.execute('read_thread', { id: 'deadbeef' })
  assert.strictEqual(res.is_error, true)
  assert.match(res.output, /did not come from this conversation/)
  // Banned phrasings must never come back: the store is the authority and
  // ids surfaced by the system always resolve.
  assert.ok(!/not found/i.test(res.output))
  assert.ok(!/no message with/i.test(res.output))
})

test('list_secrets lists names only', async () => {
  const { tools, harness } = await makeFixture()
  await harness.secrets.set('STRIPE_KEY', 'sk_live_supersecretvalue123')
  const res = await tools.execute('list_secrets', {})
  assert.match(res.output, /STRIPE_KEY/)
  assert.ok(!res.output.includes('supersecret'))
})

test('shell output and task logs are redacted when they echo a secret', async () => {
  const { tools, harness } = await makeFixture({ config: { builtin_tools: ['shell'] } })
  await harness.secrets.set('LEAKY_TOKEN', 'tok-supersecret-991122')

  const shellRes = await tools.execute('shell', { command: 'echo "value is $LEAKY_TOKEN"' })
  assert.ok(!shellRes.output.includes('tok-supersecret-991122'), 'shell output must be redacted')
  assert.match(shellRes.output, /Redacted by Cheesoid/)

  const started = await tools.execute('task_start', { command: 'echo "task sees $LEAKY_TOKEN"' })
  const id = started.output.match(/Task ([a-f0-9]{8})/)[1]
  await new Promise(r => setTimeout(r, 400))
  const status = await tools.execute('task_status', { id })
  assert.ok(!status.output.includes('tok-supersecret-991122'), 'task log tail must be redacted')
})

test('no peer-approval tool exists — approval is human-only', async () => {
  const { tools } = await makeFixture()
  const names = tools.definitions.map(d => d.name)
  for (const name of names) {
    assert.ok(!/approve|deny/.test(name), `tool ${name} must not exist`)
  }
})
