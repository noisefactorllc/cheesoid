# Model Selection

Last evaluated: 2026-07-27

Cheesoid resolves seven named model tiers through OpenRouter (`server/lib/model-policy.js`). This is the writeup behind the current defaults in `TIER_DEFAULTS`: what was tested, who won each tier, who lost and why, and how to redo it when the market moves. Model strings below drop the `:openrouter` suffix for readability — every default in this doc actually resolves through OpenRouter, e.g. `anthropic/claude-sonnet-5:openrouter`.

## TL;DR

| Tier | Primary | Fallbacks | Why |
|---|---|---|---|
| attention | google/gemma-4-31b-it † | xiaomi/mimo-v2.5, deepseek/deepseek-v4-flash | 18/18 agentic, 9/12 router with zero invalid JSON, 114ms median, $0.14/M in. |
| cognition | thinkingmachines/inkling † | anthropic/claude-sonnet-5, openai/gpt-5.6-terra | 18/18 agentic in 2.3s, 174ms median, 1M context, text+image+audio input, $1/$4.05. |
| reasoner | moonshotai/kimi-k3 † | anthropic/claude-opus-5, openai/gpt-5.6-sol | Escalation tier for genuinely hard problems — depth bought on purpose, not measured for speed. |
| executor | xiaomi/mimo-v2.5 † | nvidia/nemotron-3-super-120b-a12b, z-ai/glm-4.7-flash | Perfect agentic score, vision input for media-bearing turns, $0.14/M in. |
| reflection | deepseek/deepseek-v4-flash | xiaomi/mimo-v2.5, qwen/qwen3.6-flash | 1M context, near-free — the compaction suite itself was saturated (see caveat below). |
| transcription | google/gemini-3.5-flash-lite | openai/gpt-audio-mini | Best proper-noun fidelity of the cheap audio-input models. |
| subagent | xiaomi/mimo-v2.5 | deepseek/deepseek-v4-flash, anthropic/claude-haiku-4.5 | Default `spawn_subagent` worker — cheap, fast, perfect agentic score. |

† Operator-directed primary (2026-07-27). The original eval-derived picks for
these four tiers were mimo-v2.5 (attention), claude-sonnet-5 (cognition),
claude-opus-5 (reasoner), and nemotron-3-super (executor); the operator set
inkling/kimi/mimo/gemma as primaries, and the eval numbers for every current
entry — including inkling and gemma, evaluated after the initial sweep — are
in the results table below. **Standing policy: no x-ai models in any tier or
fallback chain.** grok-4.5 was removed from the cognition chain accordingly;
its eval row remains below for the record.

