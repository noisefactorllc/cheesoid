import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadTools } from '../server/lib/tools.js'
import { Memory, MEMORY_READ_CAP_BYTES, MEMORY_COMPACT_WARN_BYTES } from '../server/lib/memory.js'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function makeMemoryPersona(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-tools-mem-'))
  const memDir = join(dir, 'memory')
  await mkdir(memDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(memDir, name), content)
  }
  return dir
}

function stubState() {
  return { load: async () => {}, save: async () => {}, update: () => {}, data: {} }
}

function stubRoom() {
  return {
    broadcast: () => {},
    recordHistory: () => {},
    chatLog: null,
    participants: new Map(),
    _pendingRoom: 'home',
    roomClients: new Map(),
    persona: { config: { display_name: 'TestAgent', agents: [], rooms: [] } },
  }
}

// This exercises the tools.js wiring on top of a real Memory instance (real
// tmp-dir files), rather than the shared tools-internal.test.js stubMemory(),
// because the behavior under test — cap trailer text, pressure-note sizing —
// lives in the interaction between tools.js and memory.js.
describe('memory tools (read_memory / append_memory) via loadTools', () => {
  it('read_memory returns small files unchanged', async () => {
    const dir = await makeMemoryPersona({ 'topics.md': 'Topic content.' })
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const mem = new Memory(dir, 'memory/')
    const tools = await loadTools(dir, config, mem, stubState(), stubRoom(), null)

    const result = await tools.execute('read_memory', { filename: 'topics.md' })
    assert.equal(result.output, 'Topic content.')
  })

  it('read_memory truncates a file over 32KB and reports the true size', async () => {
    const big = 'a'.repeat(MEMORY_READ_CAP_BYTES + 5000)
    const dir = await makeMemoryPersona({ 'MEMORY.md': big })
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const mem = new Memory(dir, 'memory/')
    const tools = await loadTools(dir, config, mem, stubState(), stubRoom(), null)

    const result = await tools.execute('read_memory', { filename: 'MEMORY.md' })
    assert.ok(result.output.length < big.length, 'output is capped, not the full file')
    assert.ok(result.output.startsWith('a'.repeat(MEMORY_READ_CAP_BYTES)), 'keeps the first 32KB verbatim')
    assert.match(result.output, /truncated/)
    assert.match(result.output, /topic files/)
  })

  it('read_memory reports File not found for a missing file', async () => {
    const dir = await makeMemoryPersona()
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const mem = new Memory(dir, 'memory/')
    const tools = await loadTools(dir, config, mem, stubState(), stubRoom(), null)

    const result = await tools.execute('read_memory', { filename: 'nope.md' })
    assert.ok(result.is_error)
    assert.match(result.output, /File not found/)
  })

  it('append_memory succeeds quietly when the resulting file stays under 64KB', async () => {
    const dir = await makeMemoryPersona({ 'notes.md': 'small' })
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const mem = new Memory(dir, 'memory/')
    const tools = await loadTools(dir, config, mem, stubState(), stubRoom(), null)

    const result = await tools.execute('append_memory', { filename: 'notes.md', content: 'more' })
    assert.equal(result.output, 'Appended to: notes.md')
  })

  it('append_memory adds a compaction pressure note once the file exceeds 64KB', async () => {
    // Start just under the 64KB warn threshold; the append pushes it over.
    const dir = await makeMemoryPersona({ 'MEMORY.md': 'x'.repeat(MEMORY_COMPACT_WARN_BYTES - 10) })
    const config = { memory: { dir: 'memory/', auto_read: [] } }
    const mem = new Memory(dir, 'memory/')
    const tools = await loadTools(dir, config, mem, stubState(), stubRoom(), null)

    const result = await tools.execute('append_memory', { filename: 'MEMORY.md', content: 'y'.repeat(50) })
    assert.match(result.output, /^Appended to: MEMORY\.md/)
    assert.match(result.output, /KB — consider compacting into topic files/)
  })
})
