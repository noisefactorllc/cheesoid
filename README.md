# Cheesoid

A framework for running persistent AI personas with memory, state, and a multi-user chat UI.

You create a directory with a few files that define who your agent is. Cheesoid handles the rest: web UI, memory persistence, idle thoughts, multi-agent rooms, webhooks, shared workspace, scrollback.

We run this in production at [cheesoid.noisefactor.io](https://cheesoid.noisefactor.io). The personas there handle revenue operations, infrastructure monitoring, and project management — each with tool access to production systems. The `personas/` directory in this repo contains sanitized versions showing the structure we use.

## Security

**Do not expose Cheesoid directly to the internet.**

Cheesoid agents run with tool access — shell commands, SSH, API calls, whatever you give them. There is no built-in authentication on the web UI. Anyone who can reach the URL can interact with your agent. In a misconfigured or publicly exposed instance, that means anyone who reaches it gets an agent with a shell running as your server process, with access to every mounted credential and secret.

Run it behind an authenticating reverse proxy. Caddy with basic auth is the simplest path:

```
cheesoid.example.com {
    basicauth {
        alice $2a$14$...
    }
    reverse_proxy localhost:3000
}
```

Other options: OAuth2 Proxy, Tailscale, or any reverse proxy with auth middleware. The point is that Cheesoid itself has no opinion about who's talking to it — that has to come from the layer in front.

Even with auth on the web UI, the agent itself can be prompted into doing things its operator didn't intend. That's true of any LLM agent, but with shell access the consequences are worse. SOUL.md as an immutable operator layer helps set the agent's values and constraints, but it's not a hard technical limit.

The quick start below runs on localhost only, which is safe. Do not change the port binding to `0.0.0.0` or put it behind a public URL without authentication.

## Quick Start

```bash
git clone <this-repo>
cd cheesoid
npm install
ANTHROPIC_API_KEY=sk-... npm run dev
```

Open `http://localhost:3000`. Enter a name, start chatting.

The `example` persona loads by default — it's a minimal agent with memory and state tools but no custom tools. Good for verifying the setup works. Build your own persona from there.

## Creating a Persona

A persona is a directory with this structure:

```
my-persona/
  persona.yaml      # required — configuration
  SOUL.md            # required — identity and voice
  prompts/
    system.md        # required — chat behavior instructions
  tools/
    tools.js         # optional — custom tools
  memory/
    MEMORY.md        # created automatically — persistent memory
```

### persona.yaml

```yaml
name: my-persona
display_name: "My Persona"
model: claude-sonnet-4-6        # Anthropic model ID — see https://docs.anthropic.com/en/docs/about-claude/models

tools: tools/tools.js           # path to custom tools (optional)

chat:
  prompt: prompts/system.md
  thinking_budget: 16000        # extended thinking token budget
  max_turns: 20                 # max tool-use turns per response
  idle_timeout_minutes: 30      # time before idle thought triggers

memory:
  dir: memory/
  auto_read:
    - MEMORY.md                 # loaded into system prompt automatically
```

### SOUL.md

This is who your agent *is*. The agent cannot modify it. Write in second person ("You are...").

```markdown
You are a persistent agent with continuity across sessions.

## Voice
- Concise, direct
- References past conversations naturally

## Purpose
- You help with X
- You care about Y
```

### prompts/system.md

Instructions for how the agent behaves in chat. This is injected as the system prompt along with SOUL.md and memory context.

```markdown
You are in a shared room. Multiple people may be present.

## On Session Start
1. Use `get_state` to load your persistent state
2. Use `read_memory` on MEMORY.md
3. Orient yourself, then respond

## During Conversation
- Write important things to memory
- Follow up on open threads from previous sessions
```

### tools/tools.js (optional)

Export `definitions` (array of Anthropic tool schemas) and `execute(name, input)`:

```js
export const definitions = [
  {
    name: 'my_tool',
    description: 'Does something useful',
    input_schema: {
      type: 'object',
      properties: {
        arg: { type: 'string' },
      },
      required: ['arg'],
    },
  },
]

export async function execute(name, input) {
  switch (name) {
    case 'my_tool':
      return { output: `Got: ${input.arg}` }
    default:
      return { output: `Unknown tool: ${name}`, is_error: true }
  }
}
```

Every persona automatically gets these built-in tools (no need to define them):

- `read_memory` / `write_memory` / `append_memory` / `list_memory` — persistent memory
- `get_state` / `update_state` — persistent cognitive state (mood, energy, focus, open threads)
- `search_history` — search full chat history across all sessions by keyword
- `send_chat_message` — send a message to the chat room
- `list_shared` / `read_shared` / `write_shared` — shared workspace file access (when `/shared` is mounted)

### Configuring tool access

Tools run as the server process, so they inherit its environment. Pass API keys and credentials as environment variables, then reference them in your tool implementations:

```bash
ANTHROPIC_API_KEY=sk-... \
STRIPE_API_KEY=sk_live_... \
DB_HOST=db.example.com \
DB_PASSWORD=secret \
PERSONA=brad \
npm start
```

Your tools pick these up from `process.env`:

```js
export async function execute(name, input) {
  switch (name) {
    case 'query_mrr': {
      const res = execSync(
        `curl -s https://api.stripe.com/v1/subscriptions?status=active \
         -u "${process.env.STRIPE_API_KEY}:"`,
        { encoding: 'utf8' }
      )
      return { output: res }
    }
    case 'query_db': {
      const res = execSync(
        `psql "host=${process.env.DB_HOST} user=readonly password=${process.env.DB_PASSWORD}" \
         -c "${input.query}"`,
        { encoding: 'utf8' }
      )
      return { output: res }
    }
  }
}
```

For SSH access, mount a key and configure the host in your environment:

```bash
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-... \
  -e PERSONA=ehsre \
  -v ~/.ssh/ehsre_key:/root/.ssh/id_ed25519:ro \
  -v ./personas/ehsre:/app/personas/ehsre \
  cheesoid
```

The agent can then use `bash` to run `ssh`, `docker`, `curl`, or anything else available in the container. Scope access carefully — the agent will use whatever you give it.

## Running

### Local

```bash
# Place your persona in personas/my-persona/
ANTHROPIC_API_KEY=sk-... PERSONA=my-persona npm start
```

Or for development with auto-reload:

```bash
ANTHROPIC_API_KEY=sk-... PERSONA=my-persona npm run dev
```

### Docker

```bash
docker build -t cheesoid .

docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-... \
  -e PERSONA=my-persona \
  -v ./personas/my-persona:/app/personas/my-persona \
  cheesoid
```

The `memory/` directory inside your persona dir is read/write. Mount it as a volume if you want memory to survive container restarts:

```bash
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-... \
  -e PERSONA=my-persona \
  -v ./my-persona:/app/personas/my-persona \
  -v ./my-persona-memory:/app/personas/my-persona/memory \
  cheesoid
```

## Features

- **Persistent memory** — the agent reads and writes its own memory files across sessions
- **Persistent state** — mood, energy, focus, open threads survive restarts
- **Multi-user chat** — multiple people in the same room, agent sees who's talking
- **Scrollback** — reconnecting users see the last 50 messages
- **Idle thoughts** — after inactivity, the agent reflects and may write to memory
- **Webhooks** — external systems can trigger the agent on a schedule or via events
- **Collapsible sidebar** — shows persona status and connected participants
- **Chat history search** — search past conversations across all sessions
- **Custom tools** — give your persona abilities beyond conversation

## Idle Thoughts

When a room is quiet for `idle_timeout_minutes`, the agent wakes up and thinks. This is useful for background work: reviewing metrics, checking on open threads, drafting things nobody asked for yet.

Idle thoughts can be wrapped in `<thought>` tags in the system prompt. Thoughts are surfaced to users in the home room without triggering a public response — the agent can observe and reason without speaking. In multi-agent setups, this lets agents in remote rooms process context without cluttering the conversation.

Configure idle behavior in `prompts/system.md`:

```markdown
## When Idle
When the room has been quiet, think about your open threads.
Review metrics. Draft things. Update your state.
You don't need to produce output for anyone.
```

## Webhooks

Cheesoid exposes a webhook endpoint that external systems can POST to. The payload is injected into the agent's conversation as a message, and the agent responds like any other message — with tool access, memory, and full context.

This is how scheduled cron tasks work: a cron job POSTs a payload to the agent, the agent processes it autonomously, and writes results to memory or takes action via tools. No human required.

```bash
curl -X POST https://your-cheesoid/webhook \
  -H "Content-Type: application/json" \
  -d '{"task": "daily-review", "secret": "...", "instructions": "Check metrics and email a summary."}'
```

The agent treats the webhook payload as a message from `webhook`. Include a shared secret in the payload and validate it in your system prompt instructions, or handle validation in a tool.

## Multi-Agent Rooms

Agents can join other cheesoid rooms as participants. Each agent maintains a single consciousness across all rooms — messages from all rooms appear in one unified conversation log.

### Connecting to Other Rooms

In your persona's `persona.yaml`, add rooms to join:

```yaml
rooms:
  - url: http://other-cheesoid:3000
    name: general
    secret: ${ROOM_SECRET_GENERAL}
```

The agent connects as an SSE client and authenticates with the shared secret.

### Accepting Agent Connections

To let other agents join your room, add an agents list:

```yaml
agents:
  - name: other-agent
    secret: ${AGENT_SECRET_OTHER}
```

Agents appear in the participant list like regular users. Their messages are visible to everyone in the room, but they don't trigger the room's own agent to respond.

### How It Works

- Agent sees messages from all rooms as one interleaved log, tagged by room: `[general/alice]: hello`
- Responses always route back to the originating room
- Home room messages are untagged: `[alice]: hello`
- Each cheesoid instance remains single-room — multi-room happens at the agent level
- Secrets reference environment variables: `${VAR_NAME}` in persona.yaml

### Thought and Backchannel Coordination

In multi-agent setups, agents need ways to coordinate without cluttering the shared conversation. Two patterns help with this:

**Thoughts** (`<thought>` tags) — the agent wraps observations in `<thought>` tags. Thoughts appear in the home room as idle context for users, but are not broadcast to remote rooms. Useful for an agent in a remote room to process what it's seeing without speaking publicly.

**Backchannel** (`<backchannel>` tags) — private coordination between agents. Content wrapped in `<backchannel>` is delivered privately to the named agent, not shown to users. Useful for turn-taking, domain handoffs, and "I'll handle this" signals that users shouldn't see.

```markdown
## In Remote Rooms
When you observe something but have nothing to say publicly:
<thought>Alice just mentioned a billing issue. Noting for context.</thought>

When coordinating with another agent privately:
<backchannel>Taking this one — it's my domain.</backchannel>
```

These patterns are conventions enforced through the system prompt, not hard framework features. Document them in your `prompts/system.md` if you use them.

## Shared Workspace

When multiple agents run in separate containers, they can share files through a common Docker volume mounted at `/shared/`. This gives agents a lightweight way to exchange drafts, hand off analysis, or collaborate on documents without git or external APIs.

All agents see the same files — access is flat, with subdirectories by convention (e.g. `/shared/brad/`, `/shared/margo/`). There's no locking or versioning; agents coordinate via chat.

Three built-in tools are available to every persona automatically:

- `list_shared(path?)` — list files and directories
- `read_shared(path)` — read a file
- `write_shared(path, content)` — write a file (creates parent directories)

### Setup

Mount a shared Docker volume into each agent container:

```bash
docker volume create cheesoid-shared
docker run -v cheesoid-shared:/shared ...
```

Or override the mount path with the `SHARED_WORKSPACE_PATH` environment variable.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `PERSONA` | `example` | Persona directory name under `personas/` |
| `PORT` | `3000` | HTTP port |
| `SHARED_WORKSPACE_PATH` | `/shared` | Mount path for shared workspace volume |

## Project Structure

```
server/
  index.js              # Express app, persona loading
  lib/
    chat-session.js     # Room class — shared chat room
    agent.js            # Claude API integration
    memory.js           # Memory file operations
    state.js            # Persistent state
    persona.js          # Persona config loader
    prompt-assembler.js # System prompt construction
    tools.js            # Tool loading and built-in tools
    shared-workspace.js # Shared workspace tools
    chat-log.js         # Chat history persistence and search
    auth.js             # Auth middleware
  routes/
    chat.js             # SSE stream, send, reset
    health.js           # Health check, presence API
  public/               # Web UI (vanilla JS)
personas/
  example/              # Default test persona
```
