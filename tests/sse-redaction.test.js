import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

function mockPersona() {
  return {
    dir: '/tmp/fake-persona',
    config: {
      name: 'test',
      display_name: 'Test',
      model: 'claude-sonnet-4-6',
      chat: { max_turns: 5 },
      memory: { dir: 'memory/' },
    },
  }
}

function captureRes() {
  const writes = []
  return {
    writes,
    req: { socket: {}, headers: {} },
    on() {},
    write(d) { writes.push(d); return true },
  }
}

describe('SSE egress redaction', () => {
  it('redacts a multi-line/quoted stored secret in the scrollback frame (replay path)', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    // Value contains a newline, quotes, and a backslash — all JSON-escaped once
    // serialized, so an exact-substring redactor that runs AFTER JSON.stringify
    // cannot match it. It is also not API-key-pattern shaped.
    const secret = 'BEGIN\nKEY-"quoted"-\\slash-abcXYZ12'
    // Recorded before the secret is stored, so the raw value sits in history.
    room.recordHistory({ type: 'user_message', name: 'alice', text: `credential is ${secret} ok` })
    // Operator now drops the value into the secrets panel.
    room.harness = { secrets: { values: () => [secret], hasAny: () => true } }

    const res = captureRes()
    room.addClient(res, 'bob')
    room._stopHeartbeat?.()

    const frame = res.writes.find(w => w.includes('"type":"scrollback"'))
    assert.ok(frame, 'scrollback frame was sent')
    assert.ok(!frame.includes('BEGIN'), 'raw multi-line secret must not appear in the scrollback frame')
    assert.ok(!frame.includes('quoted'), 'quoted portion of the secret must not leak')
    assert.ok(frame.includes('[Redacted'), 'redaction marker present')
  })

  it('pattern-redacts a non-stored API key in a live broadcast frame', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    // A stored secret exists, but the leaked key below is NOT it — only the
    // API-key PATTERN can catch a key a tool echoes back. A stored-values-only
    // redactor (redactDeep) leaves it raw.
    room.harness = {
      secrets: {
        values: () => ['unrelated-stored-secret-value-1234'],
        hasAny: () => false,
        redactDeep: v => v,
      },
    }
    const res = captureRes()
    room.clients.add(res)
    const leakedKey = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    room.broadcast({ type: 'assistant_message', text: `here is a key ${leakedKey}` })
    room._stopHeartbeat?.()

    const frame = res.writes.find(w => w.includes('assistant_message'))
    assert.ok(frame, 'broadcast frame was written')
    assert.ok(!frame.includes(leakedKey), 'non-stored API key must be pattern-redacted on broadcast')
  })

  it('does not stream thinking deltas to a remote room while a secret exists', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    room.harness = { secrets: { values: () => ['s3cr3t-value-1234567890'], hasAny: () => true } }
    let sent = 0
    const fakeClient = { sendEvent() { sent++ } }
    room.roomClients.set('peerroom', fakeClient)
    room._pendingRoom = 'peerroom'
    room._pendingRoomChannel = 'main'

    // Simulate the remote-branch delivery used in the orchestrator loop.
    const event = { type: 'thinking_delta', text: 'partial s3cr3t-val' }
    if (!room._suppressWhenSecrets(event)) {
      room.roomClients.get(room._pendingRoom).sendEvent(event, room._pendingRoomChannel)
    }
    assert.equal(sent, 0, 'thinking_delta must be suppressed to remote rooms when a secret exists')
  })
})
