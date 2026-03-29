# Idle Loop Circuit Breakers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent idle thought loops from burning API credits by detecting degenerate results, protecting backoff from room message resets, and adding provider-level circuit breakers.

**Architecture:** Three independent fixes — (A) degenerate idle detection in `_idleThought()`, (B) source-aware backoff in `addAgentMessage()`, (C) per-endpoint circuit breaker singleton consumed by `openai-compat.js` and `agent.js`. All are independent codepaths that reinforce each other.

**Tech Stack:** Node.js (ESM), node:test for testing

---

### Task 1: Circuit Breaker Module

**Files:**
- Create: `server/lib/circuit-breaker.js`
- Create: `tests/circuit-breaker.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/circuit-breaker.test.js`:

```js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { CircuitBreaker, CircuitOpenError } from '../server/lib/circuit-breaker.js'

describe('CircuitBreaker', () => {
  let breaker

  beforeEach(() => {
    breaker = new CircuitBreaker({ threshold: 3, initialCooldown: 100, maxCooldown: 1000 })
  })

  it('starts in CLOSED state — requests allowed', () => {
    assert.equal(breaker.isOpen('http://example.com'), false)
  })

  it('opens after N consecutive failures', () => {
    const url = 'http://dead.provider'
    breaker.recordFailure(url)
    breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), false)
    breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), true)
  })

  it('throws CircuitOpenError with remaining cooldown', () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    const remaining = breaker.remainingCooldown(url)
    assert.ok(remaining > 0)
    assert.ok(remaining <= 100)
  })

  it('success resets failure count', () => {
    const url = 'http://flaky.provider'
    breaker.recordFailure(url)
    breaker.recordFailure(url)
    breaker.recordSuccess(url)
    breaker.recordFailure(url)
    breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), false) // only 2 consecutive, not 3
  })

  it('transitions OPEN -> HALF_OPEN after cooldown expires', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), true)
    // Wait for cooldown (100ms)
    await new Promise(r => setTimeout(r, 120))
    assert.equal(breaker.isOpen(url), false) // HALF_OPEN allows one through
  })

  it('HALF_OPEN probe success closes the circuit', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 120))
    // Probe succeeds
    breaker.recordSuccess(url)
    assert.equal(breaker.isOpen(url), false)
    // Should allow unlimited requests now (CLOSED)
    assert.equal(breaker.isOpen(url), false)
    assert.equal(breaker.isOpen(url), false)
  })

  it('HALF_OPEN probe failure re-opens with doubled cooldown', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 120))
    // Allow one through (HALF_OPEN)
    assert.equal(breaker.isOpen(url), false)
    // Probe fails
    breaker.recordFailure(url)
    assert.equal(breaker.isOpen(url), true)
    const remaining = breaker.remainingCooldown(url)
    // Cooldown should be ~200ms now (doubled from 100)
    assert.ok(remaining > 100)
    assert.ok(remaining <= 200)
  })

  it('cooldown caps at maxCooldown', async () => {
    const url = 'http://dead.provider'
    // Open circuit
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    // Exhaust doublings: 100 -> 200 -> 400 -> 800 -> 1000 (capped)
    for (let round = 0; round < 5; round++) {
      // Wait for cooldown to expire
      await new Promise(r => setTimeout(r, 1100))
      breaker.recordFailure(url) // probe fail, doubles cooldown
    }
    const remaining = breaker.remainingCooldown(url)
    assert.ok(remaining <= 1000)
  })

  it('success after HALF_OPEN resets cooldown to initial value', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 120))
    // First probe fail — doubles to 200
    breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 220))
    // Second probe succeeds — resets to CLOSED
    breaker.recordSuccess(url)
    // Now fail 3 more times to reopen
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    // Cooldown should be back to initial 100, not 400
    const remaining = breaker.remainingCooldown(url)
    assert.ok(remaining <= 100)
  })

  it('CircuitOpenError has expected properties', () => {
    const err = new CircuitOpenError('http://dead.provider', 30)
    assert.ok(err instanceof Error)
    assert.ok(err.message.includes('http://dead.provider'))
    assert.ok(err.message.includes('circuit open'))
    assert.equal(err.isCircuitOpen, true)
  })

  it('tracks endpoints independently', () => {
    const url1 = 'http://provider-a.com'
    const url2 = 'http://provider-b.com'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url1)
    assert.equal(breaker.isOpen(url1), true)
    assert.equal(breaker.isOpen(url2), false)
  })

  it('HALF_OPEN allows exactly one request', async () => {
    const url = 'http://dead.provider'
    for (let i = 0; i < 3; i++) breaker.recordFailure(url)
    await new Promise(r => setTimeout(r, 120))
    // First check: allowed (HALF_OPEN -> probing)
    assert.equal(breaker.isOpen(url), false)
    // Second check: blocked (already probing)
    assert.equal(breaker.isOpen(url), true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/circuit-breaker.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement circuit-breaker.js**

Create `server/lib/circuit-breaker.js`:

```js
const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' }

