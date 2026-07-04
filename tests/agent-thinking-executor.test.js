// Covers the extended-thinking lifecycle and hybrid-executor gating in the
// agent loops:
//  - thinking blocks survive a tool-loop iteration (so the signed block can be
//    replayed alongside tool_use) but are stripped from the returned history
//  - the executor shim is skipped entirely for Claude orchestrators
//  - the executor runs with toolChoice 'auto' (not 'required') for non-Claude
//    orchestrators, so it can answer "done"
//  - config.maxOutputTokens is honored (default 16384)

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runAgent, runHybridAgent } from '../server/lib/agent.js'

// Provider whose streamMessage returns scripted responses and records a deep
// snapshot of the messages array it was called with (the array is mutated in
// place by the agent, so a live reference would only show the final state).
function recordingProvider(responses) {
  let i = 0
  const seen = []
  const streamMessage = mock.fn(async (params) => {
    seen.push(structuredClone(params.messages))
    return responses[i++] || responses[responses.length - 1]
  })
  return { streamMessage, seen }
}

function scriptedProvider(responses) {
  let i = 0
  return { streamMessage: mock.fn(async () => responses[i++] || responses[responses.length - 1]) }
}

const noop = () => {}

describe('extended thinking — in-loop preservation, loop-exit strip', () => {
  const thinkThenTool = {
    contentBlocks: [
      { type: 'thinking', thinking: 'let me think', signature: 'sig-abc' },
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
    ],
    stopReason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  }
  const finalText = {
    contentBlocks: [{ type: 'text', text: 'Done.' }],
    stopReason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 },
  }

  it('runHybridAgent replays the signed thinking block, then strips it from returned messages', async () => {
    const provider = recordingProvider([thinkThenTool, finalText])
    const tools = { definitions: [{ name: 'bash', description: 'run' }], execute: mock.fn(async () => ({ output: 'files' })) }
    const config = { provider, model: 'claude-opus-4-6' } // Claude → no executor

    const result = await runHybridAgent('system', [{ role: 'user', content: 'list' }], tools, config, noop)

    // The second orchestrator call saw the assistant tool_use turn WITH its
    // thinking block (and signature) intact — required for replay.
    const secondCall = provider.seen[1]
    const replayed = secondCall.find(m => m.role === 'assistant')
    const thinkingBlock = replayed.content.find(b => b.type === 'thinking')
    assert.ok(thinkingBlock, 'thinking block preserved in-loop for replay')
    assert.equal(thinkingBlock.signature, 'sig-abc', 'signature survives into the replayed message')

    // Returned history is thinking-free, but the tool_use block is retained.
    for (const m of result.messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        assert.ok(!m.content.some(b => b.type === 'thinking'), 'no thinking in returned history')
      }
    }
    const toolTurn = result.messages.find(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'))
    assert.ok(toolTurn, 'tool_use block retained after strip')
  })

  it('runAgent replays the signed thinking block, then strips it from returned messages', async () => {
    const provider = recordingProvider([thinkThenTool, finalText])
    const tools = { definitions: [{ name: 'bash', description: 'run' }], execute: mock.fn(async () => ({ output: 'files' })) }
    const config = { provider, model: 'claude-opus-4-6' }

    const result = await runAgent('system', [{ role: 'user', content: 'list' }], tools, config, noop)

    const secondCall = provider.seen[1]
    const replayed = secondCall.find(m => m.role === 'assistant')
    assert.ok(replayed.content.some(b => b.type === 'thinking'), 'thinking preserved in-loop')

    for (const m of result.messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        assert.ok(!m.content.some(b => b.type === 'thinking'), 'no thinking in returned history')
      }
    }
  })
})

describe('hybrid executor gating', () => {
  const orchestratorScript = [
    { contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }], stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
    { contentBlocks: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } },
  ]
  const makeExecutor = () => ({
    streamMessage: mock.fn(async () => ({ contentBlocks: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })),
  })

  it('skips the executor loop entirely for a Claude orchestrator', async () => {
    const orchestrator = scriptedProvider(orchestratorScript)
    const executor = makeExecutor()
    const registry = { resolve: (m) => (m === 'gemma-exec' ? { modelId: 'gemma-exec', provider: executor } : { modelId: m, provider: orchestrator }) }
    const tools = { definitions: [{ name: 'bash', description: 'run' }], execute: mock.fn(async () => ({ output: 'files' })) }
    const config = { provider: orchestrator, model: 'claude-sonnet-4-6', executorModel: 'gemma-exec', registry }

    await runHybridAgent('system', [{ role: 'user', content: 'list' }], tools, config, noop)

    assert.equal(executor.streamMessage.mock.callCount(), 0, 'executor never runs for a Claude orchestrator')
  })

  it("runs the executor with toolChoice 'auto' for a non-Claude orchestrator", async () => {
    const orchestrator = scriptedProvider(orchestratorScript)
    const executor = makeExecutor()
    const registry = { resolve: (m) => (m === 'gemma-exec' ? { modelId: 'gemma-exec', provider: executor } : { modelId: m, provider: orchestrator }) }
    const tools = { definitions: [{ name: 'bash', description: 'run' }], execute: mock.fn(async () => ({ output: 'files' })) }
    const config = { provider: orchestrator, model: 'gemma-4-31b', executorModel: 'gemma-exec', registry }

    await runHybridAgent('system', [{ role: 'user', content: 'list' }], tools, config, noop)

    assert.equal(executor.streamMessage.mock.callCount(), 1, 'executor runs once for a non-Claude orchestrator')
    const execParams = executor.streamMessage.mock.calls[0].arguments[0]
    assert.equal(execParams.toolChoice, 'auto', "executor toolChoice must be 'auto' so it can answer 'done'")
  })
})

describe('config.maxOutputTokens', () => {
  const textOnly = [{ contentBlocks: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }]
  const noTools = () => ({ definitions: [], execute: mock.fn() })

  it('runHybridAgent honors config.maxOutputTokens', async () => {
    const provider = scriptedProvider(textOnly)
    const config = { provider, model: 'claude-opus-4-6', maxOutputTokens: 32000 }
    await runHybridAgent('system', [{ role: 'user', content: 'hi' }], noTools(), config, noop)
    assert.equal(provider.streamMessage.mock.calls[0].arguments[0].maxTokens, 32000)
  })

  it('runHybridAgent defaults maxTokens to 16384 when maxOutputTokens is unset', async () => {
    const provider = scriptedProvider(textOnly)
    const config = { provider, model: 'claude-opus-4-6' }
    await runHybridAgent('system', [{ role: 'user', content: 'hi' }], noTools(), config, noop)
    assert.equal(provider.streamMessage.mock.calls[0].arguments[0].maxTokens, 16384)
  })

  it('runAgent honors config.maxOutputTokens', async () => {
    const provider = scriptedProvider(textOnly)
    const config = { provider, model: 'claude-opus-4-6', maxOutputTokens: 24000 }
    await runAgent('system', [{ role: 'user', content: 'hi' }], noTools(), config, noop)
    assert.equal(provider.streamMessage.mock.calls[0].arguments[0].maxTokens, 24000)
  })
})
