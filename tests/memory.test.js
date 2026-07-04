import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Memory, MEMORY_READ_CAP_BYTES, capUtf8Bytes } from '../server/lib/memory.js'
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Memory', () => {
  async function makeMemoryDir(files = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-mem-'))
    const memDir = join(dir, 'memory')
    await mkdir(memDir, { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(memDir, name), content)
    }
    return { personaDir: dir, memDir }
  }

  it('loads context from auto-read files', async () => {
    const { personaDir } = await makeMemoryDir({
      'MEMORY.md': 'Core memory content.',
    })
    const mem = new Memory(personaDir, 'memory/')
    const ctx = await mem.loadContext(['MEMORY.md'])
    assert.equal(ctx, 'Core memory content.')
  })

  it('writes a new memory file', async () => {
    const { personaDir, memDir } = await makeMemoryDir()
    const mem = new Memory(personaDir, 'memory/')
    await mem.write('notes.md', 'Some notes.')
    const content = await readFile(join(memDir, 'notes.md'), 'utf8')
    assert.equal(content, 'Some notes.')
  })

  it('appends to an existing memory file', async () => {
    const { personaDir, memDir } = await makeMemoryDir({
      'log.md': 'Line 1.',
    })
    const mem = new Memory(personaDir, 'memory/')
    await mem.append('log.md', 'Line 2.')
    const content = await readFile(join(memDir, 'log.md'), 'utf8')
    assert.equal(content, 'Line 1.\nLine 2.')
  })

  it('lists available memory files', async () => {
    const { personaDir } = await makeMemoryDir({
      'MEMORY.md': 'core',
      'topics.md': 'topics',
    })
    const mem = new Memory(personaDir, 'memory/')
    const files = await mem.list()
    assert.ok(files.includes('MEMORY.md'))
    assert.ok(files.includes('topics.md'))
  })

  it('reads a specific memory file', async () => {
    const { personaDir } = await makeMemoryDir({
      'topics.md': 'Topic content.',
    })
    const mem = new Memory(personaDir, 'memory/')
    const content = await mem.read('topics.md')
    assert.equal(content, 'Topic content.')
  })

  it('returns null for missing files', async () => {
    const { personaDir } = await makeMemoryDir()
    const mem = new Memory(personaDir, 'memory/')
    const content = await mem.read('nope.md')
    assert.equal(content, null)
  })

  describe('readCapped', () => {
    it('passes small files through unchanged', async () => {
      const { personaDir } = await makeMemoryDir({
        'topics.md': 'Topic content.',
      })
      const mem = new Memory(personaDir, 'memory/')
      const content = await mem.readCapped('topics.md')
      assert.equal(content, 'Topic content.')
    })

    it('passes a file exactly at the cap through unchanged', async () => {
      const exact = 'x'.repeat(100)
      const { personaDir } = await makeMemoryDir({ 'at-cap.md': exact })
      const mem = new Memory(personaDir, 'memory/')
      const content = await mem.readCapped('at-cap.md', 100)
      assert.equal(content, exact)
    })

    it('truncates oversized files to the cap plus a sizing trailer', async () => {
      // KB-scale cap, matching how MEMORY_READ_CAP_BYTES is actually used (a
      // clean multiple of 1024) so the KB figures in the trailer are exact.
      const capBytes = 2048
      const big = 'y'.repeat(capBytes + 500) // 2548 bytes -> ceil(2548/1024) = 3KB
      const { personaDir } = await makeMemoryDir({ 'big.md': big })
      const mem = new Memory(personaDir, 'memory/')
      const content = await mem.readCapped('big.md', capBytes)
      assert.ok(content.startsWith('y'.repeat(capBytes)), 'keeps exactly the first capBytes')
      assert.ok(content.includes('truncated'), 'states that the content was truncated')
      assert.ok(content.includes('2KB'), 'states the cap size in KB')
      assert.ok(content.includes('3KB'), 'states the true total size in KB')
      assert.ok(content.includes('topic files'), 'advises splitting the file into topic files')
    })

    it('defaults to MEMORY_READ_CAP_BYTES (32KB) when no cap is given', async () => {
      const big = 'z'.repeat(MEMORY_READ_CAP_BYTES + 1024)
      const { personaDir } = await makeMemoryDir({ 'MEMORY.md': big })
      const mem = new Memory(personaDir, 'memory/')
      const content = await mem.readCapped('MEMORY.md')
      assert.ok(content.length < big.length, 'default cap truncates a file over 32KB')
      assert.ok(content.startsWith('z'.repeat(MEMORY_READ_CAP_BYTES)))
    })

    it('returns null for missing files, same as read', async () => {
      const { personaDir } = await makeMemoryDir()
      const mem = new Memory(personaDir, 'memory/')
      assert.equal(await mem.readCapped('nope.md'), null)
    })
  })

  describe('sizeOf', () => {
    it('returns the byte size of a memory file on disk', async () => {
      const { personaDir } = await makeMemoryDir({ 'notes.md': 'x'.repeat(42) })
      const mem = new Memory(personaDir, 'memory/')
      assert.equal(await mem.sizeOf('notes.md'), 42)
    })

    it('returns null for missing files', async () => {
      const { personaDir } = await makeMemoryDir()
      const mem = new Memory(personaDir, 'memory/')
      assert.equal(await mem.sizeOf('nope.md'), null)
    })

    it('reflects growth after an append', async () => {
      const { personaDir } = await makeMemoryDir({ 'log.md': 'a'.repeat(10) })
      const mem = new Memory(personaDir, 'memory/')
      await mem.append('log.md', 'b'.repeat(10))
      // original 10 bytes + '\n' + 10 appended bytes = 21
      assert.equal(await mem.sizeOf('log.md'), 21)
    })
  })

  describe('capUtf8Bytes', () => {
    it('passes content at or under the cap through untouched', () => {
      const content = 'x'.repeat(100)
      const result = capUtf8Bytes(content, 100)
      assert.equal(result.text, content)
      assert.equal(result.truncated, false)
      assert.equal(result.totalBytes, 100)
    })

    it('truncates content over the cap and reports the true size', () => {
      const content = 'x'.repeat(MEMORY_READ_CAP_BYTES + 500)
      const result = capUtf8Bytes(content)
      assert.equal(result.truncated, true)
      assert.equal(result.totalBytes, MEMORY_READ_CAP_BYTES + 500)
      assert.equal(Buffer.byteLength(result.text, 'utf8'), MEMORY_READ_CAP_BYTES)
    })

    it('measures bytes, not characters, for multibyte content', () => {
      const content = '🧀'.repeat(50) // 4 bytes each = 200 bytes, 100 JS chars
      const result = capUtf8Bytes(content, 100)
      assert.equal(result.truncated, true)
      assert.equal(result.totalBytes, 200)
    })
  })
})
