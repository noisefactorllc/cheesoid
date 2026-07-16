import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { trimContextToBudget, estimateMessageTokens, resolveContextBudget } from '../server/lib/chat-session.js'

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
    // Aging runs before eviction, so the 13 old, oversized tool_results here
    // shrink enough on their own to satisfy the budget — eviction never needs
    // to drop a whole message. That is a strictly better outcome than
    // dropping messages: no history is lost, only stale tool-result detail.
    assert.equal(out.length, msgs.length, 'aging alone can satisfy the budget without evicting any message')
    assert.ok(tokensOf(out) < tokensOf(msgs) / 4, `trimmed=${tokensOf(out)} should have shrunk dramatically via aging`)
  })

  it('evicts down to the target once triggered (hysteresis), not just under the trigger', () => {
    const msgs = []
    for (let i = 0; i < 16; i++) {
      msgs.push({ role: 'user', content: `turn ${i}` })
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(60 * 1024) }],
      })
    }
    const out = trimContextToBudget(msgs, { maxTokens: 80_000, targetTokens: 48_000, minMessages: 4 })
    // Draining to the 48K target leaves it well under the 80K trigger. The old
    // trim-to-trigger behavior would have stopped at ~77K (> 64K).
    assert.ok(tokensOf(out) < 64_000, `trimmed=${tokensOf(out)} should approach the 48K target, not the 80K trigger`)
    assert.ok(tokensOf(out) <= 48_000 + 16_000, 'within one large message of the target')
    assert.ok(tokensOf(out) < tokensOf(msgs))
    assert.deepStrictEqual(out[out.length - 1], msgs[msgs.length - 1])
  })

  it('does NOT evict between the target and the trigger (trigger stays at maxTokens)', () => {
    // ~61K total — above the 48K target but below the 80K trigger. The target
    // only governs how far to drain ONCE triggered; the trigger is maxTokens, so
    // nothing is evicted here.
    const msgs = []
    for (let i = 0; i < 4; i++) {
      msgs.push({ role: 'user', content: `turn ${i}` })
      msgs.push({
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(60 * 1024) }],
      })
    }
    const total = tokensOf(msgs)
    assert.ok(total > 48_000 && total < 80_000, `precondition: ${total} is between target and trigger`)
    const out = trimContextToBudget(msgs)
    assert.equal(out.length, msgs.length, 'no messages evicted between target and trigger')
    assert.equal(tokensOf(out), total)
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

  it('scales the trim target to a custom budget, so a small budget still drains below its trigger', () => {
    // A caller passing only a small maxTokens used to inherit the fixed 48K
    // target, which clamps to maxTokens (floor = min(48K, 16K) = 16K). Target
    // == trigger means every turn shaves one message and re-trips the trigger:
    // the exact prefix churn the hysteresis exists to avoid. The target must
    // stay proportional to whatever budget the caller asked for.
    const msgs = []
    for (let i = 0; i < 20; i++) msgs.push({ role: 'user', content: 'x'.repeat(4000) }) // ~1008 tok each
    const total = tokensOf(msgs)
    assert.ok(total > 16_000, `precondition: ${total} exceeds the 16K trigger`)

    const out = trimContextToBudget(msgs, { maxTokens: 16_000, minMessages: 4 })

    // 60% of 16K = 9.6K target. Clamping to the trigger instead would stop at ~15K.
    assert.ok(tokensOf(out) <= 9_600 + 1_100, `trimmed=${tokensOf(out)} should drain to the ~9.6K target, not stop at the 16K trigger`)
    // The point of draining past the trigger: the next turn does not re-trim.
    assert.ok(tokensOf(out) < 16_000, 'must land strictly under the trigger so the prefix stays stable')
    assert.deepStrictEqual(out[out.length - 1], msgs[msgs.length - 1], 'newest turn survives')
  })

  it('keeps the default budget at 80K/48K exactly (Claude-tier agents must not regress)', () => {
    const msgs = []
    for (let i = 0; i < 200; i++) msgs.push({ role: 'user', content: 'x'.repeat(4000) })
    const out = trimContextToBudget(msgs, { minMessages: 4 })
    // Deriving the target as a ratio must reproduce the historical 48K target.
    assert.ok(tokensOf(out) <= 48_000 + 1_100, `trimmed=${tokensOf(out)} should drain to the historical 48K target`)
    assert.ok(tokensOf(out) > 40_000, `trimmed=${tokensOf(out)} should not overshoot below the 48K target`)
  })
})

