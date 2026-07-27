import { test } from 'node:test'
import assert from 'node:assert'
import { createAutonomy } from '../server/lib/autonomy.js'

test('user-originated turns are never gated', () => {
  const a = createAutonomy({ autonomy: 'low' })
  assert.strictEqual(a.gate('task_start', 'user').allowed, true)
  assert.strictEqual(a.gate('join_room', 'user').allowed, true)
  assert.strictEqual(a.gate('shell', 'webhook').allowed, true)
})

test('low autonomy blocks self-directed initiative', () => {
  const a = createAutonomy({ autonomy: 'low' })
  const res = a.gate('task_start', 'idle')
  assert.strictEqual(res.allowed, false)
  assert.match(res.reason, /autonomy level "low"/)
  assert.strictEqual(a.gate('send_chat_message', 'sleep').allowed, false)
})

test('medium (the default) permits tasks and speech but not topology', () => {
  const a = createAutonomy({})
  assert.strictEqual(a.level, 'medium')
  assert.strictEqual(a.gate('task_start', 'idle').allowed, true)
  assert.strictEqual(a.gate('send_chat_message', 'wakeup').allowed, true)
  assert.strictEqual(a.gate('join_room', 'idle').allowed, false)
  assert.strictEqual(a.gate('set_model', 'idle').allowed, false)
})

test('high permits everything', () => {
  const a = createAutonomy({ autonomy: 'high' })
  assert.strictEqual(a.gate('join_room', 'idle').allowed, true)
  assert.strictEqual(a.gate('set_model', 'sleep').allowed, true)
})

test('ungated tools always pass', () => {
  const a = createAutonomy({ autonomy: 'low' })
  assert.strictEqual(a.gate('write_memory', 'idle').allowed, true)
  assert.strictEqual(a.gate('wiki_write', 'sleep').allowed, true)
})

test('invalid level falls back to medium and describe() mentions the level', () => {
  const a = createAutonomy({ autonomy: 'yolo' })
  assert.strictEqual(a.level, 'medium')
  assert.match(a.describe(), /"medium"/)
})
