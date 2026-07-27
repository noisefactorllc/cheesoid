import { readFileSync } from 'node:fs'
import { writeFile, rename, chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Write-only credential drop: the UI hands an agent a secret (API key, token,
// password) by writing it here, and the running agent gets it injected into
// process/tool env without ever being able to read the value back through its
// own tools. Keeping the read path (env()/values()) synchronous and separate
// from the async CRUD surface (set/remove/list/names) is what makes that
// guarantee enforceable — model-facing tools only ever get wired to the async
// surface, which by construction cannot return a value.
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
export const MAX_SECRET_VALUE_BYTES = 64 * 1024

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/**
 * Build a secrets store rooted at `runtimeDir` (an absolute path that may not
 * exist yet — it's created on first write). Secrets persist to
 * `${runtimeDir}/secrets.env` as `NAME=base64(value) # updated-iso` lines, one
 * per secret, base64-encoded so multi-line values survive as a single line.
 */
export function createSecretsStore(runtimeDir) {
  const file = join(runtimeDir, 'secrets.env')

  // In-memory cache of decoded secrets: Map<name, { value, updated }>. Loaded
  // lazily (once) from disk, then kept in sync by set()/remove() — no reload
  // needed after that, since this process is the only writer we support.
  let cache = null

  function parse(content) {
    const map = new Map()
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) {
        console.log(`[secrets] skipping corrupt line in ${file}: ${line}`)
        continue
      }
      const name = line.slice(0, eq)
      if (!SECRET_NAME_RE.test(name)) {
        console.log(`[secrets] skipping corrupt line in ${file} (invalid name): ${line}`)
        continue
      }
      let rest = line.slice(eq + 1)
      let updated = null
      const hashIdx = rest.indexOf('#')
      if (hashIdx >= 0) {
        updated = rest.slice(hashIdx + 1).trim() || null
        rest = rest.slice(0, hashIdx).trim()
      } else {
        rest = rest.trim()
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(rest) || rest.length === 0) {
        console.log(`[secrets] skipping corrupt line in ${file} (bad encoding): ${name}`)
        continue
      }
      const value = Buffer.from(rest, 'base64').toString('utf8')
      if (!value) {
        console.log(`[secrets] skipping corrupt line in ${file} (empty value): ${name}`)
        continue
      }
      map.set(name, { value, updated })
    }
    return map
  }

  // Synchronous by design (see the write-only rationale at the top of this
  // file): env() and values() must be callable without an await, so the load
  // they trigger has to be sync too. readFileSync only ever runs once per
  // store instance — after that, cache is authoritative and set()/remove()
  // keep it current directly.
  function ensureLoaded() {
    if (cache !== null) return
    let content = ''
    try {
      content = readFileSync(file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.log(`[secrets] failed to read ${file}: ${err.message}`)
      }
    }
    cache = parse(content)
  }

  function serialize() {
    const lines = []
    for (const [name, entry] of cache) {
      const encoded = Buffer.from(entry.value, 'utf8').toString('base64')
      lines.push(`${name}=${encoded} # ${entry.updated}`)
    }
    return lines.length ? lines.join('\n') + '\n' : ''
  }

  // Write-then-rename so a reader (or a crash mid-write) never sees a
  // half-written secrets.env. chmod is best-effort: some platforms/containers
  // don't support POSIX permission bits, and that's not fatal here.
  async function persist() {
    await mkdir(runtimeDir, { recursive: true, mode: DIR_MODE })
    try {
      await chmod(runtimeDir, DIR_MODE)
    } catch (err) {
      console.log(`[secrets] failed to chmod directory ${runtimeDir}: ${err.message}`)
    }
    const tmp = `${file}.tmp`
    await writeFile(tmp, serialize(), 'utf8')
    await rename(tmp, file)
    try {
      await chmod(file, FILE_MODE)
    } catch (err) {
      console.log(`[secrets] failed to chmod ${file}: ${err.message}`)
    }
  }

  return {
    /** Validate and store `name=value`, overwriting any existing value for `name`. */
    async set(name, value) {
      if (!SECRET_NAME_RE.test(name)) {
        throw new Error(`invalid secret name: ${name}`)
      }
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`invalid secret value for ${name}: must be a non-empty string`)
      }
      if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
        throw new Error(`invalid secret value for ${name}: exceeds ${MAX_SECRET_VALUE_BYTES} byte limit`)
      }
      ensureLoaded()
      cache.set(name, { value, updated: new Date().toISOString() })
      await persist()
    },

    /** Remove `name` if present. Returns whether it existed. */
    async remove(name) {
      ensureLoaded()
      const existed = cache.delete(name)
      if (existed) await persist()
      return existed
    },

    /** Names and last-updated timestamps only — values are never included. */
    async list() {
      ensureLoaded()
      return [...cache.entries()].map(([name, entry]) => ({ name, updated: entry.updated }))
    },

    /** Just the names. */
    async names() {
      ensureLoaded()
      return [...cache.keys()]
    },

    // SYNCHRONOUS. Decoded secrets as { NAME: value }. This is the only path
    // that ever yields plaintext secret values, and it exists solely for the
    // framework to inject credentials into a child process's environment or a
    // tool call's execution env.
    //
    // DO NOT expose this over HTTP, a chat-visible tool result, a log line, or
    // any other surface the model or a client could read. Doing so defeats
    // the entire point of a write-only secrets store.
    env() {
      ensureLoaded()
      const out = {}
      for (const [name, entry] of cache) out[name] = entry.value
      return out
    },

    // SYNCHRONOUS. Decoded values only, unlabeled — for output redaction
    // filters to scan for and strip secret values before they reach the
    // model or a transcript. Same exposure rules as env(): never surface this
    // list itself, only use it to detect/redact.
    values() {
      ensureLoaded()
      return [...cache.values()].map(entry => entry.value)
    },

    // SYNCHRONOUS. Mask every stored secret value inside `text`. The one
    // sanctioned consumer-side use of values(): tool outputs, task logs, and
    // agent-bound messages pass through here so the write-only guarantee
    // holds even when a shell echoes its own environment.
    redact(text) {
      ensureLoaded()
      let out = String(text ?? '')
      for (const entry of cache.values()) {
        if (entry.value && entry.value.length >= 6 && out.includes(entry.value)) {
          out = out.split(entry.value).join('**[Redacted by Cheesoid]**')
        }
      }
      return out
    },
  }
}
