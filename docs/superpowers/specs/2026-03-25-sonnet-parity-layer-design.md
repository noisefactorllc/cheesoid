# Sonnet-Parity Layer for OpenAI-Compatible Providers

**Date:** 2026-03-25
**Status:** Draft
**Scope:** cheesoid agent framework — openai-compat provider path only

## Problem

Open models (Qwen3, DeepSeek, Kimi) running through cheesoid's OpenAI-compatible provider cannot match Claude Sonnet's reliability for agentic tool-calling workflows. Key failures:

- Models hallucinate tool use (narrate instead of calling structured API)
- Infinite tool-calling loops with no text response
- Thinking/reasoning context lost between turns
- Flat system prompt with no priority hierarchy
- Silent config failures when Anthropic-only features are set
- No feedback loop when rescue mechanisms fire

Claude gets these capabilities from training. We must replicate them in application code for open models, without regressing the Anthropic provider path.

## Constraint

**No changes to the Anthropic provider path.** All modifications are gated on `provider === 'openai-compat'` or `provider.supportsIntentRouting`. The Anthropic provider, its message format, and its behavior remain untouched.

## Design

### 1. Intent Router v2

**Goal:** Determine whether each turn needs tool calls or a text response, with minimal latency and API cost.

**Three-tier classification:**

**Tier 1 — Heuristic fast-path (no API call):**
Pattern-match on conversation state. Handles ~60% of turns at zero cost.

- Last message contains `tool_result` blocks → `auto` (model decides: more tools or summarize)
- Consecutive tool calls >= 8 → `none` (force text response, existing safety valve)
- User message matches action patterns (imperative verbs: "run", "check", "do", "make", "start", "show", "look up", "find") → `required`
- User message matches conversation patterns (acknowledgments: "thanks", "ok", "nice", "lol", "got it"; questions about the agent: "how are you", "what do you think") → `none`
- No match → `uncertain`, fall through to Tier 2

The heuristic is a pure function. Easy to test, no API dependency. The pattern lists above are a starting set — they will grow based on observed router logs. Patterns are defined as arrays in the heuristic function, not in config files.

**Tier 2 — LLM classifier (cheap API call):**
Only fires when heuristic returns `uncertain`. Same structure as current router but with:
- Tool descriptions (not just names) in the classification prompt
- Post-tool-result awareness
- `max_tokens: 32`, `temperature: 0`
- Fallback to `auto` on any failure

**Tier 3 — Consecutive tool cap (existing):**
After 8 consecutive tool calls in one agent loop run, force `toolChoice: none`. Prevents runaway tool chains from exhausting maxTurns with no user-visible output.

**Files:** `server/lib/agent.js`, `server/lib/providers/openai-compat.js`

### 2. Thinking Context Round-Trip

**Goal:** Preserve model reasoning across turns so the chain of thought isn't lost between tool calls.

**Current behavior:** `translateMessages` drops all thinking/reasoning blocks. The model loses its own reasoning on every turn boundary.

**Proposed behavior:** When translating an assistant message that contains thinking blocks, prepend the reasoning to the assistant message content:

```
[internal reasoning: <reasoning text>]

<actual response text>
```

For tool-call-only turns (no text content), the reasoning becomes the assistant `content` field alongside the `tool_calls` array. The OpenAI format supports both `content` and `tool_calls` on the same assistant message.

Users never see the reasoning preamble — the chat session strips thinking blocks before broadcasting. The preamble exists only in the API message history.

**Files:** `server/lib/providers/translate.js`

### 3. Hierarchical Soul Corpus

**Goal:** Give open models a structured priority hierarchy equivalent to Claude's layered training.

**Current behavior:** One flat system prompt. All sections concatenated with `---` separators. Open models treat all sections equally and drift toward whichever is most contextually "interesting."

**Proposed behavior:** Four-layer hierarchy delivered as separate system messages, with tail reinforcement.

**Layer 1 — Constitutional (first system message):**
Behavioral base + tool discipline. Non-negotiable rules. Safety, honesty, "use function calling not narration." This gets maximum structural priority by being the first system message.

**Layer 2 — Identity (second system message):**
SOUL.md + persona voice + boundaries. Who the agent is, how it speaks, what it can and cannot do.

**Layer 3 — Operational (third system message):**
system.md + room topology + office awareness + plugin skills. What the agent does and how.

