/**
 * Ad-hoc peering store — runtime-joined agent peers, alongside the static
 * config `agents:` list handled by auth.js.
 *
 * Two directions:
 *   - Inbound: a remote agent asks to join this room (requestJoin). It sits
 *     'pending' until an owning (non-agent) user approves it (approve). Only
 *     an 'approved' peer's secret authenticates (see authenticate).
 *   - Outbound: this instance joins a remote room (addOutbound). No secret is
 *     stored here — the RoomClient holds that in memory — this just records
 *     the join for the UI/list.
 *
 * Secrets are never stored in plaintext: each pending/approved record keeps a
 * random salt and scrypt digest. Legacy SHA-256 records are accepted and
 * upgraded after a successful authentication. Public callers only ever
 * see publicRecord() projections (name, url, note, state, requested,
 * approvedBy, approved) — salt/hash never leave this module.
 *
 * Persisted as JSON at `${runtimeDir}/peers.json`, written atomically
 * (tmp file + rename). A corrupt file logs a warning and starts empty rather
 * than throwing.
 */

import { chmod, readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  scrypt as scryptCallback,
} from 'node:crypto'
import { promisify } from 'node:util'

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000

const MAX_NAME_LENGTH = 40
const MIN_SECRET_LENGTH = 16
const MAX_SECRET_BYTES = 1024
const MAX_URL_LENGTH = 2048

const scrypt = promisify(scryptCallback)

export function isLegacyPeerLifecycleEntry(entry) {
  if (entry?.type !== 'system' || typeof entry.text !== 'string') return false
  return entry.text.startsWith('Peer join request from "')
    || (entry.text.startsWith('Peer "') && entry.text.includes('" approved by '))
    || (entry.text.startsWith('Peer request "') && entry.text.endsWith('" denied.'))
}

function legacyHashSecret(salt, secret) {
  return createHash('sha256').update(salt + secret).digest('hex')
}

async function hashSecret(salt, secret) {
  return (await scrypt(secret, salt, 32)).toString('hex')
}