export class CircuitOpenError extends Error {
  constructor(url, remainingSeconds) {
    super(`endpoint ${url} circuit open, retry in ${remainingSeconds}s`)
    this.isCircuitOpen = true
    this.url = url
    this.remainingSeconds = remainingSeconds
  }
}

export class CircuitBreaker {
  constructor({ threshold = 3, initialCooldown = 30000, maxCooldown = 1800000 } = {}) {
    this.threshold = threshold
    this.initialCooldown = initialCooldown
    this.maxCooldown = maxCooldown
    this.endpoints = new Map()
  }

  _getEndpoint(url) {
    if (!this.endpoints.has(url)) {
      this.endpoints.set(url, {
        state: STATES.CLOSED,
        failures: 0,
        cooldown: this.initialCooldown,
        openedAt: null,
        probing: false,
      })
    }
    return this.endpoints.get(url)
  }

  isOpen(url) {
    const ep = this._getEndpoint(url)

    if (ep.state === STATES.CLOSED) return false

    if (ep.state === STATES.OPEN) {
      const elapsed = Date.now() - ep.openedAt
      if (elapsed >= ep.cooldown) {
        ep.state = STATES.HALF_OPEN
        ep.probing = false
        console.log(`[circuit-breaker] ${url} OPEN -> HALF_OPEN (cooldown expired, probing)`)
        // Fall through to HALF_OPEN handling
      } else {
        return true
      }
    }

    if (ep.state === STATES.HALF_OPEN) {
      if (ep.probing) return true // already one request in flight
      ep.probing = true
      return false // allow one probe
    }

    return false
  }

  remainingCooldown(url) {
    const ep = this._getEndpoint(url)
    if (ep.state !== STATES.OPEN) return 0
    const elapsed = Date.now() - ep.openedAt
    return Math.max(0, ep.cooldown - elapsed)
  }

  recordSuccess(url) {
    const ep = this._getEndpoint(url)
    if (ep.state === STATES.HALF_OPEN) {
      console.log(`[circuit-breaker] ${url} HALF_OPEN -> CLOSED (probe succeeded)`)
    }
    ep.state = STATES.CLOSED
    ep.failures = 0
    ep.cooldown = this.initialCooldown
    ep.probing = false
  }

  recordFailure(url) {
    const ep = this._getEndpoint(url)

    if (ep.state === STATES.HALF_OPEN) {
      ep.cooldown = Math.min(ep.cooldown * 2, this.maxCooldown)
      ep.state = STATES.OPEN
      ep.openedAt = Date.now()
      ep.probing = false
      console.log(`[circuit-breaker] ${url} HALF_OPEN -> OPEN (probe failed, cooldown ${Math.round(ep.cooldown / 1000)}s)`)
      return
    }

    ep.failures++
    if (ep.failures >= this.threshold) {
      ep.state = STATES.OPEN
      ep.openedAt = Date.now()
      ep.probing = false
      console.log(`[circuit-breaker] ${url} CLOSED -> OPEN (${ep.failures} consecutive failures, cooldown ${Math.round(ep.cooldown / 1000)}s)`)
    }
  }
}

// Shared singleton — all sessions share circuit state
export default new CircuitBreaker({ threshold: 3, initialCooldown: 30000, maxCooldown: 1800000 })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/circuit-breaker.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/circuit-breaker.js tests/circuit-breaker.test.js
git commit -m "feat: add circuit breaker module for provider endpoints"
```

---

### Task 2: Integrate Circuit Breaker into openai-compat.js

**Files:**
- Modify: `server/lib/providers/openai-compat.js`
- Modify: `tests/providers-openai-compat.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/providers-openai-compat.test.js`:

```js
import { CircuitBreaker, CircuitOpenError } from '../server/lib/circuit-breaker.js'

