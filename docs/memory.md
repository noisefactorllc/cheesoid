# Agent Memory

Each persona has a flat-file memory directory (`memory:` in persona.yaml). Files are plain Markdown. `memory.auto_read` names the files preloaded into the system prompt on every turn.

## Enforced limits

| Limit | Value | Enforced in |
|---|---|---|
| Preload cap — auto_read files are truncated in the system prompt past this, with an in-prompt notice | 32KB | `server/lib/prompt-assembler.js` |
| Read cap — `read_memory` returns at most this much of one file | 32KB | `server/lib/tools.js` + `memory.js` |
| Compaction pressure — `append_memory` notes the size once a file passes this | 64KB | `server/lib/tools.js` |

The constants live in `server/lib/memory.js` (`MEMORY_READ_CAP_BYTES`, `MEMORY_COMPACT_WARN_BYTES`). The in-prompt doctrine derives its numbers from those constants, so the prose agents read can never drift from what the code enforces.

## Doctrine (framework-injected into every persona's system prompt)

Agents manage their own compaction. The `## Memory Hygiene` section the assembler injects tells every persona:

- **MEMORY.md is an index**: durable facts, active priorities, standing directives, one-line pointers to topic files — kept well under the cap.
- **Topic files hold the details**: episodes, incident notes, dated snapshots (`launch-2026-04.md`, `metrics-2026-q2.md`).
- **Compaction procedure**: verify facts from live sources first, then rewrite MEMORY.md with `write_memory`, move episodic detail to topic files, and delete what is no longer true — never compress stale facts into confident summaries.

Supporting affordances: `list_memory` reports every file's size and flags files over the cap; the idle-thought prompt includes memory upkeep as a standing duty; an oversized auto_read file carries a truncation notice in the prompt itself until the agent compacts it.

## Why

- 2026-06-13: a 104KB MEMORY.md, read wholesale into live context, helped push a persona's prompt past 300K tokens and degraded it into confabulation (see the `MAX_CONTEXT_TOKENS` commentary in `chat-session.js`).
- 2026-07-04: another persona's MEMORY.md reached 479KB and was being injected whole into its system prompt on every turn via `auto_read`, which bypassed the read cap.

The caps bound the blast radius mechanically; the doctrine and size visibility make the agents keep their own working set healthy.
