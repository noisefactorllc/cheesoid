import { readFile, writeFile, appendFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// read_memory returns the whole file — a 104KB MEMORY.md became ~26K tokens of
// live context on its own (2026-06-13 "Brad braindead"; see chat-session.js's
// MAX_CONTEXT_TOKENS comment). Cap what a single read_memory call can return.
export const MEMORY_READ_CAP_BYTES = 32 * 1024
// append_memory keeps working past this size, but nudges toward splitting the
// file up before it becomes the next oversized read_memory dump.
export const MEMORY_COMPACT_WARN_BYTES = 64 * 1024

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
    const buf = Buffer.from(content, 'utf8')
    if (buf.length <= capBytes) return content
    const head = buf.subarray(0, capBytes).toString('utf8')
    const totalKB = Math.ceil(buf.length / 1024)
    const capKB = Math.floor(capBytes / 1024)
    return `${head}\n\n… [truncated: showing the first ${capKB}KB of ${totalKB}KB total — this file is too large to read in full; split it into smaller topic files]`
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
}
