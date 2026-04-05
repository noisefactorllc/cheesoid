import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assembleDMNPrompt, buildDMNContext, runDMNPass } from '../server/lib/dmn.js'

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

function makeProvider(response) {
  return {
    streamMessage: mock.fn(async (params, onEvent) => response),
  }
}

describe('runDMNPass', () => {
  it('calls provider with correct params and returns assessment', async () => {
    const provider = makeProvider({
      contentBlocks: [{ type: 'text', text: 'SITUATION: Casual greeting.\nINTERPRETATION: User wants to chat.\nAPPROACH: Be friendly.' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 50 },
    })

    const messages = [
      { role: 'user', content: 'alice: hey how are you?' },
    ]

    const { assessment, usage } = await runDMNPass('system prompt', messages, provider, 'haiku')

    assert.ok(assessment.includes('SITUATION'))
    assert.equal(usage.input_tokens, 200)
    assert.equal(usage.output_tokens, 50)

    // Verify provider was called correctly
    const call = provider.streamMessage.mock.calls[0]
    const params = call.arguments[0]
    assert.equal(params.model, 'haiku')
    assert.equal(params.maxTokens, 512)
    assert.deepEqual(params.tools, [])
    assert.deepEqual(params.serverTools, [])
    assert.equal(params.thinkingBudget, null)
    // System prompt should be the dmn prompt (no context since only 1 message)
    assert.equal(params.system, 'system prompt')
    // Messages should be a single user message with the raw input
    assert.equal(params.messages.length, 1)
    assert.equal(params.messages[0].content, 'alice: hey how are you?')
  })

  it('includes recent context in system prompt when available', async () => {
    const provider = makeProvider({
      contentBlocks: [{ type: 'text', text: 'assessment' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 300, output_tokens: 40 },
    })

    const messages = [
      { role: 'user', content: 'alice: check the server' },
      { role: 'assistant', content: [{ type: 'text', text: 'Server looks good.' }] },
      { role: 'user', content: 'alice: now check the pipeline' },
    ]

    await runDMNPass('base prompt', messages, provider, 'haiku')

    const call = provider.streamMessage.mock.calls[0]
    const system = call.arguments[0].system
    assert.ok(system.includes('base prompt'))
    assert.ok(system.includes('RECENT CONTEXT'))
    assert.ok(system.includes('alice: check the server'))
    assert.ok(system.includes('Server looks good.'))
    // Raw input should NOT be in context — it's in the user message
    assert.ok(!system.includes('now check the pipeline'))
  })

  it('returns null assessment on provider error', async () => {
    const provider = {
      streamMessage: mock.fn(async () => { throw new Error('503 overloaded') }),
    }

    const messages = [{ role: 'user', content: 'alice: hello' }]
    const { assessment, usage } = await runDMNPass('prompt', messages, provider, 'haiku')

    assert.equal(assessment, null)
    assert.equal(usage.input_tokens, 0)
    assert.equal(usage.output_tokens, 0)
  })

  it('returns null when last message is not a user text message', async () => {
    const provider = makeProvider({
      contentBlocks: [{ type: 'text', text: 'should not reach' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ]

    const { assessment } = await runDMNPass('prompt', messages, provider, 'haiku')

    assert.equal(assessment, null)
    assert.equal(provider.streamMessage.mock.callCount(), 0)
  })

  it('returns null when response has no text block', async () => {
    const provider = makeProvider({
      contentBlocks: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 0 },
    })

    const messages = [{ role: 'user', content: 'alice: hi' }]
    const { assessment, usage } = await runDMNPass('prompt', messages, provider, 'haiku')

    assert.equal(assessment, null)
    assert.equal(usage.input_tokens, 100)
  })
})