describe('resolveContextBudget', () => {
  it('defaults to the 80K Claude-tier budget when unset', () => {
    assert.equal(resolveContextBudget({}), 80_000)
    assert.equal(resolveContextBudget({ chat: {} }), 80_000)
    assert.equal(resolveContextBudget(null), 80_000)
  })

  it('honors chat.context_budget_tokens', () => {
    assert.equal(resolveContextBudget({ chat: { context_budget_tokens: 16_000 } }), 16_000)
  })

  it('ignores values that are not a positive number', () => {
    // A typo must not silently produce a 0-token context or a NaN budget.
    for (const bad of [0, -5, 'lots', null, {}, NaN]) {
      assert.equal(resolveContextBudget({ chat: { context_budget_tokens: bad } }), 80_000, `bad value: ${JSON.stringify(bad)}`)
    }
  })
})

describe('tool-result aging (trimContextToBudget)', () => {
  // 8 messages / 4 assistant turns, with the oversized tool_result on the
  // OLDEST assistant turn — 3 assistant turns newer than it, so it falls
  // outside the protected window (TOOL_RESULT_AGE_PROTECT_TURNS = 3) and is
  // eligible for aging once a trim event fires.
  function messagesWithOldToolResult(toolResultContent) {
    return [
      { role: 'user', content: 'turn 0' },
      { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't0', content: toolResultContent }] },
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'ack 1' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'ack 2' },
      { role: 'user', content: 'turn 3' },
      { role: 'assistant', content: 'ack 3' },
    ]
  }

  it('ages an oversized tool_result outside the protected window once a trim event fires', () => {
    const bigResult = 'q'.repeat(1000)
    const msgs = messagesWithOldToolResult(bigResult)
    // minMessages == msgs.length so the eviction loop can never run — isolates
    // aging from eviction. maxTokens: 1 guarantees the trim event fires.
    const out = trimContextToBudget(msgs, { maxTokens: 1, minMessages: msgs.length })

    assert.equal(out.length, msgs.length, 'aging shrinks content, it does not evict messages')
    const aged = out[1].content[0]
    assert.equal(
      aged.content,
      `${'q'.repeat(200)}… [aged tool result — 1000 chars total; re-run the tool if this data is needed]`,
    )
    assert.notEqual(out[1], msgs[1], 'aged message is a new object (copy-on-write)')
    assert.equal(msgs[1].content[0].content, bigResult, 'original input message is never mutated')
  })

  it('never ages tool_results in the most recent protected turns, even if huge, even when a trim fires', () => {
    const bigResult = 'r'.repeat(1000)
    // 3 assistant turns total (indices 1, 3, 5) — the protected window is the
    // most recent 3 assistant turns, so ALL of them (including the tool_result
    // on the very last one) are protected here.
    const msgs = [
      { role: 'user', content: 'turn 0' },
      { role: 'assistant', content: 'ack 0' },
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'ack 1' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't2', content: bigResult }] },
    ]
    const out = trimContextToBudget(msgs, { maxTokens: 1, minMessages: msgs.length })

    assert.equal(out[5], msgs[5], 'protected message keeps the exact same reference — untouched')
    assert.equal(out[5].content[0].content, bigResult, 'protected tool_result content is not shrunk')
  })

  it('leaves tool_results at or under the aging threshold untouched, even when old and a trim fires', () => {
    // Exactly at TOOL_RESULT_AGE_THRESHOLD_CHARS (600) — "longer than ~600"
    // means strictly-over triggers aging, so this boundary case must survive.
    const smallResult = 's'.repeat(600)
    const msgs = messagesWithOldToolResult(smallResult)
    const out = trimContextToBudget(msgs, { maxTokens: 1, minMessages: msgs.length })

    assert.equal(out[1], msgs[1], 'small tool_result message keeps the same reference — untouched')
    assert.equal(out[1].content[0].content, smallResult)
    assert.ok(!out[1].content[0].content.includes('aged tool result'))
  })

  it('does not age anything when no trim event fires, even with an old oversized tool_result present', () => {
    const bigResult = 't'.repeat(1000)
    const msgs = messagesWithOldToolResult(bigResult)
    // Default budget (80K tokens) — this tiny message set comes nowhere close,
    // so the hysteresis trigger never fires and aging must not run at all.
    const out = trimContextToBudget(msgs)

    assert.equal(out.length, msgs.length)
    for (let i = 0; i < msgs.length; i++) {
      assert.equal(out[i], msgs[i], `message ${i} must be the exact same reference — no trim, no aging`)
    }
  })
})