function constantTimeEqual(hexA, hexB) {
  const bufA = Buffer.from(hexA, 'hex')
  const bufB = Buffer.from(hexB, 'hex')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function publicRecord(rec) {
  return {
    name: rec.name,
    url: rec.url,
    note: rec.note,
    state: rec.state,
    requested: rec.requested,
    approvedBy: rec.approvedBy,
    approved: rec.approved,
  }
}

function byNewestFirst(a, b) {
  return Date.parse(b.requested) - Date.parse(a.requested)
}

export function createPeerStore(runtimeDir) {
  const filePath = join(runtimeDir, 'peers.json')
  const lookupKeyPath = join(runtimeDir, '.peer-lookup.key')

  let peers = null
  let loadPromise = null
  let lookupKey = null
  let lookupKeyPromise = null
  let nextLegacyScanAt = 0

  async function ensureLookupKey() {
    if (lookupKey) return lookupKey
    if (!lookupKeyPromise) {
      lookupKeyPromise = (async () => {
        await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
        try {
          const existing = await readFile(lookupKeyPath)
          if (existing.length !== 32) throw new Error('invalid peer lookup key')
          lookupKey = existing
          return lookupKey
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
        const generated = randomBytes(32)
        try {
          await writeFile(lookupKeyPath, generated, { flag: 'wx', mode: 0o600 })
          lookupKey = generated
        } catch (err) {
          if (err.code !== 'EEXIST') throw err
          lookupKey = await readFile(lookupKeyPath)
        }
        await chmod(lookupKeyPath, 0o600).catch(() => {})
        return lookupKey
      })()
    }
    return lookupKeyPromise
  }

  function tokenLookup(secret) {
    return createHmac('sha256', lookupKey).update(secret).digest('hex')
  }

  async function load() {
    await ensureLookupKey()
    const map = new Map()
    let raw
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.log(`peering: could not read ${filePath}, starting empty: ${err.message}`)
      }
      peers = map
      return
    }

    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('expected an array')
      for (const rec of parsed) {
        if (rec && typeof rec.name === 'string') {
          map.set(rec.name.toLowerCase(), rec)
        }
      }
    } catch (err) {
      console.log(`peering: corrupt peers file at ${filePath}, starting empty (${err.message})`)
      map.clear()
    }
    peers = map
  }

  function ensureLoaded() {
    if (!loadPromise) loadPromise = load()
    return loadPromise
  }

  async function persist() {
    await mkdir(runtimeDir, { recursive: true })
    const payload = JSON.stringify(Array.from(peers.values()), null, 2)
    const tmpPath = join(runtimeDir, `.peers.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    await writeFile(tmpPath, payload, 'utf8')
    await rename(tmpPath, filePath)
  }

  async function pruneExpired() {
    await ensureLoaded()
    const now = Date.now()
    let changed = false
    for (const [key, rec] of peers) {
      if (rec.state !== 'pending') continue
      const requestedMs = Date.parse(rec.requested)
      if (Number.isFinite(requestedMs) && now - requestedMs > PENDING_TTL_MS) {
        peers.delete(key)
        changed = true
      }
    }
    if (changed) await persist()
  }

  function findByName(name) {
    return peers.get(String(name).toLowerCase())
  }

  function validateName(name) {
    if (typeof name !== 'string' || name.length < 1 || name.length > MAX_NAME_LENGTH) {
      throw new Error(`invalid peer name (must be 1-${MAX_NAME_LENGTH} chars)`)
    }
    if (!/^[\w][\w .-]*$/.test(name)) {
      throw new Error('invalid peer name (letters, digits, spaces, dot, dash, underscore only)')
    }
  }

  function validateUrl(url) {
    if (url == null || url === '') return null
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || /[\r\n\0]/.test(url)) {
      throw new Error('invalid peer url')
    }
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('invalid peer url')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('invalid peer url')
    }
    return url
  }

  async function requestJoin({ name, secret, url = null, note = null }) {
    // The note is human-facing only. Cap and flatten it so unauthenticated
    // callers cannot create oversized peer records or disruptive UI content.
    if (note != null) {
      note = String(note).replace(/\s+/g, ' ').trim().slice(0, 300) || null
    }
    await ensureLoaded()

    validateName(name)
    if (findByName(name)) {
      throw new Error(`peer name taken: ${name}`)
    }
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
      throw new Error('secret too short (min 16 chars)')
    }
    if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) {
      throw new Error(`secret too long (max ${MAX_SECRET_BYTES} bytes)`)
    }
    url = validateUrl(url)

    const salt = randomBytes(16).toString('hex')
    const rec = {
      name,
      url,
      note,
      state: 'pending',
      requested: new Date().toISOString(),
      salt,
      kdf: 'scrypt',
      hash: await hashSecret(salt, secret),
      tokenLookup: tokenLookup(secret),
      approvedBy: null,
      approved: null,
    }
    peers.set(name.toLowerCase(), rec)
    await persist()
    return publicRecord(rec)
  }

  async function approve(name, approvedBy) {
    await ensureLoaded()
    const rec = findByName(name)
    if (!rec || rec.state !== 'pending') {
      throw new Error(`no pending peer: ${name}`)
    }
    rec.state = 'approved'
    rec.approvedBy = approvedBy
    rec.approved = new Date().toISOString()
    await persist()
    return publicRecord(rec)
  }

  async function deny(name) {
    await ensureLoaded()
    const rec = findByName(name)
    if (!rec || rec.state !== 'pending') return false
    peers.delete(rec.name.toLowerCase())
    await persist()
    return true
  }

  async function remove(name) {
    await ensureLoaded()
    const rec = findByName(name)
    if (!rec) return false
    peers.delete(rec.name.toLowerCase())
    await persist()
    return true
  }

  async function list() {
    await pruneExpired()
    const all = Array.from(peers.values())
    const pending = all.filter(r => r.state === 'pending').sort(byNewestFirst)
    const rest = all.filter(r => r.state !== 'pending').sort(byNewestFirst)
    return [...pending, ...rest].map(publicRecord)
  }

  async function authenticate(secret) {
    await pruneExpired()
    if (typeof secret !== 'string' || secret.length === 0) return null
    const lookup = tokenLookup(secret)
    const direct = [...peers.values()].find(rec => (
      rec.state === 'approved'
      && rec.tokenLookup === lookup
      && rec.salt
      && rec.hash
    ))
    if (direct) {
      const candidate = await hashSecret(direct.salt, secret)
      return constantTimeEqual(candidate, direct.hash) ? direct.name : null
    }

    // Pre-lookup records require a bounded one-time compatibility scan.
    // Rate-limit globally so invalid bearer traffic cannot turn peer count
    // into unbounded scrypt work. A successful legacy auth is upgraded.
    const now = Date.now()
    if (now < nextLegacyScanAt) return null
    const legacy = [...peers.values()].filter(rec => (
      rec.state === 'approved' && !rec.tokenLookup && rec.salt && rec.hash
    ))
    if (!legacy.length) return null
    nextLegacyScanAt = now + 5000
    for (const rec of legacy) {
      const candidate = rec.kdf === 'scrypt'
        ? await hashSecret(rec.salt, secret)
        : legacyHashSecret(rec.salt, secret)
      if (constantTimeEqual(candidate, rec.hash)) {
        rec.tokenLookup = lookup
        if (rec.kdf !== 'scrypt') {
          rec.salt = randomBytes(16).toString('hex')
          rec.hash = await hashSecret(rec.salt, secret)
          rec.kdf = 'scrypt'
        }
        await persist()
        return rec.name
      }
    }
    return null
  }

  async function addOutbound({ name, url, addedBy }) {
    await ensureLoaded()

    validateName(name)
    if (findByName(name)) {
      throw new Error(`peer name taken: ${name}`)
    }

    const now = new Date().toISOString()
    const rec = {
      name,
      url,
      note: null,
      state: 'outbound',
      requested: now,
      salt: null,
      hash: null,
      kdf: null,
      approvedBy: addedBy ?? null,
      approved: now,
    }
    peers.set(name.toLowerCase(), rec)
    await persist()
    return publicRecord(rec)
  }

  return { requestJoin, approve, deny, remove, list, authenticate, addOutbound }
}
