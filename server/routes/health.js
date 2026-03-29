import { Router } from 'express'
import { State } from '../lib/state.js'

const router = Router()

router.get('/up', (req, res) => {
  const checks = req.app.locals.startupCheckResults
  if (checks && !checks.ok) {
    return res.status(503).json({
      status: 'degraded',
      service: 'cheesoid',
      version: process.env.npm_package_version || '0.1.0',
      missing: checks.missing
    })
  }
  res.json({
    status: 'ok',
    service: 'cheesoid',
    version: process.env.npm_package_version || '0.1.0'
  })
})

router.get('/api/health', (req, res) => {
  res.json({ status: 'ok', persona: req.app.locals.persona?.config?.display_name || 'unknown' })
})

router.get('/api/presence', async (req, res) => {
  const { persona, rooms } = req.app.locals
  // Backward compat: use rooms manager if available, else legacy room
  const room = req.app.locals.room
  const authProxy = !!persona.config.auth_proxy

  let stateData = {}
  if (room && room.state) {
    stateData = room.state.data
  } else {
    const state = new State(persona.dir)
    await state.load()
    stateData = state.data
  }

  const result = {
    persona: persona.config.display_name,
    state: stateData,
    participants: rooms ? rooms.allParticipants : room.participantList,
    auth_proxy: authProxy,
  }

  // Hub-specific fields
  if (rooms && rooms.isHub) {
    result.hosted_rooms = rooms.roomNames
  }

  if (authProxy) {
    const email = req.headers['x-gs-user-email']
    if (email) result.user = email.split('@')[0]
  }

  res.json(result)
})

export default router
