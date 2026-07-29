import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSecretsStore, MAX_SECRET_VALUE_BYTES } from '../server/lib/secrets.js'
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('secrets store', () => {
  // runtimeDir itself must NOT exist yet — set() is responsible for creating
  // it on demand, so tests only pre-create the mkdtemp base.
  async function makeRuntimeDir() {
    const base = await mkdtemp(join(tmpdir(), 'cheesoid-secrets-'))
    return join(base, 'runtime')
  }

  it('round-trips a value through set() and resolveForBroker(), including multi-line values', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('API_KEY', 'line one\nline two\nline three')
    assert.equal(store.resolveForBroker('API_KEY'), 'line one\nline two\nline three')
    assert.deepEqual(await store.names(), ['API_KEY'])
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
    await store.set('FOO', 'value-aaa')
    await store.set('BAR', 'value-bbb')
    const names = await store.names()
    assert.deepEqual([...names].sort(), ['BAR', 'FOO'])
  })

  it('remove() returns true when a secret existed and false otherwise', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('TEMP', 'value-long')
    assert.equal(await store.remove('TEMP'), true)
    assert.equal(await store.remove('TEMP'), false)
    assert.equal(await store.remove('NEVER_SET'), false)
  })

  it('resolveForBroker() and names() exclude removed names', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('KEEP', 'keep-value')
    await store.set('DROP', 'drop-value')
    await store.remove('DROP')
    assert.deepEqual(await store.names(), ['KEEP'])
    assert.equal(store.resolveForBroker('KEEP'), 'keep-value')
    assert.equal(store.resolveForBroker('DROP'), null)
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

  it('redactDeep masks secrets recursively without changing result shape', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('TOKEN', 'recursive-secret-value')
    const redacted = store.redactDeep({
      output: 'saw recursive-secret-value',
      nested: ['recursive-secret-value', { ok: true }],
    })
    assert.deepEqual(redacted, {
      output: 'saw **[Redacted by Cheesoid]**',
      nested: ['**[Redacted by Cheesoid]**', { ok: true }],
    })
  })

  it('redacts accepted multibyte secrets by bytes rather than code units', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('UNICODE_KEY', '密钥值')
    assert.equal(store.redact('echoed 密钥值'), 'echoed **[Redacted by Cheesoid]**')
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
    await assert.rejects(() => store.set('TOO_SHORT', 'short'), /at least 8 bytes/)
    await assert.rejects(() => store.set('TOO_BIG', 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1)), /invalid secret value/)
    await store.set('AT_LIMIT', 'x'.repeat(MAX_SECRET_VALUE_BYTES))
    assert.equal(store.resolveForBroker('AT_LIMIT').length, MAX_SECRET_VALUE_BYTES)
  })

  it('sets secrets.env file mode to 0o600', { skip: process.platform === 'win32' }, async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('FOO', 'bar-value')
    const info = await stat(join(runtimeDir, 'secrets.env'))
    assert.equal(info.mode & 0o777, 0o600)
  })

  it('a fresh store instance reads what a previous instance wrote', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store1 = createSecretsStore(runtimeDir)
    await store1.set('SHARED', 'shared-value')

    const store2 = createSecretsStore(runtimeDir)
    assert.equal(store2.resolveForBroker('SHARED'), 'shared-value')
    assert.deepEqual(store2.values(), ['shared-value'])
  })

  it('refuses to read a symlinked secrets file', { skip: process.platform === 'win32' }, async () => {
    const runtimeDir = await makeRuntimeDir()
    await mkdir(runtimeDir, { recursive: true })
    const outside = join(runtimeDir, '..', 'outside.env')
    await writeFile(outside, 'STOLEN=c2VjcmV0\n')
    await symlink(outside, join(runtimeDir, 'secrets.env'))

    const store = createSecretsStore(runtimeDir)
    assert.throws(() => store.values(), /unsafe secrets file/)
  })

  it('refuses a symlinked runtime directory', { skip: process.platform === 'win32' }, async () => {
    const runtimeDir = await makeRuntimeDir()
    const outside = join(runtimeDir, '..', 'outside-runtime')
    await mkdir(outside)
    await symlink(outside, runtimeDir)

    const store = createSecretsStore(runtimeDir)
    await assert.rejects(() => store.set('TOKEN', 'do-not-redirect'), /unsafe secrets directory/)
  })

  it('serializes concurrent mutations without losing persisted values', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await Promise.all([
      store.set('ONE', 'first-value'),
      store.set('TWO', 'second-value'),
      store.set('THREE', 'third-value'),
    ])
    await Promise.all([
      store.remove('TWO'),
      store.set('FOUR', 'fourth-value'),
    ])

    const fresh = createSecretsStore(runtimeDir)
    assert.deepEqual((await fresh.names()).sort(), ['FOUR', 'ONE', 'THREE'])
    assert.equal(fresh.resolveForBroker('ONE'), 'first-value')
    assert.equal(fresh.resolveForBroker('THREE'), 'third-value')
    assert.equal(fresh.resolveForBroker('FOUR'), 'fourth-value')
    assert.equal(fresh.resolveForBroker('TWO'), null)
    const files = await readFile(join(runtimeDir, 'secrets.env'), 'utf8')
    assert.doesNotMatch(files, /\.tmp/)
  })

  it('overwrites an existing name on a second set()', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = createSecretsStore(runtimeDir)
    await store.set('ROTATING', 'old-value')
    await store.set('ROTATING', 'new-value')
    assert.equal(store.resolveForBroker('ROTATING'), 'new-value')
    assert.equal((await store.list()).length, 1)
  })

  // Finding 1 (I4): parse() must enforce the same minimum length redact()
  // requires, or a short hand-edited/legacy value is live but never masked.
  it('does not admit a stored value below the minimum length (parse floor)', async () => {
    const runtimeDir = await makeRuntimeDir()
    await mkdir(runtimeDir, { recursive: true })
    const short = Buffer.from('abcdefg', 'utf8').toString('base64') // 7 bytes < floor
    const ok = Buffer.from('long-enough-value', 'utf8').toString('base64')
    await writeFile(join(runtimeDir, 'secrets.env'), `TOO_SHORT=${short}\nOK_SECRET=${ok}\n`)
    const store = createSecretsStore(runtimeDir)
    assert.deepEqual(await store.names(), ['OK_SECRET'])
    assert.equal(store.resolveForBroker('TOO_SHORT'), null)
    assert.equal(store.resolveForBroker('OK_SECRET'), 'long-enough-value')
  })

  // Finding 2 (I3): raise the hard floor above trivially-short common words.
  it('enforces an 8-byte minimum floor in set()', async () => {
    const store = createSecretsStore(await makeRuntimeDir())
    await assert.rejects(() => store.set('SEVEN', '1234567'), /at least 8 bytes/)
    await store.set('EIGHT', '12345678')
    assert.equal(store.resolveForBroker('EIGHT'), '12345678')
  })

  // Finding 2 (I3): weak values above the floor are warned about, not rejected,
  // and the warning must never contain the value itself.
  it('stores but logs a warning for short/low-entropy values above the floor', async () => {
    const store = createSecretsStore(await makeRuntimeDir())
    const logs = []
    const orig = console.log
    console.log = (...a) => logs.push(a.join(' '))
    try {
      await store.set('WEAKISH', 'aaaaaaaa') // 8 bytes: passes floor, low entropy
    } finally {
      console.log = orig
    }
    assert.equal(store.resolveForBroker('WEAKISH'), 'aaaaaaaa')
    const joined = logs.join('\n')
    assert.match(joined, /warn/i)
    assert.ok(!joined.includes('aaaaaaaa'), 'the warning must not contain the value')
  })

  // Finding 3 (M6/M7): redactDeep runs on every res.json body; it must not
  // mangle Date/Buffer/class instances, and must still redact plain objects.
  it('redactDeep passes Date and Buffer through untouched but still redacts plain objects', async () => {
    const store = createSecretsStore(await makeRuntimeDir())
    await store.set('TOKEN', 'plain-object-secret')
    const when = new Date('2020-01-02T03:04:05.000Z')
    const buf = Buffer.from('binary-bytes')
    const out = store.redactDeep({
      when,
      buf,
      note: 'saw plain-object-secret',
      nested: { when, list: ['plain-object-secret'] },
    })
    assert.ok(out.when instanceof Date, 'Date must survive redactDeep intact')
    assert.equal(out.when.getTime(), when.getTime())
    assert.ok(Buffer.isBuffer(out.buf), 'Buffer must survive redactDeep intact')
    assert.equal(out.buf.toString(), 'binary-bytes')
    assert.ok(out.nested.when instanceof Date)
    assert.equal(out.note, 'saw **[Redacted by Cheesoid]**')
    assert.deepEqual(out.nested.list, ['**[Redacted by Cheesoid]**'])
  })

  // Finding 4 (M5): the invalid-name skip branch must log the name only, never
  // the base64 value that follows the '='.
  it('never logs the secret value when skipping a corrupt invalid-name line', async () => {
    const runtimeDir = await makeRuntimeDir()
    await mkdir(runtimeDir, { recursive: true })
    const secretB64 = Buffer.from('super-secret-payload', 'utf8').toString('base64')
    await writeFile(join(runtimeDir, 'secrets.env'), `badname=${secretB64}\n`)
    const logs = []
    const orig = console.log
    console.log = (...a) => logs.push(a.join(' '))
    try {
      const store = createSecretsStore(runtimeDir)
      await store.names() // triggers ensureLoaded -> parse
    } finally {
      console.log = orig
    }
    const joined = logs.join('\n')
    assert.match(joined, /invalid name/)
    assert.ok(!joined.includes(secretB64), 'must not log the base64 secret value')
    assert.ok(!joined.includes('super-secret-payload'), 'must not log the decoded value')
  })

  // Finding 5 (M8): the dead env() exfiltration surface is removed.
  it('does not expose an env() method', async () => {
    const store = createSecretsStore(await makeRuntimeDir())
    assert.equal(typeof store.env, 'undefined')
  })
})
