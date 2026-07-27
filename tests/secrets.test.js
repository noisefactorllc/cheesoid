import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSecretsStore, MAX_SECRET_VALUE_BYTES } from '../server/lib/secrets.js'
import { mkdtemp, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('secrets store', () => {
  // runtimeDir itself must NOT exist yet — set() is responsible for creating
  // it on demand, so tests only pre-create the mkdtemp base.
  async function makeRuntimeDir() {
    const base = await mkdtemp(join(tmpdir(), 'cheesoid-secrets-'))
    return join(base, 'runtime')
  }

  it('round-trips a value through set() and env(), including multi-line values', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('API_KEY', 'line one\nline two\nline three')
    assert.deepEqual(store.env(), { API_KEY: 'line one\nline two\nline three' })
  })

  it('list() reports names and timestamps but never values', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('DB_PASSWORD', 'super-secret-value')
    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'DB_PASSWORD')
    assert.equal(typeof list[0].updated, 'string')
    assert.ok(!Number.isNaN(Date.parse(list[0].updated)), 'updated must be a parseable ISO timestamp')
    const serialized = JSON.stringify(list)
    assert.ok(!serialized.includes('super-secret-value'), 'list() output must never contain the secret value')
  })

  it('names() returns just the names', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('FOO', 'a')
    await store.set('BAR', 'b')
    const names = await store.names()
    assert.deepEqual([...names].sort(), ['BAR', 'FOO'])
  })

  it('remove() returns true when a secret existed and false otherwise', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('TEMP', 'value')
    assert.equal(await store.remove('TEMP'), true)
    assert.equal(await store.remove('TEMP'), false)
    assert.equal(await store.remove('NEVER_SET'), false)
  })

  it('env() excludes removed names', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('KEEP', 'keep-me')
    await store.set('DROP', 'drop-me')
    await store.remove('DROP')
    assert.deepEqual(store.env(), { KEEP: 'keep-me' })
  })

  it('values() contains the decoded secret values', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('ONE', 'first-value')
    await store.set('TWO', 'second-value')
    const values = store.values()
    assert.ok(values.includes('first-value'))
    assert.ok(values.includes('second-value'))
  })

  it('rejects invalid secret names', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await assert.rejects(() => store.set('lowercase', 'x'), /invalid secret name/)
    await assert.rejects(() => store.set('1STARTS_WITH_DIGIT', 'x'), /invalid secret name/)
    await assert.rejects(() => store.set('HAS-DASH', 'x'), /invalid secret name/)
    await assert.rejects(() => store.set('HAS SPACE', 'x'), /invalid secret name/)
    await assert.rejects(() => store.set('A'.repeat(65), 'x'), /invalid secret name/)
  })

  it('rejects empty and oversized values, but allows exactly the byte limit', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await assert.rejects(() => store.set('EMPTY', ''), /invalid secret value/)
    await assert.rejects(() => store.set('TOO_BIG', 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1)), /invalid secret value/)
    await store.set('AT_LIMIT', 'x'.repeat(MAX_SECRET_VALUE_BYTES))
    assert.equal(store.env().AT_LIMIT.length, MAX_SECRET_VALUE_BYTES)
  })

  it('sets secrets.env file mode to 0o600', { skip: process.platform === 'win32' }, async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('FOO', 'bar')
    const info = await stat(join(runtimeDir, 'secrets.env'))
    assert.equal(info.mode & 0o777, 0o600)
  })

  it('a fresh store instance reads what a previous instance wrote', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store1 = createSecretsStore(runtimeDir)
    await store1.set('SHARED', 'shared-value')

    const store2 = createSecretsStore(runtimeDir)
    assert.deepEqual(store2.env(), { SHARED: 'shared-value' })
    assert.deepEqual(store2.values(), ['shared-value'])
  })

  it('overwrites an existing name on a second set()', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('ROTATING', 'old-value')
    await store.set('ROTATING', 'new-value')
    assert.deepEqual(store.env(), { ROTATING: 'new-value' })
    assert.equal((await store.list()).length, 1)
  })
})
