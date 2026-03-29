# Attention/Cognition Modal Architecture

**Date:** 2026-03-28
**Status:** Draft

## Overview

Replace the current single "orchestrator" role with two **modal states** — **attention** and **cognition** — that share identical tool access and functionality but run different models. The agent dynamically shifts between them based on engagement level.

## Current State

Today, the orchestrator is a single model that handles everything: watching chat, deciding on actions, speaking with the agent's voice, and delegating to the executor for tool loops. There's no concept of "how engaged am I right now."

## Proposed Layer Stack

```
┌─────────────────────┐
│     REASONING        │  deep_think tool — unchanged
├─────────────────────┤
│     COGNITION        │  frontier model, full engagement, Agent Voice
├─────────────────────┤
│     ATTENTION        │  capable but cheaper model, monitoring, triage
├─────────────────────┤
│     EXECUTION        │  tool-loop executor — unchanged
└─────────────────────┘
```

## What Changes

### Attention Mode (default/resting state)

- Runs a capable but lower-cost model (e.g. GPT, Haiku)
- Watches open threads with "half an eye"
- Handles routine triage: tool delegation, simple acknowledgments, background monitoring
- Does NOT speak with Agent Voice for substantive engagement
- Delegates to execution layer for tool use (same as today)
- Delegates **up** to cognition when direct engagement is detected

### Cognition Mode (active engagement state)

- Runs a higher-end frontier model (e.g. Sonnet)
- Activates when the agent is being directly addressed or needs to engage substantively
- Speaks with the full Agent Voice — this is where persona shines
- Delegates to execution layer for tool use (same as today)
- Delegates **up** to reasoning layer via deep_think (same as today)
- Steps **down** to attention mode after a period of non-engagement

## Key Design Principles

1. **Modal, not structural.** Attention and cognition are the same agent in different gears. Same system prompt, same tools, same message history. The only difference is which model is running.

2. **Agent-controlled gear shifting.** The agent decides when to step up and step down. This is not external routing — it's self-aware modality switching. The system prompt must clearly explain both modes and give the agent explicit guidance on when/how to shift.

3. **Step-up triggers** (attention → cognition):
   - Being directly addressed/mentioned
   - Questions or topics requiring substantive response
   - Situations requiring Agent Voice (opinion, personality, nuanced communication)
   - Agent's own judgment that the moment calls for full engagement

4. **Step-down triggers** (cognition → attention):
   - Conversation goes quiet / no direct engagement for some duration
   - Thread shifts to other participants
   - Agent's own judgment that monitoring mode is sufficient

5. **System prompt requirements.** Must include detailed documentation of both modalities — what they are, why they exist, and explicit instructions for how to self-manage the gear shift. The agent needs to understand it's the same "self" at two levels of engagement.

## What Doesn't Change

- **Execution layer** — tool-loop executor works exactly as today
- **Reasoning layer** — deep_think delegation works exactly as today
- **Prompt assembly** — same SOUL.md, same system prompt, same memory
- **Tool access** — identical in both modes

## Configuration Shape (sketch)

```yaml
# replaces single `orchestrator` field
cognition: claude-sonnet-4-6              # frontier model, full engagement
attention: claude-haiku-4-5               # capable model, monitoring
model: gpt-4.1-nano:openai               # executor (unchanged)
```

## Open Questions

1. **Gear-shift mechanism.** How does attention mode actually trigger a cognition call? Options:
   - Attention model returns a special signal/tool call ("step_up") that causes the framework to re-run the turn with the cognition model
   - Framework detects the signal and swaps models for the next turn
   - Something else?

2. **Step-down timing.** What's the idle threshold before cognition drops back to attention? Is it time-based, turn-based, or purely agent-judged?

3. **Transition visibility.** Should gear shifts be visible in the chat (even subtly), or completely transparent?

4. **Fallback chains.** Do attention and cognition each get their own fallback model lists?

5. **Hybrid executor interaction.** Today the orchestrator delegates to executor. In the new world, both attention and cognition delegate to executor identically — confirm this is the intent.
