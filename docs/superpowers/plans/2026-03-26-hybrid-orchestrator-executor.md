# Hybrid Orchestrator/Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hybrid execution mode where a smart orchestrator plans and a cheap executor runs tools, controlled by an `orchestrator` config block in persona.yaml.

**Architecture:** When `orchestrator` is present in config, `runHybridAgent` takes over. The orchestrator provider handles all reasoning/text via `streamMessage`. Tool execution happens directly (no LLM needed — the orchestrator already provided exact arguments). The existing `runAgent` and all single-model behavior is untouched.

**Tech Stack:** Node.js ESM, existing provider interface (`streamMessage`), existing tool interface (`tools.execute`)

---

### Task 1: Provider Factory — Create Orchestrator Provider

**Files:**
- Modify: `server/lib/providers/index.js`
- Test: `tests/providers-factory.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/providers-factory.test.js`:

```javascript
it('creates orchestrator provider from config.orchestrator', () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const config = {
    provider: 'openai-compat',
    base_url: 'http://localhost:8080/v1',
    api_key: 'test',
    model: 'test-model',
    orchestrator: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
  }
  const provider = getProvider(config)
  const orchestrator = getProvider(config.orchestrator)
  assert.equal(typeof provider.streamMessage, 'function')
  assert.equal(typeof orchestrator.streamMessage, 'function')
  assert.equal(provider.supportsIntentRouting, true) // openai-compat
  assert.equal(orchestrator.supportsIntentRouting, undefined) // anthropic
  delete process.env.ANTHROPIC_API_KEY
})

it('creates openai-compat orchestrator from config.orchestrator', () => {
  const config = {
    provider: 'anthropic',
    orchestrator: {
      provider: 'openai-compat',
      base_url: 'http://localhost:9090/v1',
      api_key: 'orch-key',
      model: 'smart-model',
    },
  }
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const orchestrator = getProvider(config.orchestrator)
  assert.equal(typeof orchestrator.streamMessage, 'function')
  assert.equal(orchestrator.supportsIntentRouting, true)
  delete process.env.ANTHROPIC_API_KEY
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/providers-factory.test.js`
Expected: FAIL — tests don't exist yet in the file

- [ ] **Step 3: Write minimal implementation**

No changes needed to `server/lib/providers/index.js` — `getProvider` already accepts any config object with a `provider` field. The test is just verifying this works with `config.orchestrator` as input. Add the tests to the existing file.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/providers-factory.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/providers-factory.test.js
git commit -m "test: verify provider factory works for orchestrator configs"
```

---

### Task 2: Persona Config Validation for Orchestrator

**Files:**
- Modify: `server/lib/persona.js`
- Test: `tests/persona.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/persona.test.js`:

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Add these tests to the existing describe block:

it('validates orchestrator config with anthropic provider', async () => {
  // Create a temp persona dir with orchestrator config
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const os = await import('node:os')
  const dir = await mkdtemp(join(os.tmpdir(), 'persona-'))
  await writeFile(join(dir, 'persona.yaml'), `
name: test
display_name: Test
model: cheap-model
provider: openai-compat
base_url: http://localhost/v1
api_key: test
orchestrator:
  provider: anthropic
  model: claude-sonnet-4-6
`)
  const { loadPersona } = await import('../server/lib/persona.js')
  const persona = await loadPersona(dir)
  assert.equal(persona.config.orchestrator.provider, 'anthropic')
  assert.equal(persona.config.orchestrator.model, 'claude-sonnet-4-6')
})

it('warns when orchestrator is openai-compat without base_url', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const os = await import('node:os')
  const dir = await mkdtemp(join(os.tmpdir(), 'persona-'))
  await writeFile(join(dir, 'persona.yaml'), `
name: test
display_name: Test
model: cheap-model
orchestrator:
  provider: openai-compat
  model: smart-model
`)
  const { loadPersona } = await import('../server/lib/persona.js')
  await assert.rejects(() => loadPersona(dir), /orchestrator.*base_url/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/persona.test.js`
Expected: FAIL — no orchestrator validation exists

- [ ] **Step 3: Write minimal implementation**

In `server/lib/persona.js`, add validation after the existing `validateOpenAICompat` call:

