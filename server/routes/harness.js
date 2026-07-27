import { Router } from 'express'
import express from 'express'
import { transcribe } from '../lib/voice.js'
import { redactHistoryEntry, redactKeys } from '../lib/chat-session.js'
import { MEDIA_MAX_BYTES } from '../lib/media.js'

const router = Router()

// Same auth chain as chat routes — proxy header or agent bearer.
// /api/peer/join is exempted inside the handler chain below (an unknown
// peer by definition has no credentials yet).
router.use((req, res, next) => {
  if (req.path === '/api/peer/join') return next()
  const auth = req.app.locals.authMiddleware
  if (auth) return auth(req, res, next)
  next()
})

function harnessOf(req) {
  return req.app.locals.rooms?.resolve()?.harness || null
}
function roomOf(req) {
  return req.app.locals.rooms?.resolve() || null
}

// A human at the UI — not a visiting agent. Secrets, peer approval, and
// task control are operator surfaces.
function requireHuman(req, res) {
  if (req.isAgent) {
    res.status(403).json({ error: 'not available to agents' })
    return false
  }
  return true
}

// ---------------- secrets (write-only) ----------------

router.get('/api/secrets', async (req, res) => {
  if (!requireHuman(req, res)) return
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  res.json({ secrets: await harness.secrets.list() })
})

