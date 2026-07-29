import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { minimalChildEnv } from './task-manager.js'
import { requestPublic } from './network-policy.js'

const execFileAsync = promisify(execFile)

const OUTPUT_CAP = 16 * 1024
const SHELL_TIMEOUT_MS = 120 * 1000
const FETCH_CAP_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 20 * 1000
const FETCH_MAX_REDIRECTS = 5

const cap = (text, limit = OUTPUT_CAP) => {
  const s = String(text ?? '')
  return s.length > limit ? `${s.slice(0, limit)}\n… [truncated: showing the first ${Math.floor(limit / 1024)}KB]` : s
}

/**
 * The harness tool group: background tasks, schedules, subagents, wiki,
 * unified memory search, threads, ad-hoc peering, media, secrets listing,
 * model control, and the opt-in shell/fetch_url built-ins.
 *
 * Everything here goes through the autonomy gate: user-originated turns are
 * never blocked, self-directed turns are held to the persona's autonomy
 * level. Peer APPROVAL is deliberately absent — only a human in the room can
 * approve a peer, via the UI/API, never the agent itself.
 */
export function buildHarnessTools(harness, room, config, memory) {
  const definitions = [
    {
      name: 'task_start',
      description: 'Start a background task that runs while you keep talking. Provide EITHER command (a shell command run in your workspace) OR prompt (delegates the work to a background subagent). You are notified in the room when it finishes. Use for anything slower than a few seconds: builds, scans, research, long fetches.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short label shown in the task list' },
          command: { type: 'string', description: 'Shell command to run in the background' },
          prompt: { type: 'string', description: 'Task text for a background subagent' },
          model: { type: 'string', description: 'Optional model override for a subagent task' },
          timeout_minutes: { type: 'number', description: 'Kill the task after this many minutes (default 30)' },
        },
      },
    },
    {
      name: 'task_list',
      description: 'List background tasks: running and recently finished, with status.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'task_status',
      description: 'Get one task\'s record and the tail of its log output.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The 8-character task id' } },
        required: ['id'],
      },
    },
    {
      name: 'schedule_create',
      description: 'Schedule future work for yourself. Provide cron ("0 9 * * 1-5", fires repeatedly, interpreted in server local time) OR at (an ISO timestamp, fires once). The prompt is delivered to you as a wakeup message at fire time. Use this for reminders, recurring reviews, and deferred work — "remind me tomorrow at 9" is one schedule_create with at.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What this schedule is for' },
          cron: { type: 'string', description: '5-field cron expression for recurring schedules' },
          at: { type: 'string', description: 'ISO timestamp for a one-time schedule' },
          prompt: { type: 'string', description: 'The instructions your future self receives when it fires' },
          once: { type: 'boolean', description: 'For cron schedules: fire once then delete' },
        },
        required: ['name', 'prompt'],
      },
    },
    {
      name: 'schedule_list',
      description: 'List your schedules (both persona-configured wakeups and runtime schedules) with next fire times.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'spawn_subagent',
      description: 'Delegate a self-contained piece of work to a fresh subagent with its own context and a read-mostly tool set (memory/wiki search, web search, shared files). Foreground by default: you wait and get the result as this tool\'s output. Set background: true for slow work — it becomes a task and the result is announced in the room. Subagents cannot spawn subagents.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Complete task description — the subagent knows nothing you do not include here' },
          model: { type: 'string', description: 'Optional model override (e.g. a stronger model for hard analysis)' },
          background: { type: 'boolean', description: 'Run as a background task instead of waiting' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'wiki_read',
      description: 'Read a page from your private wiki. Use wiki_search or wiki_list first if you are not sure of the slug.',
      input_schema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'Page slug, e.g. "infrastructure" or "people-alex"' } },
        required: ['slug'],
      },
    },
    {
      name: 'wiki_write',
      description: 'Write a page in your private wiki — your long-term structured knowledge, organized by topic with [[links]] between pages. The wiki is where distilled knowledge lives (facts, people, projects, decisions); memory files are for working notes. Keep pages focused; link related pages with [[slug]], and cite supporting memory topic files with [[memory:filename.md]] — both render as drill-down links for users reading your wiki. Compaction applies here too: rewrite bloated pages, merge overlapping ones, wiki_delete what is no longer true.',
      input_schema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Page slug: lowercase letters, digits, hyphens' },
          content: { type: 'string', description: 'Full markdown content of the page' },
        },
        required: ['slug', 'content'],
      },
    },
    {
      name: 'wiki_delete',
      description: 'Delete a wiki page. Use during compaction: after merging its content elsewhere, or when a page no longer reflects reality. The index regenerates automatically.',
      input_schema: {
        type: 'object',
        properties: { slug: { type: 'string', description: 'Page slug to delete' } },
        required: ['slug'],
      },
    },
    {
      name: 'wiki_list',
      description: 'List all wiki pages with titles and sizes.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'wiki_search',
      description: 'Search your wiki for matching lines. Cheap and fast — search before assuming you do not know something.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Text to search for (case-insensitive)' } },
        required: ['query'],
      },
    },
    {
      name: 'search_memory',
      description: 'Search ALL your persistent knowledge at once — memory files and wiki pages — for matching lines with filenames. Your in-context memory is a sparse cache; this tool is how you refresh it. Search before answering anything that depends on the past.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for (case-insensitive)' },
          limit: { type: 'number', description: 'Max matching lines (default 30)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_thread',
      description: 'Read a full reply thread by any message id in it — the chain of messages linked by replies, oldest first. Use when a reply references context that has scrolled out of your window.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Any 8-character message id in the thread' } },
        required: ['id'],
      },
    },
    {
      name: 'list_peers',
      description: 'List agent peers: config-declared agents, runtime-approved peers, pending join requests, and outbound connections.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'share_media',
      description: 'Share a stored media file into the room (image, audio, pdf, text). Use a media id from an upload, or a path in the shared workspace to import and share.',
      input_schema: {
        type: 'object',
        properties: {
          media_id: { type: 'string', description: 'The 8-character id of an uploaded media file' },
          shared_path: { type: 'string', description: 'Path of a file in the shared workspace to import and share' },
          note: { type: 'string', description: 'Optional message text to accompany the file' },
        },
      },
    },
    {
      name: 'read_media',
      description: 'Read a shared media file: full text for text files, metadata for binary ones. Images are already visible to you when attached to messages.',
      input_schema: {
        type: 'object',
        properties: { media_id: { type: 'string', description: 'The 8-character media id' } },
        required: ['media_id'],
      },
    },
    {
      name: 'list_secrets',
      description: 'List configured destination-bound credential bindings and whether each is available. Backing secret names and values are never readable.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'set_model',
      description: 'Pin a different model for one of your tiers (cognition, attention, reasoner, executor). Only models on your allow list. Use sparingly — when a task clearly needs more or less horsepower.',
      input_schema: {
        type: 'object',
        properties: {
          tier: { type: 'string', description: 'One of: cognition, attention, reasoner, executor' },
          model: { type: 'string', description: 'Model string from your allow list (see list in error output if unsure)' },
        },
        required: ['tier', 'model'],
      },
    },
  ]

  if (harness.shellPolicy.available()) {
    definitions.push({
      name: 'shell',
      description: 'Run a shell command in your workspace (bash, 120s timeout, output capped) with a minimal environment and no server credentials. For anything long-running, use task_start instead.',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The command to run' } },
        required: ['command'],
      },
    })
  }
  if (!(config.builtin_tools || []).includes('no_fetch')) {
    definitions.push({
      name: 'fetch_url',
      description: 'Fetch a public http(s) URL and return its text content (HTML is stripped to text, 1MB cap). Complements web_search: search finds pages, fetch_url reads one.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          credential: { type: 'string', description: 'Optional preconfigured secret binding name for this destination' },
        },
        required: ['url'],
      },
    })
  }

  const toolNames = new Set(definitions.map(d => d.name))

  async function executeRaw(name, input, options) {
    const origin = options?.origin || room?._turnOrigin || 'user'
    const gate = harness.autonomy.gate(name, origin)
    if (!gate.allowed) return { output: gate.reason, is_error: true }

    try {
      switch (name) {
        case 'task_start': {
          if (!input.command && !input.prompt) {
            return { output: 'Provide either command or prompt.', is_error: true }
          }
          if (input.command && input.prompt) {
            return { output: 'Provide command OR prompt, not both.', is_error: true }
          }
          const timeoutMs = (Number(input.timeout_minutes) > 0) ? Math.min(Number(input.timeout_minutes), 240) * 60 * 1000 : undefined
          let record
          if (input.command) {
            if (!harness.shellPolicy.available()) {
              return { output: harness.shellPolicy.denialReason(), is_error: true }
            }
            record = await harness.tasks.startShell({ name: input.name, command: input.command, timeoutMs })
          } else {
            if (input.model && !harness.modelAllowList().includes(input.model)) {
              return { output: `"${input.model}" is not on your allow list. Allowed: ${harness.modelAllowList().join(', ')}`, is_error: true }
            }
            record = await harness.tasks.startJob({
              name: input.name || cap(input.prompt, 40),
              run: async ({ signal }) => {
                const result = await harness.subagents.run({ prompt: input.prompt, model: input.model, signal })
                return result.text
              },
            })
          }
          return { output: `Task ${record.id} started (${record.kind}): ${record.name}. You will be notified when it finishes; task_status ${record.id} checks on it.` }
        }
        case 'task_list': {
          const records = await harness.tasks.list()
          if (!records.length) return { output: '(no tasks)' }
          const lines = records.map(t =>
            `${t.id} [${t.status}] ${t.name} — started ${t.started}${t.finished ? `, finished ${t.finished}` : ''}${t.exitCode != null ? `, exit ${t.exitCode}` : ''}`)
          return { output: lines.join('\n') }
        }
        case 'task_status': {
          const record = await harness.tasks.get(input.id)
          if (!record) return { output: `No task ${input.id}`, is_error: true }
          const tail = harness.secrets.redact(await harness.tasks.tail(input.id))
          return { output: `${JSON.stringify(record, null, 2)}\n--- log tail ---\n${cap(tail, 8192)}` }
        }
        case 'schedule_create': {
          const record = await harness.schedules.create({
            name: input.name,
            cron: input.cron || null,
            at: input.at || null,
            prompt: input.prompt,
            once: Boolean(input.once),
            createdBy: origin === 'user' ? 'user-turn' : origin,
          })
          return { output: `Schedule ${record.id} created: ${record.name}${record.cron ? ` (cron ${record.cron})` : ` (at ${record.at})`}.` }
        }
        case 'schedule_list': {
          const runtime = await harness.schedules.list()
          const configured = (config.wakeups || (config.wakeup && config.wakeup.mode !== 'none' ? [config.wakeup] : []))
            .filter(w => w && w.schedule)
            .map(w => `(config) ${w.name || 'wakeup'} — cron ${w.schedule}`)
          const lines = [
            ...configured,
            ...runtime.map(s => `${s.id} ${s.name} — ${s.cron ? `cron ${s.cron}` : `at ${s.at}`}${s.once ? ' (once)' : ''}, next ${s.next || 'n/a'}`),
          ]
          return { output: lines.length ? lines.join('\n') : '(no schedules)' }
        }
        case 'spawn_subagent': {
          if (input.model && !harness.modelAllowList().includes(input.model)) {
            return { output: `"${input.model}" is not on your allow list. Allowed: ${harness.modelAllowList().join(', ')}`, is_error: true }
          }
          if (input.background) {
            const record = await harness.tasks.startJob({
              name: `subagent: ${cap(input.prompt, 40)}`,
              run: async ({ signal }) => {
                const result = await harness.subagents.run({ prompt: input.prompt, model: input.model, signal })
                return result.text
              },
            })
            return { output: `Subagent running in background as task ${record.id}. You will be notified with the result.` }
          }
          const result = await harness.subagents.run({ prompt: input.prompt, model: input.model })
          return { output: cap(`[subagent ${result.model}, ${result.toolUses.length} tool uses]\n${result.text}`) }
        }
        case 'wiki_read': {
          const content = await harness.wiki.read(input.slug)
          return content !== null
            ? { output: cap(content, 32 * 1024) }
            : { output: `No wiki page "${input.slug}". wiki_list shows what exists.`, is_error: true }
        }
        case 'wiki_write': {
          await harness.wiki.write(input.slug, input.content)
          const { broken } = await harness.wiki.links(input.slug)
          const note = broken.length ? ` Links to pages that do not exist yet: ${broken.join(', ')}.` : ''
          return { output: `Wiki page "${input.slug}" written.${note}` }
        }
        case 'wiki_delete': {
          const removed = await harness.wiki.remove(input.slug)
          return removed
            ? { output: `Wiki page "${input.slug}" deleted; index regenerated.` }
            : { output: `No wiki page "${input.slug}".`, is_error: true }
        }
        case 'wiki_list': {
          const pages = await harness.wiki.list()
          if (!pages.length) return { output: '(wiki is empty — wiki_write creates pages)' }
          return { output: pages.map(p => `${p.slug} (${Math.ceil(p.bytes / 1024)}KB) — ${p.title}`).join('\n') }
        }
        case 'wiki_search': {
          const hits = await harness.wiki.search(input.query)
          if (!hits.length) return { output: `No wiki matches for "${input.query}".` }
          return { output: hits.map(h => `${h.slug}:${h.lineNumber}: ${h.line.trim()}`).join('\n') }
        }
        case 'search_memory': {
          const limit = input.limit || 30
          const results = []
          const files = await memory.listWithSizes()
          for (const { filename } of files) {
            if (results.length >= limit) break
            const content = await memory.read(filename)
            if (!content) continue
            const lines = content.split('\n')
            for (let i = 0; i < lines.length && results.length < limit; i++) {
              if (lines[i].toLowerCase().includes(input.query.toLowerCase())) {
                results.push(`memory/${filename}:${i + 1}: ${lines[i].trim()}`)
              }
            }
          }
          const wikiHits = await harness.wiki.search(input.query, { limit: Math.max(0, limit - results.length) })
          for (const h of wikiHits) results.push(`wiki/${h.slug}:${h.lineNumber}: ${h.line.trim()}`)
          if (!results.length) return { output: `No matches for "${input.query}" in memory or wiki. Try search_history for conversation.` }
          return { output: results.join('\n') }
        }
        case 'read_thread': {
          let result = await room.chatLog.threadEntries(input.id)
          if (!result) {
            // Seconds-old messages may not be flushed to JSONL yet.
            const live = (room.history || []).find(h => h.id === input.id)
            if (live) {
              const threadId = live.threadId || live.replyTo || live.id
              const members = (room.history || []).filter(h => h.id === threadId || h.threadId === threadId || h.id === input.id)
              result = { threadId, entries: members, truncated: false }
            }
          }
          if (!result) {
            return { output: `The id ${input.id} did not come from this conversation — re-check it against the [bracketed] ids in your context and copy exactly; search_history locates messages by content.`, is_error: true }
          }
          const { threadId, entries, truncated } = result
          // Render the returned entries directly — membership is already
          // resolved; re-deriving it against a truncated subset would drop
          // deep chains whose parents fell outside the window.
          const lines = entries.map(e => {
            const ts = e.timestamp ? new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 16) : ''
            const who = e.name || (e.type === 'assistant_message' ? config.display_name : 'unknown')
            const replyMark = e.replyTo ? ` (reply to ${e.replyTo})` : ''
            return `[${ts}] ${who} [${e.id}]${replyMark}: ${e.text || ''}`
          })
          const note = `(thread ${threadId}, ${entries.length} messages${truncated ? ', middle truncated — root and newest kept' : ''})`
          return { output: `${lines.join('\n')}\n${note}` }
        }
        case 'list_peers': {
          const configured = (config.agents || []).map(a => `(config) ${a.name}`)
          const runtime = await harness.peers.list()
          const lines = [
            ...configured,
            ...runtime.map(p => `${p.name} [${p.state}]${p.url ? ` ${p.url}` : ''}${p.approvedBy ? ` — approved by ${p.approvedBy}` : ''}`),
          ]
          return { output: lines.length ? lines.join('\n') : '(no peers)' }
        }
        case 'share_media': {
          let meta
          if (input.media_id) {
            meta = await harness.media.meta(input.media_id)
            if (!meta) return { output: `No media ${input.media_id}`, is_error: true }
          } else if (input.shared_path) {
            const imported = await harness.importSharedFile?.(input.shared_path)
            if (!imported) return { output: `Could not import "${input.shared_path}" from the shared workspace.`, is_error: true }
            meta = imported
          } else {
            return { output: 'Provide media_id or shared_path.', is_error: true }
          }
          room.postAgentAttachment(meta, input.note || '')
          return { output: `Shared ${meta.name} (${meta.mime}) into the room.` }
        }
        case 'read_media': {
          const loaded = await harness.media.load(input.media_id)
          if (!loaded) return { output: `No media ${input.media_id}`, is_error: true }
          if (harness.media.isText(loaded.meta)) {
            return { output: cap(loaded.buffer.toString('utf8'), 32 * 1024) }
          }
          return { output: `${loaded.meta.name}: ${loaded.meta.mime}, ${loaded.meta.bytes} bytes, uploaded ${loaded.meta.uploaded}${loaded.meta.by ? ` by ${loaded.meta.by}` : ''}. Binary content — images attached to messages are already visible to you.` }
        }
        case 'list_secrets': {
          const bindings = harness.secretBroker.status()
          if (!bindings.length) return { output: '(no secret bindings configured)' }
          return {
            output: bindings
              .map(binding => `${binding.name}: ${binding.available ? 'available' : 'unavailable'}`)
              .join('\n'),
          }
        }
        case 'set_model': {
          const tierKey = input.tier === 'executor' ? 'model' : input.tier
          if (!['cognition', 'attention', 'reasoner', 'model'].includes(tierKey)) {
            return { output: 'tier must be one of: cognition, attention, reasoner, executor', is_error: true }
          }
          const allowed = harness.modelAllowList()
          if (!allowed.includes(input.model)) {
            return { output: `"${input.model}" is not on your allow list. Allowed: ${allowed.join(', ')}`, is_error: true }
          }
          const chain = config[tierKey]
          if (!chain) return { output: `You have no ${input.tier} tier configured.`, is_error: true }
          const previous = chain[0]
          const rest = chain.filter(m => m !== input.model)
          // Mutate the array IN PLACE — the live Modality captured this exact
          // array reference at construction, so replacing the reference would
          // leave the agent serving the old primary while reporting success.
          chain.length = 0
          chain.push(input.model, ...rest)
          await harness.persistModelOverride(tierKey, input.model)
          return { output: `${input.tier} model pinned to ${input.model} (was ${previous}). This persists across restarts; set_model again to change back.` }
        }
        case 'shell': {
          if (!input.command) return { output: 'command required', is_error: true }
          if (!harness.shellPolicy.available()) {
            return { output: harness.shellPolicy.denialReason(), is_error: true }
          }
          try {
            const { stdout, stderr } = await execFileAsync('bash', ['--noprofile', '--norc', '-c', input.command], {
              cwd: harness.workDir,
              timeout: SHELL_TIMEOUT_MS,
              maxBuffer: 1024 * 1024,
              env: minimalChildEnv(harness.workDir),
            })
            const out = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join('\n')
            return { output: harness.secrets.redact(cap(out)) || '(no output)' }
          } catch (err) {
            const out = [err.stdout, err.stderr, err.killed ? '[killed: timeout]' : `[exit ${err.code}]`].filter(Boolean).join('\n')
            return { output: harness.secrets.redact(cap(out)), is_error: true }
          }
        }
        case 'fetch_url': {
          let url
          try {
            url = new URL(input.url)
            if (!/^https?:$/.test(url.protocol)) throw new Error('http(s) only')
          } catch (err) {
            return { output: `Invalid url: ${err.message}`, is_error: true }
          }
          // Follow redirects manually so EVERY hop passes the private-network
          // check — redirect: 'follow' would let a public URL 302 straight
          // into localhost or the cloud metadata service.
          let res = null
          const deadlineAt = Date.now() + FETCH_TIMEOUT_MS
          for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
            let credentialHeaders = {}
            if (input.credential) {
              try {
                credentialHeaders = harness.secretBroker.headersFor(input.credential, url)
              } catch (err) {
                return { output: `Refused credential: ${err.message}`, is_error: true }
              }
            }
            try {
              res = await requestPublic(url, {
                timeoutMs: FETCH_TIMEOUT_MS,
                deadlineAt,
                maxBytes: FETCH_CAP_BYTES,
                allowPrivate: process.env.CHEESOID_ALLOW_LOCAL_FETCH === '1',
                headers: {
                  'User-Agent': 'cheesoid-agent/1.0 (+https://cheesoid.noisefactor.io)',
                  ...credentialHeaders,
                },
              })
            } catch (err) {
              return { output: `Refused: ${err.message}`, is_error: true }
            }
            const location = res.headers.location
            if (res.statusCode >= 300 && res.statusCode < 400 && location) {
              if (hop === FETCH_MAX_REDIRECTS) {
                return { output: `Too many redirects (>${FETCH_MAX_REDIRECTS}) from ${input.url}`, is_error: true }
              }
              const next = new URL(location, url)
              if (!/^https?:$/.test(next.protocol)) {
                return { output: `Refused: redirect to non-http(s) URL ${next.protocol}//…`, is_error: true }
              }
              url = next
              continue
            }
            break
          }
          let text = res.body.toString('utf8')
          const contentType = res.headers['content-type'] || ''
          if (contentType.includes('html')) {
            text = text
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
              .trim()
          }
          return { output: `[${res.statusCode} ${contentType.split(';')[0]}] ${url}\n\n${cap(text)}` }
        }
        default:
          return { output: `Unknown harness tool: ${name}`, is_error: true }
      }
    } catch (err) {
      return { output: `${name} failed: ${err.message}`, is_error: true }
    }
  }

  async function execute(name, input, options) {
    return harness.secrets.redactDeep(await executeRaw(name, input, options))
  }

  return { definitions, handles: (name) => toolNames.has(name), execute }
}
