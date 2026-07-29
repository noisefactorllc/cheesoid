import { test } from 'node:test'
import assert from 'node:assert'
import { createAutonomy } from '../server/lib/autonomy.js'
import { buildHarnessTools } from '../server/lib/tools-harness.js'

// A minimal harness stub exposing only what buildHarnessTools touches at build
// time and inside its gate chokepoint. This lets us exercise the ONE place that
// actually consults the autonomy gate without standing up a real harness.
function fakeHarness(level) {
  return {
    autonomy: createAutonomy({ autonomy: level }),
    shellPolicy: { available: () => false },
    secrets: { redactDeep: v => v },
  }
}

test('user-originated turns are never gated', () => {
  const a = createAutonomy({ autonomy: 'low' })
  assert.strictEqual(a.gate('task_start', 'user').allowed, true)
  assert.strictEqual(a.gate('set_model', 'user').allowed, true)
  assert.strictEqual(a.gate('shell', 'webhook').allowed, true)
})

test('low autonomy blocks self-directed initiative', () => {
  const a = createAutonomy({ autonomy: 'low' })
  const res = a.gate('task_start', 'idle')
  assert.strictEqual(res.allowed, false)
  assert.match(res.reason, /autonomy level "low"/)
  assert.strictEqual(a.gate('send_chat_message', 'sleep').allowed, false)
})

test('medium (the default) permits tasks and speech but not model changes', () => {
  const a = createAutonomy({})
  assert.strictEqual(a.level, 'medium')
  assert.strictEqual(a.gate('task_start', 'idle').allowed, true)
  assert.strictEqual(a.gate('send_chat_message', 'wakeup').allowed, true)
  assert.strictEqual(a.gate('set_model', 'idle').allowed, false)
})

test('high permits everything', () => {
  const a = createAutonomy({ autonomy: 'high' })
  assert.strictEqual(a.gate('task_start', 'idle').allowed, true)
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

// --- Finding #1: reply_to_message / react_to_message gated like send_chat_message ---
test('low autonomy blocks self-directed replies and reactions (same level as send_chat_message)', () => {
  const low = createAutonomy({ autonomy: 'low' })
  assert.strictEqual(low.gate('reply_to_message', 'idle').allowed, false)
  assert.strictEqual(low.gate('react_to_message', 'sleep').allowed, false)
  // A person driving is never gated; medium+ may reply/react on its own.
  assert.strictEqual(low.gate('reply_to_message', 'user').allowed, true)
  assert.strictEqual(createAutonomy({ autonomy: 'medium' }).gate('react_to_message', 'idle').allowed, true)
})

// --- Finding #3: trigger-bearing internal backchannel gated ---
test('low autonomy blocks the self-directed internal backchannel', () => {
  const low = createAutonomy({ autonomy: 'low' })
  assert.strictEqual(low.gate('internal', 'idle').allowed, false)
  assert.strictEqual(low.gate('internal', 'user').allowed, true)
  assert.strictEqual(createAutonomy({ autonomy: 'medium' }).gate('internal', 'wakeup').allowed, true)
})

// --- Finding #2: fetch_url is an exfiltration channel — restricted at low AND medium ---
test('fetch_url is blocked on self-directed low and medium turns, allowed at high or when a person drives', () => {
  assert.strictEqual(createAutonomy({ autonomy: 'low' }).gate('fetch_url', 'idle').allowed, false)
  assert.strictEqual(createAutonomy({ autonomy: 'medium' }).gate('fetch_url', 'sleep').allowed, false)
  assert.strictEqual(createAutonomy({ autonomy: 'high' }).gate('fetch_url', 'idle').allowed, true)
  assert.strictEqual(createAutonomy({ autonomy: 'low' }).gate('fetch_url', 'user').allowed, true)
  assert.strictEqual(createAutonomy({ autonomy: 'low' }).gate('fetch_url', 'webhook').allowed, true)
})

// --- Enforcement (finding #2): fetch_url really is stopped at the one gate chokepoint ---
test('the gate chokepoint (buildHarnessTools) blocks fetch_url before any network on a self-directed low turn', async () => {
  const tools = buildHarnessTools(fakeHarness('low'), {}, {}, {})
  assert.strictEqual(tools.handles('fetch_url'), true)
  // localhost:1 would be refused by the network policy anyway — but the gate
  // must fire FIRST, so the refusal is the autonomy reason, not a network one.
  const res = await tools.execute('fetch_url', { url: 'http://localhost:1/' }, { origin: 'idle' })
  assert.strictEqual(res.is_error, true)
  assert.match(res.output, /autonomy level "low" does not permit fetch_url/)
})

// --- Enforcement GAP (findings #1, #3): the gate chokepoint never sees the chat/room tools ---
test('the only gate chokepoint does not handle reply/react/internal/send_chat_message', () => {
  const tools = buildHarnessTools(fakeHarness('low'), {}, {}, {})
  // The ONLY autonomy.gate() call lives inside buildHarnessTools.execute. These
  // chat/room tools are handled by buildRoomTools (tools.js) and routed there by
  // tools.js `execute`, which never consults the gate — so a GATED entry alone
  // cannot stop them at runtime; enforcement must be wired at the dispatcher.
  for (const name of ['reply_to_message', 'react_to_message', 'internal', 'send_chat_message']) {
    assert.strictEqual(tools.handles(name), false, `${name} unexpectedly handled by the gate chokepoint`)
  }
})

// --- Finding #4: doctrine text matches reality ---
test('describe() no longer claims a non-existent "join peer rooms" agent capability', () => {
  const high = createAutonomy({ autonomy: 'high' }).describe()
  // The old doctrine falsely told the agent it "may also join known peer rooms";
  // joinRemote is human-only, so the granted-capability line must not mention it.
  assert.doesNotMatch(high, /join/i)
  assert.doesNotMatch(high, /peer room/i)
  // real self-directed control (model choice) is still described
  assert.match(high, /model/i)
})

test('low-autonomy doctrine tells the agent not to reply or react unprompted', () => {
  const low = createAutonomy({ autonomy: 'low' }).describe()
  assert.match(low, /repl(y|ies)|react/i)
})