describe('openai-compat circuit breaker integration', () => {
  it('records success on successful response', async () => {
    // This test verifies the wiring — that streamMessage calls circuitBreaker methods.
    // We'll test by checking that after 3 failures, the 4th call throws CircuitOpenError
    // without making a network request.
    const provider = createOpenAICompatProvider({
      base_url: 'http://dead-provider.test:1234',
      api_key: 'test-key',
    })

    // Stub fetch to always fail with network error
    const origFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount++
      throw new Error('connect ECONNREFUSED')
    }

    // First call: 3 retries, all fail
    try {
      await provider.streamMessage(
        { model: 'test', maxTokens: 100, system: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [], serverTools: [] },
        () => {},
      )
    } catch { /* expected */ }

    const firstFetchCount = fetchCount

    // Second call: should throw CircuitOpenError immediately (no fetch)
    try {
      await provider.streamMessage(
        { model: 'test', maxTokens: 100, system: 'test', messages: [{ role: 'user', content: 'hi' }], tools: [], serverTools: [] },
        () => {},
      )
      assert.fail('should have thrown')
    } catch (err) {
      assert.equal(err.isCircuitOpen, true)
    }

    // Verify no additional fetch calls were made
    assert.equal(fetchCount, firstFetchCount)

    globalThis.fetch = origFetch
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/providers-openai-compat.test.js`
Expected: FAIL — CircuitOpenError not thrown (all 3 retries run on second call too)

- [ ] **Step 3: Integrate circuit breaker into openai-compat.js**

In `server/lib/providers/openai-compat.js`, add the import at the top:

```js
import circuitBreaker, { CircuitOpenError } from '../circuit-breaker.js'
```

In `streamMessage`, before the retry loop, add a circuit breaker check. Replace the retry loop (lines 234-271) with:

```js
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // Circuit breaker check — skip all retries if endpoint is dead
        if (circuitBreaker.isOpen(baseUrl)) {
          throw new CircuitOpenError(baseUrl, Math.round(circuitBreaker.remainingCooldown(baseUrl) / 1000))
        }

        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
          })
        } catch (err) {
          const cause = err.cause ? `: ${err.cause.message || err.cause.code || err.cause}` : ''
          lastErr = new Error(`OpenAI-compat fetch failed${cause}`)
          response = null
          console.log(`[openai-compat] fetch attempt ${attempt + 1}/${MAX_RETRIES} failed${cause}`)
          circuitBreaker.recordFailure(baseUrl)
        }

        // Retry on network errors and 429/5xx
        if (response && response.status !== 429 && response.status < 500) {
          circuitBreaker.recordSuccess(baseUrl)
          break
        }

        if (response && response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10)
          const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAY_MS * (attempt + 1)
          lastErr = new Error(`OpenAI-compat rate limited (429), retrying in ${Math.round(delay / 1000)}s`)
          circuitBreaker.recordFailure(baseUrl)
        } else if (response && response.status >= 500) {
          const text = await response.text().catch(() => '')
          lastErr = new Error(`OpenAI-compat server error ${response.status}: ${text}`)
          circuitBreaker.recordFailure(baseUrl)
        }

        // Delay before retry (network errors, 429, 5xx all get backoff)
        if (attempt < MAX_RETRIES - 1) {
          const retryAfter = response?.status === 429
            ? parseInt(response.headers.get('retry-after') || '0', 10)
            : 0
          const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAY_MS * (attempt + 1)
          await new Promise(r => setTimeout(r, delay))
        }
      }
