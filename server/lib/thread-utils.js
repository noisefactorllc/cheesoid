// Pure utilities for resolving and rendering reply-chain "threads" over chat
// history entries (see chat-log.js for the JSONL entry shape: { type, id,
// replyTo?, text, name?, room?, timestamp }). A thread is identified by the
// id of its ROOT message — the transitively-first message in a chain of
// replyTo links. None of these functions perform I/O; callers load `entries`
// (e.g. via ChatLog#recent/#search) and pass them in.
//
// Cycle handling: replyTo chains are expected to be acyclic, but corrupted or
// hand-built data can form a cycle (e.g. a replies to b, b replies to a).
// resolveThreadId() walks parent links with a visited-id guard and a hard
// depth cap (100 hops) so a cycle can never hang or stack-overflow the
// caller. On cycle detection the walk stops and returns the id of the node
// where the cycle was first re-entered — i.e. the id that is seen a second
// time while walking from the original `entry`. This is deterministic for a
// given graph (same input always yields the same output) but is not
// guaranteed to equal `entry.id`: if `entry` sits upstream of the cycle
// rather than inside it, the returned id is whichever cycle node the walk
// reaches first.

const MESSAGE_TYPES = new Set(['user_message', 'assistant_message', 'idle_thought'])
const DEPTH_CAP = 100
const MAX_INDENT_DEPTH = 8

function isMessageEntry(entry) {
  return !!entry && entry.id != null && MESSAGE_TYPES.has(entry.type)
}

/**
 * Resolve the thread root id for a single entry by walking its replyTo chain
 * through `index`.
 * @param {object} entry - history entry, optionally carrying a replyTo id.
 * @param {Map<string, object>} index - id -> entry, as from buildMessageIndex.
 * @returns {string|null} Root id if entry participates in a chain (has
 *   replyTo); otherwise entry.id ?? null. If a replyTo link points at an id
 *   not present in `index`, the thread is anchored to that unknown id.
 */
export function resolveThreadId(entry, index) {
  if (!entry) return null
  if (!entry.replyTo) return entry.id ?? null

  const visited = new Set()
  let current = entry
  let hops = 0

  while (current && current.replyTo && hops < DEPTH_CAP) {
    const key = current.id ?? current.replyTo
    if (visited.has(key)) return current.id ?? null // cycle — see module comment
    visited.add(key)
    const parent = index.get(current.replyTo)
    if (!parent) return current.replyTo // unknown parent anchors the thread
    current = parent
    hops++
  }
  return current.id ?? null
}

/**
 * Index history entries by id for O(1) replyTo lookups. Only entries with an
 * id and a message type (user_message, assistant_message, idle_thought) are
 * indexed; other types, and typeless/idless entries, are skipped.
 * @param {object[]} entries
 * @returns {Map<string, object>}
 */
export function buildMessageIndex(entries) {
  const index = new Map()
  for (const entry of entries) {
    if (isMessageEntry(entry)) index.set(entry.id, entry)
  }
  return index
}

/**
 * Annotate every message entry that participates in a thread (has replyTo,
 * or is replied to by another entry) with its resolved threadId. Entries
 * with no thread involvement are returned unchanged (same reference, no
 * threadId key added). Never mutates the input array or its entries.
 * @param {object[]} entries
 * @returns {object[]} New array; unaffected entries keep their original reference.
 */
export function stampThreadIds(entries) {
  const index = buildMessageIndex(entries)

  const involved = new Set()
  for (const entry of entries) {
    if (isMessageEntry(entry) && entry.replyTo) {
      involved.add(entry.id)
      involved.add(entry.replyTo)
    }
  }

  return entries.map(entry => {
    if (!isMessageEntry(entry) || !involved.has(entry.id)) return entry
    return { ...entry, threadId: resolveThreadId(entry, index) }
  })
}

/**
 * Collect every message entry belonging to a thread, in original order.
 * @param {object[]} entries
 * @param {string} threadId
 * @returns {object[]}
 */
export function collectThread(entries, threadId) {
  const index = buildMessageIndex(entries)
  return entries.filter(entry => isMessageEntry(entry) && resolveThreadId(entry, index) === threadId)
}

// Number of replyTo hops from `entry` up to its root (root itself is depth 0).
// Guarded the same way as resolveThreadId (visited set + DEPTH_CAP) so a
// cycle or runaway chain can't hang formatThread's rendering pass.
function chainDepth(entry, index) {
  if (!entry || !entry.replyTo) return 0
  const visited = new Set()
  let current = entry
  let depth = 0
  while (current && current.replyTo && depth < DEPTH_CAP) {
    const key = current.id ?? current.replyTo
    if (visited.has(key)) break
    visited.add(key)
    depth++
    const parent = index.get(current.replyTo)
    if (!parent) break
    current = parent
  }
  return depth
}

function formatName(entry) {
  if (entry.name) return entry.name
  return entry.type === 'assistant_message' ? 'agent' : 'unknown'
}

/**
 * Render a thread as human/agent-readable text: one line per message,
 * `[timestamp] name [id]: text`, indented two spaces per reply depth
 * relative to the root (depth capped at 8 indent levels). When the thread
 * has more than maxEntries messages, only the last maxEntries are shown,
 * preceded by a `… (N earlier messages)` head line.
 * @param {object[]} entries
 * @param {string} threadId
 * @param {{maxEntries?: number}} [options]
 * @returns {string} Rendered thread, or `Thread not found: <threadId>` if empty.
 */
export function formatThread(entries, threadId, { maxEntries = 50 } = {}) {
  const thread = collectThread(entries, threadId)
  if (thread.length === 0) return `Thread not found: ${threadId}`

  const index = buildMessageIndex(entries)
  const omitted = Math.max(0, thread.length - maxEntries)
  const visible = omitted > 0 ? thread.slice(omitted) : thread

  const lines = []
  if (omitted > 0) lines.push(`… (${omitted} earlier messages)`)
  for (const entry of visible) {
    const indent = '  '.repeat(Math.min(chainDepth(entry, index), MAX_INDENT_DEPTH))
    lines.push(`${indent}[${entry.timestamp}] ${formatName(entry)} [${entry.id}]: ${entry.text}`)
  }
  return lines.join('\n')
}
