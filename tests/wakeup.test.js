import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, nextMatch, nextTimer, MAX_TIMEOUT } from '../server/lib/wakeup.js'

describe('parseCron', () => {
  it('parses simple schedule "0 12 * * *"', () => {
    const s = parseCron('0 12 * * *')
    assert.ok(s)
    assert.deepEqual(s.minute, new Set([0]))
    assert.deepEqual(s.hour, new Set([12]))
    assert.equal(s.dom.size, 31)
    assert.equal(s.month.size, 12)
    assert.equal(s.dow.size, 7)
  })

  it('parses comma-separated hours "0 0,3,6,9,12,15,18,21 * * *"', () => {
    const s = parseCron('0 0,3,6,9,12,15,18,21 * * *')
    assert.ok(s)
    assert.deepEqual(s.minute, new Set([0]))
    assert.deepEqual(s.hour, new Set([0, 3, 6, 9, 12, 15, 18, 21]))
  })

  it('parses step values "*/5 * * * *"', () => {
    const s = parseCron('*/5 * * * *')
    assert.ok(s)
    assert.deepEqual(s.minute, new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]))
  })

  it('parses day-of-week "0 8 * * 1,3,5"', () => {
    const s = parseCron('0 8 * * 1,3,5')
    assert.ok(s)
    assert.deepEqual(s.dow, new Set([1, 3, 5]))
  })

  it('parses range "0 9-17 * * *"', () => {
    const s = parseCron('0 9-17 * * *')
    assert.ok(s)
    assert.deepEqual(s.hour, new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]))
  })

  it('rejects invalid expressions', () => {
    assert.equal(parseCron('0 12 *'), null) // too few fields
    assert.equal(parseCron('0 25 * * *'), null) // hour out of range
    assert.equal(parseCron('60 12 * * *'), null) // minute out of range
  })
})

describe('nextMatch', () => {
  it('finds next occurrence of daily noon schedule', () => {
    // 11:30 AM → should find 12:00 PM same day
    const after = new Date('2026-03-26T11:30:00')
    const schedule = parseCron('0 12 * * *')
    const next = nextMatch(schedule, after)
    assert.equal(next.getHours(), 12)
    assert.equal(next.getMinutes(), 0)
    assert.equal(next.getDate(), 26)
  })

  it('rolls to next day if past the scheduled time', () => {
    // 12:30 PM → should find 12:00 PM next day
    const after = new Date('2026-03-26T12:30:00')
    const schedule = parseCron('0 12 * * *')
    const next = nextMatch(schedule, after)
    assert.equal(next.getHours(), 12)
    assert.equal(next.getMinutes(), 0)
    assert.equal(next.getDate(), 27)
  })

  it('finds next occurrence of every-3-hours schedule', () => {
    // 1:00 AM → should find 3:00 AM same day
    const after = new Date('2026-03-26T01:00:00')
    const schedule = parseCron('0 0,3,6,9,12,15,18,21 * * *')
    const next = nextMatch(schedule, after)
    assert.equal(next.getHours(), 3)
    assert.equal(next.getMinutes(), 0)
  })

  it('finds next match for day-of-week constraint', () => {
    // Thursday March 26 → next Monday (dow=1) is March 30
    const after = new Date('2026-03-26T09:00:00')
    const schedule = parseCron('0 8 * * 1')
    const next = nextMatch(schedule, after)
    assert.equal(next.getDay(), 1) // Monday
    assert.equal(next.getHours(), 8)
  })

  it('handles exactly-on-the-minute (advances past current minute)', () => {
    // Exactly at 12:00 → should find next occurrence, not current
    const after = new Date('2026-03-26T12:00:00')
    const schedule = parseCron('0 12 * * *')
    const next = nextMatch(schedule, after)
    assert.equal(next.getDate(), 27) // next day
  })
})

describe('nextTimer (overflow-safe scheduling — the death-loop guard)', () => {
  it('fires directly when the target is within the setTimeout ceiling', () => {
    const now = 1_000_000
    const r = nextTimer(now + 60_000, now) // 1 minute out
    assert.equal(r.fire, true)
    assert.equal(r.delay, 60_000)
  })

  it('re-arms in a clamped chunk when the target exceeds the ceiling', () => {
    // The exact EHSRE case: a ~36916-minute wakeup (~2.21B ms) must NOT be
    // handed to setTimeout, which would fire immediately and spin the scheduler.
    const now = 1_000_000
    const r = nextTimer(now + 36_916 * 60_000, now)
    assert.equal(r.fire, false)        // does not run the wakeup yet
    assert.equal(r.delay, MAX_TIMEOUT) // clamped to Node's ceiling
  })

  it('never returns a delay above Node\'s setTimeout ceiling', () => {
    for (const days of [25, 60, 366]) {
      const r = nextTimer(days * 24 * 60 * 60 * 1000, 0)
      assert.ok(r.delay <= 2_147_483_647, `${days}d delay must be clamped`)
    }
  })

  it('fires with zero delay when the target is already in the past', () => {
    const r = nextTimer(4000, 5000)
    assert.equal(r.fire, true)
    assert.equal(r.delay, 0)
  })

  it('MAX_TIMEOUT is Node\'s 32-bit signed millisecond ceiling', () => {
    assert.equal(MAX_TIMEOUT, 2 ** 31 - 1)
  })
})
