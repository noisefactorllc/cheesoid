import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runHybridAgent } from '../server/lib/agent.js'

function makeTools(definitions = []) {
  const executeFn = mock.fn(async (name, input) => ({ output: `result of ${name}` }))
  return {
    definitions,
    execute: executeFn,
  }
}

function makeProvider({ responses, supportsIntentRouting = false, classifyIntentResult = 'auto' } = {}) {
  let callIndex = 0
  const streamMessageFn = mock.fn(async (params, onEvent) => {
    const resp = responses[callIndex++] || responses[responses.length - 1]
    for (const block of resp.contentBlocks) {
      if (block.type === 'text') {
        onEvent({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use') {
        onEvent({ type: 'tool_start', name: block.name })
      }
    }
    return resp
  })

  const classifyIntentFn = mock.fn(async () => classifyIntentResult)

  const provider = {
    streamMessage: streamMessageFn,
    classifyIntent: classifyIntentFn,
  }

  if (supportsIntentRouting) {
    provider.supportsIntentRouting = true
  }

  return provider
}

function collectEvents() {
  const events = []
  return { events, onEvent: (e) => events.push(e) }
}

describe('runHybridAgent', () => {
  it('handles text-only response from orchestrator', async () => {
    const provider = makeProvider({
      responses: [{
        contentBlocks: [{ type: 'text', text: 'Hello there!' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      }],
    })
    const tools = makeTools([])
    const config = { provider, model: 'claude-sonnet-4-20250514' }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent)

    assert.equal(result.usage.input_tokens, 100)
    assert.equal(result.usage.output_tokens, 20)
    assert.equal(tools.execute.mock.callCount(), 0)
    const doneEvent = events.find(e => e.type === 'done')
    assert.ok(doneEvent)
    assert.equal(doneEvent.usage.input_tokens, 100)
  })

  it('executes tools directly without executor LLM', async () => {
    const provider = makeProvider({
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 150, output_tokens: 30 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Done! Here are the files.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 25 },
        },
      ],
    })
    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = { provider, model: 'claude-sonnet-4-20250514' }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'list files' }], tools, config, onEvent)

    // tools.execute was called directly
    assert.equal(tools.execute.mock.callCount(), 1)
    assert.equal(tools.execute.mock.calls[0].arguments[0], 'bash')
    assert.deepEqual(tools.execute.mock.calls[0].arguments[1], { command: 'ls' })

    // tool_result event was emitted
    const toolResultEvent = events.find(e => e.type === 'tool_result')
    assert.ok(toolResultEvent)
    assert.equal(toolResultEvent.name, 'bash')

    // Provider was called twice (initial + after tool result)
    assert.equal(provider.streamMessage.mock.callCount(), 2)

    // Usage was accumulated
    assert.equal(result.usage.input_tokens, 350)
    assert.equal(result.usage.output_tokens, 55)
  })

  it('appends tool results to message history for orchestrator', async () => {
    const messages = [{ role: 'user', content: 'list files' }]
    const provider = makeProvider({
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Here are the files.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      ],
    })
    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = { provider, model: 'claude-sonnet-4-20250514' }
    const { onEvent } = collectEvents()

    const result = await runHybridAgent('system', messages, tools, config, onEvent)

    // Message history: user, assistant(tool_use), user(tool_result), assistant(text)
    assert.equal(result.messages.length, 4)
    assert.equal(result.messages[0].role, 'user')
    assert.equal(result.messages[1].role, 'assistant')
    assert.equal(result.messages[1].content[0].type, 'tool_use')
    assert.equal(result.messages[2].role, 'user')
    assert.equal(result.messages[2].content[0].type, 'tool_result')
    assert.equal(result.messages[3].role, 'assistant')
    assert.equal(result.messages[3].content[0].type, 'text')
  })

  it('respects maxTurns limit', async () => {
    // Provider always returns tool_use
    const provider = makeProvider({
      responses: [{
        contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }],
        stopReason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      }],
    })
    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = { provider, model: 'claude-sonnet-4-20250514', maxTurns: 3 }
    const { events, onEvent } = collectEvents()

    await runHybridAgent('system', [{ role: 'user', content: 'loop' }], tools, config, onEvent)

    // Should stop after maxTurns iterations
    assert.equal(tools.execute.mock.callCount(), 3)
    assert.ok(events.find(e => e.type === 'done'))
  })

  it('applies intent routing when orchestrator supports it', async () => {
    const provider = makeProvider({
      supportsIntentRouting: true,
      classifyIntentResult: 'required',
      responses: [{
        contentBlocks: [{ type: 'text', text: 'I will help.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 10 },
      }],
    })
    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = { provider, model: 'test-model' }
    const { onEvent } = collectEvents()

    await runHybridAgent('system', [{ role: 'user', content: 'what happened yesterday' }], tools, config, onEvent)

    // classifyIntent should have been called (heuristic returns 'uncertain' for this input)
    assert.equal(provider.classifyIntent.mock.callCount(), 1)
  })

  it('skips intent routing for anthropic orchestrator', async () => {
    const provider = makeProvider({
      supportsIntentRouting: false,
      responses: [{
        contentBlocks: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 10 },
      }],
    })
    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = { provider, model: 'claude-sonnet-4-20250514' }
    const { onEvent } = collectEvents()

    await runHybridAgent('system', [{ role: 'user', content: 'what happened yesterday' }], tools, config, onEvent)

    // classifyIntent should NOT have been called
    assert.equal(provider.classifyIntent.mock.callCount(), 0)
  })

  it('falls back to next orchestrator model on failure', async () => {
    const failingOrchestrator = {
      streamMessage: mock.fn(async () => {
        const err = new Error('overloaded')
        err.status = 529
        throw err
      }),
    }
    const workingOrchestrator = makeProvider({
      responses: [{
        contentBlocks: [{ type: 'text', text: 'Fallback response.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      }],
    })

    const mockRegistry = {
      resolve(modelString) {
        if (modelString === 'claude-sonnet-4-6') return { modelId: 'claude-sonnet-4-6', provider: workingOrchestrator }
        return { modelId: modelString, provider: failingOrchestrator }
      },
    }

    const tools = makeTools([])
    const config = {
      provider: failingOrchestrator,
      model: 'claude-opus-4-6',
      orchestratorFallbackModels: ['claude-sonnet-4-6'],
      registry: mockRegistry,
    }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent)

    assert.equal(failingOrchestrator.streamMessage.mock.callCount(), 1)
    assert.ok(workingOrchestrator.streamMessage.mock.callCount() >= 1)
    assert.ok(events.find(e => e.type === 'done'))
  })

  it('tracks reasoner usage separately when deep_think is called', async () => {
    const provider = makeProvider({
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'deep_think', input: JSON.stringify({ prompt: 'analyze this' }) }],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Based on my analysis...' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 40 },
        },
      ],
    })

    const deepThinkResult = { output: 'Deep reasoning result.', _usage: { input_tokens: 500, output_tokens: 200 }, _model: 'o3' }
    const tools = makeTools([{ name: 'deep_think', description: 'Reason deeply' }])
    tools.execute = mock.fn(async (name, input, options) => deepThinkResult)

    const config = { provider, model: 'claude-sonnet-4-6' }
    const { events, onEvent } = collectEvents()

    await runHybridAgent('system', [{ role: 'user', content: 'think hard' }], tools, config, onEvent)

    const doneEvent = events.find(e => e.type === 'done')
    assert.ok(doneEvent)
    // Total should include reasoner usage: 100+200+500=800 in, 20+40+200=260 out
    assert.equal(doneEvent.usage.input_tokens, 800)
    assert.equal(doneEvent.usage.output_tokens, 260)
  })

  it('full reasoning flow: orchestrator calls deep_think, gets result, responds', async () => {
    const orchestrator = makeProvider({
      responses: [
        {
          // Orchestrator decides to think deeply
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'deep_think', input: { prompt: 'Is P=NP?' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 200, output_tokens: 50 },
        },
        {
          // Orchestrator uses reasoning result to respond
          contentBlocks: [{ type: 'text', text: 'After careful analysis, probably not.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 400, output_tokens: 80 },
        },
      ],
    })

    // Mock reasoning provider
    const reasoningProvider = {
      streamMessage: mock.fn(async (params, onEvent) => {
        onEvent({ type: 'thinking_delta', text: 'Let me consider the implications...' })
        onEvent({ type: 'text_delta', text: 'Analysis suggests P≠NP based on...' })
        return {
          contentBlocks: [{ type: 'text', text: 'Analysis suggests P≠NP based on...' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 300, output_tokens: 150 },
        }
      }),
    }

    const mockRegistry = {
      resolve(modelString) {
        if (modelString === 'o3:openai') return { modelId: 'o3', provider: reasoningProvider }
        return { modelId: modelString, provider: orchestrator }
      },
    }

    // Build tools with deep_think mock that simulates what buildReasonerTools does
    const deepThinkExecute = async (name, input, options) => {
      const onEvent = options?.onEvent || (() => {})
      const { modelId, provider } = mockRegistry.resolve('o3:openai')
      const result = await provider.streamMessage(
        { model: modelId, maxTokens: 16384, system: 'You are a reasoning assistant.', messages: [{ role: 'user', content: input.prompt }], tools: [], serverTools: [], thinkingBudget: null },
        onEvent,
      )
      const text = result.contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
      return { output: text, _usage: result.usage, _model: modelId }
    }

    const tools = {
      definitions: [{ name: 'deep_think', description: 'Reason deeply', input_schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }],
      execute: mock.fn(async (name, input, options) => {
        if (name === 'deep_think') return deepThinkExecute(name, input, options)
        return { output: `result of ${name}` }
      }),
    }

    const config = { provider: orchestrator, model: 'claude-opus-4-6', registry: mockRegistry }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'Is P=NP?' }], tools, config, onEvent)

    // Reasoning provider was called
    assert.equal(reasoningProvider.streamMessage.mock.callCount(), 1)

    // Thinking deltas were forwarded
    assert.ok(events.some(e => e.type === 'thinking_delta'))

    // Final response came from orchestrator
    const lastAssistant = result.messages[result.messages.length - 1]
    assert.equal(lastAssistant.role, 'assistant')
    assert.ok(lastAssistant.content.some(b => b.type === 'text' && b.text.includes('probably not')))

    // Done event includes all usage (orchestrator + reasoner)
    const doneEvent = events.find(e => e.type === 'done')
    assert.equal(doneEvent.usage.input_tokens, 200 + 400 + 300)
    assert.equal(doneEvent.usage.output_tokens, 50 + 80 + 150)
  })

  it('executor fallback uses registry when available', async () => {
    const orchestrator = makeProvider({
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Done.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      ],
    })

    // Executor that fails on first call
    const failingExecutor = {
      streamMessage: mock.fn(async () => {
        throw new Error('rate limited')
      }),
    }
    const workingExecutor = {
      streamMessage: mock.fn(async (params, onEvent) => ({
        contentBlocks: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      })),
    }

    // Mock registry that returns different providers
    const mockRegistry = {
      resolve(modelString) {
        if (modelString === 'failing-model') return { modelId: 'failing-model', provider: failingExecutor }
        if (modelString === 'claude-haiku-4-5') return { modelId: 'claude-haiku-4-5', provider: workingExecutor }
        return { modelId: modelString, provider: orchestrator }
      },
    }

    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = {
      provider: orchestrator,
      model: 'claude-sonnet-4-6',
      executorProvider: failingExecutor,
      executorModel: 'failing-model',
      executorFallbackModels: ['claude-haiku-4-5'],
      registry: mockRegistry,
    }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'list files' }], tools, config, onEvent)

    // Failing executor was called, then working one succeeded
    assert.equal(failingExecutor.streamMessage.mock.callCount(), 1)
    assert.equal(workingExecutor.streamMessage.mock.callCount(), 1)
    assert.ok(events.find(e => e.type === 'done'))
  })
})
