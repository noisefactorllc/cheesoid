import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

// Write-only credential drop: the UI hands an agent a secret (API key, token,
// password) by writing it here. Plaintext is available only to framework-owned
// redaction and destination-bound broker code, never to model-facing tools,
// child-process environments, logs, or HTTP responses.
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
// Hard floor for a stored secret. redact() rewrites every occurrence of a value
// as an exact substring at output time, so very short values risk colliding
// with ordinary text and being redacted everywhere. 8 bytes rejects trivially
// short / single dictionary-word secrets while still accommodating the shortest
// legitimate credentials (8-char password policies). Both parse() and set()
// enforce it, and chat-session's redaction shares the same constant.
export const MIN_SECRET_VALUE_BYTES = 8
export const MAX_SECRET_VALUE_BYTES = 64 * 1024
// Accepted-but-warned band: values at/above the floor that are still short or
// low-entropy. Not rejected (legitimate short keys exist), but logged so an
// operator notices a value likely to over-match during substring redaction.
const WEAK_SECRET_VALUE_BYTES = 16

const FILE_MODE = 0o600
const DIR_MODE = 0o700

// Heuristic for a value worth warning about (never rejecting): short, or built
// from very few distinct characters. Value is never included in the warning.
function isWeakSecretValue(value, valueBytes) {
  return valueBytes < WEAK_SECRET_VALUE_BYTES || new Set(value).size <= 4
}

/**
 * Build a secrets store rooted at `runtimeDir` (an absolute path that may not
 * exist yet — it's created on first write). Secrets persist to
 * `${runtimeDir}/secrets.env` as `NAME=base64(value) # updated-iso` lines, one
 * per secret, base64-encoded so multi-line values survive as a single line.
 */
