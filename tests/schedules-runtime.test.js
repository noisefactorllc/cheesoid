import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createScheduleStore } from '../server/lib/schedule-store.js'

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('schedule store', () => {
  // Every store a test arms carries a real setTimeout (cron schedules arm
  // toward their next match, which can be many hours out). Those timers are
  // ref'd, same as WakeupScheduler's, so `node --test` will hang at exit
  // waiting for them unless each store is stop()ped. Track every store a
  // test creates here instead of repeating try/finally everywhere.
  const stores = []

  afterEach(() => {
    while (stores.length) stores.pop().stop()
  })

  async function makeRuntimeDir() {
    const base = await mkdtemp(join(tmpdir(), 'cheesoid-schedules-'))
    return join(base, 'runtime')
  }

  function makeStore(runtimeDir, opts = {}) {
    const store = createScheduleStore({ runtimeDir, ...opts })
    stores.push(store)
    return store
  }

  it('create() with a cron schedule persists and appears in list() with a next time', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = makeStore(runtimeDir)

    const record = await store.create({ name: 'daily', cron: '0 0 * * *', prompt: 'do the thing' })
    assert.match(record.id, /^[0-9a-f]{8}$/)
    assert.equal(record.name, 'daily')
    assert.equal(record.cron, '0 0 * * *')
    assert.equal(record.at, null)
    assert.equal(record.once, false)
    assert.equal(record.lastFired, null)
    assert.equal(typeof record.created, 'string')

    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, record.id)
    assert.equal(typeof list[0].next, 'string')
    assert.ok(!Number.isNaN(Date.parse(list[0].next)), 'next must be a parseable ISO timestamp')

    const onDisk = JSON.parse(await readFile(join(runtimeDir, 'schedules.json'), 'utf8'))
    assert.equal(onDisk.length, 1)
    assert.equal(onDisk[0].id, record.id)
  })

  it('create() with both cron and at throws', async () => {
    const store = makeStore(await makeRuntimeDir())
    await assert.rejects(
      () => store.create({
        name: 'x',
        cron: '0 0 * * *',
        at: new Date(Date.now() + 60_000).toISOString(),
        prompt: 'p',
      }),
      /invalid schedule: /
    )
  })

  it('create() with neither cron nor at throws', async () => {
    const store = makeStore(await makeRuntimeDir())
    await assert.rejects(
      () => store.create({ name: 'x', prompt: 'p' }),
      /invalid schedule: /
    )
  })

  it('create() with an invalid cron string throws', async () => {
    const store = makeStore(await makeRuntimeDir())
    await assert.rejects(
      () => store.create({ name: 'x', cron: 'not a cron', prompt: 'p' }),
      /invalid schedule: /
    )
  })

  it('create() with at in the past throws', async () => {
    const store = makeStore(await makeRuntimeDir())
    await assert.rejects(
      () => store.create({ name: 'x', at: new Date(Date.now() - 60_000).toISOString(), prompt: 'p' }),
      /invalid schedule: at is in the past/
    )
  })

  it('a once/at schedule fires via a short real timer and auto-removes itself', async () => {
    const runtimeDir = await makeRuntimeDir()
    const fired = []
    const store = makeStore(runtimeDir, { onFire: async ({ schedule }) => { fired.push(schedule.id) } })

    const record = await store.create({
      name: 'soon',
      at: new Date(Date.now() + 150).toISOString(),
      prompt: 'ping',
    })
    store.start()

    await wait(400)

    assert.deepEqual(fired, [record.id])
    assert.equal((await store.list()).length, 0)

    const onDisk = JSON.parse(await readFile(join(runtimeDir, 'schedules.json'), 'utf8'))
    assert.equal(onDisk.length, 0)
  })

  it('a recurring cron schedule re-arms after a manual _fire()', async () => {
    const runtimeDir = await makeRuntimeDir()
    const fired = []
    const store = makeStore(runtimeDir, { onFire: async ({ schedule }) => { fired.push(schedule.id) } })

    const record = await store.create({ name: 'daily', cron: '0 0 * * *', prompt: 'ping' })
    const ok = await store._fire(record.id)
    assert.equal(ok, true)

    assert.deepEqual(fired, [record.id])

    const list = await store.list()
    assert.equal(list.length, 1, 'recurring schedule remains after firing')
    assert.equal(list[0].id, record.id)
    assert.equal(typeof list[0].lastFired, 'string')
    assert.ok(!Number.isNaN(Date.parse(list[0].lastFired)))
  })

  it('remove() disarms the timer so onFire is never called', async () => {
    const runtimeDir = await makeRuntimeDir()
    const fired = []
    const store = makeStore(runtimeDir, { onFire: async ({ schedule }) => { fired.push(schedule.id) } })

    const record = await store.create({
      name: 'soon',
      at: new Date(Date.now() + 150).toISOString(),
      prompt: 'ping',
    })
    store.start()

    assert.equal(await store.remove(record.id), true)

    await wait(400)

    assert.deepEqual(fired, [])
  })

  it('persists schedules across store instances', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store1 = makeStore(runtimeDir)
    const record = await store1.create({ name: 'daily', cron: '0 0 * * *', prompt: 'ping' })

    const store2 = makeStore(runtimeDir)
    await store2.start()

    const list = await store2.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].id, record.id)
    assert.equal(list[0].name, 'daily')
  })

  it('enforces a limit of 50 schedules', async () => {
    const runtimeDir = await makeRuntimeDir()
    const store = makeStore(runtimeDir)

    for (let i = 0; i < 50; i++) {
      await store.create({ name: `s${i}`, cron: '0 0 * * *', prompt: 'ping' })
    }

    await assert.rejects(
      () => store.create({ name: 's50', cron: '0 0 * * *', prompt: 'ping' }),
      /schedule limit reached/
    )
  })

  // A syntactically-valid cron whose next occurrence is unreachable within
  // nextMatch's 366-day window (Feb 30 never exists; a leap-day far from a
  // leap year is >366 days out). create() must reject BEFORE persisting so the
  // poison record can never reach disk and brick list()/start() on every turn.
  for (const cron of ['0 0 30 2 *', '0 0 29 2 *']) {
    it(`create() rejects a poison cron (${cron}), persists nothing, and leaves list() working`, async () => {
      const runtimeDir = await makeRuntimeDir()
      // Pin now far from any leap day so '0 0 29 2 *' is reliably >366d out.
      const store = makeStore(runtimeDir, { now: () => Date.UTC(2026, 6, 29, 12, 0, 0) })

      await assert.rejects(
        () => store.create({ name: 'poison', cron, prompt: 'p' }),
        /invalid schedule: /
      )

      // Nothing was written to disk.
      await assert.rejects(
        () => readFile(join(runtimeDir, 'schedules.json'), 'utf8'),
        /ENOENT/
      )
      // And list() still works (does not throw).
      assert.deepEqual(await store.list(), [])
    })
  }

  it('list()/start() tolerate a legacy poison-cron record already on disk', async () => {
    const runtimeDir = await makeRuntimeDir()
    await mkdir(runtimeDir, { recursive: true })
    const poison = {
      id: 'deadbeef', name: 'legacy', cron: '0 0 30 2 *', at: null,
      prompt: 'p', once: false, created: new Date().toISOString(),
      createdBy: null, lastFired: null,
    }
    await writeFile(join(runtimeDir, 'schedules.json'), JSON.stringify([poison], null, 2))

    const store = makeStore(runtimeDir)

    const list = await store.list() // must not throw
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'deadbeef')
    assert.equal(list[0].next, null, 'un-computable next degrades to null, not a throw')

    await store.start() // must not throw
  })

  it('does not drop an unfired past-due one-shot on list(), and fires it once on start()', async () => {
    const runtimeDir = await makeRuntimeDir()
    await mkdir(runtimeDir, { recursive: true })
    const base = Date.now()
    const rec = {
      id: 'abcd1234', name: 'oneshot', cron: null,
      at: new Date(base - 10_000).toISOString(), // already past-due, never fired
      prompt: 'p', once: true, created: new Date(base - 20_000).toISOString(),
      createdBy: null, lastFired: null,
    }
    await writeFile(join(runtimeDir, 'schedules.json'), JSON.stringify([rec], null, 2))

    const fired = []
    const store = makeStore(runtimeDir, { onFire: async ({ schedule }) => { fired.push(schedule.id) } })

    const list = await store.list()
    assert.equal(list.length, 1, 'past-due unfired one-shot must survive list()')
    assert.equal(list[0].id, 'abcd1234')

    await store.start()
    await wait(80)
    assert.deepEqual(fired, ['abcd1234'], 'past-due one-shot fires once on start()')
    assert.equal((await store.list()).length, 0, 'fired one-shot is then removed')
  })

  it('a recurring leap-day cron does not crash on re-arm when the next match is beyond the search window', async () => {
    const runtimeDir = await makeRuntimeDir()
    // Feb 27 2028 (UTC) — safely within 366d of Feb 29 2028 in every timezone.
    let nowMs = Date.UTC(2028, 1, 27, 0, 0, 0)
    const fired = []
    const store = makeStore(runtimeDir, { now: () => nowMs, onFire: async ({ schedule }) => { fired.push(schedule.id) } })

    const rec = await store.create({ name: 'leap', cron: '0 0 29 2 *', prompt: 'p' })

    // Advance past the fired occurrence; the next Feb 29 (2032) is now beyond
    // the 366-day window, so re-arm's nextMatch throws.
    nowMs = Date.UTC(2028, 5, 1, 0, 0, 0)
    const ok = await store._fire(rec.id) // must not throw on re-arm
    assert.equal(ok, true)
    assert.deepEqual(fired, [rec.id])

    const list = await store.list() // must not throw despite un-computable next
    assert.equal(list.length, 1, 'recurring schedule is retained')
    assert.equal(list[0].id, rec.id)
    assert.equal(typeof list[0].lastFired, 'string')
    assert.equal(list[0].next, null, 'next match beyond the window degrades to null')
  })
})
