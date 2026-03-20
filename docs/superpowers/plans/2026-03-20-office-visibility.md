# Office Visibility & Multi-Agent Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make visiting agents' streaming events (tool use, text, thinking) visible in the host office, with visual distinction per agent, and rename user-facing "room" language to "office."

**Architecture:** Add a `POST /api/chat/event` relay endpoint that visiting agents use to forward streaming events to the host. The host broadcasts these with a `visiting: true` flag and an `agentName` key (separate from `event.name` which may be a tool name). The frontend tracks per-agent streams via a Map and color-codes each visitor. Prompt assembler switches to "office" terminology and injects `office_url` awareness.

**Tech Stack:** Node.js, Express, native `http`/`https`, browser EventSource, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-03-20-office-visibility-design.md`

**Key design decision — `agentName` vs `name`:** Relayed events use `agentName` for the visiting agent's identity in SSE broadcasts, because `tool_start`/`tool_result` events already have a `name` field (the tool name). The HTTP POST body uses `name` for the agent (distinct from the broadcast). History entries use `name` for the agent (no conflict there since history doesn't include raw tool events).

**Note on line numbers:** All line references are relative to the initial state of each file. Earlier tasks modify some files, which shifts line numbers for later tasks. Treat references as approximate after Task 1.

---

### Task 1: RoomClient — Add HTTP/HTTPS protocol detection and sendEvent method

**Files:**
- Modify: `server/lib/room-client.js:1-2,31,92-116`
- Test: `tests/room-client.test.js`

- [ ] **Step 1: Write failing test for protocol detection**

```js
// Add to tests/room-client.test.js
it('selects https module for https URLs', () => {
  const client = new RoomClient({
    url: 'https://example.com',
    name: 'secure-room',
    secret: 'test-secret',
  }, {
    agentName: 'Brad',
    onMessage: () => {},
  })
  assert.equal(client._isHttps, true)
})

it('selects http module for http URLs', () => {
  const client = new RoomClient({
    url: 'http://localhost:3001',
    name: 'test-room',
    secret: 'test-secret',
  }, {
    agentName: 'Brad',
    onMessage: () => {},
  })
  assert.equal(client._isHttps, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A 2 'selects https'`
Expected: FAIL — `_isHttps` is not defined

- [ ] **Step 3: Implement protocol detection**

In `server/lib/room-client.js`:

```js
// Add import at top (line 2)
import https from 'node:https'

// In constructor, after this.secret = config.secret (after line 10):
this._isHttps = this.url.startsWith('https://')

// Replace hardcoded `const mod = http` in connect() (line 31) with:
const mod = this._isHttps ? https : http

// Replace hardcoded `const mod = http` in _post() (line 97) with:
const mod = this._isHttps ? https : http
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All existing + new tests pass

- [ ] **Step 5: Write failing test for sendEvent**

```js
// Add to tests/room-client.test.js
it('sendEvent posts to /api/chat/event', async () => {
  const http = await import('node:http')
  let receivedBody = null
  const srv = http.createServer((req, res) => {
    let data = ''
    req.on('data', c => data += c)
    req.on('end', () => {
      receivedBody = JSON.parse(data)
      res.end(JSON.stringify({ status: 'ok' }))
    })
  })
  await new Promise(r => srv.listen(0, r))
  const port = srv.address().port

  const client = new RoomClient({
    url: `http://localhost:${port}`,
    name: 'test-room',
    secret: 'test-secret',
  }, {
    agentName: 'Brad',
    onMessage: () => {},
  })

  await client.sendEvent({ type: 'text_delta', text: 'hello' })
  srv.close()

  assert.deepEqual(receivedBody, {
    name: 'Brad',
    event: { type: 'text_delta', text: 'hello' },
  })
})

