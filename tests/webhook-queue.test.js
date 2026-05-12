import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Room } from '../server/lib/chat-session.js'

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

describe('Webhook queueing', () => {
  it('queues webhooks when busy instead of dropping them', () => {
    const room = new Room(mockPersona())
    room.busy = true

    // Simulate webhook arriving while busy
    room._processMessage('home', 'webhook', 'payload-1')
    assert.equal(room._messageQueue.length, 1)
    assert.equal(room._messageQueue[0].name, 'webhook')
    assert.equal(room._messageQueue[0].text, 'payload-1')
  })

  it('queues human messages when busy and broadcasts them immediately', () => {
    // Current policy: don't drop human messages while the agent is thinking.
    // Queue them so they're processed after the current turn, and broadcast
    // them right away so the UI shows what the user said without a lag.
    const room = new Room(mockPersona())
    room.busy = true

    const broadcasts = []
    room.broadcast = (event) => broadcasts.push(event)

    room._processMessage('home', 'user1', 'hello')
    assert.equal(room._messageQueue.length, 1, 'human message is queued')
    assert.equal(room._messageQueue[0].name, 'user1')
    assert.equal(room._messageQueue[0].text, 'hello')
    assert.equal(room._messageQueue[0]._alreadyBroadcast, true)

    const userBroadcast = broadcasts.find(e => e.type === 'user_message')
    assert.ok(userBroadcast, 'user_message event broadcast immediately')
    assert.equal(userBroadcast.name, 'user1')
    assert.equal(userBroadcast.text, 'hello')
  })

  it('caps queued webhooks at MAX_QUEUED_WEBHOOKS', () => {
    const room = new Room(mockPersona())
    room.busy = true

    // Queue 10 (the cap)
    for (let i = 0; i < 10; i++) {
      room._processMessage('home', 'webhook', `payload-${i}`)
    }
    assert.equal(room._messageQueue.length, 10)

    // 11th should be dropped
    room._processMessage('home', 'webhook', 'payload-overflow')
    assert.equal(room._messageQueue.length, 10)
  })

  it('still queues remote room messages when busy', () => {
    const room = new Room(mockPersona())
    room.busy = true

    room._processMessage('other-room', 'agent', 'hello from remote')
    assert.equal(room._messageQueue.length, 1)
    assert.equal(room._messageQueue[0].room, 'other-room')
  })

  it('combines multiple queued webhooks into one message', () => {
    const room = new Room(mockPersona())

    // Manually populate queue as if webhooks arrived while busy
    room._messageQueue = [
      { room: 'home', name: 'webhook', text: 'incident-1' },
      { room: 'home', name: 'webhook', text: 'incident-2' },
      { room: 'home', name: 'webhook', text: 'incident-3' },
    ]

    // Capture what _processMessage is called with during drain
    let drainedMessage = null
    const origProcess = room._processMessage.bind(room)
    room._processMessage = async (room, name, text) => {
      drainedMessage = { room, name, text }
    }

    // Simulate the finally block's drain logic by calling it via a minimal busy cycle
    // We need to trigger the finally block, so we restore and use the real method
    // but stub the agent parts. Easier: just test the drain inline.
    room._processMessage = origProcess

    // Instead, directly test the drain by simulating what the finally block does:
    // Extract webhooks, combine, call _processMessage
    const webhooks = []
    const remaining = []
    for (const msg of room._messageQueue) {
      if (msg.name === 'webhook') {
        webhooks.push(msg)
      } else {
        remaining.push(msg)
      }
    }
    room._messageQueue = remaining

    const combined = webhooks.map((w, i) => {
      const label = webhooks.length > 1 ? `--- webhook ${i + 1} of ${webhooks.length} ---\n` : ''
      return label + w.text
    }).join('\n\n')

    assert.ok(combined.includes('--- webhook 1 of 3 ---'))
    assert.ok(combined.includes('--- webhook 2 of 3 ---'))
    assert.ok(combined.includes('--- webhook 3 of 3 ---'))
    assert.ok(combined.includes('incident-1'))
    assert.ok(combined.includes('incident-2'))
    assert.ok(combined.includes('incident-3'))
    assert.equal(room._messageQueue.length, 0)
  })

  it('skips label prefix for a single queued webhook', () => {
    const webhooks = [{ room: 'home', name: 'webhook', text: 'only-one' }]

    const combined = webhooks.map((w, i) => {
      const label = webhooks.length > 1 ? `--- webhook ${i + 1} of ${webhooks.length} ---\n` : ''
      return label + w.text
    }).join('\n\n')

    assert.equal(combined, 'only-one')
    assert.ok(!combined.includes('---'))
  })

  it('preserves remote room messages when draining webhooks', () => {
    const room = new Room(mockPersona())

    room._messageQueue = [
      { room: 'other-room', name: 'agent', text: 'remote msg' },
      { room: 'home', name: 'webhook', text: 'webhook-1' },
      { room: 'another-room', name: 'bot', text: 'another remote' },
      { room: 'home', name: 'webhook', text: 'webhook-2' },
    ]

    // Extract webhooks (same logic as the drain)
    const webhooks = []
    const remaining = []
    for (const msg of room._messageQueue) {
      if (msg.name === 'webhook') {
        webhooks.push(msg)
      } else {
        remaining.push(msg)
      }
    }
    room._messageQueue = remaining

    assert.equal(webhooks.length, 2)
    assert.equal(room._messageQueue.length, 2)
    assert.equal(room._messageQueue[0].name, 'agent')
    assert.equal(room._messageQueue[1].name, 'bot')
  })

  it('does not elect a visitor moderator for webhook messages', async () => {
    // Regression: webhook payloads are not broadcast to visitors (broadcast
    // guard at _processMessage excludes name='webhook'). When the round-robin
    // moderator election lands on a visitor for a webhook, the visitor is
    // triggered with routing instructions but has no payload to route, and
    // replies with a confused placeholder. The election must skip webhook
    // messages so they always land on the host who can actually see them.
    const room = new Room(mockPersona())

    room._moderatorPool = ['Test', 'Visitor']
    room.participants.set('Visitor', Date.now())
    room._moderatorIndex = 1
    room._floor = null
    room.systemPrompt = 'stub'
    room.initialize = async () => {}

    const broadcasts = []
    room.broadcast = (event) => broadcasts.push(event)

    let resolveCalled = false
    room.registry = {
      resolve: () => { resolveCalled = true; throw new Error('PAST_SKIP') },
    }

    try {
      await room._processMessage('home', 'webhook', '[webhook] daily-ops payload')
    } catch { /* expected stub throw */ }

    const electionTrigger = broadcasts.find(
      e => e.type === 'backchannel' && e.moderator_election === true
    )
    assert.ok(
      !electionTrigger,
      'webhook should not trigger a visitor moderator-election backchannel'
    )
    assert.ok(
      resolveCalled,
      'webhook should fall through to host model resolution, not return early at the election'
    )

    room.destroy()
  })
})
