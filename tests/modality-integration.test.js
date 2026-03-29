import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { runHybridAgent } from '../server/lib/agent.js'
import { Modality } from '../server/lib/modality.js'

function makeProvider(responses) {
  let callIndex = 0
  return {
    streamMessage: mock.fn(async (params, onEvent) => {
      const resp = responses[callIndex++] || responses[responses.length - 1]
      for (const block of resp.contentBlocks) {
        if (block.type === 'text') onEvent({ type: 'text_delta', text: block.text })
        if (block.type === 'tool_use') onEvent({ type: 'tool_start', name: block.name })
      }
      return resp
    }),
  }
}

function collectEvents() {
  const events = []
  return { events, onEvent: (e) => events.push(e) }
}

describe('modality integration — step_up re-run', () => {
  it('re-runs turn with cognition model after step_up', async () => {
    const modality = new Modality({ attention: 'haiku:anthropic', cognition: 'sonnet:anthropic' })

    // Attention provider: calls step_up tool
    const attentionProvider = makeProvider([
      {
        contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'step_up', input: { reason: 'user asked directly' } }],
        stopReason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ])

    // Cognition provider: responds with text
    const cognitionProvider = makeProvider([
      {
        contentBlocks: [{ type: 'text', text: 'Hello! Let me help you with that.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 40 },
      },
    ])

    const registry = {
      resolve: (modelStr) => {
        if (modelStr === 'haiku:anthropic') return { modelId: 'haiku', provider: attentionProvider }
        if (modelStr === 'sonnet:anthropic') return { modelId: 'sonnet', provider: cognitionProvider }
        return { modelId: modelStr, provider: attentionProvider }
      },
    }

    const toolDefs = modality.toolDefinitions()
    const executeFn = mock.fn(async (name, input) => {
      const result = modality.executeTool(name, input)
      if (result) return result
      return { output: `result of ${name}` }
    })
    const tools = { definitions: toolDefs, execute: executeFn }

    const config = {
      model: 'haiku',
      provider: attentionProvider,
      maxTurns: 10,
      registry,
      modality,
    }

    const { events, onEvent } = collectEvents()
    const messages = [{ role: 'user', content: 'hi' }]
    const result = await runHybridAgent('system', messages, tools, config, onEvent)

    // Modality should now be in cognition mode
    assert.equal(modality.mode, 'cognition')

    // Cognition provider should have been called
    assert.equal(cognitionProvider.streamMessage.mock.callCount(), 1)

    // The cognition call should use the cognition model
    const cognitionCall = cognitionProvider.streamMessage.mock.calls[0]
    assert.equal(cognitionCall.arguments[0].model, 'sonnet')

    // The attention model's step_up message should NOT be in final messages
    // (it was popped during re-run)
    const assistantMessages = messages.filter(m => m.role === 'assistant')
    // Should only have the cognition response, not the step_up call
    assert.equal(assistantMessages.length, 1)
    const finalContent = assistantMessages[0].content
    assert.ok(finalContent.some(b => b.type === 'text' && b.text.includes('Hello')))
  })

  it('step_down takes effect without re-run', async () => {
    const modality = new Modality({ attention: 'haiku:anthropic', cognition: 'sonnet:anthropic' })
    modality.stepUp('test')

    const provider = makeProvider([
      {
        contentBlocks: [
          { type: 'tool_use', id: 'toolu_1', name: 'step_down', input: { reason: 'quiet now' } },
        ],
        stopReason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 10 },
      },
      {
        contentBlocks: [{ type: 'text', text: 'Stepping back to monitoring.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    ])

    const toolDefs = modality.toolDefinitions()
    const executeFn = mock.fn(async (name, input) => {
      const result = modality.executeTool(name, input)
      if (result) return result
      return { output: `result of ${name}` }
    })
    const tools = { definitions: toolDefs, execute: executeFn }

    const config = {
      model: 'sonnet',
      provider,
      maxTurns: 10,
      modality,
    }

    const { events, onEvent } = collectEvents()
    await runHybridAgent('system', [{ role: 'user', content: 'bye' }], tools, config, onEvent)

    // Modality should now be back in attention mode
    assert.equal(modality.mode, 'attention')

    // Provider should have been called twice (tool call + final text)
    assert.equal(provider.streamMessage.mock.callCount(), 2)
  })

  it('no modality config means no re-run behavior', async () => {
    // When config.modality is null, step_up tool calls are just regular tools
    const provider = makeProvider([
      {
        contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'some_tool', input: { x: 1 } }],
        stopReason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 10 },
      },
      {
        contentBlocks: [{ type: 'text', text: 'Done.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    ])

    const tools = {
      definitions: [{ name: 'some_tool', input_schema: { type: 'object', properties: {} } }],
      execute: mock.fn(async () => ({ output: 'ok' })),
    }

    const config = {
      model: 'test-model',
      provider,
      maxTurns: 10,
      // No modality — normal behavior
    }

    const { events, onEvent } = collectEvents()
    await runHybridAgent('system', [{ role: 'user', content: 'do something' }], tools, config, onEvent)

    // Should work normally — 2 provider calls
    assert.equal(provider.streamMessage.mock.callCount(), 2)
  })

  it('prevents infinite loop if cognition model also calls step_up', async () => {
    const modality = new Modality({ attention: 'haiku:anthropic', cognition: 'sonnet:anthropic' })

    // Attention provider: calls step_up
    const attentionProvider = makeProvider([
      {
        contentBlocks: [{ type: 'tool_use', id: 'toolu_1', name: 'step_up', input: { reason: 'user asked' } }],
        stopReason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ])

    // Cognition provider: also calls step_up (no-op), then responds
    const cognitionProvider = makeProvider([
      {
        contentBlocks: [{ type: 'tool_use', id: 'toolu_2', name: 'step_up', input: { reason: 'confused' } }],
        stopReason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 15 },
      },
      {
        contentBlocks: [{ type: 'text', text: 'Here I am.' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 40 },
      },
    ])

    const registry = {
      resolve: (modelStr) => {
        if (modelStr === 'haiku:anthropic') return { modelId: 'haiku', provider: attentionProvider }
        if (modelStr === 'sonnet:anthropic') return { modelId: 'sonnet', provider: cognitionProvider }
        return { modelId: modelStr, provider: attentionProvider }
      },
    }

    const toolDefs = modality.toolDefinitions()
    const executeFn = mock.fn(async (name, input) => {
      const result = modality.executeTool(name, input)
      if (result) return result
      return { output: `result of ${name}` }
    })
    const tools = { definitions: toolDefs, execute: executeFn }

    const config = {
      model: 'haiku',
      provider: attentionProvider,
      maxTurns: 5,
      registry,
      modality,
    }

    const { events, onEvent } = collectEvents()
    await runHybridAgent('system', [{ role: 'user', content: 'hi' }], tools, config, onEvent)

    // Should complete without infinite loop
    assert.equal(modality.mode, 'cognition')
    // Attention called once (step_up), cognition called twice (no-op step_up + text)
    assert.equal(attentionProvider.streamMessage.mock.callCount(), 1)
    assert.equal(cognitionProvider.streamMessage.mock.callCount(), 2)
  })
})