```javascript
export async function loadPersona(personaDir) {
  // ... existing code ...

  const config = yaml.load(raw)
  resolveEnvVars(config)

  if (config.provider === 'openai-compat') {
    validateOpenAICompat(config)
  }

  // Validate orchestrator config if present
  if (config.orchestrator) {
    validateOrchestrator(config)
  }

  const plugins = await loadPlugins(config.plugins || [])
  return { dir: personaDir, config, plugins }
}

function validateOrchestrator(config) {
  const name = config.name || 'unknown'
  const orch = config.orchestrator

  if (!orch.provider) {
    orch.provider = 'anthropic' // default orchestrator is anthropic
  }

  if (orch.provider === 'openai-compat') {
    if (!orch.base_url) {
      throw new Error(`[${name}] orchestrator with openai-compat requires base_url`)
    }
    if (!orch.api_key) {
      throw new Error(`[${name}] orchestrator with openai-compat requires api_key`)
    }
  }

  console.log(`[${name}] Hybrid mode: orchestrator=${orch.provider}/${orch.model}, executor=${config.provider || 'anthropic'}/${config.model}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/persona.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/persona.js tests/persona.test.js
git commit -m "feat: validate orchestrator config in persona loading"
```

---

### Task 3: The Hybrid Agent Loop

**Files:**
- Modify: `server/lib/agent.js`
- Test: `tests/agent-hybrid.test.js`

This is the core implementation. `runHybridAgent` is the same loop as `runAgent` but tool execution is direct (calling `tools.execute`) rather than going through the provider. The orchestrator does the thinking; tools run locally.

- [ ] **Step 1: Write the failing test**

Create `tests/agent-hybrid.test.js`:

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runHybridAgent } from '../server/lib/agent.js'

// Mock orchestrator that returns text then stops
function mockOrchestratorText(text) {
  return {
    async streamMessage(params, onEvent) {
      onEvent({ type: 'text_delta', text })
      return {
        contentBlocks: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
    },
  }
}

// Mock orchestrator that calls a tool then responds
function mockOrchestratorToolThenText(toolName, toolInput, responseText) {
  let turn = 0
  return {
    async streamMessage(params, onEvent) {
      turn++
      if (turn === 1) {
        onEvent({ type: 'tool_start', name: toolName })
        return {
          contentBlocks: [{
            type: 'tool_use',
            id: `toolu_test_${turn}`,
            name: toolName,
            input: toolInput,
          }],
          stopReason: 'tool_use',
          usage: { input_tokens: 20, output_tokens: 10 },
        }
      }
      onEvent({ type: 'text_delta', text: responseText })
      return {
        contentBlocks: [{ type: 'text', text: responseText }],
        stopReason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 15 },
      }
    },
  }
}

const mockTools = {
  definitions: [
    { name: 'bash', description: 'Run command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  ],
  execute: async (name, input) => {
    if (name === 'bash') return { output: `ran: ${input.command}` }
    return { output: 'unknown', is_error: true }
  },
}

describe('runHybridAgent', () => {
  it('handles text-only response from orchestrator', async () => {
    const events = []
    const orchestrator = mockOrchestratorText('Hello world')
    const messages = [{ role: 'user', content: 'hi' }]

    const result = await runHybridAgent(
      'system prompt',
      messages,
      mockTools,
      { model: 'test', maxTurns: 5, provider: orchestrator },
      e => events.push(e),
    )

    assert.ok(events.some(e => e.type === 'text_delta' && e.text === 'Hello world'))
    assert.ok(events.some(e => e.type === 'done'))
    assert.equal(result.usage.input_tokens, 10)
  })

  it('executes tools directly without executor LLM', async () => {
    const events = []
    const orchestrator = mockOrchestratorToolThenText('bash', { command: 'ls' }, 'Done.')
    const messages = [{ role: 'user', content: 'list files' }]

    const result = await runHybridAgent(
      'system prompt',
      messages,
      mockTools,
      { model: 'test', maxTurns: 5, provider: orchestrator },
      e => events.push(e),
    )

    // Tool was called directly
    const toolResult = events.find(e => e.type === 'tool_result')
    assert.ok(toolResult)
    assert.equal(toolResult.name, 'bash')
    assert.equal(toolResult.result.output, 'ran: ls')

    // Orchestrator got tool result and responded
    assert.ok(events.some(e => e.type === 'text_delta' && e.text === 'Done.'))

    // Usage includes both turns
    assert.equal(result.usage.input_tokens, 50)
    assert.equal(result.usage.output_tokens, 25)
  })

  it('appends tool results to message history for orchestrator', async () => {
    const orchestrator = mockOrchestratorToolThenText('bash', { command: 'echo hi' }, 'ok')
    const messages = [{ role: 'user', content: 'run echo' }]

    const result = await runHybridAgent(
      'system prompt',
      messages,
      mockTools,
      { model: 'test', maxTurns: 5, provider: orchestrator },
      () => {},
    )

    // Messages should contain: user, assistant (tool_use), user (tool_result), assistant (text)
    assert.equal(result.messages.length, 4)
    assert.equal(result.messages[0].role, 'user')
    assert.equal(result.messages[1].role, 'assistant')
    assert.equal(result.messages[2].role, 'user')
    assert.equal(result.messages[3].role, 'assistant')

    // tool_result should be in messages[2]
    const toolResultMsg = result.messages[2]
    assert.ok(Array.isArray(toolResultMsg.content))
    assert.equal(toolResultMsg.content[0].type, 'tool_result')
  })

  it('respects maxTurns limit', async () => {
    // Orchestrator that always calls tools
    const infiniteToolOrchestrator = {
      async streamMessage(params, onEvent) {
        onEvent({ type: 'tool_start', name: 'bash' })
        return {
          contentBlocks: [{
            type: 'tool_use',
            id: `toolu_${Date.now()}`,
            name: 'bash',
            input: { command: 'echo loop' },
          }],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      },
    }

    const messages = [{ role: 'user', content: 'go' }]
    const result = await runHybridAgent(
      'system prompt',
      messages,
      mockTools,
      { model: 'test', maxTurns: 3, provider: infiniteToolOrchestrator },
      () => {},
    )

    // Should stop after maxTurns tool iterations
    const toolUseCount = result.messages.filter(
      m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use')
    ).length
    assert.ok(toolUseCount <= 3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-hybrid.test.js`
