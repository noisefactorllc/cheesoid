# The Cheesoid Harness

Cheesoid personas are full agents, not chatbots: they run background work,
keep their own calendar, maintain a private knowledge wiki, accept media,
speak and listen, sleep, and federate with other cheesoids at runtime. This
document covers those subsystems. Model selection lives in
[models.md](models.md); persona basics live in the README.

Everything here is file-backed under the persona directory:

```
personas/my-agent/
  runtime/            # created automatically, gitignored
    secrets.env       # operator-dropped secrets (0600, write-only)
    peers.json        # ad-hoc peer registry (hashed secrets)
    schedules.json    # runtime schedules
    tasks/            # task records + logs
    media/            # uploaded/shared files
    model-overrides.json  # set_model pins
  wiki/               # the agent's knowledge wiki (gitignored, user-readable)
```

## Zero-config start

```bash
OPENROUTER_API_KEY=sk-or-... PERSONA=example npm start
```

With no models configured, the model policy fills every tier with evaluated
OpenRouter defaults (docs/models.md). A persona that pins any model keeps
exactly what it pinned — the policy only fills what is empty, so existing
deployments load unchanged.

## Background tasks

`task_start` runs work while the conversation continues:

- `command:` — a shell command in the persona directory, with operator
  secrets in its environment. 30-minute default timeout, 1MB log cap,
  5 concurrent.
- `prompt:` — the work goes to a background subagent instead.

The agent is notified in-room when a task finishes ("[background task] …"),
reads the log tail, and decides whether the result matters. `task_list`,
`task_status`, `task_stop` manage them; the Tasks sidebar panel and
`GET /api/tasks` expose the same records to users. Tasks left running by a
restart are marked failed as orphaned on boot.

## Schedules

Two layers:

- **Config wakeups** (`wakeups:` in persona.yaml) — operator-owned, prompt
  files, deployed with the persona.
