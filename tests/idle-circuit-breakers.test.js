import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Room } from '../server/lib/chat-session.js'

function makePersona(overrides = {}) {
  return {
    dir: '/tmp/test-persona',
    config: {
      name: 'test-agent',
      display_name: 'Test',
      model: 'test-model',
      ...overrides,
    },
    plugins: [],
  }
}

describe('Idle thought degenerate detection (Fix A)', () => {
  it('returns "degenerate" for trivial output with no tools', async () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test system prompt'
    room.tools = { definitions: [], execute: async () => ({}) }
    room.memory = { dir: '/tmp' }
    room.state = { update: () => {}, save: async () => {} }
    room.chatLog = { append: async () => {} }
    room.registry = {
      resolve: () => ({
        modelId: 'test-model',
        provider: {
          streamMessage: async (params, onEvent) => {
            onEvent({ type: 'done' })
            return {
              contentBlocks: [{ type: 'text', text: '' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 12 },
            }
          },
        },
      }),
    }
    room.messages = []

    const result = await room._idleThought()
    assert.equal(result, 'degenerate')
    assert.equal(room.messages.length, 0)
    room.destroy()
  })

  it('returns true for substantial output with tool use', async () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test system prompt'
    room.tools = {
      definitions: [{ name: 'bash', description: 'test' }],
      execute: async () => ({ output: 'result' }),
    }
    room.memory = { dir: '/tmp' }
    room.state = { update: () => {}, save: async () => {} }
    room.chatLog = { append: async () => {} }
    room.registry = {
      resolve: () => ({
        modelId: 'test-model',
        provider: {
          streamMessage: async (params, onEvent) => {
            onEvent({ type: 'tool_start', name: 'bash' })
            onEvent({ type: 'text_delta', text: 'I checked the status and everything looks good.' })
            onEvent({ type: 'done' })
            return {
              contentBlocks: [{ type: 'text', text: 'I checked the status and everything looks good.' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 80 },
            }
          },
        },
      }),
    }
    room.messages = []

    const result = await room._idleThought()
    assert.equal(result, true)
    assert.ok(room.messages.length > 0)
    room.destroy()
  })

  it('suspends idle timer after 5 consecutive degenerate results', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room._consecutiveDegenerateCount = 4
    room._idleInterval = 1000
    room._destroyed = false

    room._consecutiveDegenerateCount++
    assert.equal(room._consecutiveDegenerateCount, 5)
  })
})

describe('Single idle_thought per cycle (Fix C — no duplicate when tool + text fire together)', () => {
  it('combines a tool-emitted thought with text-lane content into ONE history entry', async () => {
    // Regression: gpt-5.4 commonly emits text AND calls internal({thought})
    // in the same idle turn. The tool used to recordHistory immediately and
    // the post-emit also recorded the text. Two idle_thought entries landed
    // per cycle in brad/history (one no-id from tool, one id-tagged from
    // post-emit). The fix routes the tool's thought through _idleToolThoughts
    // so the post-emit folds both sources into a single entry.
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    const historyCalls = []
    room.chatLog = { append: async (entry) => { historyCalls.push(entry) } }
    room.memory = { dir: '/tmp' }
    room.state = { update: () => {}, save: async () => {} }
    // Minimal tool stub that mirrors the real internal({thought}) behavior
    // during an idle turn — pushes to _idleToolThoughts, no recordHistory.
    room.tools = {
      definitions: [{ name: 'internal', description: 'internal tool stub' }],
      execute: async (name, input) => {
        if (name === 'internal' && input.thought) {
          if (Array.isArray(room._idleToolThoughts)) {
            room._idleToolThoughts.push(input.thought)
          } else {
            room.recordHistory({ type: 'idle_thought', text: input.thought, name: 'Test' })
          }
          return { output: `Thought: ${input.thought}` }
        }
        return { output: 'ok' }
      },
    }
    room.registry = {
      resolve: () => ({
        modelId: 'test-model',
        provider: {
          streamMessage: async (params, onEvent) => {
            // Model writes some prose
            onEvent({ type: 'text_delta', text: 'thinking out loud about the threads ' })
            // ... then calls internal({thought:"..."}) mid-turn
            onEvent({ type: 'tool_start', name: 'internal', input: { thought: 'side note: stripe is flat' }, id: 'tool-1' })
            await room.tools.execute('internal', { thought: 'side note: stripe is flat' })
            onEvent({ type: 'tool_result', name: 'internal', id: 'tool-1', output: 'Thought: side note: stripe is flat' })
            // ... then more prose
            onEvent({ type: 'text_delta', text: 'and then back to the main point.' })
            onEvent({ type: 'done' })
            return {
              contentBlocks: [{ type: 'text', text: 'thinking out loud about the threads and then back to the main point.' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 80 },
            }
          },
        },
      }),
    }
    room.messages = []

    const result = await room._idleThought()
    assert.equal(result, true)

    const idleEntries = historyCalls.filter(c => c.type === 'idle_thought')
    assert.equal(idleEntries.length, 1, `expected exactly one idle_thought history entry, got ${idleEntries.length}`)
    assert.match(idleEntries[0].text, /thinking out loud/)
    assert.match(idleEntries[0].text, /side note: stripe is flat/)
    assert.match(idleEntries[0].text, /back to the main point/)
    room.destroy()
  })

  it('clears _idleToolThoughts in finally so subsequent non-idle internal calls still record', async () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    room.chatLog = { append: async () => {} }
    room.memory = { dir: '/tmp' }
    room.state = { update: () => {}, save: async () => {} }
    room.tools = { definitions: [], execute: async () => ({}) }
    room.registry = {
      resolve: () => ({
        modelId: 'test-model',
        provider: {
          streamMessage: async (params, onEvent) => {
            onEvent({ type: 'text_delta', text: 'a sufficient thought.' })
            onEvent({ type: 'done' })
            return {
              contentBlocks: [{ type: 'text', text: 'a sufficient thought.' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 100, output_tokens: 80 },
            }
          },
        },
      }),
    }
    room.messages = []

    await room._idleThought()
    assert.equal(room._idleToolThoughts, null, '_idleToolThoughts must be cleared after the idle turn so non-idle internal calls record history normally')
    room.destroy()
  })
})

describe('Backoff protection from room messages (Fix B)', () => {
  it('source=user resets idle interval to base', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    room.tools = { definitions: [] }
    room.chatLog = { append: async () => {} }
    room._idleInterval = 999999
    room._consecutiveDegenerateCount = 3
    room._destroyed = true

    room.addAgentMessage('visitor', 'hello', { source: 'user' })

    assert.equal(room._idleInterval, 120 * 60 * 1000)
    assert.equal(room._consecutiveDegenerateCount, 0)
    room.destroy()
  })

  it('source=room preserves idle interval but resets degenerate count', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    room.tools = { definitions: [] }
    room.chatLog = { append: async () => {} }
    room._idleInterval = 999999
    room._consecutiveDegenerateCount = 3
    room._destroyed = true

    room.addAgentMessage('visitor', 'hello', { source: 'room' })

    assert.equal(room._idleInterval, 999999)
    assert.equal(room._consecutiveDegenerateCount, 0)
    room.destroy()
  })

  it('default source is "user" (backward compat)', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    room.tools = { definitions: [] }
    room.chatLog = { append: async () => {} }
    room._idleInterval = 999999
    room._destroyed = true

    room.addAgentMessage('visitor', 'hello')

    assert.equal(room._idleInterval, 120 * 60 * 1000)
    room.destroy()
  })
})