export function createSecretsStore(runtimeDir, { canSet = null } = {}) {
  const file = join(runtimeDir, 'secrets.env')

  // In-memory cache of decoded secrets: Map<name, { value, updated }>. Loaded
  // lazily (once) from disk, then kept in sync by set()/remove() — no reload
  // needed after that, since this process is the only writer we support.
  let cache = null
  let mutations = Promise.resolve()

  function assertSafeRuntimeDir() {
    try {
      const info = lstatSync(runtimeDir)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`unsafe secrets directory: ${runtimeDir} must be a real directory`)
      }
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
  }

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
        // Log the name only — never the base64 value after '=', which is the
        // secret and would otherwise leak into logs on a malformed line.
        console.log(`[secrets] skipping corrupt line in ${file} (invalid name): ${name}`)
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
      // Enforce the same floor set() applies. A short value (legacy or
      // hand-edited) would be live everywhere yet never masked, since redact()
      // only masks values >= MIN_SECRET_VALUE_BYTES — skip it rather than admit
      // an un-redactable secret.
      if (Buffer.byteLength(value, 'utf8') < MIN_SECRET_VALUE_BYTES) {
        console.log(`[secrets] skipping corrupt line in ${file} (below minimum length): ${name}`)
        continue
      }
      map.set(name, { value, updated })
    }
    return map
  }

  // Synchronous by design (see the write-only rationale at the top of this
  // file): values()/redact()/resolveForBroker() must be callable without an
  // await, so the load they trigger has to be sync too. readFileSync only ever
  // runs once per store instance — after that, cache is authoritative and
  // set()/remove() keep it current directly.
  function ensureLoaded() {
    if (cache !== null) return
    assertSafeRuntimeDir()
    let content = ''
    let fd = null
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      const info = fstatSync(fd)
      if (!info.isFile()) {
        throw new Error(`unsafe secrets file: ${file} must be a regular file`)
      }
      content = readFileSync(fd, 'utf8')
    } catch (err) {
      if (err.code === 'ELOOP') {
        throw new Error(`unsafe secrets file: ${file} must not be a symbolic link`)
      }
      if (err.code !== 'ENOENT') throw err
    } finally {
      if (fd !== null) closeSync(fd)
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
    assertSafeRuntimeDir()
    try {
      await chmod(runtimeDir, DIR_MODE)
    } catch (err) {
      console.log(`[secrets] failed to chmod directory ${runtimeDir}: ${err.message}`)
    }
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      await writeFile(tmp, serialize(), {
        encoding: 'utf8',
        flag: 'wx',
        mode: FILE_MODE,
      })
      await rename(tmp, file)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
    try {
      await chmod(file, FILE_MODE)
    } catch (err) {
      console.log(`[secrets] failed to chmod ${file}: ${err.message}`)
    }
  }

  function mutate(operation) {
    const pending = mutations.then(operation, operation)
    mutations = pending.catch(() => {})
    return pending
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
      const valueBytes = Buffer.byteLength(value, 'utf8')
      if (valueBytes < MIN_SECRET_VALUE_BYTES) {
        throw new Error(`invalid secret value for ${name}: must be at least ${MIN_SECRET_VALUE_BYTES} bytes`)
      }
      if (valueBytes > MAX_SECRET_VALUE_BYTES) {
        throw new Error(`invalid secret value for ${name}: exceeds ${MAX_SECRET_VALUE_BYTES} byte limit`)
      }
      if (isWeakSecretValue(value, valueBytes)) {
        // Warn, don't reject: legitimate short/simple credentials exist, but an
        // operator should know a weak value redacts as an exact substring and
        // may over-match ordinary text. The value is never logged.
        console.log(`[secrets] warning: value for ${name} is short or low-entropy; it is redacted as an exact substring and may over-match ordinary text`)
      }
      if (typeof canSet === 'function') {
        const denial = canSet(name)
        if (denial) throw new Error(denial)
      }
      return mutate(async () => {
        ensureLoaded()
        const previous = cache.get(name)
        cache.set(name, { value, updated: new Date().toISOString() })
        try {
          await persist()
        } catch (err) {
          if (previous) cache.set(name, previous)
          else cache.delete(name)
          throw err
        }
      })
    },

    /** Remove `name` if present. Returns whether it existed. */
    async remove(name) {
      return mutate(async () => {
        ensureLoaded()
        const previous = cache.get(name)
        if (!previous) return false
        cache.delete(name)
        try {
          await persist()
        } catch (err) {
          cache.set(name, previous)
          throw err
        }
        return true
      })
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

    /** Whether the store contains any credentials. Safe for policy checks. */
    hasAny() {
      ensureLoaded()
      return cache.size > 0
    },

    /**
     * Framework-only lookup for the destination-bound secret broker.
     * Never expose this method through a model-facing tool or HTTP response.
     */
    resolveForBroker(name) {
      ensureLoaded()
      return cache.get(name)?.value || null
    },

    // SYNCHRONOUS. Decoded values only, unlabeled — for output redaction
    // filters to scan for and strip secret values before they reach the
    // model or a transcript. Never surface this list itself over any
    // model- or client-visible channel; only use it to detect/redact.
    values() {
      ensureLoaded()
      return [...cache.values()].map(entry => entry.value)
    },

    // SYNCHRONOUS. Mask every stored secret value inside `text`. The one
    // sanctioned consumer-side use of values(): tool outputs, task logs, and
    // agent-bound messages pass through here so the write-only guarantee
    // holds even if another tool happens to echo a credential.
    redact(text) {
      ensureLoaded()
      let out = String(text ?? '')
      for (const entry of cache.values()) {
        if (
          entry.value
          && Buffer.byteLength(entry.value, 'utf8') >= MIN_SECRET_VALUE_BYTES
          && out.includes(entry.value)
        ) {
          out = out.split(entry.value).join('**[Redacted by Cheesoid]**')
        }
      }
      return out
    },

    /**
     * Recursively redact strings without changing a tool result's shape. Only
     * plain objects and arrays are recursed into; Date, Buffer, Map, and class
     * instances pass through untouched. This runs on every res.json body via
     * the global wrapper, and Object.fromEntries(Object.entries(v)) would flatten
     * a Date to {} or corrupt a Buffer — so anything that isn't a plain object
     * or array is returned as-is.
     */
    redactDeep(value) {
      if (typeof value === 'string') return this.redact(value)
      if (Array.isArray(value)) return value.map(item => this.redactDeep(item))
      if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, this.redactDeep(item)]),
        )
      }
      return value
    },
  }
}
