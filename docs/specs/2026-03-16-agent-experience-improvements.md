# Agent Experience Improvements

**Date:** 2026-03-16
**Status:** Approved
**Source:** https://github.com/noisedeck/cheesoid/issues/2

## Overview

Four improvements to the Cheesoid agent framework based on friction observed during the first three-agent session (2026-03-16). All changes serve agent experience — making multi-agent collaboration smoother and more reliable.

## 1. Shared Workspace

### Problem
Agents run in isolated containers with separate volumes. No reliable way to hand off files, share drafts, or collaborate on documents without going through git (slow, high ceremony).

### Solution
A shared Docker volume mounted at `/shared/` in every agent container. Three new built-in tools in cheesoid's tool system:

- `list_shared(path?)` — list files/directories under `/shared/`, optional subdirectory path
- `read_shared(path)` — read a file from `/shared/`
- `write_shared(path, content)` — write/overwrite a file in `/shared/`

### Design

**Tools** are added as a new module `server/lib/shared-workspace.js`, registered in `server/lib/tools.js` alongside memory tools and room tools. Same pattern: export `handles(name)`, `execute(name, input)`, `definitions[]`.

**Path safety:** All paths are resolved relative to `/shared/` and validated to prevent directory traversal (no `../` escapes). Paths are normalized and must stay within the shared root.

**Filesystem:** Plain files. Agents can create subdirectories (e.g. `/shared/agent-a/`, `/shared/drafts/`). Parent directories are created automatically on write (`mkdir -p` equivalent).

**No access control.** All agents see everything. They're collaborators, not tenants.

**Not included:** No file locking, no change notifications, no versioning. Agents check what's there when they need it.

**Infrastructure:** A named Docker volume `cheesoid-shared` created once on the ops server. Mounted into each agent container via `-v cheesoid-shared:/shared` in the dispatch workflow and manual docker run commands.

### Tool Definitions

```javascript
{
  name: 'list_shared',
  description: 'List files and directories in the shared workspace at /shared/. All agents can read and write here.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Subdirectory path (optional, defaults to root)' }
    }
  }
}

{
  name: 'read_shared',
  description: 'Read a file from the shared workspace at /shared/.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to /shared/' }
    },
    required: ['path']
  }
}

{
  name: 'write_shared',
  description: 'Write a file to the shared workspace at /shared/. Creates parent directories if needed. Other agents can immediately read this file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to /shared/' },
      content: { type: 'string', description: 'File content to write' }
    },
    required: ['path', 'content']
  }
}
```

## 2. Startup Volume Health Checks

### Problem
An agent's `/secrets/` volume was unmounted for an unknown period. No alert, no log — silent failure discovered only when a capability was needed during an incident. The `/up` endpoint reported healthy despite the agent operating without critical capabilities.

### Solution
A `startup_checks` config option in `persona.yaml`:

```yaml
startup_checks:
  required_paths:
    - /secrets/.ssh/id_ed25519
    - /shared/
```

### Design

**New module:** `server/lib/startup-checks.js`

On server startup (in `server/index.js`), after persona loading but before `app.listen()`:
1. Read `persona.startup_checks.required_paths` (default: empty array)
2. Check each path exists (`fs.existsSync`)
3. Store results in `app.locals.startupCheckResults`

**Health endpoint change** (`server/routes/health.js`):
- If all checks pass: `{"status": "ok", ...}` with HTTP 200 (unchanged)
- If any checks fail: `{"status": "degraded", "missing": ["/secrets/.ssh/id_ed25519"]}` with HTTP 503
- kamal-proxy uses `/up` for health checks — a 503 means it won't route traffic to this container

**Server still starts** even with failed checks. This lets operators SSH in, inspect logs, and fix the issue. The container is just marked unhealthy so it doesn't receive traffic.

**Logging:** Each missing path logged as `console.error(`STARTUP CHECK FAILED: missing ${path}`)` at startup.

**Backwards compatible:** If `startup_checks` is not in persona.yaml, no checks run, `/up` returns 200 as before.

## 3. Add `jq` to Container Image

### Problem
Agents frequently need to parse JSON from API responses. Without `jq`, they resort to piping through `node -e` one-liners — awkward and error-prone.

### Solution
Add `jq` to the Dockerfile's `apt-get install` line:

```dockerfile
RUN apt-get update && apt-get install -y git curl jq && rm -rf /var/lib/apt/lists/*
```

## 4. Ground Truth Hierarchy in Prompt Assembler

### Problem
A new agent read stale repo docs, trusted them, and reported wrong information. Three agents caught it in 30 seconds, but in an async single-agent session, bad data from stale docs propagates into decisions. This is a framework problem — agents trust authoritative-looking documents.

### Solution
Inject a short source-trust block into every agent's system prompt, automatically, via the prompt assembler.

### Design

In `server/lib/prompt-assembler.js`, add a `SOURCE_TRUST_BLOCK` constant:

```
## Source Trust Hierarchy
When sources conflict, trust in this order:
1. Live data (API responses, database queries, health checks)
2. Agent memory (your own verified observations)
3. Repository documentation (may be stale)
If you find a conflict, surface it explicitly rather than silently picking one source.
```

Injected after the room/agent sections, before the memory auto_read files (which are always last as "freshest context"). The trust hierarchy is static framework guidance, not per-session content. Applies to all personas automatically. No opt-out — universally good guidance.

## Infrastructure Changes

### Shared Volume (ops server)

Create the shared Docker volume once:
```bash
ssh ops@$OPS_SERVER_IP 'docker volume create cheesoid-shared'
```

Add `-v cheesoid-shared:/shared` to every agent container's `docker run` command in the deploy workflow and any manual docker run commands.

### Persona Updates

Add `startup_checks` to each persona's `persona.yaml` with `required_paths` including `/shared/` and any secrets the persona needs.

## Files Changed

| File | Change |
|------|--------|
| `server/lib/shared-workspace.js` | New — shared workspace tools |
| `server/lib/tools.js` | Register shared workspace tools |
| `server/lib/startup-checks.js` | New — startup path verification |
| `server/index.js` | Run startup checks before listen |
| `server/routes/health.js` | Return 503 if startup checks failed |
| `server/lib/prompt-assembler.js` | Add source trust hierarchy block |
| `Dockerfile` | Add `jq` to apt-get install |
| `tests/shared-workspace.test.js` | New — shared workspace tool tests |
| `tests/startup-checks.test.js` | New — startup check tests |
| `tests/prompt-assembler.test.js` | Update — verify trust hierarchy in prompt |
