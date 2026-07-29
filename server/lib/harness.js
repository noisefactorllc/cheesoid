import { join, resolve, sep } from 'node:path'
import { constants, mkdirSync } from 'node:fs'
import { open, readFile, writeFile, realpath } from 'node:fs/promises'
import { createSecretsStore } from './secrets.js'
import { createTaskManager } from './task-manager.js'
import { createScheduleStore } from './schedule-store.js'
import { createWiki } from './wiki.js'
import { createPeerStore } from './peering.js'
import { createMediaStore, MEDIA_MAX_BYTES } from './media.js'
import { createAutonomy } from './autonomy.js'
import { createSubagentRunner } from './subagent.js'
import { createSecretBroker } from './secret-broker.js'
import { TIER_DEFAULTS } from './model-policy.js'
import { RoomClient } from './room-client.js'
import { allowPrivatePeers, resolvePublicTarget } from './network-policy.js'

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

  const shellConfigured = (config.builtin_tools || []).includes('shell')
  harness.secrets = createSecretsStore(runtimeDir, {
    canSet: () => shellConfigured
      ? 'cannot store secrets while shell capability is enabled; remove "shell" from builtin_tools and restart'
      : null,
  })
  harness.secretBroker = createSecretBroker({
    bindings: config.secret_bindings || {},
    resolveSecret: name => harness.secrets.resolveForBroker(name),
  })
  harness.shellPolicy = {
    configured: shellConfigured,
    available: () => shellConfigured && !harness.secrets.hasAny(),
    denialReason: () => harness.secrets.hasAny()
      ? 'shell capability is disabled because stored secrets exist; remove the secrets and restart'
      : 'shell capability is not enabled in builtin_tools',
  }
  harness.autonomy = createAutonomy(config)
  harness.wiki = createWiki(personaDir)
  harness.peers = createPeerStore(runtimeDir)
  harness.media = createMediaStore(runtimeDir)

  harness.tasks = createTaskManager({
    runtimeDir,
    cwd: personaDir,
    redact: text => harness.secrets.redact(text),
    onEvent: (event) => harness._onTaskEvent(event),
  })

  harness.schedules = createScheduleStore({
    runtimeDir,
    onFire: ({ schedule }) => harness._onScheduleFire(schedule),
  })

  harness.subagents = createSubagentRunner({
    config,
    registry,
    redactDeep: value => harness.secrets.redactDeep(value),
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

  harness.revokePeer = async (name, room = harness._room) => {
    const removed = await harness.peers.remove(name)
    if (!removed) return false
    const normalizedName = String(name).toLowerCase()
    for (const [clientName, client] of room?.roomClients || []) {
      if (String(clientName).toLowerCase() !== normalizedName) continue
      client.destroy()
      room.roomClients.delete(clientName)
      break
    }
    return true
  }

  /**
   * Connect to a remote room. This is deliberately a framework method rather
   * than a model tool: only the authenticated human route may change network
   * topology or provide the shared credential.
   */
  harness.joinRemote = async ({ url: inputUrl, secret, name, actor }, room = harness._room) => {
    if (!room) throw new Error('room not ready')
    let url
    try {
      url = new URL(inputUrl)
      if (!/^https?:$/.test(url.protocol)) throw new Error('http(s) only')
    } catch (err) {
      throw new Error(`Invalid url: ${err.message}`)
    }
    const connName = (name || url.hostname.split('.')[0]).slice(0, 40)
    if (!connName) throw new Error('connection name required')
    if (room.roomClients.has(connName)) {
      throw new Error(`Already connected to a room named "${connName}".`)
    }
    const allowPrivate = allowPrivatePeers(config)
    await resolvePublicTarget(url, { allowPrivate })
    const roomConfig = {
      url: inputUrl.replace(/\/$/, ''),
      name: connName,
      domain: url.hostname,
      secret,
      allow_private: allowPrivate,
    }
    const client = new RoomClient(roomConfig, {
      agentName: config.display_name,
      onMessage: event => room._handleRemoteEvent(event, connName),
    })
    room.roomClients.set(connName, client)
    try {
      await harness.peers.addOutbound({
        name: connName,
        url: roomConfig.url,
        addedBy: actor,
      })
      client.connect()
    } catch (err) {
      room.roomClients.delete(connName)
      client.destroy()
      throw err
    }
    return { name: connName, url: roomConfig.url }
  }

  /**
   * Import a file from the shared workspace into the media store so it can
   * be attached to a message. Path rules mirror shared-workspace.js.
   */
  harness.importSharedFile = async (sharedPath) => {
    const base = process.env.SHARED_WORKSPACE_PATH || '/shared'
    const resolved = resolve(base, String(sharedPath).replace(/^\/+/, ''))
    if (resolved !== base && !resolved.startsWith(base + sep)) return null
    try {
      const [realBase, realTarget] = await Promise.all([realpath(base), realpath(resolved)])
      if (realTarget !== realBase && !realTarget.startsWith(realBase + sep)) return null
      const handle = await open(realTarget, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      let buffer
      try {
        const info = await handle.stat()
        if (!info.isFile()) return null
        if (info.size <= 0 || info.size > MEDIA_MAX_BYTES) return null
        buffer = await handle.readFile()
      } finally {
        await handle.close()
      }
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
    await harness.schedules.start()
    await harness.applyModelOverrides()
  }

  let stopPromise = null
  harness.stop = () => {
    if (!stopPromise) {
      stopPromise = (async () => {
        harness.schedules.stop()
        await harness.tasks.stopAll()
      })()
    }
    return stopPromise
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