- **Runtime schedules** — created by the agent (or via API) with
  `schedule_create`: cron for recurring, `at` for one-shots ("remind me
  tomorrow at 9am" is one tool call). Persisted, restart-safe, capped at 50,
  removable by agent (`schedule_delete`) or user (Schedules panel).

At fire time the prompt arrives as a `[scheduled]` message and the agent
acts on it with full tool access.

## Subagents

`spawn_subagent` delegates a self-contained piece of work to a fresh
context running the `subagent` tier (or an explicit stronger model).
Foreground spawns block and return the result as tool output; background
spawns become tasks. Subagents get a read-mostly tool subset — memory/wiki
search, shared workspace reads, web search, fetch_url — and structurally
cannot spawn subagents or touch tasks, schedules, or peers.

## Secrets (write-only)

The Secrets sidebar panel (or `POST /api/secrets {name, value}`) drops a
credential to the running agent. Properties:

- Values are never readable back through any API, tool, or panel — listing
  returns names and dates only. The agent's `list_secrets` shows names.
- Values are injected as environment variables into `shell` and shell-task
  processes, so tools use `$STRIPE_KEY` normally.
- Every SSE broadcast is filtered against current secret values — if a tool
  echoes one, the wire carries `**[Redacted by Cheesoid]**`.
- Storage is `runtime/secrets.env`, mode 0600, base64-encoded values.

Rotate by overwriting the same name; revoke with the panel's delete or
`DELETE /api/secrets/:name`.

## Media

Users attach files by button, drag-drop onto the chat, or paste. Limits:
20MB, images/audio/pdf/text/json. Attachments ride on the message:

- Images (except SVG) become vision blocks for the model — on Anthropic
  natively and on openai-compat backends via data-URL image parts.
- Other files arrive as `[attached: name (mime, size) media:id]` notices;
  `read_media` returns text-file contents.
- The agent shares files back with `share_media` (by media id, or importing
  a path from the shared workspace), rendered inline in the UI.

`GET /api/media/:id` serves stored files with a sandboxing CSP.

## Threads

Every reply carries `replyTo`; the framework stamps `threadId` — the root
of the reply chain — on history entries. The agent is taught to treat
threads as first-class: `read_thread <id>` reconstructs the full chain from
history even after it scrolled out of context. The UI groups replies and
offers thread views backed by `GET /api/chat/thread?id=`.

Users get the same reach: the 🔍 button (or ⌘K) opens full-history search
(`GET /api/chat/search`) over the same JSONL store the agent's
`search_history` tool uses. Every hit with a message id has one action —
**reply** — which threads your message directly off the old one, wherever
it is in history. The reply carries the referenced message with it: quoted
in the chat header for users, injected into context for the agent.

## The wiki

The agent's long-term structured knowledge: markdown pages with `[[slug]]`
links under `wiki/`, maintained by the agent (`wiki_write` / `wiki_delete`,
encouraged during sleep — compaction applies to the wiki the same as to
memory: rewrite bloat, merge overlap, delete what stopped being true),
searched cheaply (`wiki_search`, `search_memory`), and readable by users
(Wiki panel, `GET /api/wiki/:slug`). An auto-generated `index.md` (titles
only) is preloaded into the system prompt so the agent knows what it knows
without paying for the content.

Pages cite supporting memory topics as `[[memory:filename.md]]`. In the
Wiki panel both link forms are live: `[[slug]]` navigates between wiki
pages and `[[memory:…]]` drills down into a read-only view of the memory
file (`GET /api/memory/:filename`), so a user can follow the agent's
knowledge from distilled page to raw working notes.

Memory files remain the working set; the wiki is the library.

## Search-first doctrine

The framework teaches every persona that in-context memory is a sparse,
usually-stale cache: before answering anything that depends on the past,
search — `search_memory` (memory + wiki, one call), `search_history`
(all sessions), `read_thread` (conversation lines). Honest emptiness is
required when search finds nothing. This doctrine plus the wiki index and
tight `auto_read` keeps live context small — which is also what keeps
cheap-tier prefill fast.

## Sleep

Idle thoughts are the nap; sleep is the real cycle. Nightly (in the 04:00
server-time hour by default, at a minute derived from the persona name so
co-hosted agents stagger; `sleep: {schedule}` retimes, `sleep: false`
disables) and after two substantive idle cycles, the reflection tier runs
a sleep turn:

1. journal the day (`journal-YYYY-MM-DD.md` in memory),
2. curate wiki pages,
3. prune MEMORY.md back to an index,
4. update state,

and only then the framework compacts live context to a short tail behind a
marker — intelligent compaction, because the distillate landed in files
first. The reflection streams into the UI like an idle thought.

## Autonomy

`autonomy: low | medium | high` (default medium) governs self-directed
turns only — user-initiated turns are never gated:

- **low** — observe, remember, maintain files.
- **medium** — also start/stop tasks, spawn subagents, manage schedules,
  and speak unprompted.
- **high** — also join peer rooms and re-pin its own models (`set_model`
  within the allow list).

Gating happens at tool dispatch with an explanatory refusal, and the
system prompt tells the agent its level so it acts inside it deliberately.

## Ad-hoc peering

Config peering (`agents:` / `rooms:`) is unchanged. Runtime peering adds:

**Inbound** — a remote cheesoid POSTs `/api/peer/join {name, secret, url}`.
The request is stored pending (secret salted-hashed, 24h expiry), the room
gets a banner and the host agent announces it — and only a **human in the
room** can approve (Approve button / `POST /api/peer/approve`). Agents
cannot approve peers; the approval endpoints reject agent credentials.
On approval the peer's bearer secret authenticates exactly like a
config-declared agent. Revocation (`remove_peer`, panel ×) is immediate.

**Outbound** — `join_room {url, secret}` (agent tool, autonomy high, or the
Peers panel form) connects this cheesoid to a remote room at runtime, no
config edit, no restart. The connection is recorded in the peer list;
secrets are held in memory only.

## Voice

- **In**: the mic button records, the browser encodes 16kHz WAV, and
  `POST /api/voice` transcribes via the `transcription` tier with the
  persona and participant names as vocabulary hints. The text lands in the
  input (or sends immediately in hands-free mode).
- **Out**: a per-user TTS toggle speaks assistant messages with the
  browser's speechSynthesis — zero server cost. Hands-free mode chains
  TTS-end back into recording for spoken conversation.

Voice degrades cleanly: no transcription tier configured → the mic UI
doesn't render and `/api/voice` returns 501.

## Built-in opt-in tools

```yaml
builtin_tools:
  - shell        # bash in the persona dir, secrets in env, 120s/1MB caps
```

`fetch_url` (public http(s), HTML→text, 1MB cap, private addresses
refused) is on by default; suppress with `builtin_tools: [no_fetch]`.

`set_model` lets the agent pin a tier's model within its allow list
(`model_policy.allow` plus everything already configured); pins persist
across restarts in `runtime/model-overrides.json`.

## HTTP surface added by the harness

| Route | Purpose |
|---|---|
| `GET/POST/DELETE /api/secrets[...]` | write-only secret drop (humans only) |
| `GET /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks/:id/stop` | task panel |
| `GET /api/schedules`, `DELETE /api/schedules/:id` | schedule panel |
| `POST /api/peer/join` | inbound ad-hoc join (unauthenticated, throttled, pending until approved) |
| `POST /api/peer/approve` / `deny`, `GET /api/peers`, `DELETE /api/peers/:name` | approval + management (humans only) |
| `POST /api/peer/join-remote` | outbound runtime join (humans only) |
| `POST /api/media`, `GET /api/media/:id` | uploads and serving |
| `POST /api/voice` | speech-to-text |
| `GET /api/wiki`, `GET /api/wiki/:slug` | read-only wiki |
| `GET /api/memory`, `GET /api/memory/:filename` | read-only memory drill-down from wiki links |
| `GET /api/chat/search?q=` | user-facing full-history search (thread/reply off hits) |
| `GET /api/chat/thread?id=` | thread reconstruction |
| `GET /api/harness` | tier/autonomy/status bootstrap for the panels |

## Rollout notes for existing deployments

The model policy never touches configured tiers, but three harness features
activate by default on personas that predate them:

- **Sleep cycle** — nightly reflection + compaction runs even without an
  OpenRouter key (the reflection tier falls back through attention/executor
  models). Opt out with `sleep: false`, or retime with `sleep: {schedule}`.
- **`fetch_url`** — available to the agent (and its subagents) by default.
  Opt out with `builtin_tools: [no_fetch]`.
- **Autonomy `medium`** — self-directed turns may start tasks, schedule
  work, and speak unprompted. Pin `autonomy: low` for old behavior.

Decide these per persona at rollout rather than inheriting the defaults
silently. Also note: `medium`'s "speak unprompted" is doctrine-guided, not
counter-enforced, and voice enablement is keyed on the transcription tier
being configured rather than a separate `voice:` block.
