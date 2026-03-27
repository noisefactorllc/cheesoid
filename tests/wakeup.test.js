import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, nextMatch } from '../server/lib/wakeup.js'

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
