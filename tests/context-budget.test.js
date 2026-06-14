import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { trimContextToBudget, estimateMessageTokens } from '../server/lib/chat-session.js'

const big = (bytes) => 'x'.repeat(bytes)
const tokensOf = (msgs) => msgs.reduce((s, m) => s + estimateMessageTokens(m), 0)
const leadsWithToolResult = (m) =>
  Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result')

describe('trimContextToBudget', () => {
  it('caps an oversized context (huge tool_results) to ~the token budget', () => {
    // Simulate the Brad failure: repeated read_memory results (~15K tokens each)
    // stacked into the live window until the prompt hit hundreds of K tokens.
    const msgs = []
    for (let i = 0; i < 16; i++) {
      msgs.push({ role: 'user', content: `turn ${i}` })
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(60 * 1024) }],
      })
    }
    assert.ok(tokensOf(msgs) > 200_000, 'precondition: original context is huge')

    const budget = 80_000
    const out = trimContextToBudget(msgs, { maxTokens: budget, minMessages: 4 })

    // Bounded: within one ~15K message of the budget.
    assert.ok(tokensOf(out) <= budget + 16_000, `trimmed=${tokensOf(out)} should be ~<= ${budget}`)
    // Newest turn preserved.
    assert.deepStrictEqual(out[out.length - 1], msgs[msgs.length - 1])
    // Actually dropped something.
    assert.ok(out.length < msgs.length)
  })

  it('never trims below minMessages, even if the tail is large', () => {
    const msgs = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: big(400 * 1024) },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: big(400 * 1024) },
    ]
    const out = trimContextToBudget(msgs, { maxTokens: 1_000, minMessages: 4 })
    assert.equal(out.length, 4, 'floor keeps the most recent N regardless of budget')
    assert.deepStrictEqual(out[out.length - 1], msgs[msgs.length - 1])
  })

  it('does not leave a leading orphan tool_result', () => {
    // Drop the two huge leaders; the survivor at the front would be a
    // tool_result whose tool_use was trimmed — strip it so the API is valid.
    const msgs = [
      { role: 'user', content: big(200 * 1024) }, // ~50K -> trimmed
      { role: 'assistant', content: big(200 * 1024) }, // ~50K -> trimmed
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'newest' },
    ]
    const out = trimContextToBudget(msgs, { maxTokens: 20_000, minMessages: 1 })
    assert.ok(!leadsWithToolResult(out[0]), 'first kept message must not be an orphan tool_result')
    assert.deepStrictEqual(out[out.length - 1], msgs[msgs.length - 1])
  })

  it('is a no-op for a small healthy context', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you' },
    ]
    const out = trimContextToBudget(msgs)
    assert.deepStrictEqual(out, msgs)
  })

  it('handles empty / non-array input safely', () => {
    assert.deepStrictEqual(trimContextToBudget([]), [])
    assert.equal(trimContextToBudget(null), null)
  })
})
