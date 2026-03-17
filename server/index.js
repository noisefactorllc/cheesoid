import express from 'express'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPersona } from './lib/persona.js'
import { createAuthMiddleware } from './lib/auth.js'
import { runStartupChecks } from './lib/startup-checks.js'
import { Room } from './lib/chat-session.js'
import chatRouter from './routes/chat.js'
import healthRouter from './routes/health.js'
import webhookRouter from './routes/webhook.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY not set')
  process.exit(1)
}

// Load persona
const personaName = process.env.PERSONA || 'example'
const personaDir = join(__dirname, '..', 'personas', personaName)
const persona = await loadPersona(personaDir)
console.log(`Loaded persona: ${persona.config.display_name} (${persona.config.name})`)

// Single room per persona
app.locals.persona = persona
app.locals.room = new Room(persona)
await app.locals.room.initialize()
app.locals.authMiddleware = createAuthMiddleware(persona.config.agents || null)

const requiredPaths = persona.config.startup_checks?.required_paths || []
app.locals.startupCheckResults = runStartupChecks(requiredPaths)

// Routes
app.use(chatRouter)
app.use(healthRouter)
app.use(webhookRouter)

// Start
const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`Cheesoid running on port ${port}`)
})
