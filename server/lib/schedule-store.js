import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseCron, nextMatch, nextTimer } from './wakeup.js'

const SCHEDULES_FILE = 'schedules.json'
const MAX_SCHEDULES = 50
const NAME_MAX = 80
const PROMPT_MAX = 4000

// Short id generator — 8 hex chars, same pattern as makeTaskId in
// task-manager.js / shortMsgId in tools.js.
function makeScheduleId() {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

/**
 * Runtime schedule store: agent- or user-created scheduled tasks, distinct
 * from the config-owned `wakeups:` block in persona.yaml (see wakeup.js —
 * that stays declarative/persona-authored; this is the mutable store behind
 * a "remind me" / "run this every day at noon" style tool). Each schedule
 * fires once at an absolute `at` timestamp, or repeatedly on a 5-field cron
 * expression (or once on a cron expression, if `once` is set explicitly).
 *
 * Records are the source of truth on disk (`${runtimeDir}/schedules.json`,
 * the whole set written as one JSON array via atomic tmp+rename so a reader
 * never observes a half-written file; a corrupt file is treated as empty,
 * with a warning, rather than crashing the store).
 *
 * Timer arming reuses wakeup.js's overflow-safe nextTimer/MAX_TIMEOUT
 * stepping directly (imported, not reimplemented) — the same guard
 * WakeupScheduler._arm() uses so a schedule more than ~24.8 days out
 * re-arms in clamped chunks instead of handing setTimeout a delay it will
 * fire (almost) immediately with a TimeoutOverflowWarning.
 */
export function createScheduleStore({ runtimeDir, onFire = null, now = () => Date.now() } = {}) {
  const file = join(runtimeDir, SCHEDULES_FILE)

  const records = new Map() // id -> schedule record (source of truth once loaded)
  const timers = new Map()  // id -> live setTimeout handle
  let loadPromise = null

  // Lazy, memoized load — every public async method awaits this first, so
  // whichever call (create/list/remove/start) happens to run first pays the
  // disk read and every later call (even ones that fire before the first
  // await resolves, e.g. harness.js calls schedules.start() without
  // awaiting it) shares the same in-flight promise instead of racing it.
  function ensureLoaded() {
    if (!loadPromise) loadPromise = load()
    return loadPromise
  }

  async function load() {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[schedule-store] failed to read ${file}, starting empty: ${err.message}`)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('expected a JSON array')
      for (const record of parsed) {
        if (record && typeof record.id === 'string') records.set(record.id, record)
      }
    } catch (err) {
      console.warn(`[schedule-store] corrupt ${file}, starting empty: ${err.message}`)
    }
  }

  // Atomic tmp+rename write so a reader never observes a half-written file —
  // same pattern as task-manager.js's persist().
  async function persist() {
    await mkdir(runtimeDir, { recursive: true })
    const tmpPath = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await writeFile(tmpPath, JSON.stringify([...records.values()], null, 2))
    await rename(tmpPath, file)
  }

  function disarm(id) {
    const handle = timers.get(id)
    if (handle) {
      clearTimeout(handle)
      timers.delete(id)
    }
  }

  // Absolute next-fire time (ms) for a record, or null if it has neither a
  // valid cron nor an `at` (defensive — create() never persists such a
  // record, so this should only trip on hand-edited/corrupt state).
  function targetMs(record) {
    if (record.at) return new Date(record.at).getTime()
    if (record.cron) {
      const schedule = parseCron(record.cron)
      if (!schedule) return null
      // nextMatch throws when a syntactically-valid cron has no occurrence
      // within its 366-day window (Feb 30, a leap-day far from a leap year).
      // Degrade to null so one bad (typically legacy/hand-edited) record can't
      // break arm()/start() for the whole store; create() rejects such crons.
      try {
        return nextMatch(schedule, new Date(now())).getTime()
      } catch (err) {
        console.warn(`[schedule-store] no upcoming fire for ${record.id} (${record.name}): ${err.message}`)
        return null
      }
    }
    return null
  }

  // Arm (or re-arm) the timer for `id` toward absolute `target`, stepping in
  // MAX_TIMEOUT-clamped chunks exactly like WakeupScheduler._arm() — reused
  // here via wakeup.js's nextTimer export rather than reimplemented.
  function armToward(id, target) {
    const { delay, fire } = nextTimer(target, now())
    const handle = setTimeout(() => {
      timers.delete(id)
      if (!records.has(id)) return // removed while the timer was pending
      if (!fire) {
        armToward(id, target) // far-future chunk elapsed — re-arm toward the same target
        return
      }
      // fireNow re-arms the next occurrence, which can throw (a recurring
      // cron whose next match falls outside the search window). Swallow it —
      // an unhandled rejection here would crash the process.
      fireNow(id).catch(err => console.error(`[schedule-store] fire failed for ${id}: ${err.message}`))
    }, delay)
    timers.set(id, handle)
  }

  function arm(id) {
    disarm(id)
    const record = records.get(id)
    if (!record) return
    const target = targetMs(record)
    if (target == null) return
    armToward(id, target)
  }

  // Fire path shared by a real timer callback and the _fire() test hook:
  // call onFire, then either auto-remove (once) or stamp lastFired and
  // re-arm the next occurrence.
  async function fireNow(id) {
    const record = records.get(id)
    if (!record) return

    if (typeof onFire === 'function') {
      try {
        await onFire({ schedule: { ...record } })
      } catch (err) {
        console.error(`[schedule-store] onFire handler threw for ${id} (${record.name}):`, err.message)
      }
    }

    // Re-fetch — the onFire await may have crossed a concurrent remove().
    const current = records.get(id)
    if (!current) return

    if (current.once) {
      records.delete(id)
      disarm(id)
    } else {
      current.lastFired = new Date(now()).toISOString()
      arm(id)
    }
    await persist()
  }

  function computeNext(record, nowMs) {
    if (record.at) return new Date(record.at).toISOString()
    if (record.cron) {
      const schedule = parseCron(record.cron)
      if (!schedule) return null
      // See targetMs: a valid cron may still have no occurrence within the
      // search window. Degrade to null so list() never throws on one bad
      // record (and so create()'s pre-persist validation can detect it).
      try {
        return nextMatch(schedule, new Date(nowMs)).toISOString()
      } catch (err) {
        console.warn(`[schedule-store] no upcoming fire for ${record.id} (${record.name}): ${err.message}`)
        return null
      }
    }
    return null
  }

  async function create({ name, cron = null, at = null, prompt, once = false, createdBy = null } = {}) {
    await ensureLoaded()

    if (records.size >= MAX_SCHEDULES) {
      throw new Error('schedule limit reached')
    }
    if (typeof name !== 'string' || name.length < 1 || name.length > NAME_MAX) {
      throw new Error(`invalid schedule: name must be 1-${NAME_MAX} characters`)
    }
    if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > PROMPT_MAX) {
      throw new Error(`invalid schedule: prompt must be 1-${PROMPT_MAX} characters`)
    }

    const hasCron = cron !== null && cron !== undefined
    const hasAt = at !== null && at !== undefined
    if (hasCron === hasAt) {
      throw new Error('invalid schedule: exactly one of cron or at must be set')
    }

    if (hasCron) {
      if (typeof cron !== 'string' || !parseCron(cron)) {
        throw new Error('invalid schedule: invalid cron expression')
      }
    }

    let atIso = null
    let isOnce = Boolean(once)
    if (hasAt) {
      const atDate = at instanceof Date ? at : new Date(at)
      if (Number.isNaN(atDate.getTime())) {
        throw new Error('invalid schedule: invalid at timestamp')
      }
      if (atDate.getTime() <= now()) {
        throw new Error('invalid schedule: at is in the past')
      }
      atIso = atDate.toISOString()
      isOnce = true // at is always one-shot, regardless of the caller-supplied `once`
    }

    const record = {
      id: makeScheduleId(),
      name,
      cron: hasCron ? cron : null,
      at: atIso,
      prompt,
      once: isOnce,
      created: new Date(now()).toISOString(),
      createdBy: typeof createdBy === 'string' ? createdBy : null,
      lastFired: null,
    }

    // Validate the schedule can actually resolve a next occurrence BEFORE we
    // persist anything. A syntactically-valid cron may still have no match
    // within nextMatch's 366-day window (Feb 30 never exists; a leap-day far
    // from a leap year is >366d out). computeNext degrades such a cron to null
    // instead of throwing; either way we must reject and write NOTHING —
    // persisting a poison record would brick list()/start() every turn.
    if (computeNext(record, now()) == null) {
      throw new Error('invalid schedule: cron has no upcoming occurrence within the search window')
    }

    records.set(record.id, record)
    await persist()
    arm(record.id)

    return { ...record }
  }

  async function list() {
    await ensureLoaded()
    const nowMs = now()

    // NOTE: a past-due one-shot `at` schedule that has not yet fired is
    // deliberately NOT swept here. It is retained so start()/arm() can still
    // fire it exactly once (armToward gives a past target a zero delay);
    // sweeping it in list() would silently drop it unfired if list() ran
    // before start() after a restart. Fired one-shots remove themselves in
    // fireNow(), so a persisted `at` record is by definition still pending.

    const projections = [...records.values()].map(record => ({
      ...record,
      next: computeNext(record, nowMs),
    }))

    projections.sort((a, b) => {
      const aNext = a.next ? new Date(a.next).getTime() : Infinity
      const bNext = b.next ? new Date(b.next).getTime() : Infinity
      return aNext - bNext
    })

    return projections
  }

  async function remove(id) {
    await ensureLoaded()
    if (!records.has(id)) return false
    records.delete(id)
    disarm(id)
    await persist()
    return true
  }

  async function start() {
    await ensureLoaded()
    for (const id of records.keys()) arm(id)
  }

  function stop() {
    for (const id of [...timers.keys()]) disarm(id)
  }

  // Test-only hook: run the same onFire + once/re-arm bookkeeping a real
  // timer callback would, immediately, bypassing the real delay. Lets tests
  // assert recurring-schedule re-arm behavior (lastFired stamped, record
  // retained) without waiting on a live cron match in real time.
  async function _fire(id) {
    if (!records.has(id)) return false
    disarm(id)
    await fireNow(id)
    return true
  }

  return { create, list, remove, start, stop, _fire }
}
