import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
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
})