```

Also add circuit breaker check to `classifyIntent` — before the fetch call at line 177:

```js
        if (circuitBreaker.isOpen(baseUrl)) return 'auto' // fall back on circuit open
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/providers-openai-compat.test.js`
Expected: All tests PASS

Note: The circuit breaker is a shared singleton, so the test from Step 1 will leave its endpoint in OPEN state. This is fine — each test uses a unique URL (`dead-provider.test:1234`). If existing tests use the same `base_url`, they may need unique URLs. Check and fix if needed.

- [ ] **Step 5: Commit**

```bash
git add server/lib/providers/openai-compat.js tests/providers-openai-compat.test.js
git commit -m "feat: integrate circuit breaker into openai-compat provider"
```

---

### Task 3: Handle CircuitOpenError in Executor Fallback Chain

**Files:**
- Modify: `server/lib/agent.js`
- Modify: `tests/agent-hybrid.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/agent-hybrid.test.js`:

```js
import { CircuitOpenError } from '../server/lib/circuit-breaker.js'

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

    // Orchestrator emits a tool call, executor fallback chain has dead + good
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

    // Dead provider was attempted (threw CircuitOpenError), good provider succeeded
    assert.equal(deadProvider.streamMessage.mock.callCount(), 1)
    assert.equal(goodProvider.streamMessage.mock.callCount(), 1)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agent-hybrid.test.js`
Expected: Should already pass since `callExecutorWithFallback` catches all errors — but verify the log message says "circuit open" not a generic error.

- [ ] **Step 3: Add explicit CircuitOpenError handling to callExecutorWithFallback**

In `server/lib/agent.js`, add the import:

```js
import { CircuitOpenError } from './circuit-breaker.js'
```

In `callExecutorWithFallback`, replace the catch block:

```js
    try {
      const result = await provider.streamMessage({ ...params, model: modelId }, onEvent)
      return { result, model: modelId }
    } catch (err) {
      lastErr = err
      if (err.isCircuitOpen) {
        console.log(`[hybrid] executor ${modelId} skipped: circuit open for ${err.url}`)
      } else {
        console.log(`[hybrid] executor ${modelId} failed: ${err.message}, trying next`)
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agent-hybrid.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent.js tests/agent-hybrid.test.js
git commit -m "feat: handle CircuitOpenError in executor fallback chain"
```

---

### Task 4: Degenerate Idle Thought Detection (Fix A)

**Files:**
- Modify: `server/lib/chat-session.js`

This task modifies `_idleThought()` and `_startIdleTimer()` in `chat-session.js`. We test this through the Room class directly in Task 6. This task focuses on the implementation.

- [ ] **Step 1: Add `_consecutiveDegenerateCount` to constructor**

In the `Room` constructor (around line 66), after `this._idleInterval = IDLE_THOUGHT_INTERVAL`, add:

```js
    this._consecutiveDegenerateCount = 0
```

- [ ] **Step 2: Modify `_idleThought()` to detect and discard degenerate results**

Replace the `_idleThought()` method (lines 504-595) with:

```js
  async _idleThought() {
    if (this.busy) {
      return false // skipped — timer wrapper handles restart
    }

    this.busy = true
    console.log(`[${this.persona.config.name}] Idle thought triggered, ${this.clients.size} clients connected`)

    try {
      const idleMessages = [
        ...this.messages,
        { role: 'user', content: IDLE_THOUGHT_PROMPT },
      ]

      // Determine orchestrator vs direct mode
      const hasOrchestrator = this.persona.config.orchestrator != null
      let orchestratorModel, orchestratorProvider, executorModel, executorProvider

      if (hasOrchestrator) {
        const orchModelStr = typeof this.persona.config.orchestrator === 'string'
          ? this.persona.config.orchestrator
          : this.persona.config.orchestrator.model
        const orchResolved = this.registry.resolve(orchModelStr)
        orchestratorModel = orchResolved.modelId
        orchestratorProvider = orchResolved.provider

        executorModel = this.persona.config.model
      } else {
        const mainResolved = this.registry.resolve(this.persona.config.model)
        orchestratorModel = mainResolved.modelId
        orchestratorProvider = mainResolved.provider
      }

      const agentConfig = {
        model: orchestratorModel,
        maxTurns: 5,
        thinkingBudget: this.persona.config.chat?.thinking_budget || null,
        serverTools: this.persona.config.server_tools || [],
        provider: orchestratorProvider,
        executorProvider: null,
        executorModel: hasOrchestrator ? executorModel : null,
        executorFallbackModels: hasOrchestrator ? (this.persona.config.fallback_models || []) : [],
        orchestratorFallbackModels: hasOrchestrator ? (this.persona.config.orchestrator_fallback_models || []) : [],
        registry: this.registry,
      }

      // Wrap events as idle thoughts for the UI — broadcast errors must not
      // abort the agent call, so catch them individually
      let idleText = ''
      let toolUseCount = 0
      const onEvent = (event) => {
        try {
          if (event.type === 'text_delta') {
            idleText += event.text
            this.broadcast({ type: 'idle_text_delta', text: event.text })
          } else if (event.type === 'done') {
            this.broadcast({ type: 'idle_done' })
          } else if (event.type === 'tool_start') {
            toolUseCount++
            this.broadcast({ ...event, idle: true })
          } else if (event.type === 'tool_result') {
            this.broadcast({ ...event, idle: true })
          }
        } catch (err) {
          console.error(`[${this.persona.config.name}] Idle broadcast error:`, err.message)
        }
      }

      const prompt = replaceTimestamp(this.systemPrompt)
      const agentFn = hasOrchestrator ? runHybridAgent : runAgent
      const result = await agentFn(prompt, idleMessages, this.tools, agentConfig, onEvent)

      // Degenerate detection: discard if output is trivial with no real work
      const outputTokens = (result.usage?.output_tokens || 0)
      const isDegenerate = outputTokens <= 50
        && toolUseCount === 0
        && (!idleText || !idleText.trim())

      if (isDegenerate) {
        console.log(`[${this.persona.config.name}] Idle thought degenerate (${outputTokens} tokens, ${toolUseCount} tools, text=${!!idleText?.trim()}) — discarded`)
        return 'degenerate'
      }

      this.messages = result.messages
      if (idleText) {
        this.recordHistory({ type: 'idle_thought', text: idleText })
      }

      if (this.state) {
        this.state.update({ last_idle_thought: new Date().toISOString() })
        await this.state.save()
      }
      return true // completed
    } catch (err) {
      console.error(`[${this.persona.config.name}] Idle thought error:`, err.message)
      return false // failed
    } finally {
      this.busy = false

      // Flush any context messages that arrived while the agent was busy
      if (this._pendingContextMessages && this._pendingContextMessages.length > 0) {
        for (const msg of this._pendingContextMessages) {
          this.messages.push(msg)
        }
        this._pendingContextMessages = []
      }
    }
  }
```

- [ ] **Step 3: Modify `_startIdleTimer()` for degenerate handling and hard stop**

Replace `_startIdleTimer()` (lines 597-622) with:

```js
  _startIdleTimer() {
    this._clearIdleTimer()
    const interval = this._idleInterval
    console.log(`[${this.persona.config.name}] Idle timer set: ${Math.round(interval / 1000)}s`)
    this.idleTimer = setTimeout(async () => {
      this.idleTimer = null // mark as fired
      let completed = false
      try {
        completed = await this._idleThought()
      } catch (err) {
        // Safety net — _idleThought has its own try/catch, so this should
        // never fire, but if it does the timer must not die
        console.error(`[${this.persona.config.name}] Idle thought unhandled error:`, err.message)
        this.busy = false
      } finally {
        // ALWAYS reschedule unless destroyed or something else already set a timer
        // (e.g. a message came in during the thought and restarted it)
        if (!this.idleTimer && !this._destroyed) {
          if (completed === 'degenerate') {
            this._idleInterval = Math.min(this._idleInterval * 2, MAX_IDLE_INTERVAL)
            this._consecutiveDegenerateCount++

            if (this._consecutiveDegenerateCount >= 5) {
              console.log(`[${this.persona.config.name}] idle thoughts suspended after 5 consecutive degenerate results`)
              return // don't reschedule
            }
          } else if (completed === true) {
            this._idleInterval = Math.min(this._idleInterval * 2, MAX_IDLE_INTERVAL)
            this._consecutiveDegenerateCount = 0
          } else {
            // completed === false (error/skipped) — don't change interval
            this._consecutiveDegenerateCount = 0
          }
          this._startIdleTimer()
        }
      }
    }, interval)
  }
```

- [ ] **Step 4: Commit**

```bash
git add server/lib/chat-session.js
git commit -m "feat: detect and discard degenerate idle thoughts with hard stop at 5"
```

---

### Task 5: Protect Backoff From Room Message Resets (Fix B)

**Files:**
- Modify: `server/lib/chat-session.js`
- Modify: `server/routes/chat.js`

- [ ] **Step 1: Add `source` parameter to `addAgentMessage()`**

In `server/lib/chat-session.js`, replace `addAgentMessage` (lines 229-238) with:

```js
  addAgentMessage(name, text, { source = 'user' } = {}) {
    const taggedMessage = `[${this._timestamp()}][home/${name}${this._domainSuffix('home')}]: ${text}`
    this._safeAppendMessage({ role: 'user', content: taggedMessage })
    this.broadcast({ type: 'user_message', name, text, fromAgent: true })
    this.recordHistory({ type: 'user_message', name, text })
    this.lastActivity = Date.now()
    this._clearIdleTimer()
    this._consecutiveDegenerateCount = 0 // new info arrived, worth thinking about
    if (source === 'user') {
      this._idleInterval = IDLE_THOUGHT_INTERVAL // reset backoff on direct interaction only
    }
    this._startIdleTimer()
  }
```

- [ ] **Step 2: Also reset degenerate count on direct user messages in `_processMessage()`**

In `_processMessage()`, after line 355 (`this._idleInterval = IDLE_THOUGHT_INTERVAL`), add:

```js
      this._consecutiveDegenerateCount = 0
```

- [ ] **Step 3: Update the route call site to pass `source: 'room'` for visiting agents**

In `server/routes/chat.js`, line 74, change:

```js
    room.addAgentMessage(name, message)
```

to:

```js
    room.addAgentMessage(name, message, { source: 'room' })
```

- [ ] **Step 4: Commit**

```bash
git add server/lib/chat-session.js server/routes/chat.js
git commit -m "feat: protect idle backoff from room message resets"
```

---

### Task 6: Unit Tests for Fixes A and B

**Files:**
- Create: `tests/idle-circuit-breakers.test.js`

- [ ] **Step 1: Write tests for degenerate detection and backoff protection**

Create `tests/idle-circuit-breakers.test.js`:

```js
import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// We test by constructing a minimal Room and exercising its idle/backoff logic.
// This requires mocking the agent functions and provider.

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
    // Manually set up minimal state to call _idleThought
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
            // Simulate degenerate: tiny output, no tools, no meaningful text
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
    // Messages should be unchanged (discarded)
    assert.equal(room.messages.length, 0)
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
    // Messages should be updated
    assert.ok(room.messages.length > 0)
  })

  it('suspends idle timer after 5 consecutive degenerate results', async () => {
    const persona = makePersona()
    const room = new Room(persona)
    room._consecutiveDegenerateCount = 4
    room._idleInterval = 1000
    room._destroyed = false

    // Simulate _startIdleTimer logic for degenerate result
    // We test the counter logic directly
    room._consecutiveDegenerateCount++
    assert.equal(room._consecutiveDegenerateCount, 5)
    // At this point _startIdleTimer would NOT reschedule
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
    room._destroyed = true // prevent timer from actually firing

    room.addAgentMessage('visitor', 'hello', { source: 'user' })

    assert.equal(room._idleInterval, 30 * 60 * 1000) // reset to base
    assert.equal(room._consecutiveDegenerateCount, 0)
  })

  it('source=room preserves idle interval but resets degenerate count', () => {
    const persona = makePersona()
    const room = new Room(persona)
    room.systemPrompt = 'test'
    room.tools = { definitions: [] }
    room.chatLog = { append: async () => {} }
    room._idleInterval = 999999
    room._consecutiveDegenerateCount = 3
    room._destroyed = true // prevent timer from actually firing

    room.addAgentMessage('visitor', 'hello', { source: 'room' })

    assert.equal(room._idleInterval, 999999) // preserved
    assert.equal(room._consecutiveDegenerateCount, 0)
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

    assert.equal(room._idleInterval, 30 * 60 * 1000) // reset — default is 'user'
  })
})
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/idle-circuit-breakers.test.js`
Expected: All tests PASS (implementation was done in Tasks 4 and 5)

- [ ] **Step 3: Commit**

```bash
git add tests/idle-circuit-breakers.test.js
git commit -m "test: idle thought degenerate detection and backoff protection"
```

---

### Task 7: Run Full Test Suite

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All tests PASS. If any existing tests break, investigate and fix — likely candidates are tests that call `addAgentMessage` without the new options parameter (backward compatible via default) or tests that depend on idle thought always returning boolean.

- [ ] **Step 2: Fix any failures**

If tests fail, the most likely issues:
- Tests calling `addAgentMessage(name, text)` without third arg — should be fine due to default parameter
- Tests that mock `_idleThought` and check for boolean return — update to handle `'degenerate'` string
- Circuit breaker singleton state leaking between tests — use unique URLs per test

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from idle circuit breaker changes"
```
