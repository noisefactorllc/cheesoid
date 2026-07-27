import { test } from 'node:test'
import assert from 'node:assert'
import { compactAfterSleep, runSleepCycle } from '../server/lib/sleep.js'

function fakeRoom(messages) {
  return {
    messages,
    busy: false,
    _destroyed: false,
    _a: {},
    persona: { config: { name: 't', display_name: 'T' } },
    registry: { resolve: () => { throw new Error('no provider') } },
    broadcast: () => {},
    recordHistory: () => {},
  }
}

test('compactAfterSleep keeps a clean tail behind a marker', () => {
  const messages = []
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: `alice: message ${i}` })
    messages.push({ role: 'assistant', content: `reply ${i}` })
  }
  const room = fakeRoom(messages)
  compactAfterSleep(room, '2026-07-27', { keep: 6 })
  assert.ok(room.messages.length <= 8)
  assert.match(room.messages[0].content, /CONTEXT COMPACTED DURING SLEEP \(2026-07-27\)/)
  // The first kept entry after the marker is a plain-string user message
  assert.strictEqual(room.messages[1].role, 'user')
  assert.strictEqual(typeof room.messages[1].content, 'string')
})

test('compactAfterSleep never orphans tool_result blocks at the cut', () => {
  const messages = []
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: `alice: q${i}` })
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'x', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'r' }] })
    messages.push({ role: 'assistant', content: `a${i}` })
  }
  const room = fakeRoom(messages)
  compactAfterSleep(room, '2026-07-27', { keep: 6 })
  // First non-marker message must not be a dangling tool_result
  const first = room.messages[1]
  const isToolResult = Array.isArray(first?.content) && first.content.some(b => b.type === 'tool_result')
  assert.strictEqual(isToolResult, false)
})

test('compactAfterSleep leaves short contexts alone', () => {
  const messages = [
    { role: 'user', content: 'alice: hi' },
    { role: 'assistant', content: 'hello' },
  ]
  const room = fakeRoom(messages)
  compactAfterSleep(room, '2026-07-27')
  assert.strictEqual(room.messages.length, 2)
})

test('runSleepCycle respects sleep:false, busy, and missing models', async () => {
  const off = fakeRoom([])
  off.persona.config.sleep = false
  assert.strictEqual(await runSleepCycle(off, {}), 'disabled')

  const busy = fakeRoom([])
  busy.busy = true
  busy.persona.config.reflection = ['some-model']
  assert.strictEqual(await runSleepCycle(busy, {}), 'busy')

  const noModel = fakeRoom([])
  noModel.persona.config.reflection = ['unresolvable-model']
  assert.strictEqual(await runSleepCycle(noModel, {}), 'no-model')
  assert.strictEqual(noModel.busy, false)
})
