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

describe('image attachment context accounting', () => {
  it('estimates an image block by a flat cost, not its base64 length', async () => {
    const { estimateMessageTokens } = await import('../server/lib/chat-session.js')
    const bigB64 = 'A'.repeat(1_000_000) // ~1MB base64 payload
    const msg = {
      role: 'user',
      content: [
        { type: 'text', text: 'here is a photo' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigB64 } },
      ],
    }
    const tokens = estimateMessageTokens(msg)
    assert.ok(tokens < 5000, `image must not be counted as ~250k text tokens (got ${tokens})`)
  })

  it('does not evict conversation history when a photo is uploaded', async () => {
    const { trimContextToBudget } = await import('../server/lib/chat-session.js')
    const msgs = []
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `message number ${i} with some words` })
    }
    msgs.push({
      role: 'user',
      content: [
        { type: 'text', text: 'photo' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(400_000) } },
      ],
    })
    const trimmed = trimContextToBudget(msgs, { maxTokens: 80_000 })
    assert.ok(trimmed.length >= 21, `history must survive an image upload, got ${trimmed.length} of 21`)
  })
})

describe('attachment → image block trust', () => {
  it('builds an image block only from the STORED mime, never the client-declared mime', async () => {
    const { Room } = await import('../server/lib/chat-session.js')
    const room = new Room(mockPersona())
    room.harness = {
      media: {
        async load(id) {
          const mime = id === 'imgok' ? 'image/png' : 'text/plain'
          return { meta: { mime, bytes: 10 }, buffer: Buffer.from('x') }
        },
      },
    }
    const legit = await room._imageBlocksFor([{ id: 'imgok', mime: 'image/png' }])
    assert.equal(legit.length, 1)
    assert.equal(legit[0].source.media_type, 'image/png')

    // Crafted: client claims image/png but the stored file is text/plain.
    const crafted = await room._imageBlocksFor([{ id: 'txtfile', mime: 'image/png' }])
    assert.equal(crafted.length, 0, 'must not build an image block from a non-image stored file')
  })
})
