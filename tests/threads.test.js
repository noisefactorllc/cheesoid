import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveThreadId,
  buildMessageIndex,
  stampThreadIds,
  collectThread,
  formatThread,
} from '../server/lib/thread-utils.js'

function msg(id, overrides = {}) {
  return {
    type: 'user_message',
    id,
    text: `text-${id}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('resolveThreadId', () => {
  it('linear chain: every node resolves to the root', () => {
    const a = msg('a')
    const b = msg('b', { replyTo: 'a' })
    const c = msg('c', { replyTo: 'b' })
    const index = buildMessageIndex([a, b, c])
    assert.equal(resolveThreadId(a, index), 'a')
    assert.equal(resolveThreadId(b, index), 'a')
    assert.equal(resolveThreadId(c, index), 'a')
  })

  it('branching chain: both branches resolve to the shared root', () => {
    const a = msg('a')
    const b = msg('b', { replyTo: 'a' })
    const c = msg('c', { replyTo: 'a' })
    const d = msg('d', { replyTo: 'c' })
    const index = buildMessageIndex([a, b, c, d])
    assert.equal(resolveThreadId(a, index), 'a')
    assert.equal(resolveThreadId(b, index), 'a')
    assert.equal(resolveThreadId(c, index), 'a')
    assert.equal(resolveThreadId(d, index), 'a')
  })

  it('independent message (no replyTo) resolves to its own id', () => {
    const solo = msg('solo')
    const index = buildMessageIndex([solo])
    assert.equal(resolveThreadId(solo, index), 'solo')
  })

  it('unknown parent anchors the thread to the unknown id', () => {
    const orphan = msg('orphan', { replyTo: 'ghost' })
    const index = buildMessageIndex([orphan])
    assert.equal(resolveThreadId(orphan, index), 'ghost')
  })

  it('hand-built 2-node cycle terminates and returns a stable id', () => {
    // a replies to b, b replies to a — a cycle that would never occur
    // naturally but must not hang or stack-overflow the walk.
    const a = { type: 'user_message', id: 'a', text: 'a', replyTo: 'b', timestamp: 't' }
    const b = { type: 'user_message', id: 'b', text: 'b', replyTo: 'a', timestamp: 't' }
    const index = buildMessageIndex([a, b])
    // Documented behavior: the walk returns the id of the node where the
    // cycle is first re-entered, starting from the given entry. Starting
    // from `a` re-visits 'a' first (a -> b -> a); starting from `b`
    // re-visits 'b' first (b -> a -> b). Both must be stable across calls.
    assert.equal(resolveThreadId(a, index), 'a')
    assert.equal(resolveThreadId(a, index), 'a')
    assert.equal(resolveThreadId(b, index), 'b')
    assert.equal(resolveThreadId(b, index), 'b')
  })

  it('depth cap stops a runaway chain instead of hanging', () => {
    const entries = []
    for (let i = 0; i < 150; i++) {
      entries.push(msg(`m${i}`, i === 0 ? {} : { replyTo: `m${i - 1}` }))
    }
    const index = buildMessageIndex(entries)
    const result = resolveThreadId(entries[149], index)
    // True root is m0; the 100-hop cap stops the walk short of it at m49
    // (149 - 100 hops), proving the guard actually bounds the walk.
    assert.equal(result, 'm49')
  })
})

describe('buildMessageIndex', () => {
  it('indexes message-type entries by id', () => {
    const a = msg('a')
    const b = msg('b', { type: 'assistant_message' })
    const index = buildMessageIndex([a, b])
    assert.equal(index.get('a'), a)
    assert.equal(index.get('b'), b)
    assert.equal(index.size, 2)
  })

  it('skips typeless, idless, and non-message-type entries', () => {
    const noId = { type: 'user_message', text: 'no id' }
    const noType = { id: 'x', text: 'no type' }
    const otherType = { id: 'y', type: 'tool_call', text: 'not a message' }
    const idle = msg('z', { type: 'idle_thought' })
    const index = buildMessageIndex([noId, noType, otherType, idle])
    assert.equal(index.size, 1)
    assert.equal(index.get('z'), idle)
    assert.equal(index.has('x'), false)
    assert.equal(index.has('y'), false)
    assert.equal(index.has(undefined), false)
  })
})

describe('stampThreadIds', () => {
  it('annotates both repliers and the replied-to root with the same threadId', () => {
    const a = msg('a')
    const b = msg('b', { replyTo: 'a' })
    const [sa, sb] = stampThreadIds([a, b])
    assert.equal(sa.threadId, 'a')
    assert.equal(sb.threadId, 'a')
  })

  it('does not mutate input objects or the input array', () => {
    const a = msg('a')
    const b = msg('b', { replyTo: 'a' })
    const original = [a, b]
    const stamped = stampThreadIds(original)
    assert.equal('threadId' in a, false)
    assert.equal('threadId' in b, false)
    assert.notEqual(stamped, original)
    assert.notEqual(stamped[0], a)
    assert.notEqual(stamped[1], b)
  })

  it('leaves entries with no thread involvement unchanged', () => {
    const a = msg('a')
    const b = msg('b', { replyTo: 'a' })
    const solo = msg('solo')
    const stamped = stampThreadIds([a, b, solo])
    const stampedSolo = stamped.find(e => e.id === 'solo')
    assert.equal('threadId' in stampedSolo, false)
    assert.equal(stampedSolo, solo) // same reference — untouched
  })
})

describe('collectThread', () => {
  it('collects every entry in a thread in original array order', () => {
    const a = msg('a')
    const b = msg('b', { replyTo: 'a' })
    const c = msg('c', { replyTo: 'a' })
    const d = msg('d', { replyTo: 'c' })
    const unrelated = msg('z')
    // Deliberately out of topological order (c before b) to prove
    // collectThread preserves array order rather than re-sorting by depth.
    const entries = [unrelated, a, c, b, d]
    const thread = collectThread(entries, 'a')
    assert.deepEqual(thread.map(e => e.id), ['a', 'c', 'b', 'd'])
  })

  it('returns an empty array for an unknown threadId', () => {
    const a = msg('a')
    assert.deepEqual(collectThread([a], 'nope'), [])
  })
})

describe('formatThread', () => {
  it('indents replies two spaces per depth relative to the root', () => {
    const a = msg('a', { timestamp: 't0', name: 'alice', text: 'root' })
    const b = msg('b', { timestamp: 't1', name: 'bob', text: 'reply1', replyTo: 'a' })
    const c = msg('c', { timestamp: 't2', name: 'carol', text: 'reply2', replyTo: 'b' })
    const out = formatThread([a, b, c], 'a')
    const lines = out.split('\n')
    assert.equal(lines[0], '[t0] alice [a]: root')
    assert.equal(lines[1], '  [t1] bob [b]: reply1')
    assert.equal(lines[2], '    [t2] carol [c]: reply2')
  })

  it('falls back to agent for unnamed assistant_message, unknown otherwise', () => {
    const a = msg('a', { timestamp: 't0', text: 'root' })
    const b = msg('b', { timestamp: 't1', text: 'reply', replyTo: 'a', type: 'assistant_message' })
    const out = formatThread([a, b], 'a')
    const lines = out.split('\n')
    assert.equal(lines[0], '[t0] unknown [a]: root')
    assert.equal(lines[1], '  [t1] agent [b]: reply')
  })

  it('caps indentation at 8 levels for very deep chains', () => {
    const entries = []
    for (let i = 0; i < 12; i++) {
      entries.push(msg(`m${i}`, i === 0 ? { timestamp: `t${i}` } : { replyTo: `m${i - 1}`, timestamp: `t${i}` }))
    }
    const out = formatThread(entries, 'm0')
    const lines = out.split('\n')
    assert.equal(lines.length, 12)
    assert.equal(lines[7].match(/^ */)[0].length, 14) // depth 7 -> below cap
    assert.equal(lines[8].match(/^ */)[0].length, 16) // depth 8 -> cap reached
    assert.equal(lines[11].match(/^ */)[0].length, 16) // depth 11 -> still capped
  })

  it('truncates to the last maxEntries with a head line', () => {
    const entries = []
    for (let i = 0; i < 10; i++) {
      entries.push(msg(`m${i}`, i === 0 ? {} : { replyTo: `m${i - 1}` }))
    }
    const out = formatThread(entries, 'm0', { maxEntries: 3 })
    const lines = out.split('\n')
    assert.equal(lines.length, 4) // head line + 3 messages
    assert.equal(lines[0], '… (7 earlier messages)')
    assert.match(lines[1], /\[m7\]/)
    assert.match(lines[2], /\[m8\]/)
    assert.match(lines[3], /\[m9\]/)
  })

  it('does not truncate when the thread is within maxEntries', () => {
    const a = msg('a')
    const b = msg('b', { replyTo: 'a' })
    const out = formatThread([a, b], 'a', { maxEntries: 50 })
    assert.ok(!out.includes('earlier messages'))
    assert.equal(out.split('\n').length, 2)
  })

  it('returns a not-found message for an unknown thread', () => {
    const a = msg('a')
    assert.equal(formatThread([a], 'nope'), 'Thread not found: nope')
  })
})
