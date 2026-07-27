import { join, resolve, sep } from 'node:path'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { createSecretsStore } from './secrets.js'
import { createTaskManager } from './task-manager.js'
import { createScheduleStore } from './schedule-store.js'
import { createWiki } from './wiki.js'
import { createPeerStore } from './peering.js'
import { createMediaStore } from './media.js'
import { createAutonomy } from './autonomy.js'
import { createSubagentRunner } from './subagent.js'
import { TIER_DEFAULTS } from './model-policy.js'

const OVERRIDES_FILE = 'model-overrides.json'

/**
 * The harness composes the next-gen subsystems for one persona: secrets,
 * background tasks, runtime schedules, wiki, ad-hoc peers, media, subagents,
 * and the autonomy gate. One harness per persona process, shared by all
 * rooms (it lives on the shared agent-state object the way memory does).
 *
 * Event flow back into conversation is late-bound: the Room that hosts the
 * agent calls `bindRoom(room)` once, after which task completions and
 * schedule fires arrive as ordinary queued messages.
 */
export function createHarness({ personaDir, config, registry }) {
  const runtimeDir = join(personaDir, 'runtime')
  mkdirSync(runtimeDir, { recursive: true })

  const harness = {
    runtimeDir,
    workDir: personaDir,
    _room: null,
  }

  harness.secrets = createSecretsStore(runtimeDir)
  harness.autonomy = createAutonomy(config)
  harness.wiki = createWiki(personaDir)
  harness.peers = createPeerStore(runtimeDir)
  harness.media = createMediaStore(runtimeDir)

  harness.tasks = createTaskManager({
    runtimeDir,
    env: () => harness.secrets.env(),
    cwd: personaDir,
    onEvent: (event) => harness._onTaskEvent(event),
  })

  harness.schedules = createScheduleStore({
    runtimeDir,
    onFire: ({ schedule }) => harness._onScheduleFire(schedule),
  })

  harness.subagents = createSubagentRunner({
    config,
    registry,
    buildTools: () => harness._subagentTools
      ? harness._subagentTools()
      : { definitions: [], execute: async () => ({ output: 'no tools', is_error: true }) },
  })

  harness._onTaskEvent = (event) => {
    const room = harness._room
    if (!room) return
    const t = event.task
    const verdict = event.type === 'task_done' ? 'finished'
      : event.type === 'task_stopped' ? 'was stopped'
      : 'FAILED'
    harness.tasks.tail(t.id, { bytes: 2048 }).then(rawTail => {
      const tail = harness.secrets.redact(rawTail)
      const summary = tail.trim() ? `\n--- result tail ---\n${tail.trim()}` : ''
      room.sendMessage('task', `[background task] "${t.name}" (${t.id}) ${verdict}${t.exitCode != null ? ` (exit ${t.exitCode})` : ''}.${summary}\n\nReview the result. If it matters to anyone in the room, tell them; if it changes your plans or knowledge, record that. task_status ${t.id} has the full log.`)
        .catch(err => console.log(`[harness] task notification failed: ${err.message}`))
    }).catch(() => {})
  }

  harness._onScheduleFire = (schedule) => {
    const room = harness._room
    if (!room) return
    room.sendMessage('schedule', `[scheduled] ${schedule.name}\n\n${schedule.prompt}`)
      .catch(err => console.log(`[harness] schedule fire failed: ${err.message}`))
  }

  harness.bindRoom = (room) => { harness._room = room }

  /**
   * Import a file from the shared workspace into the media store so it can
   * be attached to a message. Path rules mirror shared-workspace.js.
   */
  harness.importSharedFile = async (sharedPath) => {
    const base = process.env.SHARED_WORKSPACE_PATH || '/shared'
    const resolved = resolve(base, String(sharedPath).replace(/^\/+/, ''))
    if (resolved !== base && !resolved.startsWith(base + sep)) return null
    try {
      const info = await stat(resolved)
      if (!info.isFile()) return null
      const buffer = await readFile(resolved)
      const name = resolved.split(sep).pop()
      const mime = guessMime(name)
      return await harness.media.save({ buffer, mime, name, by: config.display_name })
    } catch {
      return null
    }
  }

  // ---- dynamic model control ----

  harness.modelAllowList = () => {
    const fromPolicy = Array.isArray(config.model_policy?.allow) ? config.model_policy.allow : []
    const fromTiers = ['model', 'attention', 'cognition', 'reasoner', 'reflection', 'subagent']
      .flatMap(t => config[t] || [])
    const fromDefaults = Object.values(TIER_DEFAULTS).flat()
    return [...new Set([...fromPolicy, ...fromTiers, ...fromDefaults])]
  }

  harness.persistModelOverride = async (tierKey, model) => {
    const file = join(runtimeDir, OVERRIDES_FILE)
    let overrides = {}
    try { overrides = JSON.parse(await readFile(file, 'utf8')) } catch { }
    overrides[tierKey] = model
    await writeFile(file, JSON.stringify(overrides, null, 2))
  }

  /** Re-apply persisted set_model pins on boot. Unknown models are dropped. */
  harness.applyModelOverrides = async () => {
    const file = join(runtimeDir, OVERRIDES_FILE)
    let overrides
    try { overrides = JSON.parse(await readFile(file, 'utf8')) } catch { return }
    const allowed = harness.modelAllowList()
    for (const [tierKey, model] of Object.entries(overrides)) {
      if (!config[tierKey] || !allowed.includes(model)) continue
      config[tierKey] = [model, ...config[tierKey].filter(m => m !== model)]
      console.log(`[harness] restored model override: ${tierKey} → ${model}`)
    }
  }

  harness.start = async () => {
    const orphaned = await harness.tasks.recoverOrphans()
    if (orphaned) console.log(`[harness] marked ${orphaned} orphaned task(s) failed after restart`)
    harness.schedules.start()
    await harness.applyModelOverrides()
  }

  harness.stop = () => {
    harness.schedules.stop()
  }

  return harness
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', mp4: 'audio/mp4', wav: 'audio/wav',
    pdf: 'application/pdf', json: 'application/json',
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', html: 'text/html', js: 'text/javascript', yaml: 'text/yaml', yml: 'text/yaml',
  }[ext] || 'text/plain'
}