Expected: FAIL — `runHybridAgent` not exported

- [ ] **Step 3: Write the implementation**

Add to `server/lib/agent.js`, after the existing `runAgent` function:

```javascript
/**
 * Hybrid agent loop. The orchestrator (smart model) does all reasoning.
 * Tools are executed directly — no executor LLM needed since the
 * orchestrator provides exact arguments.
 *
 * When the orchestrator is openai-compat, intent routing and rescue
 * logic apply (same as runAgent). When Anthropic, it runs clean.
 */
export async function runHybridAgent(systemPrompt, messages, tools, config, onEvent) {
  const { provider: orchestrator } = config
  let totalUsage = { input_tokens: 0, output_tokens: 0 }
  let iterations = 0
  const maxTurns = config.maxTurns || 20

  const MAX_CONSECUTIVE_TOOLS = 8
  let consecutiveToolCalls = 0
  let rescueCount = 0
  let totalToolTurns = 0
  let rescueFailed = false

  while (iterations < maxTurns) {
    // Intent routing — same logic as runAgent, applies when orchestrator is openai-compat
    let toolChoice = undefined
    if (orchestrator.supportsIntentRouting && tools.definitions.length > 0) {
      const lastMsg = messages[messages.length - 1]
      const isPostToolResult = Array.isArray(lastMsg?.content) &&
        lastMsg.content.some(b => b.type === 'tool_result')

      if (rescueFailed) {
        toolChoice = 'none'
      } else if (consecutiveToolCalls >= MAX_CONSECUTIVE_TOOLS) {
        toolChoice = 'none'
        console.log(`[hybrid] toolChoice=none (forced after ${consecutiveToolCalls} consecutive tool calls)`)
      } else if (isPostToolResult) {
        toolChoice = 'auto'
      } else {
        const lastUserText = getLastUserText(messages)
        const heuristic = classifyIntentHeuristic(lastUserText)

        if (heuristic !== 'uncertain') {
          toolChoice = heuristic
        } else {
          toolChoice = await orchestrator.classifyIntent({
            model: config.model,
            system: systemPrompt,
            messages,
            tools: tools.definitions,
          })
        }
      }
    }

    // Orchestrator call — full context, all tools
    const result = await orchestrator.streamMessage(
      {
        model: config.model,
        maxTokens: 16384,
        system: systemPrompt,
        messages,
        tools: toolChoice === 'none' ? [] : tools.definitions,
        serverTools: config.serverTools || [],
        thinkingBudget: config.thinkingBudget || null,
        toolChoice: toolChoice === 'none' ? undefined : toolChoice,
      },
      onEvent,
    )

    let { contentBlocks, stopReason, usage } = result
    totalUsage.input_tokens += usage.input_tokens
    totalUsage.output_tokens += usage.output_tokens

    // Rescue narrated tool calls (openai-compat orchestrator only)
    if (stopReason !== 'tool_use' && orchestrator.supportsIntentRouting && toolChoice !== 'none' && !rescueFailed) {
      const textBlock = contentBlocks.find(b => b.type === 'text')
      if (textBlock) {
        const rescued = _rescueNarratedToolCall(textBlock.text, tools.definitions)
        if (rescued) {
          contentBlocks = contentBlocks.filter(b => b !== textBlock)
          contentBlocks.push(rescued)
          stopReason = 'tool_use'
          onEvent({ type: 'tool_start', name: rescued.name })
          rescueCount++

          if (totalToolTurns >= 4 && rescueCount / totalToolTurns > 0.5) {
            rescueFailed = true
          }
        }
      }
    }

    // Finalize content blocks
    const assistantContent = contentBlocks.map(block => {
      if ((block.type === 'tool_use' || block.type === 'server_tool_use') && typeof block.input === 'string') {
        try {
          return { ...block, input: JSON.parse(block.input || '{}') }
        } catch {
          return { ...block, input: {} }
        }
      }
      return block
    })

    messages.push({ role: 'assistant', content: assistantContent })

    if (stopReason !== 'tool_use') {
      consecutiveToolCalls = 0
      break
    }
    consecutiveToolCalls++
    totalToolTurns++

    // Execute tools DIRECTLY — no executor LLM needed
    const toolResults = []
    for (const block of assistantContent.filter(b => b.type === 'tool_use')) {
      let result
      try {
        result = await tools.execute(block.name, block.input)
      } catch (err) {
        result = { output: `Tool error: ${err.message}`, is_error: true }
      }
      onEvent({ type: 'tool_result', name: block.name, input: block.input, result })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      })
    }

    // Correction feedback for rescued calls
    const wasRescued = contentBlocks.some(b => b.type === 'tool_use' && b.id?.startsWith('toolu_rescued_'))
    if (wasRescued && orchestrator.supportsIntentRouting) {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: 'system_correction',
        content: '[system: You narrated a tool call instead of using function calling. The call was executed, but you must use the function calling API directly.]',
      })
    }

    messages.push({ role: 'user', content: toolResults })
    iterations++
  }

  onEvent({ type: 'done', usage: totalUsage })
  return { messages, usage: totalUsage }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/agent-hybrid.test.js`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Run full test suite for regression**

