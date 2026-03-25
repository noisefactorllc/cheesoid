import express from 'express'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
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

// Serve index.html with persona theme injected
app.get('/', async (req, res) => {
  const theme = app.locals.persona.config.theme || 'terminal'
  const dataTheme = app.locals.persona.config.data_theme || theme
  const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf8')
  res.type('html').send(
    html.replace('{{THEME}}', theme).replace('{{DATA_THEME}}', dataTheme)
  )
})

app.use(express.static(join(__dirname, 'public'), { index: false }))

// Load persona
const personaName = process.env.PERSONA || 'example'
const personaDir = join(__dirname, '..', 'personas', personaName)
const persona = await loadPersona(personaDir)
console.log(`Loaded persona: ${persona.config.display_name} (${persona.config.name})`)

const providerType = persona.config.provider || 'anthropic'
if (providerType === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY not set')
  process.exit(1)
}

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
