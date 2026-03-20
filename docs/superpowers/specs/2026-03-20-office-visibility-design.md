# Office Visibility & Multi-Agent Streaming

**Date:** 2026-03-20
**Status:** Approved

## Problem

When agents visit another agent's office (formerly "room"), their tool use and thinking are invisible to humans. The host agent streams normally, but visiting agents appear as a single message with no indication of what they did to produce it. Additionally, there's no visual distinction between different agents' messages, and the "room" metaphor doesn't capture the intended workspace feel.

## Design

### 1. Event Relay Protocol

New endpoint on every cheesoid server:

```
POST /api/chat/event
Auth: Bearer token (same as existing agent auth)
Body: { name: "brad", event: { type: "text_delta"|"tool_start"|"tool_result"|"done", ... } }
```

**Room changes:**

- `relayAgentEvent(name, event)` — broadcasts to SSE clients with `visiting: true` flag:
  ```js
  broadcast({ ...event, name, visiting: true })
  ```
- Accumulates visitor tool names in a transient map per agent. On `done`, records a single history entry:
  ```js
  { type: 'assistant_message', name: 'brad', text: '...', tools: ['read_memory', 'search_history'] }
  ```

**RoomClient changes:**

- New `sendEvent(event)` method — POSTs to `/api/chat/event` on the host.
- RoomClient currently hardcodes `http`. Add protocol detection: parse the configured URL and use `https` module when the URL scheme is `https://`. This fixes a pre-existing limitation and is required since `office_url` values will be HTTPS in production.

**Room._processMessage changes:**

- When `_pendingRoom` is a remote office, the `onEvent` callback forwards `text_delta`, `tool_start`, `tool_result`, and `done` events to the remote RoomClient via `sendEvent()`, in addition to existing home-office broadcasting.
- `thinking_delta` events are NOT relayed — thinking is internal to the agent.
- `relayAgentEvent` does NOT interact with the agent loop, `this.messages`, or the `busy` flag. It only broadcasts and accumulates tool state. This means visitor events flow freely even while the host agent is processing.
- Every relayed event MUST include the `name` field — the frontend uses it to demux concurrent visitor streams.

### 2. Frontend: Multi-Agent Streaming

Replace the single `assistantBuffer` / streaming target with a per-agent stream map:

```js
const agentStreams = new Map()  // name → { element, buffer, toolsEl }
```

**Event handling for `visiting: true` events:**

- `text_delta`: On first delta for an agent, create a new message element with that agent's name and color. Accumulate text, render markdown incrementally.
- `tool_start` / `tool_result`: Show under that agent's message element (same as host tool rendering).
- `done`: Finalize the agent's message, clean up the stream entry.

Host agent events (no `visiting` flag) continue using the existing single-stream flow unchanged.

**Color coding:**

Deterministic color derived from agent name hash. Applied to:
- Name label on the message
- Left border on the message container (3px accent)
- Avatar background (first letter of display name, colored circle)

The host agent keeps its current styling. Only visiting agents get colored treatment.

### 3. "Office" Terminology

User-facing language changes only. Internal code (`Room` class, `roomClients`, variable names) stays unchanged.

**persona.yaml** — new optional field:

```yaml
office_url: https://ehsre.noisefactor.io
```

**Prompt assembler changes:**

- "home room" becomes "your office"
- "remote rooms" becomes "other agents' offices"
- New section when `office_url` is set:

> Your office is at {{office_url}}. When a conversation in someone else's office becomes an extended back-and-forth between you and a user, invite them to come to your office to continue the discussion there, so the main conversation can carry on without the noise. Share your office URL when you do this.

**UI changes:**

- Page title/header says "Office" instead of "Room" (set dynamically by JS, no HTML changes needed)
- Startup system message in `chat-session.js`: "Welcome to [Agent]'s office." (replaces current `${config.display_name} has started.`)

### 4. Visiting Agent History

`relayAgentEvent` accumulates tool use per visitor in a transient map. On `done`, a single history entry is recorded with both text and tool summary.

**Scrollback replay:** `assistant_message` entries with a `name` field and `tools` array render with the same color-coded treatment as live streaming. Tool names appear as a compact summary line above the message text (e.g., "used: read_memory, search_history").

**Stale stream cleanup:** If no event arrives for a visitor within 60 seconds of their last event, flush and discard the partial accumulator state. This handles visitor crashes or disconnects mid-stream.

The host agent's in-memory context (`this.messages`) continues to receive visiting agent text via `addAgentMessage` — the host agent doesn't need visitor tool details in its own conversation context.

## Scope

### Changed

| Component | Change |
|-----------|--------|
| `server/routes/chat.js` | New `POST /api/chat/event` endpoint |
| `server/lib/chat-session.js` | `relayAgentEvent()`, visitor tool accumulation, event forwarding in `_processMessage` |
| `server/lib/room-client.js` | `sendEvent()` method, HTTP/HTTPS protocol detection |
| `server/public/js/chat.js` | Per-agent stream tracking, color coding, "office" UI text |
| `server/public/css/style.css` | Visiting agent color styles |
| `server/lib/prompt-assembler.js` | "room" → "office" language, office URL injection |
| `personas/*/persona.yaml` | New `office_url` field (optional) |

### Not Changed

- `Room` class name and internal variable names
- Host agent streaming flow
- Backchannel mechanics
- Authentication scheme
- Chat log format (extended, not replaced)
