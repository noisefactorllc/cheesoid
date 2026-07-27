import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMediaStore, MEDIA_MAX_BYTES, ALLOWED_MIME } from '../server/lib/media.js'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('MediaStore', () => {
  async function makeStore() {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'cheesoid-media-'))
    return { runtimeDir, store: createMediaStore(runtimeDir) }
  }

  it('matches the given ALLOWED_MIME contract', () => {
    assert.ok(ALLOWED_MIME.test('image/png'))
    assert.ok(ALLOWED_MIME.test('APPLICATION/JSON'), 'case-insensitive')
    assert.ok(!ALLOWED_MIME.test('application/x-msdownload'))
  })

  it('saves and loads a file, preserving bytes exactly', async () => {
    const { store } = await makeStore()
    const buffer = Buffer.from([0, 1, 2, 3, 255, 254, 253, 10, 13, 0])
    const meta = await store.save({ buffer, mime: 'image/png', name: 'photo.png' })

    assert.equal(meta.mime, 'image/png')
    assert.equal(meta.name, 'photo.png')
    assert.equal(meta.bytes, buffer.length)
    assert.equal(meta.ext, 'png')
    assert.equal(meta.by, null)
    assert.ok(meta.uploaded)

    const loaded = await store.load(meta.id)
    assert.ok(loaded, 'load returns a result for a freshly saved id')
    assert.ok(loaded.buffer.equals(buffer), 'loaded bytes match saved bytes exactly')
    assert.deepEqual(loaded.meta, meta)
  })

  it('generates an 8-character lowercase hex id', async () => {
    const { store } = await makeStore()
    const meta = await store.save({ buffer: Buffer.from('hello'), mime: 'text/plain', name: 'hi.txt' })
    assert.match(meta.id, /^[a-f0-9]{8}$/)
  })

  it('rejects unsupported mime types', async () => {
    const { store } = await makeStore()
    await assert.rejects(
      () => store.save({ buffer: Buffer.from('x'), mime: 'application/x-msdownload', name: 'evil.exe' }),
      /unsupported media type: application\/x-msdownload/
    )
  })

  it('rejects buffers over MEDIA_MAX_BYTES', async () => {
    const { store } = await makeStore()
    const big = Buffer.alloc(MEDIA_MAX_BYTES + 1)
    await assert.rejects(
      () => store.save({ buffer: big, mime: 'image/png', name: 'big.png' }),
      /media too large/
    )
  })

  it('rejects an empty buffer', async () => {
    const { store } = await makeStore()
    await assert.rejects(
      () => store.save({ buffer: Buffer.alloc(0), mime: 'image/png', name: 'empty.png' }),
      /empty media/
    )
  })

  it('sanitizes a path-traversal display name', async () => {
    const { store } = await makeStore()
    const meta = await store.save({ buffer: Buffer.from('x'), mime: 'text/plain', name: '../../etc/passwd' })
    assert.ok(!meta.name.includes('/'), 'no slashes survive sanitization')
    assert.ok(!meta.name.includes('..'), 'no ".." survives sanitization')
    assert.ok(meta.name === 'passwd' || meta.name === 'etcpasswd', `unexpected sanitized name: ${meta.name}`)
  })

  it('falls back to "file" for an empty or invalid name', async () => {
    const { store } = await makeStore()
    const meta = await store.save({ buffer: Buffer.from('x'), mime: 'text/plain', name: '' })
    assert.equal(meta.name, 'file')
  })

  it('caps a display name to 80 characters', async () => {
    const { store } = await makeStore()
    const longName = `${'a'.repeat(200)}.txt`
    const meta = await store.save({ buffer: Buffer.from('x'), mime: 'text/plain', name: longName })
    assert.ok(meta.name.length <= 80)
  })

  it('records the uploader when `by` is given, null otherwise', async () => {
    const { store } = await makeStore()
    const withUploader = await store.save({ buffer: Buffer.from('x'), mime: 'text/plain', name: 'a.txt', by: 'alex' })
    assert.equal(withUploader.by, 'alex')
    const withoutUploader = await store.save({ buffer: Buffer.from('y'), mime: 'text/plain', name: 'b.txt' })
    assert.equal(withoutUploader.by, null)
  })

  it('lists metadata newest-first and respects limit', async () => {
    const { store } = await makeStore()
    const ids = []
    for (const n of ['a.txt', 'b.txt', 'c.txt']) {
      const meta = await store.save({ buffer: Buffer.from(n), mime: 'text/plain', name: n })
      ids.push(meta.id)
      await new Promise(resolve => setTimeout(resolve, 3)) // force distinct `uploaded` timestamps
    }

    const all = await store.list()
    assert.equal(all.length, 3)
    assert.deepEqual(all.map(m => m.id), [...ids].reverse(), 'newest first')

    const limited = await store.list({ limit: 2 })
    assert.equal(limited.length, 2)
    assert.deepEqual(limited.map(m => m.id), [ids[2], ids[1]])
  })

  it('removes a file, returning false on a second removal and null from load', async () => {
    const { store } = await makeStore()
    const meta = await store.save({ buffer: Buffer.from('bye'), mime: 'text/plain', name: 'bye.txt' })

    assert.equal(await store.remove(meta.id), true)
    assert.equal(await store.load(meta.id), null)
    assert.equal(await store.remove(meta.id), false)
  })

  it('meta returns the sidecar only, or null for an unknown id', async () => {
    const { store } = await makeStore()
    const saved = await store.save({ buffer: Buffer.from('data'), mime: 'application/json', name: 'x.json' })
    assert.deepEqual(await store.meta(saved.id), saved)
    assert.equal(await store.meta('deadbeef'), null)
  })

  it('isImage is true for raster images, false for svg and pdf', async () => {
    const { store } = await makeStore()
    assert.equal(store.isImage({ mime: 'image/png' }), true)
    assert.equal(store.isImage({ mime: 'image/svg+xml' }), false)
    assert.equal(store.isImage({ mime: 'application/pdf' }), false)
  })

  it('isText is true for text/plain and application/json, false for images', async () => {
    const { store } = await makeStore()
    assert.equal(store.isText({ mime: 'text/plain' }), true)
    assert.equal(store.isText({ mime: 'application/json' }), true)
    assert.equal(store.isText({ mime: 'image/png' }), false)
  })

  it('load returns null (not a throw) for a malformed or unknown id', async () => {
    const { store } = await makeStore()
    assert.equal(await store.load('not-an-id'), null)
    assert.equal(await store.load('deadbeef'), null)
  })

  it('skips a corrupt sidecar in list() and logs a warning', async () => {
    const { runtimeDir, store } = await makeStore()
    await store.save({ buffer: Buffer.from('good'), mime: 'text/plain', name: 'good.txt' })
    await writeFile(join(runtimeDir, 'media', 'deadbeef.json'), '{not valid json')

    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(' ')) }
    let all
    try {
      all = await store.list()
    } finally {
      console.log = origLog
    }

    assert.equal(all.length, 1, 'corrupt sidecar excluded from results')
    assert.ok(logs.some(l => l.includes('deadbeef.json')), 'warns about the corrupt sidecar')
  })

  it('creates the media directory on demand', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'cheesoid-media-'))
    const store = createMediaStore(runtimeDir)
    assert.deepEqual(await store.list(), [])
    const entries = await readdir(join(runtimeDir, 'media'))
    assert.deepEqual(entries, [])
  })
})
