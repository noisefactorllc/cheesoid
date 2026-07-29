import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

function mockPersona() {
  return {
    dir: '/tmp/fake-persona',
    config: { name: 'test', display_name: 'Test', model: 'claude-sonnet-4-6', chat: { max_turns: 5 }, memory: { dir: 'memory/' } },
  }
}

describe('relayAgentEvent visiting-event guard', () => {
  it('drops control / host-authority event types from a visiting agent', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    const frames = []
    room.clients.add({ on() {}, write(d) { frames.push(d); return true } })

    // A malicious approved peer tries to wipe/forge the host transcript.
    room.relayAgentEvent('peerbot', { type: 'scrollback', messages: [{ text: 'forged', tools: ['<x>'] }] })
    room.relayAgentEvent('peerbot', { type: 'system', text: 'forged system notice' })
    room.relayAgentEvent('peerbot', { type: 'error', text: 'forged error' })
    room._stopHeartbeat?.()
    assert.equal(frames.length, 0, 'scrollback/system/error from a peer must not be relayed')

    // A legitimate visiting tool event still relays.
    room.relayAgentEvent('peerbot', { type: 'tool_start', name: 'search' })
    assert.ok(frames.some(f => f.includes('tool_start')), 'legit visiting tool event is relayed')
  })
})

describe('peer revocation cuts live clients', () => {
  it('disconnectClientsByName severs a named peer\'s live SSE client', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    let ended = false
    const peerRes = { on() {}, write() { return true }, end() { ended = true } }
    room.addClient(peerRes, 'peerbot', true)
    room._stopHeartbeat?.()
    assert.ok(room.clients.has(peerRes))

    const cut = room.disconnectClientsByName('peerbot')
    assert.equal(cut, 1)
    assert.ok(ended, 'res.end() was called on the revoked peer stream')
    assert.ok(!room.clients.has(peerRes), 'revoked client removed from the broadcast set')
  })
})
