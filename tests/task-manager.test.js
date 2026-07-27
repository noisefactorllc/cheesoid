import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
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

  it('defaults name to the first 40 chars of the command', async () => {
    const { tm } = await setup()
    const command = 'echo this-is-a-fairly-long-command-that-should-be-truncated-for-the-default-name'
    const record = await tm.startShell({ command })
    assert.equal(record.name, command.slice(0, 40))
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

  it('injects env() values into the shell environment', async () => {
    const { tm } = await setup({ env: () => ({ MY_SECRET: 'x42' }) })
    const record = await tm.startShell({ command: 'echo $MY_SECRET' })
    await waitFinished(tm, record.id)
    const log = await tm.tail(record.id)
    assert.ok(log.includes('x42'), `log should contain injected env value, got: ${log}`)
  })
})

describe('createTaskManager: concurrency + stop', () => {
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

  it('counts jobs toward maxConcurrent and stop() cancels a job without erroring the caller', async () => {
    const { tm } = await setup({ maxConcurrent: 1 })
    let releaseJob
    const gate = new Promise((resolve) => { releaseJob = resolve })
    const record = await tm.startJob({ name: 'blocker', run: async () => { await gate; return 'late' } })
    assert.equal(tm.running(), 1)

    await assert.rejects(() => tm.startJob({ name: 'x', run: async () => 1 }), /task limit reached/)

    const stopped = await tm.stop(record.id)
    assert.equal(stopped.status, 'stopped')
    assert.equal(tm.running(), 0)

    releaseJob()
    // Give the discarded promise a tick to settle; the record must stay 'stopped'.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const after = await tm.get(record.id)
    assert.equal(after.status, 'stopped')
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
})
