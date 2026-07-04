import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runHybridAgent } from '../server/lib/agent.js'
import { CircuitOpenError } from '../server/lib/circuit-breaker.js'

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

  it('falls back on 400 provider errors (credit balance, auth, etc.)', async () => {
    // Regression: a 400 from Anthropic ("credit balance too low") used to be
    // classified non-retryable and bypass the fallback chain, taking the
    // cognition layer offline. Fallbacks cross providers, so per-provider
    // 4xx errors must still try the backup.
    const failingOrchestrator = {
      streamMessage: mock.fn(async () => {
        const err = new Error('Your credit balance is too low to access the Anthropic API.')
        err.status = 400
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
        if (modelString === 'gpt-5.4:openai') return { modelId: 'gpt-5.4', provider: workingOrchestrator }
        return { modelId: modelString, provider: failingOrchestrator }
      },
    }

    const tools = makeTools([])
    const config = {
      provider: failingOrchestrator,
      model: 'claude-sonnet-4-6',
      orchestratorFallbackModels: ['gpt-5.4:openai'],
      registry: mockRegistry,
    }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent)

    assert.equal(failingOrchestrator.streamMessage.mock.callCount(), 1)
    assert.ok(workingOrchestrator.streamMessage.mock.callCount() >= 1)
    assert.ok(events.find(e => e.type === 'model_fallback' && e.to === 'gpt-5.4'))
    assert.ok(events.find(e => e.type === 'done'))
  })

  it('iterates orchestrator fallback chain when nudging an empty post-tool turn', async () => {
    // Regression: when the orchestrator returned empty text after a tool
    // result, _nudgeIfEmpty bypassed the fallback wrapper and threw on a
    // single primary failure. ehsre saw "attention layer unavailable" with
    // only gemini-2.5-pro in triedModels even though claude-haiku-4-5 and
    // SecuredTEE/gemma4-31b were configured as fallbacks.
    const failingPrimary = {
      streamMessage: mock.fn(async () => {
        const err = new Error('Gemini server error 503: high demand')
        err.status = 503
        throw err
      }),
    }
    const workingFallback = makeProvider({
      responses: [
        // Turn 1: orchestrator emits a tool_use (e.g. react_to_message)
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'react', input: { x: 1 } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 5 },
        },
        // Turn 2 (post-tool): empty content — triggers _nudgeIfEmpty
        {
          contentBlocks: [],
          stopReason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 0 },
        },
        // Nudge call: must reach this fallback when primary 503s
        {
          contentBlocks: [{ type: 'text', text: 'OK done.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 5 },
        },
      ],
    })

    const mockRegistry = {
      resolve(modelString) {
        if (modelString === 'claude-haiku-4-5') return { modelId: 'claude-haiku-4-5', provider: workingFallback }
        return { modelId: modelString, provider: failingPrimary }
      },
    }

    const tools = makeTools([{ name: 'react', description: 'react' }])
    const config = {
      provider: failingPrimary,
      model: 'gemini-2.5-pro',
      layer: 'attention',
      orchestratorFallbackModels: ['claude-haiku-4-5'],
      registry: mockRegistry,
    }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent)

    // Primary tried 3 times (turn 1, turn 2, nudge); fallback handles all 3
    assert.equal(failingPrimary.streamMessage.mock.callCount(), 3)
    assert.equal(workingFallback.streamMessage.mock.callCount(), 3)

    // Final assistant message is the nudge text from the fallback model
    const lastAssistant = result.messages[result.messages.length - 1]
    assert.equal(lastAssistant.role, 'assistant')
    assert.ok(lastAssistant.content.some(b => b.type === 'text' && b.text === 'OK done.'))

    // Three model_fallback events — one per call that fell through
    const fallbackEvents = events.filter(e => e.type === 'model_fallback')
    assert.equal(fallbackEvents.length, 3)
    assert.ok(fallbackEvents.every(e => e.from === 'gemini-2.5-pro' && e.to === 'claude-haiku-4-5'))
  })

  it('surfaces layered error with full triedModels list when nudge fallback chain also fails', async () => {
    // Companion regression: when the entire chain (primary + fallback) is
    // down during the nudge, the surfaced error must list every model that
    // was tried, not just the primary.
    const failingPrimary = {
      streamMessage: mock.fn(async () => {
        const err = new Error('Gemini server error 503')
        err.status = 503
        throw err
      }),
    }
    let fallbackCalls = 0
    const failingFallback = {
      streamMessage: mock.fn(async () => {
        // Let the main loop succeed (turns 1 and 2) by not throwing on
        // those. Throw only on the nudge call (the third one).
        fallbackCalls++
        if (fallbackCalls === 1) {
          // Turn 1: tool_use
          return {
            contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'react', input: { x: 1 } }],
            stopReason: 'tool_use',
            usage: { input_tokens: 50, output_tokens: 5 },
          }
        }
        if (fallbackCalls === 2) {
          // Turn 2: empty content
          return {
            contentBlocks: [],
            stopReason: 'end_turn',
            usage: { input_tokens: 50, output_tokens: 0 },
          }
        }
        // Nudge: also fails
        const err = new Error('claude also down')
        err.status = 500
        throw err
      }),
    }

    const mockRegistry = {
      resolve(modelString) {
        if (modelString === 'claude-haiku-4-5') return { modelId: 'claude-haiku-4-5', provider: failingFallback }
        return { modelId: modelString, provider: failingPrimary }
      },
    }

    const tools = makeTools([{ name: 'react', description: 'react' }])
    const config = {
      provider: failingPrimary,
      model: 'gemini-2.5-pro',
      layer: 'attention',
      orchestratorFallbackModels: ['claude-haiku-4-5'],
      registry: mockRegistry,
    }
    const { onEvent } = collectEvents()

    await assert.rejects(
      runHybridAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent),
      (err) => {
        assert.equal(err.layer, 'attention')
        assert.deepEqual(err.triedModels, ['gemini-2.5-pro', 'claude-haiku-4-5'])
        return true
      },
    )
  })

  it('surfaces layered error with full triedModels list when entire fallback chain fails', async () => {
    const primary = {
      streamMessage: mock.fn(async () => {
        const err = new Error('credit balance too low')
        err.status = 400
        throw err
      }),
    }
    const backup = {
      streamMessage: mock.fn(async () => {
        const err = new Error('openai also unhappy')
        err.status = 500
        throw err
      }),
    }

    const mockRegistry = {
      resolve(modelString) {
        if (modelString === 'gpt-5.4:openai') return { modelId: 'gpt-5.4', provider: backup }
        return { modelId: modelString, provider: primary }
      },
    }

    const tools = makeTools([])
    const config = {
      provider: primary,
      model: 'claude-sonnet-4-6',
      layer: 'cognition',
      orchestratorFallbackModels: ['gpt-5.4:openai'],
      registry: mockRegistry,
    }
    const { onEvent } = collectEvents()

    await assert.rejects(
      runHybridAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent),
      (err) => {
        assert.equal(err.layer, 'cognition')
        assert.deepEqual(err.triedModels, ['claude-sonnet-4-6', 'gpt-5.4'])
        return true
      },
    )
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
      // Non-Claude orchestrator: the executor shim only engages for weak
      // (non-Claude) orchestrators; Claude models chain tools natively and
      // skip the executor loop entirely.
      model: 'gemma-4-31b',
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

  it('skips executor with CircuitOpenError and falls through to next model', async () => {
    const deadProvider = {
      streamMessage: mock.fn(async () => {
        throw new CircuitOpenError('http://dead.provider', 30)
      }),
    }
    const goodProvider = {
      streamMessage: mock.fn(async (params, onEvent) => ({
        contentBlocks: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      })),
    }

    const orchestratorProvider = makeProvider({
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Here are the files.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 30 },
        },
      ],
    })

    const tools = makeTools([{ name: 'bash', description: 'Run command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }])

    const mockRegistry = {
      resolve: (modelStr) => {
        if (modelStr === 'dead-model') return { modelId: 'dead-model', provider: deadProvider }
        if (modelStr === 'good-model') return { modelId: 'good-model', provider: goodProvider }
        return { modelId: modelStr, provider: orchestratorProvider }
      },
    }

    const config = {
      provider: orchestratorProvider,
      model: 'orchestrator-model',
      executorModel: 'dead-model',
      executorFallbackModels: ['good-model'],
      registry: mockRegistry,
    }

    const { events, onEvent } = collectEvents()
    const result = await runHybridAgent('system', [{ role: 'user', content: 'list files' }], tools, config, onEvent)

    assert.equal(deadProvider.streamMessage.mock.callCount(), 1)
    assert.equal(goodProvider.streamMessage.mock.callCount(), 1)
  })

  it('emits assistant_text_turn event after each turn that produces text, before tool execution', async () => {
    // Regression: alice produced 1527 tokens of text + called deep_think in the same turn.
    // deep_think stalled for 16 minutes. The text was streamed via text_delta but never
    // persisted to history because chat-session.js only writes history after the full
    // orchestrator loop returns. Fix: emit a standalone assistant_text_turn event at each
    // turn boundary so chat-session.js can flush text to history immediately, independent
    // of whether downstream tools complete.
    const provider = makeProvider({
      responses: [
        {
          // Turn 1: text + tool_use together (the alice case)
          contentBlocks: [
            { type: 'text', text: 'Got it, working on it now.' },
            { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 30 },
        },
        {
          // Turn 2: tool_use only, no text — must NOT emit assistant_text_turn
          contentBlocks: [
            { type: 'tool_use', id: 'toolu_2', name: 'bash', input: { command: 'pwd' } },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 150, output_tokens: 20 },
        },
        {
          // Turn 3: final text, no tool — must emit assistant_text_turn
          contentBlocks: [{ type: 'text', text: 'All done!' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 10 },
        },
      ],
    })
    const tools = makeTools([{ name: 'bash', description: 'Run a command' }])
    const config = { provider, model: 'claude-sonnet-4-6' }
    const { events, onEvent } = collectEvents()

    await runHybridAgent('system', [{ role: 'user', content: 'list files' }], tools, config, onEvent)

    // One event per turn that had non-empty text (turns 1 and 3 — not turn 2)
    const textTurnEvents = events.filter(e => e.type === 'assistant_text_turn')
    assert.equal(textTurnEvents.length, 2, 'expected assistant_text_turn for turns 1 and 3 only')
    assert.equal(textTurnEvents[0].text, 'Got it, working on it now.')
    assert.equal(textTurnEvents[1].text, 'All done!')

    // Turn 1's text_turn must be emitted BEFORE any tool_result — this is the core guarantee:
    // if a tool hangs indefinitely, the preceding text has already been flushed downstream.
    const firstTextTurnIdx = events.findIndex(e => e.type === 'assistant_text_turn')
    const firstToolResultIdx = events.findIndex(e => e.type === 'tool_result')
    assert.ok(firstTextTurnIdx >= 0, 'assistant_text_turn must be emitted')
    assert.ok(firstToolResultIdx >= 0, 'tool_result must be emitted')
    assert.ok(
      firstTextTurnIdx < firstToolResultIdx,
      `assistant_text_turn must come before tool_result (text_turn at ${firstTextTurnIdx}, tool_result at ${firstToolResultIdx})`,
    )
  })

  it('breaks the orchestrator loop and skips the nudge after react_to_message', async () => {
    // After react_to_message success, the tool returns _endTurn: true.
    // runHybridAgent must break the loop immediately, NOT call streamMessage
    // again, and NOT invoke _nudgeIfEmpty.
    const provider = makeProvider({
      responses: [
        // Turn 1: orchestrator emits a react_to_message tool_use
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_react_1', name: 'react_to_message', input: { messageId: 'abcd1234', emoji: '👍' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 5 },
        },
        // No further turns should be requested. If the loop wrongly continues,
        // this response is what would be returned next — we assert it isn't.
        {
          contentBlocks: [{ type: 'text', text: 'SHOULD_NOT_REACH' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 5 },
        },
      ],
    })
    // tools.execute returns _endTurn: true to mimic the real react_to_message
    // success contract (Task 1).
    const tools = {
      definitions: [{ name: 'react_to_message', description: 'react' }],
      execute: mock.fn(async () => ({ output: 'Reaction delivered.', _endTurn: true })),
    }
    const config = { provider, model: 'claude-sonnet-4-20250514' }
    const { events, onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'react with thumbs' }], tools, config, onEvent)

    // Exactly one orchestrator call — the loop must break after react.
    assert.equal(provider.streamMessage.mock.callCount(), 1)
    assert.equal(tools.execute.mock.callCount(), 1)

    // Final message history: user, assistant(tool_use), user(tool_result).
    // No fourth assistant message — _nudgeIfEmpty did not fire.
    assert.equal(result.messages.length, 3)
    assert.equal(result.messages[0].role, 'user')
    assert.equal(result.messages[1].role, 'assistant')
    assert.equal(result.messages[1].content[0].type, 'tool_use')
    assert.equal(result.messages[2].role, 'user')
    assert.equal(result.messages[2].content[0].type, 'tool_result')

    // No "SHOULD_NOT_REACH" text leaked into events.
    assert.ok(!events.some(e => e.type === 'assistant_text_turn' && e.text === 'SHOULD_NOT_REACH'))

    // done event still fires.
    assert.ok(events.find(e => e.type === 'done'))
  })

  it('does NOT short-circuit the loop when react_to_message returns an error', async () => {
    // Error returns omit _endTurn, so the model must get another turn to
    // recover / explain. Verify the loop continues normally on react errors.
    const provider = makeProvider({
      responses: [
        {
          contentBlocks: [{ type: 'tool_use', id: 'toolu_react_1', name: 'react_to_message', input: { messageId: 'bad', emoji: '👍' } }],
          stopReason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 5 },
        },
        {
          contentBlocks: [{ type: 'text', text: 'Sorry, I had a bad ID.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 8 },
        },
      ],
    })
    const tools = {
      definitions: [{ name: 'react_to_message', description: 'react' }],
      execute: mock.fn(async () => ({ output: 'messageId not found.', is_error: true })),
    }
    const config = { provider, model: 'claude-sonnet-4-20250514' }
    const { onEvent } = collectEvents()

    const result = await runHybridAgent('system', [{ role: 'user', content: 'react' }], tools, config, onEvent)

    // Two orchestrator calls — error did not end the turn.
    assert.equal(provider.streamMessage.mock.callCount(), 2)
    // Final assistant message is the recovery text.
    const lastAssistant = result.messages[result.messages.length - 1]
    assert.ok(lastAssistant.content.some(b => b.type === 'text' && b.text === 'Sorry, I had a bad ID.'))
  })
})