router.post('/api/secrets', async (req, res) => {
  if (!requireHuman(req, res)) return
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const { name, value } = req.body || {}
  if (!name || !value) return res.status(400).json({ error: 'name and value required' })
  try {
    await harness.secrets.set(name, value)
    // Confirm by name only. The value is gone from the response surface
    // forever — that is the point.
    res.json({ status: 'stored', name })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/api/secrets/:name', async (req, res) => {
  if (!requireHuman(req, res)) return
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const removed = await harness.secrets.remove(req.params.name)
  res.json({ status: removed ? 'removed' : 'not found', name: req.params.name })
})

// ---------------- tasks ----------------

router.get('/api/tasks', async (req, res) => {
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  res.json({ tasks: await harness.tasks.list({ limit: 30 }) })
})

router.get('/api/tasks/:id', async (req, res) => {
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const task = await harness.tasks.get(req.params.id)
  if (!task) return res.status(404).json({ error: 'task not found' })
  const log = await harness.tasks.tail(req.params.id, { bytes: 8192 })
  res.json({ task, log: redactKeys(log, harness.secrets.values()) })
})

router.post('/api/tasks/:id/stop', async (req, res) => {
  if (!requireHuman(req, res)) return
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const task = await harness.tasks.stop(req.params.id)
  if (!task) return res.status(404).json({ error: 'task not found' })
  res.json({ task })
})

// ---------------- schedules ----------------

router.get('/api/schedules', async (req, res) => {
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const config = req.app.locals.persona.config
  const configured = (config.wakeups || (config.wakeup && config.wakeup.mode !== 'none' ? [config.wakeup] : []))
    .filter(w => w && w.schedule)
    .map(w => ({ id: null, name: w.name || 'wakeup', cron: w.schedule, source: 'config' }))
  const runtime = (await harness.schedules.list()).map(s => ({ ...s, source: 'runtime' }))
  res.json({ schedules: [...configured, ...runtime] })
})

router.delete('/api/schedules/:id', async (req, res) => {
  if (!requireHuman(req, res)) return
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const removed = await harness.schedules.remove(req.params.id)
  res.json({ status: removed ? 'removed' : 'not found' })
})

// ---------------- ad-hoc peering ----------------

// Unauthenticated by design — an unknown agent introduces itself here.
// Throttled per-IP, and nothing activates until a human approves in-room.
const joinAttempts = new Map()
router.post('/api/peer/join', async (req, res) => {
  const ip = req.ip || 'unknown'
  const now = Date.now()
  const attempts = (joinAttempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000)
  if (attempts.length >= 5) return res.status(429).json({ error: 'too many join requests — try later' })
  attempts.push(now)
  joinAttempts.set(ip, attempts)
  // Bound the throttle map: drop entries whose window has fully expired.
  if (joinAttempts.size > 1000) {
    for (const [k, v] of joinAttempts) {
      if (v.every(t => now - t >= 10 * 60 * 1000)) joinAttempts.delete(k)
    }
  }

  const harness = harnessOf(req)
  const room = roomOf(req)
  if (!harness || !room) return res.status(503).json({ error: 'harness not ready' })
  const { name, secret, url, note } = req.body || {}
  if (!name || !secret) return res.status(400).json({ error: 'name and secret required' })
  const configAgents = (req.app.locals.persona.config.agents || []).map(a => String(a.name).toLowerCase())
  if (configAgents.includes(String(name).toLowerCase())) {
    return res.status(400).json({ error: 'peer name taken' })
  }
  try {
    const record = await harness.peers.requestJoin({ name, secret, url: url || null, note: note || null })
    // Surface the request to the owning humans: a UI banner event plus a
    // system-sourced agent turn so the host announces it in the room.
    room.broadcast({ type: 'peer_request', name: record.name, url: record.url, note: record.note, requested: record.requested })
    room.recordHistory({ type: 'system', text: `Peer join request from "${record.name}"${record.url ? ` (${record.url})` : ''} — awaiting approval by a room owner.` })
    room.sendMessage('system', `[peer request] Agent "${record.name}"${record.url ? ` at ${record.url}` : ''}${record.note ? ` says: ${record.note}` : ''} is asking to join as a peer. Only a human in the room can approve this (Peers panel). Let the room know it is pending; do not promise approval.`)
      .catch(err => console.log(`[peering] announce failed: ${err.message}`))
    res.json({ status: 'pending', name: record.name, expires_in_hours: 24 })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/api/peers', async (req, res) => {
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const config = req.app.locals.persona.config
  const configured = (config.agents || []).map(a => ({ name: a.name, state: 'config' }))
  res.json({ peers: [...configured, ...await harness.peers.list()] })
})

router.post('/api/peer/approve', async (req, res) => {
  if (!requireHuman(req, res)) return
  const harness = harnessOf(req)
  const room = roomOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const { name } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  const approver = req.userName || req.body.approver || 'operator'
  try {
    const record = await harness.peers.approve(name, approver)
    room?.broadcast({ type: 'peer_resolved', name: record.name, state: 'approved', by: approver })
    room?.recordHistory({ type: 'system', text: `Peer "${record.name}" approved by ${approver}.` })
    res.json({ status: 'approved', peer: record })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.post('/api/peer/deny', async (req, res) => {
  if (!requireHuman(req, res)) return
  const harness = harnessOf(req)
  const room = roomOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const { name } = req.body || {}
  if (!name) return res.status(400).json({ error: 'name required' })
  const removed = await harness.peers.deny(name)
  if (removed) {
    room?.broadcast({ type: 'peer_resolved', name, state: 'denied' })
    room?.recordHistory({ type: 'system', text: `Peer request "${name}" denied.` })
  }
  res.json({ status: removed ? 'denied' : 'not found' })
})

router.delete('/api/peers/:name', async (req, res) => {
  if (!requireHuman(req, res)) return
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const removed = await harness.peers.remove(req.params.name)
  res.json({ status: removed ? 'removed' : 'not found' })
})

// UI-initiated outbound join: this instance connects to a remote room.
router.post('/api/peer/join-remote', async (req, res) => {
  if (!requireHuman(req, res)) return
  const room = roomOf(req)
  if (!room) return res.status(503).json({ error: 'harness not ready' })
  const { url, secret, name } = req.body || {}
  if (!url || !secret) return res.status(400).json({ error: 'url and secret required' })
  const result = await room.tools.execute('join_room', { url, secret, name })
  if (result.is_error) return res.status(400).json({ error: result.output })
  res.json({ status: 'connecting', detail: result.output })
})

// ---------------- media ----------------

router.post('/api/media', express.raw({ type: () => true, limit: MEDIA_MAX_BYTES + 1024 }), async (req, res) => {
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const mime = (req.headers['content-type'] || '').split(';')[0].trim()
  let name = 'file'
  try {
    name = decodeURIComponent(req.headers['x-media-name'] || 'file')
  } catch {
    return res.status(400).json({ error: 'invalid x-media-name encoding' })
  }
  try {
    const meta = await harness.media.save({
      buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || ''),
      mime,
      name,
      by: req.userName || req.headers['x-media-by'] || null,
    })
    res.json({ media: meta })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.get('/api/media/:id', async (req, res) => {
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  const loaded = await harness.media.load(req.params.id)
  if (!loaded) return res.status(404).json({ error: 'media not found' })
  res.setHeader('Content-Type', loaded.meta.mime)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // svg and friends must not script against the app origin
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.setHeader('Content-Disposition', `inline; filename="${loaded.meta.name.replace(/[^\w.\- ]/g, '_')}"`)
  res.send(loaded.buffer)
})

// ---------------- voice ----------------

router.post('/api/voice', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const room = roomOf(req)
  const config = req.app.locals.persona.config
  const mime = (req.headers['content-type'] || '').split(';')[0].trim()
  try {
    const hints = [config.display_name, ...(room ? room.participantList : [])]
    const { text, model } = await transcribe({
      buffer: Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || ''),
      mime,
      config,
      hints,
    })
    res.json({ text, model })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

// ---------------- memory (read-only drill-down for users) ----------------

const MEMORY_FILE_RE = /^[\w][\w.-]{0,100}\.md$/

router.get('/api/memory', async (req, res) => {
  const room = roomOf(req)
  if (!room?.memory) return res.status(503).json({ error: 'not ready' })
  res.json({ files: await room.memory.listWithSizes() })
})

router.get('/api/memory/:filename', async (req, res) => {
  const room = roomOf(req)
  if (!room?.memory) return res.status(503).json({ error: 'not ready' })
  const filename = req.params.filename
  if (!MEMORY_FILE_RE.test(filename) || filename.includes('..')) {
    return res.status(400).json({ error: 'invalid memory filename' })
  }
  const content = await room.memory.readCapped(filename)
  if (content === null) return res.status(404).json({ error: 'memory file not found' })
  res.json({ filename, content })
})

// ---------------- wiki (read-only for users) ----------------

router.get('/api/wiki', async (req, res) => {
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  res.json({ pages: await harness.wiki.list(), index: await harness.wiki.readIndex() })
})

router.get('/api/wiki/:slug', async (req, res) => {
  const harness = harnessOf(req)
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  try {
    const content = req.params.slug === 'index' ? await harness.wiki.readIndex() : await harness.wiki.read(req.params.slug)
    if (content === null) return res.status(404).json({ error: 'page not found' })
    res.json({ slug: req.params.slug, content })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// ---------------- history search ----------------

// User-facing full-history search over the same JSONL store the agent's
// search_history tool uses. Returns whole entries so the UI can act on
// hits (view thread, reply) — not just render snippets.
router.get('/api/chat/search', async (req, res) => {
  const room = roomOf(req)
  if (!room?.chatLog) return res.status(503).json({ error: 'not ready' })
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.json({ query: q, results: [] })
  const limit = Math.min(Number(req.query.limit) || 40, 100)
  const SEARCHABLE = new Set(['user_message', 'assistant_message', 'idle_thought'])
  const raw = await room.chatLog.search(q, { limit: limit * 2 })
  const secretValues = room.harness?.secrets?.values?.()
  const results = raw
    .filter(e => SEARCHABLE.has(e.type))
    .slice(0, limit)
    .map(e => redactHistoryEntry(e, secretValues))
    .map(e => ({
      id: e.id || null,
      type: e.type,
      name: e.name || (e.type === 'assistant_message' ? null : 'unknown'),
      text: String(e.text || '').slice(0, 500),
      room: e.room || null,
      replyTo: e.replyTo || null,
      threadId: e.threadId || null,
      model: e.model || null,
      timestamp: e.timestamp || null,
      dm: Boolean(e.dm_from || e.dm_to),
    }))
  res.json({ query: q, results })
})

// ---------------- threads ----------------

// Single-message lookup — backs reply-quote headers for messages no longer
// in the rendered scrollback. Every id the UI holds came out of this store,
// so resolution is exhaustive: live in-memory history first (covers the
// append race), then the full JSONL history. A miss here means an id was
// fabricated somewhere upstream — that is a bug to surface loudly in the
// server log, never a user-facing condition.
router.get('/api/chat/message', async (req, res) => {
  const room = roomOf(req)
  if (!room?.chatLog) return res.status(503).json({ error: 'not ready' })
  const id = req.query.id
  if (!id) return res.status(400).json({ error: 'id required' })
  let entry = (room.history || []).find(h => h.id === id) || await room.chatLog.findById(id)
  if (!entry) {
    console.error(`[${req.app.locals.persona.config.name}] BUG: /api/chat/message asked for id ${id} which resolves nowhere — some surface emitted a fabricated id`)
    return res.status(500).json({ error: 'internal id resolution bug — check server logs' })
  }
  entry = redactHistoryEntry(entry, room.harness?.secrets?.values?.())
  res.json({
    id: entry.id,
    type: entry.type,
    name: entry.name || null,
    text: String(entry.text || ''),
    room: entry.room || null,
    timestamp: entry.timestamp || null,
  })
})

router.get('/api/chat/thread', async (req, res) => {
  const room = roomOf(req)
  if (!room?.chatLog) return res.status(503).json({ error: 'not ready' })
  const id = req.query.id
  if (!id) return res.status(400).json({ error: 'id required' })
  // Full-history reconstruction — anything search can surface, this can
  // thread. Seconds-old messages may not have hit the JSONL store yet, so
  // fall back to live in-memory history for the anchor.
  const secretVals = room.harness?.secrets?.values?.()
  const result = await room.chatLog.threadEntries(id)
  if (result) {
    return res.json({ threadId: result.threadId, messages: result.entries.map(e => redactHistoryEntry(e, secretVals)), truncated: result.truncated })
  }
  const live = (room.history || []).find(h => h.id === id)
  if (live) {
    const threadId = live.threadId || live.replyTo || live.id
    const members = (room.history || []).filter(h => h.id === threadId || h.threadId === threadId || h.id === id)
    return res.json({ threadId, messages: members.map(e => redactHistoryEntry(e, secretVals)), truncated: false })
  }
  console.error(`[${req.app.locals.persona.config.name}] BUG: /api/chat/thread asked for id ${id} which resolves nowhere — some surface emitted a fabricated id`)
  res.status(500).json({ error: 'internal id resolution bug — check server logs' })
})

// ---------------- harness status (UI panels bootstrap) ----------------

router.get('/api/harness', async (req, res) => {
  const harness = harnessOf(req)
  const config = req.app.locals.persona.config
  if (!harness) return res.status(503).json({ error: 'harness not ready' })
  res.json({
    autonomy: harness.autonomy.level,
    running_tasks: harness.tasks.running(),
    model_policy: config._modelPolicy || null,
    tiers: {
      cognition: config.cognition?.[0] || null,
      attention: config.attention?.[0] || null,
      reasoner: config.reasoner?.[0] || null,
      executor: config.model?.[0] || null,
      reflection: config.reflection?.[0] || null,
      transcription: config.transcription?.[0] || null,
      subagent: config.subagent?.[0] || null,
    },
    voice: Boolean((config.transcription || []).length),
  })
})

export default router