Run: `node --test`
Expected: All 137+ tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/lib/agent.js tests/agent-hybrid.test.js
git commit -m "feat: add runHybridAgent with direct tool execution"
```

---

### Task 4: Route to Hybrid Agent in Chat Session

**Files:**
- Modify: `server/lib/chat-session.js`

- [ ] **Step 1: Add orchestrator provider creation in initialize()**

In `server/lib/chat-session.js`, in the `initialize()` method, after `this.provider = getProvider(config)`, add:

```javascript
    this.provider = getProvider(config)
    this.orchestratorProvider = config.orchestrator
      ? getProvider(config.orchestrator)
      : null
```

- [ ] **Step 2: Add import for runHybridAgent**

Update the import at top of file:

```javascript
import { runAgent, runHybridAgent } from './agent.js'
```

- [ ] **Step 3: Route to hybrid in _processMessage**

In `_processMessage`, where `config` is built (around line 312), add the orchestrator provider:

```javascript
      const config = {
        model: this.orchestratorProvider
          ? this.persona.config.orchestrator.model
          : this.persona.config.model,
        maxTurns: this.persona.config.chat?.max_turns || 20,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: this.orchestratorProvider || this.provider,
      }
```

Then replace the `runAgent` call:

```javascript
      const agentFn = this.orchestratorProvider ? runHybridAgent : runAgent
      const result = await agentFn(prompt, this.messages, this.tools, config, onEvent)
