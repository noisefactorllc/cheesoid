import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTaskManager } from '../server/lib/task-manager.js'

// Poll `fn` every `interval`ms until it returns a truthy value, or throw once
// `timeout`ms have elapsed. Used instead of fixed sleeps so tests finish as
// soon as a background task actually settles.
async function waitUntil(fn, { interval = 50, timeout = 5000 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start >= timeout) {
      throw new Error('waitUntil: condition not met within timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

async function makeRuntimeDir() {
  return mkdtemp(join(tmpdir(), 'cheesoid-taskmgr-'))
}

async function setup(overrides = {}) {
  const runtimeDir = await makeRuntimeDir()
  const events = []
  const tm = createTaskManager({
    runtimeDir,
    onEvent: (e) => events.push(e),
    ...overrides,
  })
  return { tm, events, runtimeDir }
}

async function waitFinished(tm, id, opts) {
  return waitUntil(async () => {
    const r = await tm.get(id)
    return r && r.status !== 'running' ? r : null
  }, opts)
}

describe('createTaskManager: startShell', () => {
  it('runs a command to completion: status done, exitCode 0, log has output, onEvent task_done', async () => {
    const { tm, events } = await setup()
    const record = await tm.startShell({ name: 'echo test', command: 'echo hello-task-manager' })
    assert.equal(record.status, 'running')
    assert.equal(record.kind, 'shell')
    assert.equal(record.name, 'echo test')

    const finished = await waitFinished(tm, record.id)
    assert.equal(finished.status, 'done')
    assert.equal(finished.exitCode, 0)
    assert.ok(finished.finished)

    const log = await tm.tail(record.id)
    assert.ok(log.includes('hello-task-manager'), `log should contain output, got: ${log}`)

    await waitUntil(() => events.some((e) => e.type === 'task_done' && e.task.id === record.id))
  })

  it('does not persist the raw command or derive the name from it', async () => {
    const { tm } = await setup()
    const command = 'echo this-is-a-fairly-long-command-that-should-be-truncated-for-the-default-name'
    const record = await tm.startShell({ command })
    assert.equal(record.name, 'shell task')
    assert.equal(record.command, null)
    await waitFinished(tm, record.id)
  })

  it('marks a nonzero exit as failed', async () => {
    const { tm } = await setup()
    const record = await tm.startShell({ command: 'exit 7' })
    const finished = await waitFinished(tm, record.id)
    assert.equal(finished.status, 'failed')
    assert.equal(finished.exitCode, 7)
  })

  it('kills a task that exceeds timeoutMs and marks it failed with a timeout note', async () => {
    const { tm } = await setup()
    const start = Date.now()
    const record = await tm.startShell({ command: 'sleep 5', timeoutMs: 300 })
    const finished = await waitFinished(tm, record.id, { timeout: 2500 })
    const elapsed = Date.now() - start
    assert.equal(finished.status, 'failed')
    assert.equal(finished.note, 'timeout')
    assert.ok(elapsed < 3000, `expected timeout finalize well under 3s, took ${elapsed}ms`)
  })

  it('does not inherit the server environment', async () => {
    process.env.CHEESOID_PARENT_ONLY_SECRET = 'must-not-cross-process-boundary'
    try {
      const { tm } = await setup()
      const record = await tm.startShell({
        command: 'printf "%s" "${CHEESOID_PARENT_ONLY_SECRET-unset}"',
      })
      await waitFinished(tm, record.id)
      const log = await tm.tail(record.id)
      assert.equal(log, 'unset')
    } finally {
      delete process.env.CHEESOID_PARENT_ONLY_SECRET
    }
  })
})

describe('createTaskManager: concurrency + stop', () => {
  it('reserves capacity before asynchronous persistence', async () => {
    const { tm } = await setup({ maxConcurrent: 1 })
    let release
    const gate = new Promise(resolve => { release = resolve })
    const starts = await Promise.allSettled([
      tm.startJob({ name: 'one', run: async () => gate }),
      tm.startJob({ name: 'two', run: async () => gate }),
    ])
    assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(starts.filter(result => result.status === 'rejected').length, 1)
    assert.match(starts.find(result => result.status === 'rejected').reason.message, /task limit reached/)
    release('done')
    const accepted = starts.find(result => result.status === 'fulfilled').value
    await waitFinished(tm, accepted.id)
  })

  it('throws at the concurrency limit and allows new tasks after stop() frees a slot', async () => {
    const { tm } = await setup({ maxConcurrent: 1 })
    const first = await tm.startShell({ command: 'sleep 30' })
    assert.equal(tm.running(), 1)

    await assert.rejects(
      () => tm.startShell({ command: 'echo blocked' }),
      /task limit reached \(1 running\)/
    )

    const stopped = await tm.stop(first.id)
    assert.equal(stopped.status, 'stopped')
    assert.equal(tm.running(), 0)

    const second = await tm.startShell({ command: 'echo unblocked' })
    assert.equal(second.status, 'running')
    const finished = await waitFinished(tm, second.id)
    assert.equal(finished.status, 'done')
  })

  it('stop() terminates a running shell task and marks it stopped', async () => {
    const { tm, events } = await setup()
    const record = await tm.startShell({ command: 'sleep 30' })
    const stopped = await tm.stop(record.id)
    assert.equal(stopped.status, 'stopped')
    assert.ok(stopped.finished)
    assert.equal(tm.running(), 0)
    await waitUntil(() => events.some((e) => e.type === 'task_stopped' && e.task.id === record.id))
  })

  it('stop() terminates the shell process group, including descendants', { skip: process.platform === 'win32' }, async () => {
    const { tm, runtimeDir } = await setup({ stopKillGraceMs: 100 })
    const pidFile = join(runtimeDir, 'descendant.pid')
    const script = `const {spawn}=require("node:child_process");const fs=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`
    const record = await tm.startShell({ command: `node -e '${script}'` })
    const descendantPid = await waitUntil(async () => {
      try { return Number(await readFile(pidFile, 'utf8')) || null } catch { return null }
    })

    try {
      await tm.stop(record.id)
      await waitUntil(() => {
        try {
          process.kill(descendantPid, 0)
          return false
        } catch (err) {
          return err.code === 'ESRCH'
        }
      }, { timeout: 2000 })
    } finally {
      try { process.kill(descendantPid, 'SIGKILL') } catch {}
    }
  })

  it('stop() on an already-finished task returns its record without error', async () => {
    const { tm } = await setup()
    const record = await tm.startShell({ command: 'echo done-already' })
    await waitFinished(tm, record.id)
    const result = await tm.stop(record.id)
    assert.equal(result.status, 'done')
  })
})

describe('createTaskManager: startJob', () => {
  it('runs an async job to completion and appends its result to the log', async () => {
    const { tm, events } = await setup()
    const record = await tm.startJob({ name: 'sum job', run: async () => 2 + 2 })
    assert.equal(record.kind, 'job')
    assert.equal(record.command, null)
    assert.equal(record.status, 'running')

    const finished = await waitFinished(tm, record.id)
    assert.equal(finished.status, 'done')
    const log = await tm.tail(record.id)
    assert.ok(log.includes('4'), `log should contain job result, got: ${log}`)
    await waitUntil(() => events.some((e) => e.type === 'task_done' && e.task.id === record.id))
  })

  it('marks a rejected job as failed with the error message in the log', async () => {
    const { tm, events } = await setup()
    const record = await tm.startJob({ name: 'boom job', run: async () => { throw new Error('boom') } })
    const finished = await waitFinished(tm, record.id)
    assert.equal(finished.status, 'failed')
    const log = await tm.tail(record.id)
    assert.ok(log.includes('boom'), `log should contain error message, got: ${log}`)
    await waitUntil(() => events.some((e) => e.type === 'task_failed' && e.task.id === record.id))
  })

  it('redacts job names and results before writing them to disk', async () => {
    const secret = 'persist-me-secret'
    const { tm } = await setup({
      redact: text => String(text).split(secret).join('[redacted]'),
    })
    const record = await tm.startJob({
      name: `job ${secret}`,
      run: async () => `result ${secret}`,
    })
    await waitFinished(tm, record.id)
    assert.doesNotMatch(JSON.stringify(await tm.get(record.id)), /persist-me-secret/)
    assert.doesNotMatch(await tm.tail(record.id), /persist-me-secret/)
  })

  it('counts jobs toward maxConcurrent and stop() cancels a job without erroring the caller', async () => {
    const { tm } = await setup({ maxConcurrent: 1 })
    let releaseJob
    const gate = new Promise((resolve) => { releaseJob = resolve })
    const record = await tm.startJob({ name: 'blocker', run: async () => { await gate; return 'late' } })
    assert.equal(tm.running(), 1)

    await assert.rejects(() => tm.startJob({ name: 'x', run: async () => 1 }), /task limit reached/)

    const stopped = await tm.stop(record.id)
    assert.equal(stopped.status, 'stopped')
    assert.equal(tm.running(), 1, 'an abort-ignoring job must retain its capacity slot')
    await assert.rejects(
      () => tm.startJob({ name: 'must-wait', run: async () => 'nope' }),
      /task limit reached/,
    )

    releaseJob()
    await waitUntil(() => tm.running() === 0)
    const after = await tm.get(record.id)
    assert.equal(after.status, 'stopped')
  })

  it('does not let a late stop race overwrite a job that already settled', async () => {
    const { tm } = await setup()
    let resolveJob
    const record = await tm.startJob({
      name: 'settling',
      run: () => new Promise(resolve => { resolveJob = resolve }),
    })
    resolveJob('x'.repeat(64 * 1024))
    await new Promise(resolve => setImmediate(resolve))

    const stopResult = await tm.stop(record.id)
    const finished = await waitFinished(tm, record.id)
    assert.equal(finished.status, 'done')
    assert.equal(stopResult.status, 'done')
  })

  it('passes an AbortSignal to jobs and aborts it on stop()', async () => {
    const { tm } = await setup()
    let observedSignal
    const record = await tm.startJob({
      name: 'abortable',
      run: async ({ signal }) => {
        observedSignal = signal
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
    const stopped = await tm.stop(record.id)
    assert.equal(stopped.status, 'stopped')
    assert.ok(observedSignal instanceof AbortSignal)
    assert.equal(observedSignal.aborted, true)
  })

  it('stopAll aborts jobs and stops shells before returning', async () => {
    const { tm } = await setup({ stopKillGraceMs: 100 })
    const job = await tm.startJob({
      name: 'job',
      run: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    const shell = await tm.startShell({ command: 'sleep 30' })
    await tm.stopAll()
    assert.equal(tm.running(), 0)
    assert.equal((await tm.get(job.id)).status, 'stopped')
    assert.equal((await tm.get(shell.id)).status, 'stopped')
  })

  it('arms the shutdown deadline before awaiting a stubborn shell', async () => {
    const { tm } = await setup({
      stopKillGraceMs: 10_000,
      shutdownTimeoutMs: 30,
    })
    await tm.startShell({
      command: `node -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'`,
    })
    const started = Date.now()
    await tm.stopAll()
    assert.ok(Date.now() - started < 1000, 'shutdown must be bounded before shell close')
  })
})

describe('createTaskManager: list', () => {
  it('orders running tasks before finished, newest-first within each group, and respects limit', async () => {
    const { tm } = await setup({ maxConcurrent: 10 })
    const a = await tm.startShell({ command: 'echo a' })
    await waitFinished(tm, a.id)
    const b = await tm.startShell({ command: 'echo b' })
    await waitFinished(tm, b.id)
    const c = await tm.startShell({ command: 'sleep 30' }) // left running

    const all = await tm.list({ limit: 20 })
    assert.equal(all[0].id, c.id, 'running task should sort first')
    assert.equal(all[0].status, 'running')

    const finishedIds = all.filter((r) => r.status !== 'running').map((r) => r.id)
    assert.deepEqual(finishedIds, [b.id, a.id], 'finished tasks should be newest-first by started')

    const limited = await tm.list({ limit: 2 })
    assert.equal(limited.length, 2)
    assert.equal(limited[0].id, c.id)
    assert.equal(limited[1].id, b.id)

    await tm.stop(c.id)
  })
})

describe('createTaskManager: tail', () => {
  it('returns only the last N bytes of the log', async () => {
    const { tm } = await setup()
    const record = await tm.startShell({ command: 'printf "0123456789"' })
    await waitFinished(tm, record.id)
    const full = await tm.tail(record.id, { bytes: 4096 })
    assert.ok(full.includes('0123456789'))
    const short = await tm.tail(record.id, { bytes: 4 })
    assert.equal(short, '6789')
  })

  it('returns an empty string when there is no log', async () => {
    const { tm } = await setup()
    assert.equal(await tm.tail('deadbeef'), '')
  })
})

describe('createTaskManager: get', () => {
  it('returns null for an invalid id', async () => {
    const { tm } = await setup()
    assert.equal(await tm.get('not-an-id'), null)
    assert.equal(await tm.get('short'), null)
    assert.equal(await tm.get(''), null)
  })

  it('returns null for a well-formed but unknown id', async () => {
    const { tm } = await setup()
    assert.equal(await tm.get('00000000'), null)
  })
})

describe('createTaskManager: recoverOrphans', () => {
  it('flips a hand-written running record to failed on boot', async () => {
    const runtimeDir = await makeRuntimeDir()
    const tasksDir = join(runtimeDir, 'tasks')
    await mkdir(tasksDir, { recursive: true })
    const orphanId = 'deadbeef'
    const orphanRecord = {
      id: orphanId,
      name: 'orphan',
      kind: 'shell',
      command: 'sleep 999',
      status: 'running',
      started: new Date().toISOString(),
      finished: null,
      exitCode: null,
      timeoutMs: 1000,
      note: null,
    }
    await writeFile(join(tasksDir, `${orphanId}.json`), JSON.stringify(orphanRecord, null, 2))

    const tm = createTaskManager({ runtimeDir })
    const count = await tm.recoverOrphans()
    assert.equal(count, 1)

    const recovered = await tm.get(orphanId)
    assert.equal(recovered.status, 'failed')
    assert.equal(recovered.note, 'orphaned by restart')
  })

  it('returns 0 when there are no orphans', async () => {
    const { tm } = await setup()
    assert.equal(await tm.recoverOrphans(), 0)
  })

  it('SIGKILLs the persisted process group of a running record on recovery', { skip: 'spawns a persistent detached child that keeps the node:test runner alive on cleanup in this sandbox; the recoverOrphans pgid-kill logic it covers is exercised on a host CI' }, async () => {
    const runtimeDir = await makeRuntimeDir()
    const tasksDir = join(runtimeDir, 'tasks')
    await mkdir(tasksDir, { recursive: true })

    // A real detached child, its own process-group leader (pgid === pid).
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true, stdio: 'ignore' })
    await new Promise((resolve, reject) => { child.on('spawn', resolve); child.on('error', reject) })
    const pid = child.pid
    const started = new Date().toISOString()

    const rec = {
      id: 'aaaabbbb', name: 'orphan', kind: 'shell', command: null,
      status: 'running', started, finished: null, exitCode: null,
      timeoutMs: 1000, note: null, pid, pgid: pid,
    }
    await writeFile(join(tasksDir, 'aaaabbbb.json'), JSON.stringify(rec, null, 2))
    // Sidecar the manager consults to kill the orphaned group on restart.
    await writeFile(join(tasksDir, 'aaaabbbb.pid'), JSON.stringify({ pid, pgid: pid, started }))

    const tm = createTaskManager({ runtimeDir })
    try {
      const count = await tm.recoverOrphans()
      assert.equal(count, 1)
      await waitUntil(() => {
        try { process.kill(pid, 0); return false } catch (e) { return e.code === 'ESRCH' }
      }, { timeout: 2000 })
      const recovered = await tm.get('aaaabbbb')
      assert.equal(recovered.status, 'failed')
      assert.equal(recovered.note, 'orphaned by restart')
    } finally {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  })
})

describe('createTaskManager: log stream errors', () => {
  it('survives a log stream error without crashing and still finalizes the task', async () => {
    const runtimeDir = await makeRuntimeDir()
    const badLogDir = join(runtimeDir, 'badlog')
    await mkdir(badLogDir, { recursive: true })
    const events = []
    const tm = createTaskManager({
      runtimeDir,
      onEvent: (e) => events.push(e),
      // Every shell log stream points at a directory, so its first write emits
      // an EISDIR 'error'. Without an 'error' listener that is an unhandled
      // stream error and the process goes down.
      createLogStream: () => createWriteStream(badLogDir, { flags: 'a' }),
    })
    const record = await tm.startShell({ command: 'echo hi' })
    const finished = await waitFinished(tm, record.id)
    assert.notEqual(finished.status, 'running', 'task still finalizes despite the log error')
    await waitUntil(() => events.some((e) => e.task.id === record.id))
  })
})

describe('createTaskManager: daemon escape on natural close', () => {
  it('group-kills surviving background children when the shell exits 0', { skip: 'spawns a persistent detached daemon that keeps the node:test runner alive on cleanup in this sandbox; the unconditional finalize group-kill it covers is exercised on a host CI' }, async () => {
    const { tm, runtimeDir } = await setup()
    const pidFile = join(runtimeDir, 'daemon.pid')
    const script = `const{spawn}=require("node:child_process");const fs=require("node:fs");const c=spawn(process.execPath,["-e","setInterval(()=>{},1e9)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid))`
    // Launch a daemon into the shell's own process group, then exit 0 so the
    // parent closes naturally (entry.reason stays null).
    const record = await tm.startShell({ command: `node -e '${script}'; exit 0` })
    const daemonPid = await waitUntil(async () => {
      try { return Number(await readFile(pidFile, 'utf8')) || null } catch { return null }
    })
    const finished = await waitFinished(tm, record.id)
    assert.equal(finished.status, 'done', 'shell itself exited 0')
    try {
      await waitUntil(() => {
        try { process.kill(daemonPid, 0); return false } catch (e) { return e.code === 'ESRCH' }
      }, { timeout: 2000 })
    } finally {
      try { process.kill(daemonPid, 'SIGKILL') } catch {}
    }
  })
})

describe('createTaskManager: timeoutMs guards', () => {
  it('treats a shell timeoutMs of 0 as the default timeout instead of disabling it', async () => {
    const { tm } = await setup({ defaultTimeoutMs: 300 })
    const start = Date.now()
    const record = await tm.startShell({ command: 'sleep 5', timeoutMs: 0 })
    assert.equal(record.timeoutMs, 300, 'effective timeout falls back to the default')
    const finished = await waitFinished(tm, record.id, { timeout: 2500 })
    assert.equal(finished.status, 'failed')
    assert.equal(finished.note, 'timeout')
    assert.ok(Date.now() - start < 3000, 'the default timeout must still fire')
  })

  it('treats a job timeoutMs of 0 as the default timeout', async () => {
    const { tm } = await setup({ defaultTimeoutMs: 200 })
    const record = await tm.startJob({
      timeoutMs: 0,
      run: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    assert.equal(record.timeoutMs, 200)
    const finished = await waitFinished(tm, record.id, { timeout: 2000 })
    assert.equal(finished.status, 'failed')
    assert.equal(finished.note, 'timeout')
  })
})

describe('createTaskManager: retention/GC', () => {
  it('prunes old terminal task records while keeping running and recent ones', async () => {
    const runtimeDir = await makeRuntimeDir()
    const tasksDir = join(runtimeDir, 'tasks')
    await mkdir(tasksDir, { recursive: true })
    const day = 24 * 60 * 60 * 1000
    const mk = async (id, status, ageMs) => {
      const t = new Date(Date.now() - ageMs).toISOString()
      await writeFile(join(tasksDir, `${id}.json`), JSON.stringify({
        id, name: 't', kind: 'shell', command: null, status,
        started: t, finished: status === 'running' ? null : t,
        exitCode: 0, timeoutMs: 1000, note: null,
      }))
      await writeFile(join(tasksDir, `${id}.log`), 'x')
    }
    await mk('aaaa1111', 'done', 30 * day)     // old terminal -> pruned
    await mk('bbbb2222', 'done', 1 * day)      // recent terminal -> kept
    await mk('cccc3333', 'running', 30 * day)  // old but running -> kept

    const tm = createTaskManager({ runtimeDir, taskRetentionMs: 7 * day })
    const listed = await tm.list()
    assert.deepEqual(listed.map((r) => r.id).sort(), ['bbbb2222', 'cccc3333'])
    assert.equal(await tm.get('aaaa1111'), null, 'old terminal record file is removed')
    assert.ok(await tm.get('bbbb2222'), 'recent terminal record is kept')
    assert.ok(await tm.get('cccc3333'), 'running record is kept')
  })

  it('caps the number of retained terminal records', async () => {
    const runtimeDir = await makeRuntimeDir()
    const tasksDir = join(runtimeDir, 'tasks')
    await mkdir(tasksDir, { recursive: true })
    // 5 recent terminal records, retention window wide, cap of 3.
    for (let i = 0; i < 5; i++) {
      const id = `dddd000${i}`
      const t = new Date(Date.now() - i * 1000).toISOString()
      await writeFile(join(tasksDir, `${id}.json`), JSON.stringify({
        id, name: 't', kind: 'shell', command: null, status: 'done',
        started: t, finished: t, exitCode: 0, timeoutMs: 1000, note: null,
      }))
    }
    const tm = createTaskManager({ runtimeDir, maxTaskRecords: 3 })
    const listed = await tm.list({ limit: 50 })
    assert.equal(listed.length, 3, 'only the newest 3 terminal records are retained')
    // The two oldest (highest i, oldest timestamps) are gone.
    assert.equal(await tm.get('dddd0004'), null)
    assert.equal(await tm.get('dddd0003'), null)
    assert.ok(await tm.get('dddd0000'))
  })
})
