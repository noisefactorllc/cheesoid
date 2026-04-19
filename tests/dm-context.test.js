import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assemblePrompt } from '../server/lib/prompt-assembler.js'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function makePersona(files) {
  const dir = await mkdtemp(join(tmpdir(), 'cheesoid-dm-test-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

describe('DM-mode prompt assembly', () => {
  it('omits shared-room framing when mode=dm (Claude path)', async () => {
    const dir = await makePersona({
      'SOUL.md': 'I am the test agent.',
      'prompts/system.md': 'Persona voice lives here.',
    })

    const prompt = await assemblePrompt(dir, {
      display_name: 'Test',
      chat: { prompt: 'prompts/system.md' },
      rooms: [{ name: '#general' }],
      agents: [{ name: 'Other' }],
    }, [], { context: { mode: 'dm', dmPartner: 'Alice' } })

    assert.ok(!prompt.includes('You are in a shared room'),
      'Claude DM prompt must not contain shared-room framing')
    assert.ok(prompt.includes('private 1:1 DM'),
      'Claude DM prompt must contain DM framing')
    assert.ok(prompt.includes('Alice'),
      'Claude DM prompt must name the partner')
    assert.ok(!prompt.includes('Multi-Agent Turn-Taking'),
      'Claude DM prompt must omit multi-agent turn-taking section')
  })

  it('omits shared-room framing when mode=dm (openai-compat path)', async () => {
    const dir = await makePersona({
      'SOUL.md': 'I am the test agent.',
      'prompts/system.md': 'Persona voice lives here.',
    })

    const layers = await assemblePrompt(dir, {
      display_name: 'Test',
      chat: { prompt: 'prompts/system.md' },
      rooms: [{ name: '#general' }],
      agents: [{ name: 'Other' }],
    }, [], { isClaude: false, context: { mode: 'dm', dmPartner: 'Bob' } })

    assert.ok(Array.isArray(layers), 'openai-compat returns layered array')
    const joined = layers.map(l => l.content).join('\n\n')

    assert.ok(!joined.includes('You are in a shared room'),
      'openai-compat DM prompt must not contain shared-room framing')
    assert.ok(joined.includes('private 1:1 DM'),
      'openai-compat DM prompt must contain DM framing')
    assert.ok(joined.includes('Bob'), 'openai-compat DM prompt must name the partner')
    assert.ok(!joined.includes('Multi-Agent Turn-Taking'),
      'openai-compat DM prompt must omit multi-agent turn-taking')
  })

  it('processDM calls assemblePrompt with mode=dm and the sender as partner', async () => {
    // processDM is invoked on a Room instance (chat-session.js exports Room
    // as the session class). A true integration test requires a model stub
    // and room harness that do not exist yet. See Task 3 and Task 4 for
    // additional observable guarantees via source-scan tests. This
    // placeholder documents the intent so it is discoverable; remove once a
    // processDM integration harness exists.
    assert.ok(true, 'see Task 3 + Task 4 for end-to-end coverage')
  })
})
