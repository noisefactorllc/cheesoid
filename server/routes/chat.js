import { Router } from 'express'

const router = Router()

router.use((req, res, next) => {
  const auth = req.app.locals.authMiddleware
  if (auth) return auth(req, res, next)
  next()
})

/**
 * Resolve the target room from request params.
 * Hub mode: look up by room name (query or body). Legacy mode: use default room.
 * Returns null if room not found (caller should 404).
 */
function resolveRoom(req, roomName) {
  const { rooms } = req.app.locals
  if (!rooms) return req.app.locals.room // deep legacy fallback

  if (rooms.isHub && roomName) {
    return rooms.get(roomName)
  }
  return rooms.resolve(roomName)
}

// SSE stream — client connects and receives room events
router.get('/api/chat/stream', (req, res) => {
  const name = req.userName || req.query.name || null
  const { rooms } = req.app.locals

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // One stream per client. Default room handles SSE subscription,
  // broadcasts, and scrollback. Rooms are a UI routing concept —
  // events are tagged with room names, UI filters by current view.
  const defaultRoom = rooms ? rooms.defaultRoom : resolveRoom(req, req.query.room)
  if (!defaultRoom) return res.status(404).json({ error: 'room not found' })
  defaultRoom.addClient(res, name, req.isAgent)
  if (rooms) rooms.addDMClient(res, name)
})

// Send a message to a room or DM
router.post('/api/chat/send', async (req, res) => {
  const { message, to } = req.body
  const name = req.userName || req.body.name
  if (!message) return res.status(400).json({ error: 'message required' })
  if (!name) return res.status(400).json({ error: 'name required' })

  // DM handling — route to both participants
  if (to) {
    const { rooms } = req.app.locals
    if (rooms && rooms.isHub && rooms.routeDM) {
      rooms.routeDM(name, to, message, req.isAgent, req.body.model)
      return res.json({ status: 'sent' })
    }
  }

  const room = resolveRoom(req, req.body.room)
  if (!room) return res.status(404).json({ error: 'room not found' })

  res.json({ status: 'sent' })

  if (req.isAgent && req.body.dm_to) {
    // Visitor agent responding to a DM — route via DM system
    const { rooms } = req.app.locals
    if (rooms) rooms.routeDM(name, req.body.dm_to, message, true, req.body.model)
  } else if (req.isAgent && req.body.backchannel) {
    room.addBackchannelMessage(name, message, { trigger: req.body.trigger, target: req.body.target })
  } else if (req.isAgent) {
    room.addAgentMessage(name, message, { source: 'room', model: req.body.model, replyTo: req.body.replyTo })
  } else {
    const sendOpts = {}
    if (req.body.addressed) sendOpts._addressed = req.body.addressed
    if (req.body.replyTo) sendOpts._replyTo = req.body.replyTo
    room.sendMessage(name, message, sendOpts).catch(err => {
      console.error('sendMessage error:', err.message)
    })
  }
})

// Add or remove a reaction on a message
router.post('/api/chat/react', (req, res) => {
  const { messageId, emoji, action } = req.body
  const name = req.userName || req.body.name
  if (!messageId || !emoji || !name) return res.status(400).json({ error: 'messageId, emoji, and name required' })
  if (action && action !== 'add' && action !== 'remove') return res.status(400).json({ error: 'action must be add or remove' })

  const room = resolveRoom(req, req.body.room)
  if (!room) return res.status(404).json({ error: 'room not found' })

  room.addReaction(name, messageId, emoji, action || 'add')
  res.json({ status: 'ok' })
})

// Relay streaming events from visiting agents
router.post('/api/chat/event', (req, res) => {
  if (!req.isAgent) return res.status(403).json({ error: 'agent auth required' })

  const { name, event } = req.body
  if (!name || !event || !event.type) {
    return res.status(400).json({ error: 'name and event with type required' })
  }

  const room = resolveRoom(req, req.body.room)
  if (!room) return res.status(404).json({ error: 'room not found' })

  room.relayAgentEvent(name, event)
  res.json({ status: 'relayed' })
})

// Request scrollback for a specific room
router.get('/api/chat/scrollback', (req, res) => {
  const room = resolveRoom(req, req.query.room)
  if (!room) return res.status(404).json({ error: 'room not found' })
  res.json({ messages: room.getScrollback() })
})

export default router