```

- [ ] **Step 4: Do the same for the idle thought path**

In the idle thought handler (around line 444), apply the same routing:

```javascript
      const idleConfig = {
        model: this.orchestratorProvider
          ? this.persona.config.orchestrator.model
          : this.persona.config.model,
        maxTurns: this.persona.config.chat?.max_turns || 20,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: this.orchestratorProvider || this.provider,
      }

      const agentFn = this.orchestratorProvider ? runHybridAgent : runAgent
      const result = await agentFn(prompt, idleMessages, this.tools, idleConfig, onEvent)
```

- [ ] **Step 5: Reset orchestrator on session reset**

In the `reset()` method, add:

```javascript
    this.orchestratorProvider = null
```

- [ ] **Step 6: Run full test suite for regression**

Run: `node --test`
Expected: All tests PASS (single-model path unchanged)

- [ ] **Step 7: Commit**

```bash
git add server/lib/chat-session.js
git commit -m "feat: route to runHybridAgent when orchestrator configured"
```

---

### Task 5: Update Example Persona Config

**Files:**
- Modify: `personas/example/persona.yaml`

- [ ] **Step 1: Add commented orchestrator config to example persona**

Add after the existing openai-compat commented section:

```yaml
## Uncomment to use hybrid mode (smart orchestrator + cheap executor):
# orchestrator:
#   provider: anthropic
#   model: claude-sonnet-4-6
## When orchestrator is set, the main provider/model becomes the executor.
## The orchestrator handles reasoning and persona; tools execute directly.
## Both orchestrator and executor are swappable — either can be anthropic
## or openai-compat.
```

- [ ] **Step 2: Commit**

```bash
git add personas/example/persona.yaml
git commit -m "docs: add hybrid orchestrator config to example persona"
```

---

### Task 6: Integration Test — Hybrid with Mock Providers

**Files:**
- Create: `tests/agent-hybrid-integration.test.js`

- [ ] **Step 1: Write integration test for multi-step tool chain**

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runHybridAgent } from '../server/lib/agent.js'

describe('runHybridAgent integration', () => {
  it('handles multi-step tool chain like a wakeup round', async () => {
    let orchestratorTurn = 0
    const orchestrator = {
      async streamMessage(params, onEvent) {
        orchestratorTurn++
        switch (orchestratorTurn) {
          case 1: // First turn: call check_notifications
            onEvent({ type: 'tool_start', name: 'bash' })
            return {
              contentBlocks: [{
                type: 'tool_use',
                id: 'toolu_1',
                name: 'bash',
                input: { command: 'curl -s notifications' },
              }],
              stopReason: 'tool_use',
              usage: { input_tokens: 100, output_tokens: 50 },
            }
          case 2: // Second turn: saw notifications, post a reply
            onEvent({ type: 'tool_start', name: 'bash' })
            return {
              contentBlocks: [{
                type: 'tool_use',
                id: 'toolu_2',
                name: 'bash',
                input: { command: 'curl -X POST statuses -d "reply"' },
              }],
              stopReason: 'tool_use',
              usage: { input_tokens: 200, output_tokens: 60 },
            }
          case 3: // Third turn: check timeline
            onEvent({ type: 'tool_start', name: 'bash' })
            return {
              contentBlocks: [{
                type: 'tool_use',
                id: 'toolu_3',
                name: 'bash',
                input: { command: 'curl -s timeline' },
              }],
              stopReason: 'tool_use',
              usage: { input_tokens: 300, output_tokens: 40 },
            }
          default: // Final turn: summarize
            onEvent({ type: 'text_delta', text: 'Round complete.' })
            return {
              contentBlocks: [{ type: 'text', text: 'Round complete.' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 400, output_tokens: 30 },
            }
        }
      },
    }

    const tools = {
      definitions: [
        { name: 'bash', description: 'Run command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      ],
      execute: async (name, input) => {
        if (input.command.includes('notifications')) return { output: '[{"type":"mention"}]' }
        if (input.command.includes('POST')) return { output: '{"id":"12345"}' }
        if (input.command.includes('timeline')) return { output: '[]' }
        return { output: 'ok' }
      },
    }

    const events = []
    const messages = [{ role: 'user', content: 'start round' }]

    const result = await runHybridAgent(
      'You are an admin bot.',
      messages,
      tools,
      { model: 'test', maxTurns: 10, provider: orchestrator },
      e => events.push(e),
    )

    // 4 orchestrator turns happened
    assert.equal(orchestratorTurn, 4)

    // 3 tool results were generated
    const toolResults = events.filter(e => e.type === 'tool_result')
    assert.equal(toolResults.length, 3)

    // Final text was emitted
    assert.ok(events.some(e => e.type === 'text_delta' && e.text === 'Round complete.'))

    // Usage is summed across all turns
    assert.equal(result.usage.input_tokens, 1000)
    assert.equal(result.usage.output_tokens, 180)
  })

  it('applies intent routing when orchestrator supports it', async () => {
    let classifyCalled = false
    const openModelOrchestrator = {
      supportsIntentRouting: true,
      async classifyIntent() {
        classifyCalled = true
        return 'required'
      },
      async streamMessage(params, onEvent) {
        onEvent({ type: 'tool_start', name: 'bash' })
        return {
          contentBlocks: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'bash',
            input: { command: 'ls' },
          }],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      },
    }

    const tools = {
      definitions: [
        { name: 'bash', description: 'Run', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      ],
      execute: async () => ({ output: 'ok' }),
    }

    await runHybridAgent(
      'system',
      [{ role: 'user', content: 'do something complex' }],
      tools,
      { model: 'test', maxTurns: 1, provider: openModelOrchestrator },
      () => {},
    )

    // classifyIntent should have been called since the message is ambiguous
    // (doesn't match heuristic patterns)
    assert.equal(classifyCalled, true)
  })

  it('skips intent routing for anthropic orchestrator', async () => {
    const anthropicOrchestrator = {
      // No supportsIntentRouting — this is Anthropic
      async streamMessage(params, onEvent) {
        onEvent({ type: 'text_delta', text: 'hi' })
        return {
          contentBlocks: [{ type: 'text', text: 'hi' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      },
    }

    const tools = {
      definitions: [{ name: 'bash', description: 'Run', input_schema: { type: 'object', properties: {}, required: [] } }],
      execute: async () => ({ output: 'ok' }),
    }

    // Should not throw — no classifyIntent needed
    await runHybridAgent(
      'system',
      [{ role: 'user', content: 'hello' }],
      tools,
      { model: 'test', maxTurns: 5, provider: anthropicOrchestrator },
      () => {},
    )
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/agent-hybrid-integration.test.js`
Expected: PASS (all 3 tests)