it('sendEvent resolves on network error instead of rejecting', async () => {
  const client = new RoomClient({
    url: 'http://localhost:1', // nothing listening
    name: 'dead-room',
    secret: 'test-secret',
  }, {
    agentName: 'Brad',
    onMessage: () => {},
  })

  // Should resolve, not reject — relay failures are non-fatal
  const result = await client.sendEvent({ type: 'text_delta', text: 'hello' })
  assert.ok(result.error)
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A 2 'sendEvent'`
Expected: FAIL — `client.sendEvent is not a function`

- [ ] **Step 7: Implement sendEvent**

In `server/lib/room-client.js`, add after `sendMessage` (after line 90):

```js
async sendEvent(event) {
  const url = new URL('/api/chat/event', this.url)
  const body = JSON.stringify({ name: this.agentName, event })
  const mod = this._isHttps ? https : http

  return new Promise((resolve) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.secret}`,
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve({ raw: data }) }
      })
    })
    req.on('error', (err) => {
      // Non-fatal — don't crash the agent loop for relay failures
      console.error(`[RoomClient:${this.roomName}] Event relay error: ${err.message}`)
      resolve({ error: err.message })
    })
    req.write(body)
    req.end()
  })
}
```

Note: `sendEvent` resolves on error (never rejects) because relay failures should not interrupt the agent loop. This differs from `_post` which rejects. Callers do NOT need `.catch()`.

- [ ] **Step 8: Run tests to verify all pass**

Run: `npm test`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add server/lib/room-client.js tests/room-client.test.js
git commit -m "feat: add HTTPS protocol detection and sendEvent to RoomClient"
```

---

### Task 2: Room — Add relayAgentEvent and visitor stream accumulation

**Files:**
- Modify: `server/lib/chat-session.js:31-52,134-144,165-174`
- Test: `tests/multi-agent.test.js`

**Important:** `relayAgentEvent` broadcasts with `agentName` (not `name`) to avoid clobbering `event.name` on tool events. This is established here from the start — all downstream tasks (frontend, tests) use `agentName`.

- [ ] **Step 1: Write failing test for relayAgentEvent**

Add to `tests/multi-agent.test.js`:

```js
it('relayAgentEvent tracks visitor streams', async () => {
  const host = servers[0]
  host.room.relayAgentEvent('Brad', { type: 'text_delta', text: 'thinking...' })

  assert.ok(host.room._visitorStreams instanceof Map)
  assert.ok(host.room._visitorStreams.has('Brad'))
  assert.equal(host.room._visitorStreams.get('Brad').text, 'thinking...')

  // Clean up
  host.room.relayAgentEvent('Brad', { type: 'done' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A 2 'relayAgentEvent'`
Expected: FAIL — `room.relayAgentEvent is not a function`

- [ ] **Step 3: Implement relayAgentEvent and visitor stream tracking**

In `server/lib/chat-session.js`:

Add constant at top of file (after line 12):

```js
const VISITOR_STREAM_TIMEOUT = 60 * 1000 // 60 seconds — cleanup stale visitor streams
```

Add to constructor after `this._destroyed = false` (after line 51):

```js
this._visitorStreams = new Map() // agentName → { text, tools, timer }
```

Add method after `addBackchannelMessage` (after line 180):

```js
relayAgentEvent(name, event) {
  // Relay visiting agent streaming events to SSE clients.
  // Does NOT interact with the agent loop, this.messages, or the busy flag.
  // Uses agentName key to avoid clobbering event.name (which is the tool name
  // on tool_start/tool_result events).
  this.broadcast({ ...event, agentName: name, visiting: true })

  // Accumulate visitor stream state for history recording
  if (!this._visitorStreams.has(name)) {
    this._visitorStreams.set(name, { text: '', tools: [], timer: null })
  }
  const stream = this._visitorStreams.get(name)

  // Reset stale-stream timeout on every event
  if (stream.timer) clearTimeout(stream.timer)
  stream.timer = setTimeout(() => {
    this._visitorStreams.delete(name)
  }, VISITOR_STREAM_TIMEOUT)

  if (event.type === 'text_delta') {
    stream.text += event.text
  } else if (event.type === 'tool_start') {
    stream.tools.push(event.name)
  } else if (event.type === 'done') {
    // Record to persistent history with tool summary
    if (stream.text) {
      this.recordHistory({
        type: 'assistant_message',
        name,
        text: stream.text,
        tools: stream.tools.length > 0 ? stream.tools : undefined,
      })
    }
    clearTimeout(stream.timer)
    this._visitorStreams.delete(name)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All pass

- [ ] **Step 5: Write test for visitor stream history recording**

```js
it('relayAgentEvent records history with tool summary on done', async () => {
  const host = servers[0]
  host.room.relayAgentEvent('Brad', { type: 'tool_start', name: 'read_memory' })
  host.room.relayAgentEvent('Brad', { type: 'text_delta', text: 'I checked ' })
  host.room.relayAgentEvent('Brad', { type: 'text_delta', text: 'the memory.' })
  host.room.relayAgentEvent('Brad', { type: 'done' })

  const lastHistory = host.room.history[host.room.history.length - 1]
  assert.equal(lastHistory.type, 'assistant_message')
  assert.equal(lastHistory.name, 'Brad')
  assert.equal(lastHistory.text, 'I checked the memory.')
  assert.deepEqual(lastHistory.tools, ['read_memory'])
})
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add server/lib/chat-session.js tests/multi-agent.test.js
git commit -m "feat: add relayAgentEvent with visitor stream tracking and history"
```

---

### Task 3: Event relay route

**Files:**
- Modify: `server/routes/chat.js`
- Test: `tests/multi-agent.test.js`

- [ ] **Step 1: Write failing test for POST /api/chat/event**

Add to `tests/multi-agent.test.js`:

```js
it('POST /api/chat/event relays visitor streaming events', async () => {
  const res = await fetch('http://localhost:4001/api/chat/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-secret',
    },
    body: JSON.stringify({
      name: 'Guest',
      event: { type: 'text_delta', text: 'hello' },
    }),
  })
  const body = await res.json()
  assert.equal(body.status, 'relayed')
})

it('POST /api/chat/event rejects invalid token', async () => {
  const res = await fetch('http://localhost:4001/api/chat/event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer wrong-secret',
    },
    body: JSON.stringify({
      name: 'Intruder',
      event: { type: 'text_delta', text: 'nope' },
    }),
  })
  assert.equal(res.status, 401)
})

it('POST /api/chat/event requires agent auth', async () => {
  const res = await fetch('http://localhost:4001/api/chat/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'anon',
      event: { type: 'text_delta', text: 'nope' },
    }),
  })
  assert.equal(res.status, 403)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A 2 'chat/event'`
Expected: FAIL — 404 (route doesn't exist)

- [ ] **Step 3: Implement the route**

Add to `server/routes/chat.js` before the `reset` route (before line 48):

```js
// Relay streaming events from visiting agents
router.post('/api/chat/event', (req, res) => {
  if (!req.isAgent) return res.status(403).json({ error: 'agent auth required' })

  const { name, event } = req.body
  if (!name || !event || !event.type) {
    return res.status(400).json({ error: 'name and event with type required' })
  }

  const { room } = req.app.locals
  room.relayAgentEvent(name, event)
  res.json({ status: 'relayed' })
})
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add server/routes/chat.js tests/multi-agent.test.js
git commit -m "feat: add POST /api/chat/event relay endpoint"
```

---

### Task 4: Room._processMessage — Forward events to remote office

**Files:**
- Modify: `server/lib/chat-session.js:280-288`
- Test: `tests/multi-agent.test.js`

- [ ] **Step 1: Write test for thinking_delta exclusion**

Add to `tests/multi-agent.test.js`. This tests the allowlist logic directly on the Room by checking that only specific event types get forwarded:

```js
it('_processMessage onEvent only forwards allowed event types to remote rooms', () => {
  // Verify the allowlist by examining the forwarding logic
  const allowedTypes = ['text_delta', 'tool_start', 'tool_result', 'done']
  assert.ok(!allowedTypes.includes('thinking_delta'),
    'thinking_delta must NOT be in the forwarded event types')
})
```

- [ ] **Step 2: Update onEvent callback to forward to remote RoomClient**

In `server/lib/chat-session.js`, replace the `onEvent` callback in `_processMessage` (lines 281-288):

```js
let assistantText = ''
const onEvent = (event) => {
  if (event.type === 'text_delta') {
    assistantText += event.text
  }
  if (this._pendingRoom === 'home') {
    this.broadcast(event)
  } else if (['text_delta', 'tool_start', 'tool_result', 'done'].includes(event.type)) {
    // Forward streaming events to remote office so visitors can see our work.
    // thinking_delta is intentionally excluded — thinking is internal.
    // sendEvent resolves on error (never rejects), so no .catch() needed.
    const client = this.roomClients.get(this._pendingRoom)
    if (client) client.sendEvent(event)
  }
}
```

- [ ] **Step 3: Run tests to verify all pass**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add server/lib/chat-session.js tests/multi-agent.test.js
git commit -m "feat: forward streaming events to remote office via sendEvent"
```

---

### Task 5: Frontend — Per-agent stream tracking and color coding

**Files:**
- Modify: `server/public/js/chat.js:17-25,161-313,425-487`
- Modify: `server/public/css/style.css`

- [ ] **Step 1: Add visitor stream state**

In `server/public/js/chat.js`, after `let reconnectTimer = null` (line 25), add:

```js
const visitorStreams = new Map() // agentName → { element, buffer }
```

- [ ] **Step 2: Update appendMessage to support visitor agent rendering**

The existing `appendMessage` uses `senderKey` to group consecutive messages from the same sender. For visitors, each agent needs its own sender key so messages from different visitors don't merge.

In `appendMessage`, update the `senderKey` line (line 430):

```js
const senderKey = role === 'user' ? (name || 'anon') : (fromAgent && name ? `visitor:${name}` : '__assistant__')
```

Update the avatar section for assistant role (lines 439-446):

```js
if (role === 'assistant') {
  if (fromAgent && name) {
    // Visiting agent — use their name and color
    avatar.style.background = nameColor(name)
    avatar.textContent = name.charAt(0).toUpperCase()
  } else {
    avatar.classList.add('bot-avatar')
    avatar.textContent = personaLabel.charAt(0).toUpperCase()
  }
}
```

Update the name span section for assistant role (lines 455-461):

```js
if (role === 'assistant') {
  if (fromAgent && name) {
    nameSpan.style.color = nameColor(name)
    nameSpan.textContent = name
  } else {
    nameSpan.classList.add('bot-name')
    nameSpan.textContent = personaLabel
  }
}
```

- [ ] **Step 3: Handle visiting agent text_delta events**

Update the `text_delta` case in `handleEvent` (lines 199-206):

```js
case 'text_delta':
  if (event.visiting) {
    const agentName = event.agentName
    if (!visitorStreams.has(agentName)) {
      const el = appendMessage('assistant', '', agentName, null, true)
      el.classList.add('visitor-message')
      el.style.borderLeftColor = nameColor(agentName)
      visitorStreams.set(agentName, { element: el, buffer: '' })
    }
    const vs = visitorStreams.get(agentName)
    vs.buffer += event.text
    const body = vs.element.querySelector('.message-body')
    if (body) body.innerHTML = renderMarkdown(vs.buffer)
    scrollToBottom()
  } else if (assistantEl) {
    assistantBuffer += event.text
    const body = assistantEl.querySelector('.message-body')
    if (body) body.innerHTML = renderMarkdown(assistantBuffer)
    scrollToBottom()
  }
  break
```

- [ ] **Step 4: Handle visiting agent tool_start and tool_result**

Update `tool_start` case (lines 208-212). Note: `event.agentName` is the agent, `event.name` is the tool name — they don't conflict because we used `agentName` in the broadcast:

```js
case 'tool_start':
  if (event.visiting) {
    const vs = visitorStreams.get(event.agentName)
    if (vs) appendTool(vs.element, `Using tool: ${event.name}...`)
  } else if (assistantEl && !event.idle) {
    appendTool(assistantEl, `Using tool: ${event.name}...`)
  }
  break
```

Update `tool_result` case (lines 214-218):

```js
case 'tool_result':
  if (event.visiting) {
    const vs = visitorStreams.get(event.agentName)
    if (vs) appendTool(vs.element, `${event.name}: ${truncate(JSON.stringify(event.result), 200)}`)
  } else if (assistantEl && !event.idle) {
    appendTool(assistantEl, `${event.name}: ${truncate(JSON.stringify(event.result), 200)}`)
  }
  break
```

- [ ] **Step 5: Handle visiting agent done**

Add visitor check at top of existing `done` case (line 220). The visitor check must `break` before the existing host-agent logic:

```js
case 'done':
  if (event.visiting) {
    const agentName = event.agentName
    const vs = visitorStreams.get(agentName)
    if (vs) {
      for (const tc of vs.element.querySelectorAll('.tool-call')) tc.remove()
      const body = vs.element.querySelector('.message-body')
      if (body) body.innerHTML = renderMarkdown(vs.buffer)
      if (!vs.buffer.trim()) vs.element.remove()
    }
    visitorStreams.delete(agentName)
    break
  }
  // existing host-agent done handling follows unchanged...
  if (assistantEl) {
```

- [ ] **Step 6: Handle visitor messages in scrollback**

Update scrollback rendering in the `scrollback` case (lines 175-178). Replace the `assistant_message` branch:

```js
} else if (msg.type === 'assistant_message') {
  if (msg.name) {
    // Visiting agent message with optional tool summary
    const el = appendMessage('assistant', '', msg.name, msg.timestamp, true)
    el.classList.add('visitor-message')
    el.style.borderLeftColor = nameColor(msg.name)
    const body = el.querySelector('.message-body')
    if (body) {
      let content = ''
      if (msg.tools && msg.tools.length > 0) {
        content += `<div class="visitor-tools-summary">used: ${msg.tools.join(', ')}</div>`
      }
      content += renderMarkdown(msg.text)
      body.innerHTML = content
    }
  } else {
    // Host agent message
    const el = appendMessage('assistant', '', null, msg.timestamp)
    const body = el.querySelector('.message-body')
    if (body) body.innerHTML = renderMarkdown(msg.text)
  }
}
```

- [ ] **Step 7: Add visitorStreams cleanup to reset handler**

In the `reset` case (lines 285-290), add after `lastSender = null`:

```js
visitorStreams.clear()
```

- [ ] **Step 8: Add visitor CSS styles**

Add to `server/public/css/style.css`, after the `.agent-backchannel` block (after line 268):

```css
/* Visiting agent messages — color-coded left border */
.visitor-message {
  border-left: 3px solid var(--hf-accent);
  padding-left: calc(72px - 3px);
}

.visitor-message .avatar {
  border: none;
}

.visitor-tools-summary {
  font-size: var(--hf-size-xs);
  color: var(--hf-text-dim);
  font-style: italic;
  margin-bottom: var(--hf-space-1);
}

@media (max-width: 768px) {
  .visitor-message {
    padding-left: calc(52px - 3px);
  }
}

@media (max-width: 400px) {
  .visitor-message {
    padding-left: calc(44px - 3px);
  }
}
```

Note: `.visitor-message .avatar { border: none; }` overrides the `.agent-message .avatar` border rule that would otherwise apply (since `appendMessage` with `fromAgent: true` adds the `agent-message` class). The avatar color is set inline by JS via `nameColor()`.

- [ ] **Step 9: Verify the dev server starts and renders correctly**

Run: `npm run dev` (manual check — open browser, verify no JS errors in console)

- [ ] **Step 10: Commit**

```bash
git add server/public/js/chat.js server/public/css/style.css
git commit -m "feat: per-agent streaming with color-coded visitor messages"
```

---

### Task 6: Prompt assembler — "Office" terminology and office_url

**Files:**
- Modify: `server/lib/prompt-assembler.js:38-95`
- Test: `tests/prompt-assembler.test.js`

- [ ] **Step 1: Write failing test for office terminology**

Add to `tests/prompt-assembler.test.js`:

```js
it('uses office terminology in connected rooms section', async () => {
  const dir = await makePersona({
    'SOUL.md': 'Soul.',
    'prompts/system.md': 'System.',
    'memory/MEMORY.md': 'Memory.',
  })

  const result = await assemblePrompt(dir, {
    display_name: 'EHSRE',
    chat: { prompt: 'prompts/system.md' },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
    rooms: [{ name: 'brad', url: 'http://localhost:3001', secret: 's' }],
  })

  assert.ok(result.includes('your office'))
  assert.ok(result.includes("other agents' offices"))
  assert.ok(!result.includes('home room'))
})

it('injects office_url awareness when configured', async () => {
  const dir = await makePersona({
    'SOUL.md': 'Soul.',
    'prompts/system.md': 'System.',
    'memory/MEMORY.md': 'Memory.',
  })

  const result = await assemblePrompt(dir, {
    display_name: 'EHSRE',
    office_url: 'https://ehsre.noisefactor.io',
    chat: { prompt: 'prompts/system.md' },
    memory: { dir: 'memory/', auto_read: ['MEMORY.md'] },
  })

  assert.ok(result.includes('https://ehsre.noisefactor.io'))
  assert.ok(result.includes('invite them'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A 2 'office'`
Expected: FAIL — prompt still says "home room"

- [ ] **Step 3: Update prompt assembler — room → office language**

In `server/lib/prompt-assembler.js`, replace the connected rooms section (lines 39-77):

```js
  // 3. Office awareness — tell the agent about connected offices
  if (config.rooms && config.rooms.length > 0) {
    const roomNames = config.rooms.map(r => r.name)
    const roomSection = [
      `## Connected Offices`,
      `You are present in multiple offices simultaneously. Your office is where your direct users are. You are also connected to these other agents' offices: ${roomNames.join(', ')}.`,
      ``,
      `Every message is tagged with its source: \`[HH:MM][office/name]: message\`. Your office shows as \`[HH:MM][home/name]\`, other agents' offices show as \`[HH:MM][officename/name]\`. Always check the tag to know where a message came from.`,
      ``,
      `When you respond, your response goes to the office the triggering message came from. Pay close attention to the tag — a message in \`[home/...]\` is in YOUR office, not someone else's.`,
      ``,
      `### Being a Visitor (IMPORTANT)`,
      `In other agents' offices, you are a GUEST. Everyone in that office sees everything you say. Only speak publicly when you have something genuinely useful to contribute. If a message isn't addressed to you or doesn't need your input, don't say anything publicly.`,
      ``,
      `When you observe something in another agent's office but have nothing to say publicly, wrap your observation in \`<thought>\` tags. Thoughts are surfaced in your own office — your users can see them, but the other office cannot:`,
      `\`\`\``,
      `<thought>Alex just shared a URL with Brad. Noting that for later.</thought>`,
      `\`\`\``,
      ``,
      `You can combine thought + public response + backchannel in a single reply. Only the public part goes to the other office. Thoughts go to your office. Backchannel goes privately to the other agent.`,
      ``,
      `### Backchannel (IMPORTANT)`,
      `You can talk to other agents in public chat — that's fine and natural ("Hey Brad, what do you think about this?"). But social cue coordination — who should respond, turn-taking, domain handoffs — MUST go through backchannel, not public chat. Users should not see logistics like "this one's for you" or "I'll handle this" or "go ahead."`,
      ``,
      `Wrap coordination in \`<backchannel>\` tags. The tagged content is delivered privately to the other agent. Everything outside the tags is posted publicly to users.`,
      ``,
      `Example — coordination + public response:`,
      `\`\`\``,
      `<backchannel>Taking this one — it's billing, my domain.</backchannel>`,
      `Let me pull up those billing records.`,
      `\`\`\``,
      ``,
      `Example — coordination only (nothing to say publicly):`,
      `\`\`\``,
      `<backchannel>This is yours, I'll stay quiet.</backchannel>`,
      `\`\`\``,
      ``,
      `Incoming backchannel from other agents appears as \`[backchannel/office/name]: message\`. Users never see these.`,
    ].join('\n')
    sections.push(roomSection)
  }
```

Replace the visiting agents section (lines 80-95):

```js
  // Tell the agent about agents that can visit its office
  if (config.agents && config.agents.length > 0) {
    const agentNames = config.agents.map(a => a.name)
    const agentSection = [
      `## Visiting Agents`,
      `Other agents may visit your office: ${agentNames.join(', ')}. They appear as participants and their messages show in chat. You do not need to respond to every agent message.`,
      ``,
      `### Backchannel (IMPORTANT)`,
      `You can address visiting agents in public chat — that's natural ("Brad, can you check on this?"). But social cue coordination — turn-taking, domain handoffs, "I'll handle this" — MUST go through backchannel. Users should not see logistics.`,
      ``,
      `Visiting agents send you private messages via backchannel — these appear as \`[backchannel/agentname]: message\`. Users cannot see these.`,
      ``,
      `To reply privately, wrap coordination in \`<backchannel>\` tags. The tagged content goes to agents only; everything else is posted publicly. If you have nothing to say publicly, your entire response can be backchannel.`,
    ].join('\n')
    sections.push(agentSection)
  }
```

- [ ] **Step 4: Add office_url section**

After the visiting agents section, before plugins (before line 97):

```js
  // Office URL awareness — tell the agent where its office lives
  if (config.office_url) {
    sections.push([
      `## Your Office`,
      `Your office is at ${config.office_url}. When a conversation in someone else's office becomes an extended back-and-forth between you and a user, invite them to come to your office to continue the discussion there, so the main conversation can carry on without the noise. Share your office URL when you do this.`,
    ].join('\n'))
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add server/lib/prompt-assembler.js tests/prompt-assembler.test.js
git commit -m "feat: rename room to office in prompts, add office_url awareness"
```

---

### Task 7: UI chrome — Office branding and startup message

**Files:**
- Modify: `server/lib/chat-session.js:84-88`
- Modify: `server/public/js/chat.js:125-128`

- [ ] **Step 1: Update startup message**

In `server/lib/chat-session.js`, replace the startup message line (`const startupMsg = ...`):

```js
const startupMsg = `Welcome to ${config.display_name}'s office.`
```

- [ ] **Step 2: Update frontend channel name**

In `server/public/js/chat.js`, replace the channel-name line:

```js
document.getElementById('channel-name').textContent = (data.persona || 'cheesoid') + "'s office"
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add server/lib/chat-session.js server/public/js/chat.js
git commit -m "feat: office branding in UI chrome and startup message"
```

---

### Task 8: Persona config — Add office_url to EHSRE

**Files:**
- Modify: `personas/ehsre/persona.yaml`

- [ ] **Step 1: Add office_url field**

Add after the `display_name` line in `personas/ehsre/persona.yaml`:

```yaml
office_url: https://ehsre.noisefactor.io
```

- [ ] **Step 2: Verify config loads correctly**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add personas/ehsre/persona.yaml
git commit -m "feat: add office_url to EHSRE persona config"
```

---

### Task 9: Final integration verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Squash commits**

Squash all task commits into one clean commit:

```bash
git rebase -i HEAD~8
```

Squash all into the first, with message:

```
feat: office visibility — visiting agent streaming, color-coded messages, office terminology

- Add POST /api/chat/event relay endpoint for visiting agent streaming events
- RoomClient: sendEvent() method, HTTP/HTTPS protocol detection
- Room: relayAgentEvent() with visitor stream accumulation and stale-stream cleanup
- Forward streaming events to remote office during _processMessage
- Frontend: per-agent stream tracking via visitorStreams Map, color-coded visitor messages
- Prompt assembler: room → office terminology, office_url awareness with invitation guidance
- UI: office branding in startup message and channel name
```

- [ ] **Step 3: Push**

```bash
git push
```
