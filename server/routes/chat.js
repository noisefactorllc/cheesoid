import { Router } from 'express'

const router = Router()

router.use((req, res, next) => {
  const auth = req.app.locals.authMiddleware
  if (auth) return auth(req, res, next)
  next()
})

// SSE stream — client connects and receives all room events
router.get('/api/chat/stream', (req, res) => {
  const name = req.userName || req.query.name || null
  const { room } = req.app.locals

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  room.addClient(res, name, req.isAgent)
})

// Send a message to the room
router.post('/api/chat/send', async (req, res) => {
  const { message } = req.body
  const name = req.userName || req.body.name
  if (!message) return res.status(400).json({ error: 'message required' })
  if (!name) return res.status(400).json({ error: 'name required' })

  const { room } = req.app.locals

  // Respond immediately — events go to the SSE stream
  res.json({ status: 'sent' })

  // Agents inject messages without triggering the room's agent
  if (req.isAgent && req.body.backchannel) {
    room.addBackchannelMessage(name, message)
  } else if (req.isAgent) {
    room.addAgentMessage(name, message)
  } else {
    room.sendMessage(name, message).catch(err => {
      console.error('sendMessage error:', err.message)
    })
  }
})

// Relay streaming events from visiting agents
router.post('/api/chat/event', (req, res) => {
  if (!req.isAgent) return res.status(403).json({ error: 'agent auth required' })

  const { name, event } = req.body
  if (!name || !event || !event.type) {
    return res.status(400).json({ error: 'name and event with type required' })
  }

  const { room } = req.app.locals
  room.relayAgentEvent(name, event)
  res.json({ status: 'relayed' })
})

export default router
