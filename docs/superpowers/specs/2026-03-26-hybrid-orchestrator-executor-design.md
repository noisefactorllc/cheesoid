# Hybrid Orchestrator/Executor Agent Architecture

**Date:** 2026-03-26
**Status:** Draft
**Scope:** cheesoid agent framework — new hybrid execution mode

## Problem

Running cheesoid agents on Claude Sonnet works well but is expensive — every tool call, every observation, every curl output burns Sonnet tokens. Open models are cheap but can't maintain persona voice, make good judgment calls, or reliably call tools without heavy scaffolding.

## Insight

Claude's agent loop already interleaves thinking and tool execution: think → act → observe → think → act → observe. The thinking is expensive and requires intelligence. The acting (calling curl, running bash) is mechanical and requires none. Split them.

## Design

### Two Roles, One Loop

**Orchestrator** (smart, expensive): Does all reasoning, persona voice, decision-making. Sees full context — persona, memory, state, history. Generates tool calls and user-facing text.

**Executor** (cheap, fast): Runs tool calls on behalf of the orchestrator. Sees only the tool definition and arguments. Returns structured results. Never generates user-facing text. Never sees persona or history.

Both roles are swappable provider instances. Today's orchestrator is Sonnet, tomorrow it could be a capable open model. Today's executor is an open model on BlueOcean, tomorrow it could be Haiku.

### Execution Flow

The hybrid agent loop mirrors the existing single-model loop, but tool execution is delegated:

```
while (not done):
    [Orchestrator call]
    - Input: system prompt + full message history (including prior tool results)
    - Output: text content and/or tool_use blocks (standard Anthropic format)

    if response has text → broadcast to chat
    if response has tool_use → for each tool call:
        [Executor call]
        - Input: minimal system prompt + tool definition + tool arguments
        - Output: tool result (structured)
        - Tool results appended to message history

    if stop_reason != tool_use → done
```

This is the same loop structure as `runAgent` today. The difference: instead of the provider calling the tool-execution code directly, tool_use blocks from the orchestrator are forwarded to the executor provider for execution.

### The Inner Dialogue

A wakeup round looks like:

```
Orchestrator: [thinking] Starting round. Need to check mentions first.
              [tool_use] bash: curl -s .../notifications?type=mention

    Executor: runs curl, returns JSON

Orchestrator: [thinking] One mention from madcow about logging. Should reply.
              [text] → (not broadcast yet, accumulates)
              [tool_use] bash: curl -X POST .../statuses -d '{"status":"@madcow ..."}'

    Executor: runs curl, returns post ID

Orchestrator: [thinking] Now check timeline for moderation.
              [tool_use] bash: curl -s .../timelines/public?limit=40

    Executor: runs curl, returns timeline JSON

Orchestrator: [thinking] Timeline clean. Round complete.
              [text] "Round complete. No mentions to act on, timeline nominal."
              [stop_reason: end_turn]

→ final text broadcast to chat
```

The orchestrator has a continuous inner dialogue — exactly like Claude in Claude Code. The executor is invisible plumbing.

### Executor Call Shape

Each executor call is a single, narrow tool invocation:

```json
{
  "system": "You are a tool executor. Run the requested tool and return the result. Do not add commentary.",
  "messages": [
    {"role": "user", "content": "Execute this tool call."}
  ],
  "tools": [<single tool definition>],
  "tool_choice": "required"
}
```

