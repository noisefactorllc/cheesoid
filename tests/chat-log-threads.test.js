import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatLog } from '../server/lib/chat-log.js'
import { persistedThreadIdForReply } from '../server/lib/chat-session.js'

async function makeHistory(days) {
  const dir = await mkdtemp(join(tmpdir(), 'chatlog-threads-'))
  await mkdir(join(dir, 'history'), { recursive: true })
  for (const [date, entries] of Object.entries(days)) {
    const lines = entries.map(e => JSON.stringify({ timestamp: `${date}T10:00:00.000Z`, ...e })).join('\n') + '\n'
    await writeFile(join(dir, 'history', `${date}.jsonl`), lines)
  }
  return new ChatLog(dir, 'history')
}

const DAYS = {
  '2026-05-01': [
    { type: 'user_message', id: 'aaaa0001', name: 'alice', text: 'kicking off the roadmap thread' },
    { type: 'assistant_message', id: 'aaaa0002', replyTo: 'aaaa0001', text: 'noted — drafting it' },
    { type: 'user_message', id: 'bbbb0001', name: 'bob', text: 'unrelated: lunch?' },
  ],
  '2026-06-15': [
    { type: 'user_message', id: 'aaaa0003', name: 'carol', replyTo: 'aaaa0002', text: 'circling back on the roadmap' },
    { type: 'reaction', messageId: 'aaaa0003', emoji: '👍', name: 'alice' },
  ],
  '2026-07-20': [
    { type: 'user_message', id: 'aaaa0004', name: 'alice', replyTo: 'aaaa0003', text: 'roadmap v2 shipped' },
    { type: 'user_message', id: 'cccc0001', name: 'dave', text: 'new topic entirely' },
  ],
}

test('a reply to an old mid-thread entry preserves the persisted root id', () => {
  assert.strictEqual(
    persistedThreadIdForReply('reply901', {
      id: 'reply901',
      replyTo: 'root9000',
      threadId: 'root9000',
    }),
    'root9000',
  )
  assert.strictEqual(persistedThreadIdForReply('missing1', null), 'missing1')
})

test('findById reaches entries in old files', async () => {
  const log = await makeHistory(DAYS)
  const entry = await log.findById('aaaa0001')
  assert.strictEqual(entry.name, 'alice')
  assert.match(entry.text, /kicking off/)
  assert.strictEqual(await log.findById('99999999'), null)
  assert.strictEqual(await log.findById(null), null)
})

test('threadEntries reconstructs a chain spanning months of files', async () => {
  const log = await makeHistory(DAYS)
  // Anchor on the NEWEST message; the chain reaches back two files.
  const result = await log.threadEntries('aaaa0004')
  assert.strictEqual(result.threadId, 'aaaa0001')
  assert.deepStrictEqual(result.entries.map(e => e.id), ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004'])
  assert.strictEqual(result.truncated, false)

  // Anchoring anywhere in the chain lands on the same thread.
  const mid = await log.threadEntries('aaaa0002')
  assert.strictEqual(mid.threadId, 'aaaa0001')
  assert.strictEqual(mid.entries.length, 4)

  // A legacy root has no explicit threadId. It must use link reconstruction
  // instead of the modern persisted-id fast path.
  const root = await log.threadEntries('aaaa0001')
  assert.strictEqual(root.threadId, 'aaaa0001')
  assert.deepStrictEqual(root.entries.map(e => e.id), ['aaaa0001', 'aaaa0002', 'aaaa0003', 'aaaa0004'])
})

test('threadEntries isolates unrelated messages and handles singletons', async () => {
  const log = await makeHistory(DAYS)
  const solo = await log.threadEntries('cccc0001')
  assert.strictEqual(solo.threadId, 'cccc0001')
  assert.deepStrictEqual(solo.entries.map(e => e.id), ['cccc0001'])
})

test('threadEntries returns null only for ids that never existed', async () => {
  const log = await makeHistory(DAYS)
  assert.strictEqual(await log.threadEntries('deadbeef'), null)
  assert.strictEqual(await log.threadEntries(null), null)
})

test('threadEntries truncates the middle but pins the root and newest', async () => {
  const entries = [{ type: 'user_message', id: 'root0000', name: 'a', text: 'root' }]
  for (let i = 1; i <= 30; i++) {
    const id = `msg${String(i).padStart(5, '0')}`
    const prev = i === 1 ? 'root0000' : `msg${String(i - 1).padStart(5, '0')}`
    entries.push({ type: 'user_message', id, replyTo: prev, name: 'a', text: `reply ${i}` })
  }
  const log = await makeHistory({ '2026-07-01': entries })
  const result = await log.threadEntries('msg00030', { maxEntries: 10 })
  assert.strictEqual(result.truncated, true)
  // Root is always present so the thread's origin survives truncation.
  assert.strictEqual(result.entries[0].id, 'root0000')
  assert.strictEqual(result.entries.length, 11) // pinned root + 10-entry window
  assert.strictEqual(result.entries.at(-1).id, 'msg00030')
})

test('persisted threadId reconstructs a full thread even beyond the legacy link-index cap', async () => {
  const root = { type: 'user_message', id: 'root9000', threadId: 'root9000', text: 'root' }
  const filler = Array.from({ length: 20 }, (_, i) => ({
    type: 'user_message',
    id: `fill${String(i).padStart(4, '0')}`,
    text: `unrelated ${i}`,
  }))
  const replies = [
    { type: 'assistant_message', id: 'reply901', replyTo: 'root9000', threadId: 'root9000', text: 'one' },
    { type: 'user_message', id: 'reply902', replyTo: 'reply901', threadId: 'root9000', text: 'two' },
  ]
  const log = await makeHistory({ '2026-07-01': [root, ...filler, ...replies] })
  const result = await log.threadEntries('root9000', { maxIndex: 2 })
  assert.deepStrictEqual(result.entries.map(entry => entry.id), ['root9000', 'reply901', 'reply902'])
})
