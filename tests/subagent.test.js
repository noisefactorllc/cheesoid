import { test } from 'node:test'
import assert from 'node:assert'
import { createSubagentRunner } from '../server/lib/subagent.js'

const emptyTools = () => ({ definitions: [], execute: async () => ({ output: 'x' }) })

test('requires a prompt and a configured model chain', async () => {
  const runner = createSubagentRunner({ config: {}, registry: { resolve: () => { throw new Error('nope') } }, buildTools: emptyTools })
  await assert.rejects(() => runner.run({ prompt: '   ' }), /prompt required/)
  await assert.rejects(() => runner.run({ prompt: 'do a thing' }), /no subagent model configured/)
})

test('walks the fallback chain and surfaces the terminal failure', async () => {
  const tried = []
  const runner = createSubagentRunner({
    config: { subagent: ['a:x', 'b:x'] },
    registry: { resolve: (m) => { tried.push(m); throw new Error(`resolve failed for ${m}`) } },
    buildTools: emptyTools,
  })
  await assert.rejects(() => runner.run({ prompt: 'task' }), /subagent failed on all models/)
  assert.deepStrictEqual(tried, ['a:x', 'b:x'])
})

test('explicit model override bypasses the tier chain', async () => {
  const tried = []
  const runner = createSubagentRunner({
    config: { subagent: ['tier-model:x'] },
    registry: { resolve: (m) => { tried.push(m); throw new Error('down') } },
    buildTools: emptyTools,
  })
  await assert.rejects(() => runner.run({ prompt: 'task', model: 'override:x' }))
  assert.deepStrictEqual(tried, ['override:x'])
})

test('subagent tool subset never includes spawn_subagent (structural depth guard)', async () => {
  // tools.js registers harness._subagentTools with a fixed allowlist; assert
  // the allowlist source of truth excludes recursion.
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../server/lib/tools.js', import.meta.url), 'utf8')
  const match = src.match(/const SUBAGENT_TOOLS = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(match, 'SUBAGENT_TOOLS allowlist must exist')
  assert.ok(!match[1].includes('spawn_subagent'))
  assert.ok(!match[1].includes('task_start'))
  assert.ok(!match[1].includes('shell'))
  assert.ok(match[1].includes('search_memory'))
})
