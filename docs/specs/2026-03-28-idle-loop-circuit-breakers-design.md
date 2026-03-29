# Idle Loop Circuit Breakers

**Date:** 2026-03-28
**Repo:** noisefactorllc/cheesoid
**Status:** Spec

## Incident Summary

On 2026-03-28, both EHSRE and Ask agents were found stuck in idle thought loops, burning API credits on degenerate responses with no meaningful output.

### EHSRE Failure

- **Orchestrator:** claude-sonnet-4-6
- **Executor:** claude-haiku-4-5
- **Symptom:** Idle thoughts firing every 3600s, producing 12-token empty responses ("nothing to say"), no tool use. Context grew from ~137k to ~154k tokens over dozens of cycles.
- **Compounding factor:** Occasional tool calls returned results, but the orchestrator produced a 4-token empty response afterward, triggering the nudge mechanism — which added another API call that also produced nothing useful.
- **Brad connection lost:** `connect ECONNREFUSED 172.19.0.13:3000` appeared mid-loop. May have contributed to the orchestrator having nothing to do.

### Ask Failure

- **Orchestrator:** gpt-5.4 (OpenAI)
- **Executor:** UltraFast/qwen-3-235b-a22b-instruct-2507 (BlueOcean), with fallbacks to SecuredTEE/llama3-3-70b and BlueOcean/qwen3.5:35b
- **Symptom:** BlueOcean provider (`api.ai.dc.blueocean.is`, 64.71.143.164:443) completely unreachable. Every idle thought with a tool call burned 9 failed HTTP requests (3 retries x 3 models) before falling through to gpt-5.4-mini as last-resort executor.
- **Context growth:** Moderate (17k to ~27k tokens), but the wasted network requests and retry delays dominated.

### Root Causes

Three independent bugs combined to create the loops:

| Bug | Location | Problem |
|-----|----------|---------|
| **A: No degenerate idle detection** | `chat-session.js` `_idleThought()` | A 12-token "nothing to do" response counts as `completed = true`, gets appended to conversation history, and grows context indefinitely |
| **B: Backoff resets on room messages** | `chat-session.js` `addAgentMessage()` | Room messages (from yipyip-ehsre, brad) reset `_idleInterval` to base 30min, preventing exponential backoff from ever reaching longer intervals |
| **C: No provider circuit breaker** | `openai-compat.js` | A dead provider endpoint gets retried from scratch on every single call — 3 attempts per model, 3 models = 9 wasted requests per tool invocation |

## Fix A: Degenerate Idle Thought Detection and Discard

### Files
- `server/lib/chat-session.js`

### Behavior

After `_idleThought()` runs the agent, classify the result before committing it to conversation history:

**Degenerate criteria (ALL must be true):**
1. Total assistant output tokens across all turns <= 50
2. No tool calls that produced results (tool_use count = 0, or all tool results were empty/error)
3. No text was broadcast to connected clients (idleText is empty or whitespace-only)

If degenerate:
- **Do NOT update `this.messages`** — discard the entire agent run. Conversation history stays unchanged.
- **Do NOT call `recordHistory()`** — no idle_thought event recorded.
- Return a distinct value: `'degenerate'` (not `true`, not `false`).

### Timer behavior for degenerate results

In the timer wrapper (`_startIdleTimer`):

