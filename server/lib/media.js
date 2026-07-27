import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// Media store backing chat file/image sharing. Each upload writes two files
// under `${runtimeDir}/media`: `${id}.${ext}` (raw bytes) and `${id}.json`
// (a metadata sidecar) — content and metadata split apart the same way
// chat-log.js splits daily logs from search, just per-file instead of
// per-persona. Directory creation follows chat-log.js's pattern: an eagerly
// started `mkdir(recursive: true)` promise, awaited by every method before
// touching disk, so the store works against a runtimeDir that doesn't exist
// yet without every caller having to remember to `mkdir` first.

export const MEDIA_MAX_BYTES = 20 * 1024 * 1024

// image/audio/pdf/text/json only — the set the chat UI can render inline or
// hand to a vision-capable model. Case-insensitive: uploads arrive with
// inconsistently-cased mime types depending on client/browser.
export const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|svg\+xml)|audio\/(webm|ogg|mpeg|mp4|wav|x-wav)|application\/pdf|text\/[a-z0-9.+-]+|application\/json)$/i

const ID_RE = /^[a-f0-9]{8}$/
const MAX_NAME_LEN = 80
const DEFAULT_NAME = 'file'

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'application/pdf': 'pdf',
  'application/json': 'json',
}

/** Map an (already-validated) mime type to a file extension. text/* not listed above falls back to txt. */
function extFor(mime) {
  const norm = mime.toLowerCase()
  if (EXT_BY_MIME[norm]) return EXT_BY_MIME[norm]
  if (norm.startsWith('text/')) return 'txt'
  return 'bin' // unreachable given ALLOWED_MIME gates save() first — kept as a safe fallback
}

// Strip path components and cap length so an uploaded filename can never
// escape the media directory or blow out the sidecar. Splitting on both
// separators handles '/' (POSIX) and '\' (Windows-originated names) alike;
// '.', '..', and empty results collapse to the DEFAULT_NAME fallback.
function sanitizeName(rawName) {
  if (typeof rawName !== 'string') return DEFAULT_NAME
  const base = rawName.split(/[\\/]/).pop().trim()
  if (!base || base === '.' || base === '..') return DEFAULT_NAME
  return base.length > MAX_NAME_LEN ? base.slice(0, MAX_NAME_LEN) : base
}

/** True for raster/vector images the UI can preview — excludes SVG, which can't go to vision APIs as-is. */
function isImage(meta) {
  if (!meta || typeof meta.mime !== 'string') return false
  const mime = meta.mime.toLowerCase()
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

/** True for text/* and application/json — content that's safe to inline as text. */
function isText(meta) {
  if (!meta || typeof meta.mime !== 'string') return false
  const mime = meta.mime.toLowerCase()
  return mime.startsWith('text/') || mime === 'application/json'
}

/**
 * Create a media store rooted at `${runtimeDir}/media`. Returns
 * { save, load, meta, list, remove, isImage, isText }.
 */
export function createMediaStore(runtimeDir) {
  const dir = join(runtimeDir, 'media')
  const ready = mkdir(dir, { recursive: true })

  const filePath = (id, ext) => join(dir, `${id}.${ext}`)
  const sidecarPath = (id) => join(dir, `${id}.json`)

  async function save({ buffer, mime, name, by } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('empty media')
    if (buffer.length > MEDIA_MAX_BYTES) throw new Error('media too large')
    if (typeof mime !== 'string' || !ALLOWED_MIME.test(mime)) throw new Error(`unsupported media type: ${mime}`)

    await ready
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    const ext = extFor(mime)
    const meta = {
      id,
      name: sanitizeName(name),
      mime,
      bytes: buffer.length,
      ext,
      uploaded: new Date().toISOString(),
      by: by ?? null,
    }
    await writeFile(filePath(id, ext), buffer)
    await writeFile(sidecarPath(id), JSON.stringify(meta, null, 2))
    return meta
  }

  async function meta(id) {
    if (!ID_RE.test(id)) return null
    await ready
    try {
      return JSON.parse(await readFile(sidecarPath(id), 'utf8'))
    } catch {
      return null
    }
  }

  async function load(id) {
    const m = await meta(id)
    if (!m) return null
    try {
      const buffer = await readFile(filePath(id, m.ext))
      return { meta: m, buffer }
    } catch {
      return null
    }
  }

  async function list({ limit = 50 } = {}) {
    await ready
    let entries
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }
    const metas = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        metas.push(JSON.parse(await readFile(join(dir, entry), 'utf8')))
      } catch (err) {
        console.log(`[media] skipping corrupt sidecar ${entry}: ${err.message}`)
      }
    }
    metas.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
    return metas.slice(0, limit)
  }

  async function remove(id) {
    const m = await meta(id)
    if (!m) return false
    await Promise.allSettled([unlink(filePath(id, m.ext)), unlink(sidecarPath(id))])
    return true
  }

  return { save, load, meta, list, remove, isImage, isText }
}
