import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile, rename, mkdir, readdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

const ID_PATTERN = /^[a-f0-9]{8}$/

// Shell stdout+stderr are merged into one log file; stop accepting bytes past
// this cap so a runaway/chatty command can't grow the log file without bound.
const LOG_CAP_BYTES = 1024 * 1024
// startJob's run() return value is stringified and appended to the log —
// capped separately (and much smaller) since job output is normally a short
// summary, not a stream of process output.
const JOB_OUTPUT_CAP_BYTES = 64 * 1024
// Grace period between SIGTERM and SIGKILL when a task's timeout fires.
const TIMEOUT_KILL_GRACE_MS = 10_000
// Grace period between SIGTERM and SIGKILL when stop() is called explicitly.
const STOP_KILL_GRACE_MS = 5_000

// Short id generator — 8 hex chars, same pattern as shortMsgId in tools.js.
function makeTaskId() {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

// Cap a string to `capBytes` of UTF-8, truncating silently (a boundary split
// mid-character yields a replacement char at the cut point, which is fine in
// a truncation context — same tradeoff memory.js's capUtf8Bytes makes).
function capUtf8(text, capBytes) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= capBytes) return text
  return buf.subarray(0, capBytes).toString('utf8')
}

// startJob's run() may resolve with anything — normalize to a string for the log.
function stringifyResult(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Background worker / task manager: shell commands and framework-supplied
 * async jobs tracked as tasks with persisted records, logs, status, and stop.
 *
 * Records are the source of truth on disk (`${runtimeDir}/tasks/${id}.json`);
 * the in-memory `live` map only tracks currently-running tasks (child
 * processes for shell tasks, bookkeeping for jobs) so list/get/tail can be
 * served straight from disk without asking a live task for its own state.
 */
export function createTaskManager({ runtimeDir, env = () => ({}), cwd = process.cwd(), maxConcurrent = 5, defaultTimeoutMs = 30 * 60 * 1000, onEvent = null }) {
  const tasksDir = join(runtimeDir, 'tasks')
  const live = new Map() // id -> live entry (shell: {kind,record,child,...}; job: {kind,record})

  const recordPath = (id) => join(tasksDir, `${id}.json`)
  const logPath = (id) => join(tasksDir, `${id}.log`)

  async function ensureTasksDir() {
    await mkdir(tasksDir, { recursive: true })
  }

  // Atomic tmp+rename write so a reader never observes a half-written record.
  async function persist(record) {
    await ensureTasksDir()
    const finalPath = recordPath(record.id)
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await writeFile(tmpPath, JSON.stringify(record, null, 2))
    await rename(tmpPath, finalPath)
  }

  function emit(type, record) {
    if (typeof onEvent !== 'function') return
    try {
      onEvent({ type, task: record })
    } catch (err) {
      console.error('[task-manager] onEvent handler threw:', err.message)
    }
  }

  function running() {
    return live.size
  }

  // SIGTERM now, SIGKILL after `graceMs` if the process is still alive.
  // entry.killGraceHandle is unref'd so a straggler timer never keeps the
  // process alive on its own.
  function sendSignalWithGrace(entry, signal, graceMs) {
    try { entry.child.kill(signal) } catch { /* already gone */ }
    entry.killGraceHandle = setTimeout(() => {
      try { entry.child.kill('SIGKILL') } catch { /* already gone */ }
    }, graceMs)
    entry.killGraceHandle.unref?.()
  }

  // Natural exit, timeout kill, and stop() all funnel through here via the
  // child's 'close' event (not 'exit' — 'close' waits for stdio streams to
  // finish flushing, so the log is complete before we finalize the record).
  async function finalizeShell(id, code) {
    const entry = live.get(id)
    if (!entry) return // already finalized (e.g. duplicate error+close)
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle)
    if (entry.killGraceHandle) clearTimeout(entry.killGraceHandle)
    entry.logStream.end()

    const record = { ...entry.record, finished: new Date().toISOString(), exitCode: code }

    let eventType
    if (entry.reason === 'timeout') {
      record.status = 'failed'
      record.note = 'timeout'
      eventType = 'task_failed'
    } else if (entry.reason === 'stopped') {
      record.status = 'stopped'
      eventType = 'task_stopped'
    } else {
      record.status = code === 0 ? 'done' : 'failed'
      eventType = code === 0 ? 'task_done' : 'task_failed'
    }

    live.delete(id)
    try {
      await persist(record)
    } finally {
      // Always resolve stop()'s awaiter and fire onEvent even if persist
      // failed — a disk error here shouldn't hang a caller awaiting stop().
      entry.resolveClosed?.(record)
      emit(eventType, record)
    }
  }

  async function startShell({ name, command, timeoutMs } = {}) {
    if (!command || typeof command !== 'string') {
      throw new Error('startShell requires a command string')
    }
    if (running() >= maxConcurrent) {
      throw new Error(`task limit reached (${maxConcurrent} running)`)
    }

    const id = makeTaskId()
    const effectiveTimeout = timeoutMs != null ? timeoutMs : defaultTimeoutMs
    const record = {
      id,
      name: name ? String(name).slice(0, 80) : command.slice(0, 40),
      kind: 'shell',
      command,
      status: 'running',
      started: new Date().toISOString(),
      finished: null,
      exitCode: null,
      timeoutMs: effectiveTimeout,
      note: null,
    }
    await persist(record)

    const logStream = createWriteStream(logPath(id), { flags: 'a' })
    let bytesWritten = 0
    let capped = false
    const onData = (chunk) => {
      if (capped) return
      const remaining = LOG_CAP_BYTES - bytesWritten
      if (chunk.length <= remaining) {
        logStream.write(chunk)
        bytesWritten += chunk.length
      } else {
        if (remaining > 0) logStream.write(chunk.subarray(0, remaining))
        bytesWritten += remaining
        capped = true
        logStream.write('\n[log truncated: output exceeded 1MB cap]\n')
      }
    }

    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: { ...process.env, ...env() },
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const entry = {
      kind: 'shell',
      record,
      child,
      logStream,
      reason: null, // null | 'timeout' | 'stopped' — set before killing, read in finalizeShell
      timeoutHandle: null,
      killGraceHandle: null,
      resolveClosed: null,
    }
    entry.closed = new Promise((resolve) => { entry.resolveClosed = resolve })
    live.set(id, entry)

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    // Spawn-level failure (e.g. bash missing). finalizeShell is idempotent —
    // if 'close' also fires, the second call is a no-op.
    child.on('error', (err) => {
      onData(Buffer.from(`\n[task-manager] spawn error: ${err.message}\n`))
      finalizeShell(id, null).catch((e) => console.error('[task-manager] finalize error:', e.message))
    })

    child.on('close', (code) => {
      finalizeShell(id, code).catch((e) => console.error('[task-manager] finalize error:', e.message))
    })

    if (effectiveTimeout > 0 && Number.isFinite(effectiveTimeout)) {
      entry.timeoutHandle = setTimeout(() => {
        entry.reason = 'timeout'
        sendSignalWithGrace(entry, 'SIGTERM', TIMEOUT_KILL_GRACE_MS)
      }, effectiveTimeout)
      entry.timeoutHandle.unref?.()
    }

    return record
  }

  async function appendJobOutput(id, text) {
    await ensureTasksDir()
    await appendFile(logPath(id), capUtf8(text, JOB_OUTPUT_CAP_BYTES))
  }

  // run()'s settlement funnels through here. If stop() already removed the
  // live entry, `entry` is undefined and the result is discarded — matches
  // "jobs can't be force-killed ... the in-flight promise result is
  // discarded when it settles".
  async function finalizeJob(id, outcome, value) {
    const entry = live.get(id)
    if (!entry) return

    const record = { ...entry.record, finished: new Date().toISOString(), exitCode: null }

    if (outcome === 'resolved') {
      record.status = 'done'
      await appendJobOutput(id, stringifyResult(value))
    } else {
      record.status = 'failed'
      const message = value instanceof Error ? value.message : String(value)
      await appendJobOutput(id, `Error: ${message}`)
    }

    live.delete(id)
    await persist(record)
    emit(record.status === 'done' ? 'task_done' : 'task_failed', record)
  }

  async function startJob({ name, run } = {}) {
    if (typeof run !== 'function') {
      throw new Error('startJob requires a run function')
    }
    if (running() >= maxConcurrent) {
      throw new Error(`task limit reached (${maxConcurrent} running)`)
    }

    const id = makeTaskId()
    const record = {
      id,
      name: name ? String(name).slice(0, 80) : 'job',
      kind: 'job',
      command: null,
      status: 'running',
      started: new Date().toISOString(),
      finished: null,
      exitCode: null,
      timeoutMs: null,
      note: null,
    }
    await persist(record)

    live.set(id, { kind: 'job', record })

    Promise.resolve().then(run).then(
      (result) => finalizeJob(id, 'resolved', result),
      (err) => finalizeJob(id, 'rejected', err)
    ).catch((e) => console.error('[task-manager] job finalize error:', e.message))

    return record
  }

  async function list({ limit = 20 } = {}) {
    let entries
    try {
      entries = await readdir(tasksDir)
    } catch {
      return []
    }
    const records = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        records.push(JSON.parse(await readFile(join(tasksDir, entry), 'utf8')))
      } catch {
        // skip unreadable/corrupt record
      }
    }
    records.sort((a, b) => {
      const aRunning = a.status === 'running' ? 0 : 1
      const bRunning = b.status === 'running' ? 0 : 1
      if (aRunning !== bRunning) return aRunning - bRunning
      return new Date(b.started).getTime() - new Date(a.started).getTime()
    })
    return records.slice(0, limit)
  }

  async function get(id) {
    if (!ID_PATTERN.test(id)) return null
    try {
      return JSON.parse(await readFile(recordPath(id), 'utf8'))
    } catch {
      return null
    }
  }

  async function tail(id, { bytes = 4096 } = {}) {
    if (!ID_PATTERN.test(id)) return ''
    try {
      const buf = await readFile(logPath(id))
      if (buf.length <= bytes) return buf.toString('utf8')
      return buf.subarray(buf.length - bytes).toString('utf8')
    } catch {
      return ''
    }
  }

  async function stop(id) {
    if (!ID_PATTERN.test(id)) return null
    const entry = live.get(id)
    if (!entry) return get(id) // not running — already finished, or unknown

    if (entry.kind === 'job') {
      const record = { ...entry.record, status: 'stopped', finished: new Date().toISOString() }
      live.delete(id)
      await persist(record)
      emit('task_stopped', record)
      return record
    }

    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle)
    entry.reason = 'stopped'
    sendSignalWithGrace(entry, 'SIGTERM', STOP_KILL_GRACE_MS)
    return entry.closed
  }

  async function recoverOrphans() {
    let entries
    try {
      entries = await readdir(tasksDir)
    } catch {
      return 0
    }
    let count = 0
    for (const entryName of entries) {
      if (!entryName.endsWith('.json')) continue
      const filePath = join(tasksDir, entryName)
      let record
      try {
        record = JSON.parse(await readFile(filePath, 'utf8'))
      } catch {
        continue
      }
      if (record.status === 'running') {
        record.status = 'failed'
        record.note = 'orphaned by restart'
        record.finished = new Date().toISOString()
        await persist(record)
        count++
      }
    }
    return count
  }

  return { startShell, startJob, list, get, tail, stop, running, recoverOrphans }
}