- `'degenerate'` still doubles `_idleInterval` (same as `completed = true`). The agent had nothing to do — waiting longer is correct.
- Track `_consecutiveDegenerateCount`. Increment on `'degenerate'`, reset to 0 on `true` or on any real user/room message.
- **Hard stop:** When `_consecutiveDegenerateCount >= 5`, stop scheduling idle thoughts entirely. Log: `[<agent>] idle thoughts suspended after 5 consecutive degenerate results`.
- **Resume:** Reset `_consecutiveDegenerateCount` to 0 and restart idle timer when a real message arrives (user input or room message that isn't from self).

### Token counting

The agent function (`runAgent`/`runHybridAgent`) already returns usage stats in its result. Surface `totalUsage.output_tokens` from the result so `_idleThought` can check it. If the agent function doesn't currently return this, add it to the return value.

## Fix B: Protect Backoff From Room Message Resets

### Files
- `server/lib/chat-session.js`

### Current behavior

`addAgentMessage()` unconditionally resets `_idleInterval` to `IDLE_THOUGHT_INTERVAL` (30min) and restarts the timer. This is called for both direct user messages AND forwarded room messages.

### New behavior

Add a `source` parameter to `addAgentMessage()`:

```
addAgentMessage(message, { source = 'user' } = {})
```

- `source = 'user'` (direct interaction): Reset `_idleInterval` to base, reset `_consecutiveDegenerateCount` to 0, restart timer.
- `source = 'room'` (forwarded from room connection): Restart the timer (so the agent will eventually think about the new message) but **do NOT reset `_idleInterval`**. The current backoff level is preserved. Do reset `_consecutiveDegenerateCount` to 0 (new information arrived, worth thinking about).

### Call sites

Audit all callers of `addAgentMessage()`. Room client message handlers should pass `{ source: 'room' }`. Direct user message paths keep the default `'user'`.

## Fix C: Provider-Level Circuit Breaker

### Files
- New: `server/lib/circuit-breaker.js`
- Modified: `server/lib/providers/openai-compat.js`

### Circuit Breaker State Machine

Each provider endpoint (identified by base URL) gets its own circuit breaker with three states:

```
CLOSED ──(N consecutive failures)──> OPEN
OPEN ──(cooldown expires)──> HALF_OPEN
HALF_OPEN ──(probe succeeds)──> CLOSED
HALF_OPEN ──(probe fails)──> OPEN (double cooldown)
```

### Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| Failure threshold | 3 consecutive failures | Per-endpoint, not per-model |
| Initial cooldown | 30 seconds | |
| Cooldown multiplier | 2x | Exponential backoff |
| Max cooldown | 30 minutes | Upper limit |
| Cooldown reset | On successful request | Back to initial 30s |

### CLOSED state (normal operation)
- All requests proceed normally.
- Track consecutive failure count per endpoint.
- On failure: increment count. If count >= threshold, transition to OPEN.
- On success: reset count to 0.

### OPEN state (endpoint considered dead)
- All requests to this endpoint are **immediately rejected** with a synthetic error: `CircuitOpenError: endpoint ${url} circuit open, retry in ${remainingCooldown}s`
- This error is **not retryable** by the openai-compat retry loop — it skips straight to the next model in the fallback chain.
- When cooldown expires, transition to HALF_OPEN.

### HALF_OPEN state (probing)
- Allow exactly **one** request through.
- On success: transition to CLOSED, reset cooldown to initial value.
- On failure: transition to OPEN, double the cooldown (up to max).

### Integration with openai-compat.js

Before making a fetch request, check the circuit breaker for the endpoint URL:

```
if (circuitBreaker.isOpen(baseUrl)) {
  throw new CircuitOpenError(baseUrl, circuitBreaker.remainingCooldown(baseUrl))
}
```

After a response (success or failure), report to the circuit breaker:

```
circuitBreaker.recordSuccess(baseUrl)
// or
circuitBreaker.recordFailure(baseUrl)
```

The existing retry loop in openai-compat.js counts network errors and 429/5xx as failures. These same conditions feed the circuit breaker. The circuit breaker is **per-endpoint**, not per-model — if the endpoint is down, all models on that endpoint are affected.

### Integration with executor fallback chain

In `callExecutorWithFallback()` (`agent.js`), when iterating models:
- If a model's provider throws `CircuitOpenError`, skip it immediately (no retry delay).
- Log: `[hybrid] executor ${model} skipped: circuit open for ${endpoint}`
- Continue to next model in chain.

This replaces the current behavior of burning 3 retries x 2s delay = 6s+ per dead model.

### Shared instance

The circuit breaker is a singleton (or per-process instance). All chat sessions share the same circuit breaker state. If BlueOcean is down for Ask, it's down for everyone — no point in other sessions re-discovering this.

Export from `circuit-breaker.js`:

```
const breaker = new CircuitBreaker({ threshold: 3, initialCooldown: 30000, maxCooldown: 1800000 })
module.exports = breaker
```

### Logging

State transitions are logged:
- `[circuit-breaker] ${url} CLOSED -> OPEN (3 consecutive failures, cooldown 30s)`
- `[circuit-breaker] ${url} OPEN -> HALF_OPEN (cooldown expired, probing)`
- `[circuit-breaker] ${url} HALF_OPEN -> CLOSED (probe succeeded)`
- `[circuit-breaker] ${url} HALF_OPEN -> OPEN (probe failed, cooldown 60s)`

## Interaction Between Fixes

The three fixes are independent codepaths but reinforce each other:

- **A + B together** solve the idle loop: degenerate thoughts are discarded (A) AND the backoff actually progresses (B), so an idle agent quickly reaches multi-hour intervals and then suspends entirely after 5 degenerate cycles.
- **C** is orthogonal — it reduces the cost of each individual idle thought when an executor provider is down, regardless of whether the idle loop itself is fixed.
- **Without A**, fixing B alone would still accumulate degenerate responses in history (context bloat).
- **Without B**, fixing A alone would still see frequent idle fires due to room message resets (but at least they'd be cheap since degenerate ones are discarded).

## Testing

### Unit tests for Fix A
- Mock agent function returning < 50 output tokens, no tool use → verify messages unchanged, returns `'degenerate'`
- Mock agent function returning > 50 output tokens with tool use → verify messages updated, returns `true`
- Verify `_consecutiveDegenerateCount` increments and suspends at 5
- Verify counter resets on real message arrival

### Unit tests for Fix B
- Call `addAgentMessage()` with `source: 'room'` → verify `_idleInterval` not reset
- Call `addAgentMessage()` with `source: 'user'` → verify `_idleInterval` reset to base
- Both should reset `_consecutiveDegenerateCount`

### Unit tests for Fix C
- 3 consecutive failures → circuit opens, next call throws CircuitOpenError immediately
- Cooldown expires → one probe allowed
- Probe succeeds → circuit closes
- Probe fails → cooldown doubles
- Cooldown caps at 30 minutes
- Success resets cooldown to initial value

### Integration test
- Start agent with a dead executor provider endpoint
- Trigger idle thought
- Verify: circuit opens after first tool call's failures, subsequent tool calls skip the dead provider instantly
- Verify: idle thought classified as degenerate if output is minimal
- Verify: after 5 degenerate idle thoughts, idle timer suspends

## Non-Goals

- **Alerting/dashboard integration** — out of scope, can be added later by watching the log lines.
- **Persisting circuit breaker state across restarts** — in-memory is fine; on restart, providers get re-probed naturally.
- **Per-model circuit breaking** — overkill. If the endpoint is down, all models on it are down.
- **Changing the idle thought prompt** — the prompt is fine; the problem is the feedback loop, not what the agent is asked to do.
