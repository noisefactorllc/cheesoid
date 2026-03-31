import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assembleDMNPrompt, buildDMNContext } from '../server/lib/dmn.js'

describe('assembleDMNPrompt', () => {
  it('includes SOUL.md content and display name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dmn-test-'))
    await writeFile(join(dir, 'SOUL.md'), 'You are Brad from Monetization. You care about revenue.')

    const prompt = await assembleDMNPrompt(dir, { display_name: 'Brad', name: 'brad' })

    assert.ok(prompt.includes('Brad'))
    assert.ok(prompt.includes('You are Brad from Monetization'))
    assert.ok(prompt.includes('SITUATION'))
    assert.ok(prompt.includes('INTERPRETATION'))
    assert.ok(prompt.includes('APPROACH'))
  })

  it('works without SOUL.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dmn-test-'))

    const prompt = await assembleDMNPrompt(dir, { display_name: 'Test Agent', name: 'test' })

    assert.ok(prompt.includes('Test Agent'))
    assert.ok(prompt.includes('SITUATION'))
  })

  it('falls back to name when display_name is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dmn-test-'))

    const prompt = await assembleDMNPrompt(dir, { name: 'ehsre' })

    assert.ok(prompt.includes('ehsre'))
  })
})

describe('buildDMNContext', () => {
  it('extracts text from user and assistant messages', () => {
    const messages = [
      { role: 'user', content: 'alice: hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi alice!' }] },
      { role: 'user', content: 'alice: how are you?' },
    ]

    const context = buildDMNContext(messages)

    assert.ok(context.includes('alice: hello'))
    assert.ok(context.includes('Hi alice!'))
    assert.ok(context.includes('alice: how are you?'))
  })

  it('skips tool_result user messages', () => {
    const messages = [
      { role: 'user', content: 'alice: check status' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Checking...' },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      ]},
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'All good!' }] },
      { role: 'user', content: 'alice: thanks' },
    ]

    const context = buildDMNContext(messages)

    assert.ok(context.includes('alice: check status'))
    assert.ok(context.includes('All good!'))
    assert.ok(context.includes('alice: thanks'))
    assert.ok(!context.includes('tool_result'))
  })

  it('skips tool_use blocks from assistant messages', () => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
      ]},
    ]

    const context = buildDMNContext(messages)

    assert.ok(context.includes('Let me check.'))
    assert.ok(!context.includes('bash'))
    assert.ok(!context.includes('tool_use'))
  })

  it('respects the limit parameter', () => {
    const messages = [
      { role: 'user', content: 'msg1' },
      { role: 'user', content: 'msg2' },
      { role: 'user', content: 'msg3' },
      { role: 'user', content: 'msg4' },
    ]

    const context = buildDMNContext(messages, 2)

    assert.ok(!context.includes('msg1'))
    assert.ok(!context.includes('msg2'))
    assert.ok(context.includes('msg3'))
    assert.ok(context.includes('msg4'))
  })

  it('returns empty string for empty messages', () => {
    assert.equal(buildDMNContext([]), '')
  })
})
