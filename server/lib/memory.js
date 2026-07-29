import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// read_memory returns the whole file — a 104KB MEMORY.md became ~26K tokens of
// live context on its own (2026-06-13 "Brad braindead"; see chat-session.js's
// MAX_CONTEXT_TOKENS comment). Cap what a single read_memory call can return.
export const MEMORY_READ_CAP_BYTES = 32 * 1024
// append_memory keeps working past this size, but nudges toward splitting the
// file up before it becomes the next oversized read_memory dump.
export const MEMORY_COMPACT_WARN_BYTES = 64 * 1024
export const MEMORY_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.md$/

export function validateMemoryFilename(filename) {
  if (typeof filename !== 'string' || !MEMORY_FILENAME_RE.test(filename)) {
    throw new Error(`invalid memory filename: ${String(filename)}`)
  }
  return filename
}

/**
 * Cap a string to `capBytes` of UTF-8. Shared by the read_memory tool and the
 * prompt assembler's auto_read injection so both enforce the same limit — the
 * assembler previously read files unbounded, letting a 479KB MEMORY.md ride
 * into the system prompt on every turn (margo, 2026-07-04). A boundary split
 * mid-character yields a replacement char at the cut point, which is fine in
 * a truncation context.
 */
export function capUtf8Bytes(content, capBytes = MEMORY_READ_CAP_BYTES) {
  const buf = Buffer.from(content, 'utf8')
  if (buf.length <= capBytes) return { text: content, truncated: false, totalBytes: buf.length }
  return { text: buf.subarray(0, capBytes).toString('utf8'), truncated: true, totalBytes: buf.length }
}

export class Memory {
  constructor(personaDir, memorySubdir = 'memory/') {
    this.dir = join(personaDir, memorySubdir)
  }

  async loadContext(autoReadFiles) {
    const contents = []
    for (const f of autoReadFiles) {
      const c = await this.read(f)
      if (c !== null) contents.push(c)
    }
    return contents.join('\n\n')
  }

  pathFor(filename) {
    return join(this.dir, validateMemoryFilename(filename))
  }

  async read(filename) {
    const path = this.pathFor(filename)
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      return await handle.readFile('utf8')
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ELOOP') return null
      throw err
    } finally {
      await handle?.close()
    }
  }

  /**
   * Read a memory file for tool consumption, truncated to `capBytes`. Files at
   * or under the cap pass through unchanged; larger files return only the head
   * plus a trailer stating the true size, so one oversized file can no longer
   * dominate the live context at full fidelity (see MEMORY_READ_CAP_BYTES).
   */
  async readCapped(filename, capBytes = MEMORY_READ_CAP_BYTES) {
    const content = await this.read(filename)
    if (content === null) return null
    const { text, truncated, totalBytes } = capUtf8Bytes(content, capBytes)
    if (!truncated) return content
    const totalKB = Math.ceil(totalBytes / 1024)
    const capKB = Math.floor(capBytes / 1024)
    return `${text}\n\n… [truncated: showing the first ${capKB}KB of ${totalKB}KB total — this file is too large to read in full; split it into smaller topic files]`
  }

  async write(filename, content) {
    const path = this.pathFor(filename)
    let handle
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle?.close()
    }
  }

  async append(filename, content) {
    const path = this.pathFor(filename)
    let handle
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile('\n' + content, 'utf8')
    } finally {
      await handle?.close()
    }
  }

  /** Byte size of a memory file on disk, or null if it doesn't exist. */
  async sizeOf(filename) {
    const path = this.pathFor(filename)
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stats = await handle.stat()
      return stats.isFile() ? stats.size : null
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ELOOP') return null
      throw err
    } finally {
      await handle?.close()
    }
  }

  async list() {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      return entries
        .filter(entry => entry.isFile() && MEMORY_FILENAME_RE.test(entry.name))
        .map(entry => entry.name)
    } catch {
      return []
    }
  }

  /** Memory files with on-disk byte sizes — the visibility agents need to manage their own compaction. */
  async listWithSizes() {
    const files = await this.list()
    const out = []
    for (const filename of files) {
      out.push({ filename, bytes: (await this.sizeOf(filename)) ?? 0 })
    }
    return out
  }
}
