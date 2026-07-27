import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { resolve, relative, join } from 'node:path'

// Wiki page slugs are short, URL-safe, lowercase identifiers. This keeps
// filenames predictable and is the primary defense against path traversal —
// see resolvePagePath() below for the belt-and-suspenders resolved-path
// check, matching the safePath pattern in shared-workspace.js.
export const WIKI_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

// Wiki pages are read in full by the agent and rendered whole in the web UI —
// cap how large a single page can grow so one runaway write can't blow up either.
export const WIKI_CONTENT_CAP_BYTES = 256 * 1024

const WIKI_LINK_RE = /\[\[([a-z0-9][a-z0-9-]{0,79})\]\]/g

const INDEX_SLUG = 'index'
const INDEX_FILENAME = 'index.md'
const EMPTY_INDEX = '# Wiki Index\n\n_empty_'

/**
 * Build a private knowledge wiki for a persona: markdown pages the agent
 * maintains for itself, stored at `${personaDir}/wiki` and readable through
 * the web UI. A small factory returning bound async methods — same shape as
 * buildSharedWorkspaceTools — since there's no state beyond the directory path.
 */
export function createWiki(personaDir) {
  const dir = join(personaDir, 'wiki')

  // Validate the slug, then assert the resolved path still lands inside
  // `dir`. The regex already rules out '/', '.', '..', and uppercase, so this
  // can't actually escape — but assert it anyway rather than trust the regex alone.
  function resolvePagePath(slug) {
    if (typeof slug !== 'string' || !WIKI_SLUG_RE.test(slug)) {
      throw new Error(`invalid wiki slug: ${slug}`)
    }
    const root = resolve(dir)
    const resolved = resolve(root, `${slug}.md`)
    const rel = relative(root, resolved)
    if (rel.startsWith('..') || resolve(root, rel) !== resolved) {
      throw new Error(`invalid wiki slug: ${slug}`)
    }
    return resolved
  }

  // First `# heading` text, else the first non-empty line, trimmed to 80 chars.
  function extractTitle(content) {
    const lines = content.split('\n')
    for (const line of lines) {
      const m = line.match(/^#\s+(.+)/)
      if (m) return m[1].trim().slice(0, 80)
    }
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) return trimmed.slice(0, 80)
    }
    return ''
  }

  async function read(slug) {
    const filePath = resolvePagePath(slug)
    try {
      return await readFile(filePath, 'utf8')
    } catch {
      return null
    }
  }

  async function readIndex() {
    try {
      return await readFile(join(dir, INDEX_FILENAME), 'utf8')
    } catch {
      return EMPTY_INDEX
    }
  }

  async function list() {
    let entries
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }
    const slugs = entries
      .filter(e => e.endsWith('.md') && e !== INDEX_FILENAME)
      .map(e => e.slice(0, -3))
      .filter(slug => WIKI_SLUG_RE.test(slug))
      .sort()

    const out = []
    for (const slug of slugs) {
      const filePath = join(dir, `${slug}.md`)
      const content = await readFile(filePath, 'utf8')
      const stats = await stat(filePath)
      out.push({ slug, bytes: stats.size, title: extractTitle(content) })
    }
    return out
  }

  // Regenerated after every write/remove — a markdown list of all pages,
  // sorted alphabetically, plus a page count and update date. index.md is
  // never listed among its own entries.
  async function regenerateIndex() {
    const pages = await list()
    const lines = ['# Wiki Index', '']
    for (const page of pages) {
      lines.push(`- [[${page.slug}]] — ${page.title}`)
    }
    lines.push('')
    lines.push(`_${pages.length} pages, updated ${new Date().toISOString().slice(0, 10)}_`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, INDEX_FILENAME), lines.join('\n') + '\n', 'utf8')
  }

  async function write(slug, content) {
    if (slug === INDEX_SLUG) {
      throw new Error('index.md is generated')
    }
    const filePath = resolvePagePath(slug)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > WIKI_CONTENT_CAP_BYTES) {
      throw new Error(`wiki page too large: ${bytes} bytes exceeds ${WIKI_CONTENT_CAP_BYTES} byte cap`)
    }
    await mkdir(dir, { recursive: true })
    await writeFile(filePath, content, 'utf8')
    await regenerateIndex()
  }

  async function remove(slug) {
    const filePath = resolvePagePath(slug)
    try {
      await unlink(filePath)
    } catch {
      return false
    }
    await regenerateIndex()
    return true
  }

  async function search(query, { limit = 20 } = {}) {
    if (!query || !query.trim()) return []
    const q = query.toLowerCase()
    const results = []
    const pages = await list()
    for (const page of pages) {
      if (results.length >= limit) break
      const content = await read(page.slug)
      if (content === null) continue
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= limit) break
        if (lines[i].toLowerCase().includes(q)) {
          results.push({ slug: page.slug, line: lines[i], lineNumber: i + 1, title: page.title })
        }
      }
    }
    return results
  }

  async function links(slug) {
    const content = await read(slug)
    if (content === null) return { outgoing: [], broken: [] }
    const found = new Set()
    for (const m of content.matchAll(WIKI_LINK_RE)) {
      const target = m[1]
      if (target !== slug) found.add(target)
    }
    const outgoing = [...found]
    const broken = []
    for (const target of outgoing) {
      if ((await read(target)) === null) broken.push(target)
    }
    return { outgoing, broken }
  }

  return { read, write, remove, list, search, links, readIndex }
}
