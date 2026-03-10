# Cheesoid

A framework for running persistent AI personas with memory, state, and a multi-user chat UI.

You create a directory with a few files that define who your agent is. Cheesoid handles the rest: web UI, memory persistence, idle thoughts, multi-user chat, scrollback.

*DO NOT* run this in any kind of public setting.

## Quick Start

```bash
git clone <this-repo>
cd cheesoid
npm install
ANTHROPIC_API_KEY=sk-... npm run dev
```

Open `http://localhost:3000`. Enter a name, start chatting.

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
model: claude-sonnet-4-6        # any Anthropic model ID

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
- **Idle thoughts** — after inactivity, the agent reflects on its own
- **Collapsible sidebar** — shows persona status and connected participants
- **Custom tools** — give your persona abilities beyond conversation

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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `PERSONA` | `example` | Persona directory name under `personas/` |
| `PORT` | `3000` | HTTP port |

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
    tools.js            # Tool loading and built-in memory tools
    auth.js             # Auth middleware
  routes/
    chat.js             # SSE stream, send, reset
    health.js           # Health check, presence API
  public/               # Web UI (vanilla JS)
personas/
  example/              # Default test persona
```
