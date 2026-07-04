import { readFile, writeFile, appendFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// read_memory returns the whole file — a 104KB MEMORY.md became ~26K tokens of
// live context on its own (2026-06-13 "Brad braindead"; see chat-session.js's
// MAX_CONTEXT_TOKENS comment). Cap what a single read_memory call can return.
export const MEMORY_READ_CAP_BYTES = 32 * 1024
// append_memory keeps working past this size, but nudges toward splitting the
// file up before it becomes the next oversized read_memory dump.
export const MEMORY_COMPACT_WARN_BYTES = 64 * 1024

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

  async read(filename) {
    try {
      return await readFile(join(this.dir, filename), 'utf8')
    } catch {
      return null
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
    await writeFile(join(this.dir, filename), content)
  }

  async append(filename, content) {
    await appendFile(join(this.dir, filename), '\n' + content)
  }

  /** Byte size of a memory file on disk, or null if it doesn't exist. */
  async sizeOf(filename) {
    try {
      return (await stat(join(this.dir, filename))).size
    } catch {
      return null
    }
  }

  async list() {
    try {
      const entries = await readdir(this.dir)
      return entries.filter(e => e.endsWith('.md'))
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