- [ ] **Step 3: Run full test suite**

Run: `node --test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/agent-hybrid-integration.test.js
git commit -m "test: integration tests for hybrid agent multi-step tool chains"
```

---

### Task 7: Usage Logging by Role

**Files:**
- Modify: `server/lib/agent.js`

- [ ] **Step 1: Add role-tagged usage logging to runHybridAgent**

At the end of `runHybridAgent`, before the `done` event, add:

```javascript
  console.log(`[hybrid] orchestrator: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out | tools executed: ${totalToolTurns} (direct)`)
```

- [ ] **Step 2: Run full test suite**

Run: `node --test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add server/lib/agent.js
git commit -m "feat: log hybrid usage breakdown (orchestrator tokens + tool count)"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Two roles (orchestrator/executor) — Task 3
- [x] Execution flow (interleaved orchestrator + direct tool exec) — Task 3
- [x] Direct tool execution optimization — Task 3 (tools.execute called directly)
- [x] Config handling — Task 2 (validation), Task 5 (example)
- [x] Provider factory for both roles — Task 1
- [x] Chat session routing — Task 4
- [x] Guardrails on openai-compat orchestrator — Task 3 (reuses intent routing/rescue)
- [x] Guardrails skipped for Anthropic orchestrator — Task 6 test
- [x] Usage logging — Task 7
- [x] Regression safety — Tasks 3, 4, 6 all run full suite

**Placeholder scan:** No TBDs, TODOs, or "implement later" found.

**Type consistency:** `runHybridAgent` has identical signature to `runAgent`. `config.provider` is the orchestrator in hybrid mode, matching how `chat-session.js` sets it up.
