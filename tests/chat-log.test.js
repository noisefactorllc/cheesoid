import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatLog } from '../server/lib/chat-log.js'

async function tmpPersona() {
  const dir = await mkdtemp(join(tmpdir(), 'chatlog-'))
  await mkdir(join(dir, 'history'), { recursive: true })
  return dir
}
function line(i, extra = {}) {
  return JSON.stringify({ type: 'user_message', name: 'u', text: `msg-${i}`, ...extra })
}

test('recent returns the last N in chronological order', async () => {
  const dir = await tmpPersona()
  const data = Array.from({ length: 100 }, (_, i) => line(i)).join('\n') + '\n'
  await writeFile(join(dir, 'history', '2026-01-01.jsonl'), data)
  const log = new ChatLog(dir, 'history')
  const r = await log.recent(40)
  assert.equal(r.length, 40)
  assert.equal(r[0].text, 'msg-60')
  assert.equal(r[39].text, 'msg-99')
  await rm(dir, { recursive: true, force: true })
})

test('recent returns everything when fewer entries than limit', async () => {
  const dir = await tmpPersona()
  await writeFile(join(dir, 'history', '2026-01-01.jsonl'),
    Array.from({ length: 5 }, (_, i) => line(i)).join('\n') + '\n')
  const log = new ChatLog(dir, 'history')
  const r = await log.recent(40)
  assert.equal(r.length, 5)
  assert.equal(r[0].text, 'msg-0')
  assert.equal(r[4].text, 'msg-4')
  await rm(dir, { recursive: true, force: true })
})

test('recent spans multiple files, newest last', async () => {
  const dir = await tmpPersona()
  await writeFile(join(dir, 'history', '2026-01-01.jsonl'),
    Array.from({ length: 30 }, (_, i) => line(i)).join('\n') + '\n')
  await writeFile(join(dir, 'history', '2026-01-02.jsonl'),
    Array.from({ length: 30 }, (_, i) => line(100 + i)).join('\n') + '\n')
  const log = new ChatLog(dir, 'history')
  const r = await log.recent(40)
  assert.equal(r.length, 40)
  assert.equal(r[0].text, 'msg-20')   // last 10 of file 1
  assert.equal(r[39].text, 'msg-129') // all 30 of file 2
  await rm(dir, { recursive: true, force: true })
})

test('recent reads only the tail of an oversized file and still returns the true newest entries', async () => {
  const dir = await tmpPersona()
  // ~5 MB file (well over the 2 MB tail cap): 5000 entries padded to ~1 KB each.
  // The pre-fix code did readFile() on the whole thing; the fix reads the tail.
  const pad = 'x'.repeat(1000)
  const big = Array.from({ length: 5000 }, (_, i) => line(i, { pad })).join('\n') + '\n'
  await writeFile(join(dir, 'history', '2026-01-01.jsonl'), big)
  const log = new ChatLog(dir, 'history')
  const r = await log.recent(40)
  assert.equal(r.length, 40)
  assert.equal(r[0].text, 'msg-4960')
  assert.equal(r[39].text, 'msg-4999')
  await rm(dir, { recursive: true, force: true })
})

test('search streams and returns newest matches first, bounded by limit', async () => {
  const dir = await tmpPersona()
  const data = Array.from({ length: 100 }, (_, i) =>
    JSON.stringify({ type: 'user_message', name: 'u', text: i % 10 === 0 ? `findme-${i}` : `other-${i}` })
  ).join('\n') + '\n'
  await writeFile(join(dir, 'history', '2026-01-01.jsonl'), data)
  const log = new ChatLog(dir, 'history')
  const r = await log.search('findme', { limit: 5 })
  assert.equal(r.length, 5)
  assert.equal(r[0].text, 'findme-90') // newest first
  assert.equal(r[4].text, 'findme-50')
  await rm(dir, { recursive: true, force: true })
})

test('recent tolerates a partial first line in the tail window', async () => {
  const dir = await tmpPersona()
  // Force the tail window to start mid-line: one giant leading entry (~3 MB)
  // pushes the boundary past it so the first line read back is partial.
  const huge = 'y'.repeat(3 * 1024 * 1024)
  const data = [line(0, { pad: huge }), line(1), line(2), line(3)].join('\n') + '\n'
  await writeFile(join(dir, 'history', '2026-01-01.jsonl'), data)
  const log = new ChatLog(dir, 'history')
  const r = await log.recent(10)
  // The 3 MB entry is dropped (partial), the small tail entries survive intact.
  assert.deepEqual(r.map(e => e.text), ['msg-1', 'msg-2', 'msg-3'])
  await rm(dir, { recursive: true, force: true })
})
