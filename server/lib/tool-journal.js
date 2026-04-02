import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_ENTRIES = 50
const JOURNAL_FILE = 'tool-journal.jsonl'

// Internal/bookkeeping tools that don't need journaling
const SKIP_TOOLS = new Set([
  'get_state', 'update_state', 'read_memory', 'write_memory',
  'append_memory', 'list_memory', 'search_history', 'internal',
  'step_up', 'step_down', 'deep_think',
])

/**
 * Persistent journal of recent tool use, stored as JSONL in the persona's
 * memory directory. Loaded into agent context on session start so agents
 * have awareness of their recent actions across session boundaries.
 */
export class ToolJournal {
  constructor(personaDir, memorySubdir = 'memory/') {
    this.path = join(personaDir, memorySubdir, JOURNAL_FILE)
  }

  /**
   * Record a tool use event. Called after each tool_result.
   */
  async record(name, input, result) {
    if (SKIP_TOOLS.has(name)) return

    const entry = {
      ts: new Date().toISOString(),
      tool: name,
      summary: summarize(name, input, result),
    }

    // Append + rotate
    const entries = await this._load()
    entries.push(entry)
    const trimmed = entries.slice(-MAX_ENTRIES)
    await writeFile(this.path, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n')
  }

  /**
   * Get recent tool use as a formatted string for injection into context.
   * Returns null if no entries.
   */
  async getContextBlock(limit = 20) {
    const entries = await this._load()
    if (entries.length === 0) return null

    const recent = entries.slice(-limit)
    const lines = recent.map(e => `[${e.ts}] ${e.tool}: ${e.summary}`)
    return `## Recent Tool Use (last ${recent.length} actions)\n\n${lines.join('\n')}`
  }

  async _load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch {
      return []
    }
  }
}

function summarize(name, input, result) {
  const output = typeof result === 'string' ? result
    : result?.output || result?.error || ''
  const isError = result?.is_error

  switch (name) {
    case 'bash':
      return truncate(input.command, 120) + (isError ? ' [FAILED]' : '')
    case 'send_mail':
      return `→ ${input.to}: "${input.subject}"` + (isError ? ' [FAILED]' : '')
    case 'check_mail':
    case 'check_sent':
      return truncate(output, 200)
    case 'read_mail':
    case 'read_sent':
      return `message ${input.id}` + (isError ? ' [NOT FOUND]' : '')
    case 'read_file':
      return `${input.path}` + (isError ? ' [NOT FOUND]' : ` (${output.length} chars)`)
    case 'send_chat_message':
      return truncate(input.text, 120)
    default:
      return truncate(output, 150) || truncate(JSON.stringify(input), 100)
  }
}

function truncate(str, max = 150) {
  if (!str) return ''
  return str.length > max ? str.slice(0, max) + '…' : str
}