**Layer 4 — Context (fourth system message):**
Memory files + timestamp + chat history awareness. Current state.

**Tail reinforcement (appended to Layer 4):**
Compact restatement of the 3-5 most critical rules from Layer 1:

```
REMINDERS: Use tools via function calling — never narrate tool use in text.
Do not fabricate data — verify through tools. Do not take destructive actions
without confirmation. Stay in character.
```

This exploits transformer recency bias — the model attends most to what's closest to the conversation turn.

**Implementation:**
- `assemblePrompt` returns an array of section objects `[{role: 'system', content: '...'}]` for openai-compat, or a single joined string for Anthropic (no regression).
- `translateMessages` emits multiple system messages for openai-compat when given an array.
- Anthropic path receives one joined string as before.

**Files:** `server/lib/prompt-assembler.js`, `server/lib/providers/translate.js`

### 4. Config Validation and Graceful Degradation

**Goal:** Never silently ignore persona config features. Warn loudly, approximate where possible.

**At persona load time, when provider is openai-compat:**

| Config Feature | Action |
|---|---|
| `thinking_budget` | WARN + add "Think step by step before responding" to Layer 1 prompt |
| `server_tools: web_search` | WARN + add explicit "web search unavailable" notice to Layer 3 |
| `server_tools: [other]` | WARN + add "tool X unavailable" notice to Layer 3 |
| Opus-only features | INFO log, no approximation |

**Log format:**
```
[persona-name] WARN: thinking_budget (16000) approximated via prompt — native thinking not available with openai-compat
[persona-name] WARN: server_tool web_search not available with openai-compat — added notice to prompt
```

**Implementation:** Validation runs in `persona.js` after config load, before prompt assembly. Mutates config to inject approximation flags that downstream layers (prompt assembler) consume.

**Files:** `server/lib/persona.js`, `server/lib/prompt-assembler.js`

### 5. Narrated Tool Call Rescue (refinement)

**Goal:** Make the existing rescue mechanism smarter and self-correcting.

**Current behavior:** Rescue extracts JSON from narrated text, converts to tool_use block. No feedback to model.

**Three refinements:**

**5a. Correction feedback:**
After rescuing a narrated tool call, inject a synthetic message into the conversation:
```
[system: You narrated a tool call instead of using function calling. The call was executed, but you must use the function calling API directly.]
```
This teaches the model mid-conversation. Over a multi-tool chain, the model should self-correct after 1-2 rescues.

**5b. Rescue rate tracking:**
Track rescues per agent loop run. If rescue rate exceeds 50% over 4+ turns, the model fundamentally cannot do structured tool calling. Log a warning and force `toolChoice: none` for the remainder of the run — the model responds in text-only mode rather than burning tokens on broken tool chains. The cap resets on the next user message.

**5c. Respect toolChoice=none:**
If the router explicitly said "no tools" and the model narrated a tool call anyway, do NOT rescue. The model is ignoring instructions, not having a format problem. Let the text through as-is.

**Files:** `server/lib/agent.js`

## Files Changed

| File | Changes |
|---|---|
| `server/lib/agent.js` | Router v2 (heuristic layer), rescue refinements, consecutive tracking, correction injection |
| `server/lib/providers/openai-compat.js` | Heuristic classifier, toolChoice passthrough |
| `server/lib/providers/translate.js` | Thinking round-trip, multi-system-message support |
| `server/lib/prompt-assembler.js` | Hierarchical sections, tail reinforcement, array return for openai-compat |
| `server/lib/persona.js` | Config validation, degradation warnings, approximation flags |

## Files NOT Changed

| File | Why |
|---|---|
| `server/lib/providers/anthropic.js` | Anthropic path untouched |
| `server/lib/chat-session.js` | No changes needed — consumes provider output identically |
| Persona files | Work as-is with better behavior |

## Testing Strategy

- Heuristic classifier: Unit tests for each pattern category (action verbs, conversation patterns, uncertain)
- Thinking round-trip: Unit tests in translate.js for reasoning preservation
- Hierarchical prompt: Unit tests for section ordering and multi-message output
- Config validation: Unit tests for each warning/approximation case
- Rescue refinements: Extend existing agent-rescue.test.js
- Integration: Manual testing with yipyip-ehsre on BlueOcean UltraFast endpoint
- Regression: Full test suite must pass — Anthropic path verified unchanged
