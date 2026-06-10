import { appendFile, readFile, readdir, mkdir, open } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

// Cap how many bytes we read from the END of a history file to satisfy
// `recent()`. History files are append-only daily logs that can grow without
// bound (a runaway loop once produced a 494 MB single-day file). recent() only
// ever needs the last N entries, so we read a bounded tail instead of the whole
// file. At ~3.5 KB/entry, 2 MB is ~570 entries — far more than any caller's
// limit — while making it impossible to blow the V8 heap on startup.
//   2026-06-10 P0: recent(40) did readFile() on a 494 MB file -> ~1 GB heap ->
//   global host OOM. The tail read below is the durable fix for the load side.
const TAIL_BYTES = 2 * 1024 * 1024

export class ChatLog {
  constructor(personaDir, subDir = 'history') {
    this.dir = join(personaDir, subDir)
    this._ready = mkdir(this.dir, { recursive: true })
  }

  async append(entry) {
    await this._ready
    const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n'
    await appendFile(join(this.dir, `${date}.jsonl`), line)
  }

  /**
   * Parse up to `limit` newest entries from the tail of one file WITHOUT loading
   * the whole file into memory. Reads at most TAIL_BYTES from the end. Returns
   * entries newest-first.
   */
  async _tailEntries(filePath, limit) {
    let fh
    try {
      fh = await open(filePath, 'r')
    } catch {
      return []
    }
    try {
      const { size } = await fh.stat()
      if (size === 0) return []
      const readLen = Math.min(size, TAIL_BYTES)
      const start = size - readLen
      const buf = Buffer.alloc(readLen)
      await fh.read(buf, 0, readLen, start)
      let text = buf.toString('utf8')
      // If we began mid-file, the first line is probably partial — drop it.
      if (start > 0) {
        const nl = text.indexOf('\n')
        text = nl >= 0 ? text.slice(nl + 1) : ''
      }
      const lines = text.split('\n')
      const out = []
      for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
        const line = lines[j]
        if (!line) continue
        try {
          out.push(JSON.parse(line))
        } catch { /* skip malformed / partial lines */ }
      }
      return out // newest-first
    } finally {
      await fh.close()
    }
  }

  async recent(limit = 50) {
    await this._ready
    let files
    try {
      files = (await readdir(this.dir)).filter(f => f.endsWith('.jsonl')).sort()
    } catch {
      return []
    }

    // Collect newest-first across files (newest file first), bounded tail per
    // file, until we have `limit` entries; then return the last N in
    // chronological order.
    const collected = []
    for (let i = files.length - 1; i >= 0 && collected.length < limit; i--) {
      const tail = await this._tailEntries(join(this.dir, files[i]), limit - collected.length)
      collected.push(...tail)
    }

    return collected.slice(0, limit).reverse()
  }

  async search(query, { limit = 50 } = {}) {
    await this._ready
    let files
    try {
      files = (await readdir(this.dir)).filter(f => f.endsWith('.jsonl')).sort()
    } catch {
      return []
    }

    const pattern = query.toLowerCase()
    const results = []

    // Stream each file line-by-line from newest to oldest. Streaming keeps memory
    // constant regardless of file size — a single oversized daily log can no
    // longer OOM a history search. Within a file we read forward (oldest→newest)
    // and keep a rolling window of the newest matches so the final result is the
    // most recent `limit` matches.
    for (let i = files.length - 1; i >= 0 && results.length < limit; i--) {
      const perFile = []
      const rl = createInterface({
        input: createReadStream(join(this.dir, files[i]), 'utf8'),
        crlfDelay: Infinity,
      })
      try {
        for await (const line of rl) {
          if (!line) continue
          try {
            const entry = JSON.parse(line)
            if (entry.text && entry.text.toLowerCase().includes(pattern)) {
              perFile.push(entry)
              if (perFile.length > limit) perFile.shift() // keep only newest `limit`
            }
          } catch { /* skip malformed lines */ }
        }
      } finally {
        rl.close()
      }
      // perFile is oldest→newest within this file; we want newest first overall.
      for (let j = perFile.length - 1; j >= 0 && results.length < limit; j--) {
        results.push(perFile[j])
      }
    }

    return results
  }
}