The executor sees:
- A one-line system prompt (no persona, no history, no memory)
- The tool definition for the specific tool being called
- `tool_choice: required` (must call the tool, can't narrate)

The executor does NOT see:
- Persona/SOUL
- Conversation history
- Memory files
- Other tool definitions
- The orchestrator's reasoning

This keeps executor token costs minimal (~100-200 tokens per call) and prevents the cheap model from going off-script.

### Direct Tool Execution (Optimization)

Not all tool calls need an LLM. For tools where the orchestrator provides the exact arguments and no intelligence is needed in the execution, the hybrid loop can skip the executor entirely and call the tool function directly:

- `bash` — run the command, return stdout/stderr
- `read_file` — read the file, return contents
- `send_mail` — send the email, return status

These are pure function calls. The executor LLM adds nothing. The hybrid loop should detect when tool arguments are fully specified and execute directly, falling back to the executor only when needed.

This is the default behavior — direct execution. The executor is a fallback for tools that require LLM-mediated invocation (future capability, not currently needed).

### Config

```yaml
# Primary model — becomes executor in hybrid mode, sole model in single mode
provider: openai-compat
base_url: ${OPENAI_COMPAT_BASE_URL}
api_key: ${OPENAI_COMPAT_API_KEY}
model: AltFast/DeepSeek-V3.1

# Orchestrator — when present, enables hybrid mode
orchestrator:
  provider: anthropic
  model: claude-sonnet-4-6

# OR both can be openai-compat:
# orchestrator:
#   provider: openai-compat
#   base_url: ${ORCHESTRATOR_BASE_URL}
#   api_key: ${ORCHESTRATOR_API_KEY}
#   model: some-smart-model

# OR executor can be Anthropic too (e.g. Haiku):
# provider: anthropic
# model: claude-haiku-4-5
# orchestrator:
#   provider: anthropic
#   model: claude-sonnet-4-6
```

When `orchestrator` is absent, the existing single-model behavior applies (unchanged). The `provider` + `model` fields always define the primary/executor model.

### Provider Handling

Both orchestrator and executor go through the existing `getProvider()` factory. The agent loop creates two provider instances when orchestrator config is present:

```javascript
const executor = getProvider(config)          // existing behavior
const orchestrator = getProvider(config.orchestrator)  // new
```

Both providers implement the same `streamMessage` interface. The orchestrator uses it with full context (system prompt, history, all tools). The executor uses it with minimal context (narrow prompt, single tool, tool_choice: required).

### Message History

The orchestrator maintains the full message history, exactly like today. Tool results from the executor are appended as tool_result blocks in the standard format. The orchestrator sees a continuous conversation that includes its own reasoning and all tool outputs — identical to how Claude sees it in single-model mode.

The executor has no persistent state. Each call is stateless.

### What Changes vs Single-Model

| Aspect | Single-Model | Hybrid |
|--------|-------------|--------|
| Who reasons | Primary model | Orchestrator |
| Who calls tools | Primary model (via provider) | Executor (via provider) or direct |
| Who writes text | Primary model | Orchestrator |
| Tool_choice | Intent router decides | Orchestrator decides (it emits tool_use or doesn't) |
| Context per tool call | Full history | Minimal (executor) or none (direct) |
| Intent routing | Required (open models hallucinate) | Not needed (orchestrator is smart) |
| Rescue logic | Required | Not needed |
| Persona in prompt | Every call | Orchestrator calls only |

### Cost Model

Assume a wakeup round with 8 tool calls:

**Single-model (Sonnet):** 8 turns × ~4k tokens context = ~32k input tokens + ~2k output = ~34k tokens total Sonnet pricing.

**Hybrid (Sonnet orchestrator + cheap executor):**
- Orchestrator: 3-4 turns × ~4k context = ~16k input + ~1k output = ~17k tokens Sonnet pricing
- Executor: 8 calls × ~200 tokens = ~1.6k tokens cheap pricing
- Total Sonnet tokens: ~50% reduction
- Total cost: significantly less (executor tokens are 10-50x cheaper)

**Hybrid (Sonnet orchestrator + Haiku executor):**
- Same split but Haiku is still Anthropic — simpler (no openai-compat plumbing needed), just cheaper per token.

### Files Changed

| File | Changes |
|---|---|
| `server/lib/agent.js` | New `runHybridAgent` alongside existing `runAgent` |
| `server/lib/providers/index.js` | Handle `config.orchestrator` to create second provider |
| `server/lib/chat-session.js` | Route to `runHybridAgent` when orchestrator configured |
| `server/lib/persona.js` | Validate orchestrator config block |

### Files NOT Changed

| File | Why |
|---|---|
| `server/lib/providers/anthropic.js` | Used as-is for either role |
| `server/lib/providers/openai-compat.js` | Used as-is for either role |
| `server/lib/providers/translate.js` | Used as-is for both |
| `server/lib/prompt-assembler.js` | Orchestrator gets the assembled prompt, executor gets hardcoded minimal prompt |
| Existing single-model code | `runAgent` unchanged, hybrid is additive |

### Testing Strategy

- `runHybridAgent`: mock both providers, verify orchestrator/executor interleaving
- Direct tool execution: verify tools are called directly without executor LLM
- Provider factory: verify two providers created from hybrid config
- Config validation: verify graceful errors for invalid orchestrator config
- Integration: wakeup round with real Sonnet + BlueOcean
- Regression: existing 137 tests pass (single-model path untouched)
- Cost validation: log token usage per role, verify executor calls are minimal

### Migration Path

1. Implement `runHybridAgent` alongside `runAgent`
2. Test with yipyip-ehsre: Sonnet orchestrator + DeepSeek executor
3. If working, test with Haiku executor (cheapest Anthropic option)
4. Eventually: test with open-model orchestrator when one is smart enough
5. Never remove single-model path — it's the fallback and the simplest option
