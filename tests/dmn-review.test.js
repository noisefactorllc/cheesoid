import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runDMNReview, assembleDMNReviewPrompt } from '../server/lib/dmn.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeProvider(response) {
  return {
    streamMessage: mock.fn(async (params, onEvent) => response),
  }
}

function makeSequentialProvider(responses) {
  let callIdx = 0
  return {
    streamMessage: mock.fn(async (params, onEvent) => {
      const resp = responses[callIdx] || responses[responses.length - 1]
      callIdx++
      return resp
    }),
  }
}

describe('DMN Review Integration', () => {
  it('full flow: prompt assembly → review → pass', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dmn-review-int-'))
    await writeFile(join(dir, 'SOUL.md'), 'You are EHSRE, an SRE agent.')

    const prompt = await assembleDMNReviewPrompt(dir, { display_name: 'EHSRE', name: 'ehsre' })
    assert.ok(prompt.includes('EHSRE'))
    assert.ok(prompt.includes('SRE agent'))

    const provider = makeProvider({
      contentBlocks: [{ type: 'tool_use', id: 't1', name: 'pass', input: {} }],
      stopReason: 'tool_use',
      usage: { input_tokens: 200, output_tokens: 15 },
    })

    const messages = [
      { role: 'user', content: 'operator: check disk usage' },
      { role: 'assistant', content: [{ type: 'text', text: 'Disk usage on nf-toronto is at 42%.' }] },
    ]

    const { verdict } = await runDMNReview(prompt, messages, 'Disk usage on nf-toronto is at 42%.', provider, 'haiku')
    assert.equal(verdict, 'pass')
  })

  it('full flow: prompt assembly → review → critique', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dmn-review-int-'))

    const prompt = await assembleDMNReviewPrompt(dir, { display_name: 'EHSRE', name: 'ehsre' })

    const provider = makeProvider({
      contentBlocks: [{ type: 'tool_use', id: 't1', name: 'critique', input: { reason: 'RESPONSIVENESS: Agent described what it could do instead of doing it. Should have called the bash tool to check disk usage.' } }],
      stopReason: 'tool_use',
      usage: { input_tokens: 200, output_tokens: 30 },
    })

    const messages = [
      { role: 'user', content: 'operator: check disk usage' },
      { role: 'assistant', content: [{ type: 'text', text: 'I can check disk usage for you.' }] },
    ]

    const { verdict } = await runDMNReview(prompt, messages, 'I can check disk usage for you.', provider, 'haiku')
    assert.ok(verdict !== 'pass')
    assert.ok(verdict.includes('RESPONSIVENESS'))
  })

  it('review prompt includes all evaluation criteria', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dmn-review-int-'))
    const prompt = await assembleDMNReviewPrompt(dir, { display_name: 'Test', name: 'test' })

    const criteria = ['RESPONSIVENESS', 'COMPLETENESS', 'SUBSTANCE', 'TONE', 'AWARENESS', 'COHERENCE']
    for (const criterion of criteria) {
      assert.ok(prompt.includes(criterion), `Missing criterion: ${criterion}`)
    }
  })

  it('context is included in review system prompt', async () => {
    const provider = makeProvider({
      contentBlocks: [{ type: 'tool_use', id: 't1', name: 'pass', input: {} }],
      stopReason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
    })

    const messages = [
      { role: 'user', content: 'operator: what is the canary status?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Canary is healthy.' }] },
      { role: 'user', content: 'operator: restart it' },
      { role: 'assistant', content: [{ type: 'text', text: 'Restarted.' }] },
    ]

    await runDMNReview('review prompt', messages, 'Restarted.', provider, 'haiku')

    const call = provider.streamMessage.mock.calls[0]
    const system = call.arguments[0].system
    assert.ok(system.includes('RECENT CONTEXT'))
    assert.ok(system.includes('what is the canary status'))
  })
})
