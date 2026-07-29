import express from 'express'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { loadPersona } from './lib/persona.js'
import { createAuthMiddleware } from './lib/auth.js'
import { runStartupChecks } from './lib/startup-checks.js'
import { RoomManager } from './lib/room-manager.js'
import chatRouter from './routes/chat.js'
import healthRouter from './routes/health.js'
import webhookRouter from './routes/webhook.js'
import harnessRouter from './routes/harness.js'
import { setUiSecurityHeaders } from './lib/security-headers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(express.json())

// Load persona
const personaName = process.env.PERSONA || 'example'
const personaDir = join(__dirname, '..', 'personas', personaName)
const persona = await loadPersona(personaDir)
console.log(`Loaded persona: ${persona.config.display_name} (${persona.config.name})`)

// Only trust forwarding headers when the operator explicitly declares the
// authenticated reverse-proxy boundary. Direct deployments must use the
// socket address so X-Forwarded-For cannot bypass per-IP throttles.
app.set('trust proxy', persona.config.auth_proxy === true ? 1 : false)

// Only require ANTHROPIC_API_KEY if anthropic is actually needed: no
// providers block, no non-anthropic provider, and no OpenRouter key (which
// auto-registers a provider and lets the model policy fill every tier).
const needsAnthropic = !persona.config.providers
  && (persona.config.provider || 'anthropic') === 'anthropic'
  && !process.env.OPENROUTER_API_KEY
if (needsAnthropic && !process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY not set (set it, or set OPENROUTER_API_KEY to run on evaluated OpenRouter defaults)')
  process.exit(1)
}

// Serve UI unless headless
if (!persona.config.headless) {
  app.get('/', async (req, res) => {
    const theme = persona.config.theme || 'terminal'
    const dataTheme = persona.config.data_theme || theme
    const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf8')
    setUiSecurityHeaders(res)
    res.type('html').send(
      html.replace('{{THEME}}', theme).replace('{{DATA_THEME}}', dataTheme)
    )
  })
  app.use(express.static(join(__dirname, 'public'), { index: false }))
}

app.locals.persona = persona
app.locals.rooms = new RoomManager(persona)
await app.locals.rooms.initialize()
// Backward compat: legacy code accessing app.locals.room gets the default/first room
Object.defineProperty(app.locals, 'room', {
  get() { return app.locals.rooms.resolve() },
})
// Runtime ad-hoc peers authenticate alongside config-declared agents.
const peerStore = app.locals.rooms.resolve()?.harness?.peers || null
app.locals.authMiddleware = createAuthMiddleware(persona.config.agents || null, peerStore, {
  trustProxyHeaders: persona.config.auth_proxy === true,
})

// Global JSON egress projection: a credential can be dropped after state,
// memory, wiki, peer, schedule, task, or chat data was persisted. Redacting
// at the application boundary covers current and future JSON endpoints.
app.use((req, res, next) => {
  const sendJson = res.json.bind(res)
  res.json = (body) => {
    const secrets = app.locals.rooms.resolve()?.harness?.secrets
    return sendJson(secrets?.redactDeep ? secrets.redactDeep(body) : body)
  }
  next()
})

const requiredPaths = persona.config.startup_checks?.required_paths || []
app.locals.startupCheckResults = runStartupChecks(requiredPaths)

// Routes
app.use(chatRouter)
app.use(healthRouter)
app.use(webhookRouter)
app.use(harnessRouter)

// Start
const port = process.env.PORT || 3000
const server = app.listen(port, () => {
  console.log(`Cheesoid running on port ${port}`)
})

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Cheesoid shutting down (${signal})`)
  await app.locals.rooms.destroy()
  await new Promise(resolve => server.close(resolve))
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`Shutdown failed: ${err.message}`)
        process.exit(1)
      })
  })
}