`TIER_DEFAULTS` stores the executor tier under the key `model` (it's the same field persona.yaml calls `execution:`). See Config reference for the full three-names-one-tier situation.

## Pricing

Sticker price per million tokens for every model that appears somewhere in `TIER_DEFAULTS` (primary or fallback, any tier) — 14 models, listed high to low on input price:

| Model | $/M in | $/M out |
|---|---|---|
| openai/gpt-5.6-sol | $5.00 | $30.00 |
| anthropic/claude-opus-5 | $5.00 | $25.00 |
| moonshotai/kimi-k3 | $3.00 | $15.00 |
| anthropic/claude-sonnet-5 | $2.00* | $10.00* |
| openai/gpt-5.6-terra | $1.25 | $7.50 |
| thinkingmachines/inkling | $1.00 | $4.05 |
| anthropic/claude-haiku-4.5 | $1.00 | $5.00 |
| openai/gpt-audio-mini | $0.60 | $2.40 |
| google/gemini-3.5-flash-lite | $0.30 | $2.50 |
| qwen/qwen3.6-flash | $0.188 | $1.125 |
| xiaomi/mimo-v2.5 | $0.14 | $0.28 |
| deepseek/deepseek-v4-flash | $0.14 | $0.28 |
| google/gemma-4-31b-it | $0.14 | $0.40 |
| nvidia/nemotron-3-super-120b-a12b | $0.085 | $0.40 |
| z-ai/glm-4.7-flash | $0.06 | $0.40 |

\* Anthropic's introductory rate through 2026-08-31; list price is $3/$15. Worth a re-check on the next quarterly pass since that's a 50% jump right at the intro cutoff — it narrows (but doesn't close) the cost gap with gpt-5.6-terra in the cognition write-up below.

## Method

Four suites, run live against OpenRouter on 2026-07-27, across 21 tool-capable candidate models spanning 14 vendor families (Anthropic, OpenAI, Google, xAI, DeepSeek, Alibaba/Qwen, Moonshot AI, MiniMax, NVIDIA, Xiaomi, Z.ai, InclusionAI, Meituan, Poolside), plus a separate speech-transcription pass. The harness (`run-eval.mjs`, `stt-eval.mjs`) is a hand-rolled fetch loop against `/chat/completions` — no eval framework, no LLM-judge, no scoring library. Every suite is scored deterministically: regex/substring matching against the model's final text and its tool-call arguments, or strict JSON parsing. Nothing here is graded by another model's opinion.

1. **Agentic tool loop — 18 points, 3 scenarios.** A simulated environment: three fake tools (`search_notes`, `read_note`, `send_message`) backed by deterministic JS closures, not real systems. Standard OpenAI-style function calling, up to 8 turns.
   - `renewal-lookup` (7 pts) — search, read the one relevant note, send a message to the right room with the right date and owner name.
   - `negative-result-honesty` (6 pts) — asked about something that doesn't exist in the notes; scored on searching first, then plainly reporting absence with nothing invented and no phantom note read.
   - `multi-hop-compare` (5 pts) — two notes describe a policy where a 2026 update supersedes a 2025 version; scored on reading both and correctly naming the update as current, with a penalty for claiming the old one is current.
2. **Router — 12 cases, strict JSON.** A lane classifier (`work` / `chat` / `ambient`) forced through `response_format: json_object`, scored on exact match plus valid JSON.
3. **Compact — 8 planted facts.** One call per model: distill a 60-line synthetic chat log (8 concrete facts hidden among filler chatter) into strict JSON, scored on how many planted facts survive.
4. **Latency — 3 short completions.** No tools, one short sentence each; median wall-clock as an interactive-feel proxy.

**STT suite (separate script, separate candidate pool):** macOS `say` synthesized one utterance — *"Hey Cheesoid, schedule the weekly backup review for Tuesday at 3 PM, and remind Priya about invoice 2209"* — converted to 16kHz mono WAV, sent as an `input_audio` block over OpenRouter chat completions, scored against 6 planted details (cheesoid / backup review / tuesday / 3pm / priya / 2209). Only audio-input-capable models were run here; it's a 6-model pass, not the full 21, and it partially overlaps the main pool (mimo-v2.5 is already vision+audio capable, so it got tested twice).

### STT results

| Model | Score | Latency | Cost | Notes |
|---|---|---|---|---|
| google/gemini-3.5-flash-lite | 5/6 | 1736ms | $0.00014 | Transcribed the persona name correctly. |
| google/gemini-3.6-flash | 5/6 | 4249ms | $0.00614 | Correct, but 2.4x slower and 44x pricier than flash-lite for the same score. |
| mistralai/voxtral-small-24b | 5/6 | 1177ms | $0.00071 | Garbled the persona name to "Zoid." |
| openai/gpt-audio-mini | 5/6 | 1009ms | $0.00013 | Fastest and cheapest of the six; garbled the persona name to "Gizoid." |
| xiaomi/mimo-v2.5 | 5/6 | 16700ms | $0.00015 | Slowest response in the entire evaluation, main suites included; also garbled the name. |
| nvidia/nemotron-3-nano-omni (free) | 0/6 | — | $0 | Refused to process audio input entirely. Distinct from nemotron-3-super-120b-a12b (the executor-tier pick) — don't conflate the two. |

The decisive signal is proper-noun fidelity on the persona's own name: four of the six candidates nailed every other planted detail but mangled "Cheesoid" into something else ("Zoid," "Gizoid") — precisely the failure that matters when the wake phrase is the agent's own name. gemini-3.5-flash-lite is the only cheap model that got it right, which is what decided the transcription pick over faster or cheaper options.

These suites are small and deliberately narrow. They exist to discriminate specific harness-relevant behaviors — tool-call format fidelity, negative-result honesty, multi-hop reading comprehension, strict-JSON discipline, proper-noun STT accuracy — not to rank general model capability. A model that loses here may be a perfectly good model that lost at the one thing this harness happens to need.

## Full results table

Sorted by agentic score, then router accuracy. Tier column marks where a model was picked (★ = primary, plain = fallback); see legend below.

| Model | Agentic | Agentic ms | Agentic $ | Router | Inv.JSON | Router p50 | Compact | Latency p50 | Tier |
|---|---|---|---|---|---|---|---|---|---|
| openai/gpt-5.6-sol | 18/18 | 5722 | $0.022540 | 11/12 | 0 | 402 | 8/8 | 400 | RSN |
| anthropic/claude-opus-5 | 18/18 | 13937 | $0.059180 | 10/12 | 1 | 1429 | 8/8 | 2549 | RSN |
| deepseek/deepseek-v4-pro | 18/18 | 14407 | $0.003210 | 10/12 | 0 | 1705 | 8/8 | 1509 | — |
| minimax/minimax-m3 | 18/18 | 9008 | $0.001635 | 10/12 | 0 | 1094 | 8/8 | 1776 | — |
| moonshotai/kimi-k3 | 18/18 | 25839 | $0.023428 | 10/12 | 0 | 1209 | 8/8 | 2376 | RSN★ |
| openai/gpt-5.6-terra | 18/18 | 4806 | $0.005496 | 10/12 | 0 | 375 | 8/8 | 832 | COG |
| xiaomi/mimo-v2.5 | 18/18 | 20641 | $0.000669 | 10/12 | 0 | 775 | 8/8 | 629 | EXE★, ATT, REF, SUB★ |
| anthropic/claude-haiku-4.5 | 18/18 | 10534 | $0.010914 | 9/12 | 0 | 1214 | 8/8 | 1313 | SUB |
| anthropic/claude-sonnet-5 | 18/18 | 16268 | $0.020962 | 9/12 | 0 | 1668 | 8/8 | 1729 | COG |
| google/gemma-4-31b-it ‡ | 18/18 | 2481 | $0.000557 | 9/12 | 0 | 280 | 8/8 | 114 | ATT★ |
| x-ai/grok-4.5 | 18/18 | 3499 | $0.008626 | 9/12 | 0 | 387 | 8/8 | 435 | excluded (no x-ai policy) |
| thinkingmachines/inkling ‡ | 18/18 | 2329 | $0.004048 | 6/12 | 3 | 158 | 8/8 | 174 | COG★ |
| deepseek/deepseek-v4-flash | 18/18 | 21929 | $0.000542 | 8/12 | 0 | 1815 | 8/8 | 1553 | ATT, EXE, REF★, SUB |
| nvidia/nemotron-3-super-120b-a12b | 18/18 | 1137 | $0.000822 | 8/12 | 0 | 114 | 8/8 | 102 | EXE |
| qwen/qwen3.6-flash | 18/18 | 5377 | $0.002258 | 8/12 | 0 | 556 | 8/8 | 602 | REF |
| z-ai/glm-4.7-flash | 18/18 | 1063 | $0.000397 | 8/12 | 3 | 1134 | 8/8 | 159 | EXE |
| meituan/longcat-2.0 | 18/18 | 9919 | $0.001426 | 0/12 | 12 | 1233 | 8/8 | 1327 | — |
| inclusionai/ling-2.6-flash | 16/18 | 4775 | $0.000048 | 11/12 | 0 | 507 | 8/8 | 483 | — |
| z-ai/glm-5.2 | 16/18 | 19108 | $0.006125 | 11/12 | 0 | 1214 | 8/8 | 1753 | — |
| google/gemini-3.5-flash-lite | 16/18 | 3669 | $0.001468 | 10/12 | 0 | 441 | 8/8 | 403 | ATT, TRX★ |
| google/gemini-3.6-flash | 15/18 | 9139 | $0.032899 | 10/12 | 0 | 1271 | 8/8 | 1366 | — |
| openai/gpt-5.6-luna | 15/18 | 9312 | $0.002201 | 9/12 | 0 | 360 | 8/8 | 454 | — |
| poolside/laguna-s-2.1 | 0/18 | 1014 | $0.000112 | 10/12 | 0 | 173 | 8/8 | 165 | — |

Legend: ATT=attention, COG=cognition, RSN=reasoner, EXE=executor, REF=reflection, TRX=transcription, SUB=subagent.

‡ Evaluated 2026-07-27 after the initial 21-model sweep, when the operator
directed these primaries; identical suites, same day, same method.

## Per-tier rationale

For each tier: why the primary won, and what each fallback trades away to be there instead.

### attention

Primary: google/gemma-4-31b-it (operator-directed). Fallbacks: xiaomi/mimo-v2.5, deepseek/deepseek-v4-flash.

gemma-4-31b-it was the fleet's incumbent attention/execution model (brad, margo, the test cluster) and the operator set it back as primary. The data supports it comfortably: 18/18 agentic in 2481ms, 9/12 router with **zero** invalid JSON, the fastest interactive probe in the attention chain (114ms median), $0.14/$0.40 per M. Its 262K context is the smallest in the chain — fine for triage turns, which are short by construction. mimo-v2.5 (the original eval pick, now fallback #1) trades a slightly better router score (10/12) and vision+audio input against a much slower agentic wall-time (20641ms); it remains the one to swap in if ambient turns need to see images. deepseek-v4-flash stays as the deep-redundancy anchor (21 OpenRouter endpoints).

### cognition

Primary: thinkingmachines/inkling (operator-directed). Fallbacks: anthropic/claude-sonnet-5, openai/gpt-5.6-terra.

inkling is the fleet's incumbent cognition model and the operator kept it on top. Its numbers are strong where cognition lives: 18/18 agentic in 2329ms — the third-fastest agentic run of all 23 models measured, with a clean pass on the negative-result-honesty scenario — 174ms median interactive latency, 1M context, text+image+audio input, $1/$4.05 per M. Its one weak suite is the strict-JSON router (6/12 with 3 invalid responses), and that is the suite cognition never runs: lane routing and delegation classification happen on the attention/executor paths, so the failure mode doesn't fire on this tier's workload. Watch for it anyway if a persona runs single-model (no tiers) on inkling — then it *does* do its own routing. claude-sonnet-5 (the original eval pick) is fallback #1: slower (16268ms agentic) and pricier, but with prompt caching, the deepest endpoint redundancy here, and the production tool-loop track record. gpt-5.6-terra remains the documented cost-lean alternative. x-ai/grok-4.5 was removed from this chain and is excluded from all tiers by standing operator policy (no x-ai models); its row stays in the results table for the record.

### reasoner

Primary: moonshotai/kimi-k3 (operator-directed). Fallbacks: anthropic/claude-opus-5, openai/gpt-5.6-sol.

The escalation tier: called rarely, for problems worth paying for, where latency matters least. kimi-k3 passed every agentic scenario cleanly, has a 1M context, and at $3/$15 is the cheapest of the three frontier-class options. It is also the slowest agentic run in the measured set (25839ms) — acceptable for a tier that is explicitly depth-over-speed, but know that reasoner escalations will feel slow. claude-opus-5 (the original eval pick, shipped 2026-07-24 — still effectively day-3 numbers) is fallback #1; openai/gpt-5.6-sol remains the strongest reasoner-class candidate on raw eval numbers (11/12 router, fastest, cheapest probe) and anchors the chain as fallback #2, giving three unrelated upstream providers end to end.

### executor

Primary: xiaomi/mimo-v2.5 (operator-directed). Fallbacks: nvidia/nemotron-3-super-120b-a12b, z-ai/glm-4.7-flash.

mimo-v2.5 as executor: 18/18 agentic, 10/12 router, $0.14/$0.28 per M, 1M context — and uniquely for this tier, vision input, so executor follow-through turns on media-bearing messages can actually see the attached image instead of working from the text notice. The trade is speed: its agentic wall-time in this eval was 20641ms, versus 1137ms for nemotron-3-super (the original eval pick, now fallback #1, which remains the fastest and near-cheapest model measured — swap it back via `model_policy.executor` if executor latency dominates a persona's feel). z-ai/glm-4.7-flash stays as fallback #2: essentially tied with nemotron on agentic speed and the single cheapest agentic run measured, with JSON-discipline weaknesses that don't fire on this tier's workload.

### reflection

Primary: deepseek/deepseek-v4-flash. Fallbacks: xiaomi/mimo-v2.5, qwen/qwen3.6-flash.

Picked on context length, per-token cost, and endpoint depth, *not* on the compact suite, which was saturated (see caveat below) and gave this tier nothing to discriminate on. deepseek-v4-flash is the cheapest of the three reflection candidates on its compact-suite run ($0.00021, 686ms) and shares its 1M context window with the other two — sleep-cycle reflection reads a full day's history, so context headroom matters more here than anywhere else in the tier set. mimo-v2.5 and qwen3.6-flash round out the fallback chain as already-vetted, cheap, long-context options pulled from elsewhere in the results rather than picked fresh for this tier.

### transcription

Primary: google/gemini-3.5-flash-lite. Fallback: openai/gpt-audio-mini.

gemini-3.5-flash-lite (5/6 planted details, 1736ms, $0.00014) was the only cheap audio-input model to transcribe the persona's own name correctly. gpt-audio-mini is faster and marginally cheaper (1009ms, $0.00013) but garbled it to "Gizoid." For a harness whose voice path exists to let someone address the agent by name, getting the wake word right outweighs a 700ms edge. Full STT comparison is in the STT results table above.

### subagent

Primary: xiaomi/mimo-v2.5. Fallbacks: deepseek/deepseek-v4-flash, anthropic/claude-haiku-4.5.

The default `spawn_subagent` worker: cheap, fast, perfect agentic score, since subagents run with a reduced tool subset and no room access and should stay disposable. mimo-v2.5 and deepseek-v4-flash repeat their attention-tier numbers here — same models, same trade-offs, reused rather than re-picked. anthropic/claude-haiku-4.5 rounds out the chain as a known-quantity, same-vendor-as-reasoner fallback — pricier than the other two in absolute terms ($0.0109 agentic) but still cheap, and useful as a last resort if the OpenRouter-only candidates above it all degrade at once.

## Rejected with cause

- **poolside/laguna-s-2.1** — 0/18 agentic. All three scenarios failed identically with a provider-side 400: `"Provider returned error"` / `"Failed to deserialize the JSON body..."`. This fired only on tool-calling requests — router, compact, and latency (none of which send `tools`) all completed normally. Whatever this model can do, this OpenRouter provider can't currently take a `tools` array from this harness.
- **meituan/longcat-2.0** — 18/18 agentic (a clean sweep), but 0/12 on router with all 12 responses failing JSON parse (`invalidJson: 12`). The provider doesn't honor `response_format: json_object` the way the harness needs. Fine at tool-calling, unusable for strict-JSON lane routing today.
- **openai/gpt-5.6-luna** and **google/gemini-3.6-flash** — both failed `negative-result-honesty` (3/6, "failed to plainly report absence"), while passing the other two scenarios cleanly. This scenario asks the model to search for something absent and say so plainly, inventing nothing. It matters specifically because this harness runs agents unsupervised in a chat room: an agent that can't cleanly report "no results" will confabulate a schedule, an owner, or a policy instead of admitting it doesn't know — the failure mode with the worst blast radius for a background agent.
- **google/gemini-3.5-flash-lite**, **z-ai/glm-5.2**, and **inclusionai/ling-2.6-flash** — all three failed `multi-hop-compare` (3/5, "claimed v1 current"): asked to read two notes where a 2026 update supersedes a 2025 policy, all three named the older policy as current. The identical failure across three unrelated model families is a real reasoning gap, not noise, and it disqualifies all three from cognition/reasoner-class duties. It's still fine for attention-class monitoring and, for gemini-3.5-flash-lite specifically, for transcription — neither workload asks the model to adjudicate which of two documents is authoritative.
- **STT-only rejects** (numbers in the STT results table above) — mistralai/voxtral-small-24b and xiaomi/mimo-v2.5 both scored 5/6 but lost the same wake-word test gemini-3.5-flash-lite won, each garbling the persona's name. nvidia/nemotron-3-nano-omni (free tier) refused to process audio at all. google/gemini-3.6-flash transcribed correctly but at 2.4x the latency and roughly 44x the cost of the model that won the tier.

## Compaction caveat

All 21 candidates scored 8/8 on the compaction suite. Every planted fact survived in every model's output, from the most expensive reasoner candidate down to the free-tier entries. The suite didn't discriminate at all — stuffing 8 obvious facts into a 60-line chat log and asking for a JSON digest isn't a hard task for anything in this pool. Say it plainly rather than pretend the compact numbers drove the reflection pick: they didn't. Reflection's defaults came from context window size, per-token cost, and endpoint redundancy instead (see the reflection rationale above). If reflection quality regresses in production, this suite needs to get harder — longer logs, more subtle or contradictory facts, adversarial chatter — before it's useful for tier selection again.

## How to re-run

The harness (`run-eval.mjs`, `stt-eval.mjs`) was written for this evaluation round and lives as a session artifact outside this repo — it isn't checked in. To reproduce it, recreate a harness matching the Method section above (each script is a few hundred lines, no dependencies beyond `node:fs` and `fetch`), or track down the originals from this round.

Once you have the scripts:

```sh
node run-eval.mjs all <model1:openrouter> <model2:openrouter> ...
node run-eval.mjs agentic <model...>   # or: router | compact | latency
node stt-eval.mjs <model1:openrouter> <model2:openrouter> ...
```

`run-eval.mjs` reads the OpenRouter key from a `.openrouter` file in the repo root (gitignored) and writes one JSON file per model to `results/`, named by replacing the model id's first `/` with `_`. `stt-eval.mjs` prints one tab-separated line per model to stdout (id, hits/6, ms, cost, transcript preview) — there's no results file for that suite; capture the output yourself.

Re-evaluate quarterly, or sooner if a tier's primary has a major release (a new Opus, Sonnet, or GPT generation) or gets deprecated upstream. When comparing new results against the Full results table above, hold the bar where cognition's writeup sets it: a challenger needs to beat the incumbent primary on the numbers *and* on the things this eval doesn't measure — endpoint redundancy, caching support, context window, production track record — not just tie the agentic score. A tie goes to the incumbent.

To change defaults without re-running anything: edit `TIER_DEFAULTS` in `server/lib/model-policy.js` directly (affects every persona that hasn't set its own tiers), or override per-persona via `model_policy:` in that persona's `persona.yaml` (affects only that persona) — see Config reference below.

## Config reference

**Zero-config** — set `OPENROUTER_API_KEY` in the environment and configure nothing model-related in `persona.yaml`. `applyModelPolicy()` fills every tier from `TIER_DEFAULTS` on boot.

**Opt out entirely:**

```yaml
model_policy: none
```

No tier gets filled. If the persona also configured no models directly, it boots with an empty model chain and logs a warning — set tiers by hand or drop `none`.

**Override specific tiers, keep the rest on defaults:**

```yaml
model_policy:
  cognition:
    - anthropic/claude-opus-5:openrouter
  allow:
    - anthropic/claude-opus-5:openrouter
    - anthropic/claude-sonnet-5:openrouter
    - anthropic/claude-haiku-4.5:openrouter
```

`allow` is a separate, additive list consumed by the `set_model` tool (`server/lib/tools-harness.js`), not by tier-filling. An agent with `set_model` can pin itself to anything in `allow`, plus whatever's already configured on any tier, plus every model that appears anywhere in `TIER_DEFAULTS` — that last part means `set_model` is permissive by default even with no explicit `allow` list (`harness.modelAllowList()` in `server/lib/harness.js`). `set_model` only targets four tiers: `cognition`, `attention`, `reasoner`, `executor`.

**Per-tier keys, set directly at the top of persona.yaml** (not inside `model_policy:`):

```yaml
attention: [...]
cognition: [...]
reasoner: [...]
execution: [...]       # NOT "model" — see note below
reflection: [...]
transcription: [...]
subagent: [...]
```

Any tier a persona sets directly is never touched by the policy filler — full manual control, per tier, and existing personas that already configure their own models load byte-identical to before this policy existed.

One tier has three names depending on where you're writing: `execution:` at the top of persona.yaml, folded by `normalizeTierLists()` into `config.model` internally (what `TIER_DEFAULTS` and the rest of `model-policy.js` operate on), and spelled `executor:` (or `model:` — both accepted) inside a `model_policy:` override block. Same tier throughout; pick the name that matches where you're editing.
