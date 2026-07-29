import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile, rename, mkdir, readdir, appendFile, unlink } from 'node:fs/promises'
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
const CHILD_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

/** Environment for untrusted shell children. Never inherit the server env. */
export function minimalChildEnv(cwd) {
  return {
    HOME: cwd,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: CHILD_PATH,
    TMPDIR: '/tmp',
  }
}

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
export function createTaskManager({
  runtimeDir,
  cwd = process.cwd(),
  maxConcurrent = 5,
  defaultTimeoutMs = 30 * 60 * 1000,
  onEvent = null,
  stopKillGraceMs = STOP_KILL_GRACE_MS,
  timeoutKillGraceMs = TIMEOUT_KILL_GRACE_MS,
  shutdownTimeoutMs = 15_000,
  redact = text => String(text ?? ''),
  createLogStream = null,
  taskRetentionMs = 7 * 24 * 60 * 60 * 1000,
  maxTaskRecords = 200,
}) {
  const tasksDir = join(runtimeDir, 'tasks')
  const live = new Map() // id -> live entry (shell: {kind,record,child,...}; job: {kind,record})
  let occupied = 0
  let stopping = false

  const recordPath = (id) => join(tasksDir, `${id}.json`)
  const logPath = (id) => join(tasksDir, `${id}.log`)
  const pidPath = (id) => join(tasksDir, `${id}.pid`)
  const makeLogStream = createLogStream || ((id) => createWriteStream(logPath(id), { flags: 'a' }))

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
    return occupied
  }

  function reserveSlot() {
    if (stopping) throw new Error('task manager is stopping')
    if (occupied >= maxConcurrent) {
      throw new Error(`task limit reached (${maxConcurrent} running)`)
    }
    occupied++
  }

  function releaseSlot(entry = null) {
    if (entry?.slotReleased) return
    if (entry) entry.slotReleased = true
    occupied = Math.max(0, occupied - 1)
  }

  function signalProcessTree(entry, signal) {
    if (entry.processGroup && entry.child.pid) {
      try {
        process.kill(-entry.child.pid, signal)
        return
      } catch {
        // The group may already be gone; fall back to the direct child.
      }
    }
    try { entry.child.kill(signal) } catch { /* already gone */ }
  }

  // SIGTERM now, SIGKILL after `graceMs` if the process is still alive.
  // entry.killGraceHandle is unref'd so a straggler timer never keeps the
  // process alive on its own.
  function sendSignalWithGrace(entry, signal, graceMs) {
    signalProcessTree(entry, signal)
    entry.killGraceHandle = setTimeout(() => {
      signalProcessTree(entry, 'SIGKILL')
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
    // Always group-kill on finalize so a background daemon the shell spawned
    // (e.g. `some-daemon & exit 0`) can't outlive the task past all caps. A
    // setsid double-detach still escapes this without cgroups — a real limit of
    // the "caps" guarantee for shell-enabled personas.
    signalProcessTree(entry, 'SIGKILL')
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
    releaseSlot(entry)
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
    reserveSlot()

    const id = makeTaskId()
    const effectiveTimeout = (timeoutMs != null && timeoutMs > 0) ? timeoutMs : defaultTimeoutMs
    const record = {
      id,
      name: name ? redact(String(name)).slice(0, 80) : 'shell task',
      kind: 'shell',
      command: null,
      status: 'running',
      started: new Date().toISOString(),
      finished: null,
      exitCode: null,
      timeoutMs: effectiveTimeout,
      note: null,
    }
    try {
      await persist(record)
    } catch (err) {
      releaseSlot()
      throw err
    }

    const logStream = makeLogStream(id)
    let bytesWritten = 0
    let capped = false
    // A disk-full / EIO on the log stream must not surface as an unhandled
    // 'error' that crashes the whole server — stop capturing, let the task
    // finalize on the child's close event as usual.
    logStream.on('error', (err) => {
      capped = true
      console.error(`[task-manager] log stream error for ${id}: ${err.message}`)
    })
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

    let child
    try {
      child = spawn('bash', ['--noprofile', '--norc', '-c', command], {
        cwd,
        env: minimalChildEnv(cwd),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      logStream.destroy()
      releaseSlot()
      throw err
    }

    const entry = {
      kind: 'shell',
      record,
      child,
      logStream,
      reason: null, // null | 'timeout' | 'stopped' — set before killing, read in finalizeShell
      timeoutHandle: null,
      killGraceHandle: null,
      resolveClosed: null,
      processGroup: process.platform !== 'win32',
      slotReleased: false,
    }
    entry.closed = new Promise((resolve) => { entry.resolveClosed = resolve })
    live.set(id, entry)

    // Sidecar so a restart can find and SIGKILL a detached process group left
    // behind by a crash — the record alone can't be trusted to hold a live pid.
    const pgid = entry.processGroup ? child.pid : null
    record.pid = child.pid
    record.pgid = pgid
    writeFile(pidPath(id), JSON.stringify({ pid: child.pid, pgid, started: record.started })).catch(() => {})

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
        sendSignalWithGrace(entry, 'SIGTERM', timeoutKillGraceMs)
      }, effectiveTimeout)
      entry.timeoutHandle.unref?.()
    }

    return record
  }

  async function appendJobOutput(id, text) {
    await ensureTasksDir()
    await appendFile(logPath(id), capUtf8(redact(text), JOB_OUTPUT_CAP_BYTES))
  }

  // run()'s settlement funnels through here. If stop() already removed the
  // live entry, `entry` is undefined and the result is discarded — matches
  // "jobs can't be force-killed ... the in-flight promise result is
  // discarded when it settles".
  async function finalizeJob(id, outcome, value) {
    const entry = live.get(id)
    if (!entry || entry.finalizing) return
    if (entry.terminalized) {
      live.delete(id)
      releaseSlot(entry)
      entry.resolveClosed?.(entry.stopRecord)
      return
    }
    // Claim settlement synchronously. stop() can still find the entry while
    // result I/O is pending, but it must await `closed` rather than changing
    // the terminal state underneath this finalizer.
    entry.finalizing = true

    const record = { ...entry.record, finished: new Date().toISOString(), exitCode: null }
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle)

    try {
      if (outcome === 'resolved') {
        record.status = 'done'
        await appendJobOutput(id, stringifyResult(value))
      } else {
        record.status = 'failed'
        const message = value instanceof Error ? value.message : String(value)
        await appendJobOutput(id, `Error: ${message}`)
      }
      await persist(record)
    } finally {
      live.delete(id)
      releaseSlot(entry)
      entry.resolveClosed?.(record)
      emit(record.status === 'done' ? 'task_done' : 'task_failed', record)
    }
  }

  async function startJob({ name, run, timeoutMs } = {}) {
    if (typeof run !== 'function') {
      throw new Error('startJob requires a run function')
    }
    reserveSlot()

    const id = makeTaskId()
    const effectiveTimeout = (timeoutMs != null && timeoutMs > 0) ? timeoutMs : defaultTimeoutMs
    const record = {
      id,
      name: name ? redact(String(name)).slice(0, 80) : 'job',
      kind: 'job',
      command: null,
      status: 'running',
      started: new Date().toISOString(),
      finished: null,
      exitCode: null,
      timeoutMs: effectiveTimeout,
      note: null,
    }
    try {
      await persist(record)
    } catch (err) {
      releaseSlot()
      throw err
    }

    const controller = new AbortController()
    const entry = {
      kind: 'job',
      record,
      controller,
      reason: null,
      timeoutHandle: null,
      resolveClosed: null,
      finalizing: false,
      terminalized: false,
      stopRecord: null,
      slotReleased: false,
    }
    entry.closed = new Promise(resolve => { entry.resolveClosed = resolve })
    live.set(id, entry)

    if (effectiveTimeout > 0 && Number.isFinite(effectiveTimeout)) {
      entry.timeoutHandle = setTimeout(() => {
        stopJob(id, 'timeout').catch(err => console.error('[task-manager] job timeout error:', err.message))
      }, effectiveTimeout)
      entry.timeoutHandle.unref?.()
    }

    Promise.resolve().then(() => run({ signal: controller.signal })).then(
      (result) => finalizeJob(id, 'resolved', result),
      (err) => finalizeJob(id, 'rejected', err)
    ).catch((e) => console.error('[task-manager] job finalize error:', e.message))

    return record
  }

  // Delete terminal (never running/live) task records that are older than the
  // retention window, then cap the number retained — unbounded per-task files
  // (each up to ~1MB of log) would otherwise grow without limit. Mutates
  // `records` in place to drop the pruned entries.
  async function pruneRecords(records) {
    const nowMs = Date.now()
    const ageOf = (r) => new Date(r.finished || r.started).getTime()
    const terminal = records.filter(r => r.status !== 'running' && !live.has(r.id))
    const toDelete = new Set()
    if (taskRetentionMs != null) {
      for (const r of terminal) {
        const ts = ageOf(r)
        if (Number.isFinite(ts) && nowMs - ts > taskRetentionMs) toDelete.add(r.id)
      }
    }
    if (maxTaskRecords != null) {
      const survivors = terminal
        .filter(r => !toDelete.has(r.id))
        .sort((a, b) => ageOf(b) - ageOf(a))
      for (const r of survivors.slice(maxTaskRecords)) toDelete.add(r.id)
    }
    if (!toDelete.size) return
    for (const id of toDelete) {
      await unlink(recordPath(id)).catch(() => {})
      await unlink(logPath(id)).catch(() => {})
      await unlink(pidPath(id)).catch(() => {})
    }
    for (let i = records.length - 1; i >= 0; i--) {
      if (toDelete.has(records[i].id)) records.splice(i, 1)
    }
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
    await pruneRecords(records)
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
      return stopJob(id, 'stopped')
    }

    if (entry.reason) return entry.closed
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle)
    entry.reason = 'stopped'
    sendSignalWithGrace(entry, 'SIGTERM', stopKillGraceMs)
    return entry.closed
  }

  async function stopJob(id, reason) {
    const entry = live.get(id)
    if (!entry || entry.kind !== 'job') return get(id)
    if (entry.finalizing) return entry.closed
    if (entry.terminalized) return entry.stopRecord
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle)
    entry.reason = reason
    entry.terminalized = true
    entry.controller.abort(new Error(reason === 'timeout' ? 'task timed out' : 'task stopped'))
    const record = {
      ...entry.record,
      status: reason === 'timeout' ? 'failed' : 'stopped',
      note: reason === 'timeout' ? 'timeout' : entry.record.note,
      finished: new Date().toISOString(),
    }
    entry.stopRecord = record
    await persist(record)
    emit(reason === 'timeout' ? 'task_failed' : 'task_stopped', record)
    return record
  }

  async function stopAll() {
    stopping = true
    const entries = [...live.values()]
    const pending = [...live.keys()].map(id => stop(id))
    if (pending.length === 0) return 0
    let timer
    await Promise.race([
      Promise.allSettled([
        ...pending,
        ...entries.map(entry => entry.closed),
      ]),
      new Promise(resolve => {
        timer = setTimeout(resolve, shutdownTimeoutMs)
        timer.unref?.()
      }),
    ])
    if (timer) clearTimeout(timer)
    for (const entry of live.values()) {
      if (entry.kind === 'shell') signalProcessTree(entry, 'SIGKILL')
      else entry.controller.abort(new Error('task manager shutdown'))
    }
    return pending.length
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
        // Kill the detached process group the previous run left behind. The
        // sidecar's started must match the record so a recycled pid isn't hit.
        try {
          const sidecar = JSON.parse(await readFile(pidPath(record.id), 'utf8'))
          if (sidecar?.pgid && sidecar.started === record.started) {
            try { process.kill(-sidecar.pgid, 'SIGKILL') } catch { /* ESRCH: group already gone */ }
          }
        } catch { /* no sidecar — nothing to signal */ }
        record.status = 'failed'
        record.note = 'orphaned by restart'
        record.finished = new Date().toISOString()
        await persist(record)
        count++
      }
    }
    return count
  }

  return { startShell, startJob, list, get, tail, stop, stopAll, running, recoverOrphans }
}
