# Structured Internal Tool — Replace Tag-Based Response Routing

Replace the fragile `<thought>` and `<backchannel>` tag parsing system with a structured `internal` tool for private communication channels. Freeform text becomes unconditionally public. Private thoughts and backchannel coordination require an explicit tool call, making venue leaks structurally impossible.

## Problem

Agents are instructed to wrap private reactions in `<thought>` tags and coordination in `<backchannel>` tags. LLMs frequently fail to use well-formed tags, causing private text to leak publicly into remote rooms. The current system relies on post-hoc regex parsing of freeform text — the wrong abstraction for structured routing.

## Design

### Tool Definition

Registered in `buildRoomTools` (alongside `send_chat_message` and `search_history`) when the persona has `rooms` or `agents` configured.

```javascript
{
  name: 'internal',
  description: 'Send private thoughts and/or backchannel messages. Thoughts are visible only in your own office. Backchannel is delivered privately to the other agent. Neither is visible publicly. Use this whenever you want to observe, react, or coordinate without speaking publicly.',
  input_schema: {
    type: 'object',
    properties: {
      thought: {
        type: 'string',
        description: 'Private observation or reaction. Visible to your own office only.'
      },
      backchannel: {
        type: 'string',
        description: 'Private message to the other agent. Not visible to users.'
      }
    }
  }
}
```

At least one of `thought` or `backchannel` must be provided. If neither is set, the tool returns an error result.

### Response Model

- **Public text**: Freeform text output (no tool needed). Streamed in real-time via `text_delta` in home room. Sent via `client.sendMessage()` to remote rooms after agent finishes. Always public.
- **Thoughts**: Via `internal({ thought: "..." })`. Broadcast to home room as `idle_text_delta` + `idle_done`. Recorded in history as `idle_thought`. Not visible in remote rooms.
- **Backchannel**: Via `internal({ backchannel: "..." })`. Sent privately to the other agent. Always triggers (wakes the receiving agent). Not visible to users.
- **Combined**: `internal({ thought: "...", backchannel: "..." })` in a single call.

### Tool Execution

The `internal` tool executes during the normal tool loop in agent.js. It needs access to the Room instance (same as `send_chat_message`).

**Thought handling:**
- Broadcast to home room as `idle_text_delta` event (rendered collapsed in UI)
- Broadcast `idle_done` after
- Record in history as `idle_thought`

**Backchannel handling:**
- If `_pendingRoom` is a remote room: sent via `client.sendBackchannel()` (always triggers)
- If `_pendingRoom` is home and visiting agents exist: broadcast as `backchannel` event on SSE stream (visiting agents' RoomClients pick it up)
- Auto-nudge: if backchannel mentions a known agent name, trigger the existing auto-nudge logic

**Tool result returned to agent:**
- Echoes thought content back so the agent retains its reasoning in message history
- Confirms backchannel delivery
- Example: `"Thought: Yip's 18:00 UTC round. Not my duty.\nBackchannel sent."`

### Tag Parsing Removal

- Delete `_parseResponseTags` method from `chat-session.js`
- Simplify response routing in `_processMessage`:
  - Home room: `assistantText` is the public text. Broadcast + record history.
  - Remote room: `assistantText` is the public text. Send via `client.sendMessage()` if non-empty.
- Update `_autoNudgeMentionedAgents` to take only `publicText` (backchannel mentions handled in tool execution)

### Streaming Behavior

No changes to SSE event types or frontend:
- **Home room**: `text_delta` streams public text. No tags to leak.
- **Remote room**: `text_delta` already suppressed. Final public text sent after agent finishes.
- **Thoughts**: Broadcast as `idle_text_delta` during tool execution (collapsed in UI).
- **Idle thoughts**: Unchanged — idle path streams all text as `idle_text_delta`, no remote room involved.

### Prompt Changes

**Remove** all `<thought>` and `<backchannel>` tag instructions and examples from `prompt-assembler.js`.

**Replace** with tool guidance:

In the "Being a Visitor" section (rooms configured):
> You have the `internal` tool for private reactions. When you observe something in another agent's office but have nothing to say publicly, call `internal({ thought: "..." })`. To coordinate with the other agent privately, call `internal({ backchannel: "..." })`. You can combine both in one call. Anything you say without using this tool goes to that office publicly.

In the "Visiting Agents" section (agents configured):
> Use `internal({ backchannel: "..." })` to coordinate privately with visiting agents — turn-taking, domain handoffs, delegation. Users never see backchannel. Use `internal({ thought: "..." })` for private observations.

In `TAIL_REINFORCEMENT`:
> Drop the backchannel/thought tag reminder. Add: "Use the `internal` tool for private thoughts and backchannel — do not write them as plain text."

## Files Changed

| File | Change |
|------|--------|
| `server/lib/tools.js` | Add `internal` to `buildRoomTools` — definition + execution |
| `server/lib/chat-session.js` | Delete `_parseResponseTags`; simplify response routing in `_processMessage`; update `_autoNudgeMentionedAgents` signature |
| `server/lib/prompt-assembler.js` | Replace tag instructions with `internal` tool guidance in rooms/agents sections; update `TAIL_REINFORCEMENT` |
| `tests/` | Update tag parsing tests → internal tool tests; update prompt assembler tests; update multi-agent tests |
