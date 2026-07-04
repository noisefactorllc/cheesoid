import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Source-scan tests (same convention as chat-session-dm-replay.test.js): the
// behavior lives inside chat-session.js hot paths that have no standalone unit
// harness, so we pin the observable source contract instead.
async function chatSessionSource() {
  return readFile(new URL('../server/lib/chat-session.js', import.meta.url), 'utf8')
}

describe('session-start state injection', () => {
  it('no longer pushes the forced get_state/read_memory ritual message', async () => {
    // The ritual used to shove a "[system: ... You MUST call get_state and
    // read_memory ...]" user message onto the first open-model turn. It is
    // replaced by preloading current state into the system prompt, so the push
    // (and its one-shot flag) must be gone.
    const src = await chatSessionSource()
    assert.ok(!src.includes('first interaction this session'),
      'the forced session-start ritual message must be removed')
    assert.ok(!src.includes('get_state and read_memory'),
      'the ritual instruction text must be removed')
    assert.ok(!src.includes('_sessionStartHandled'),
      'the now-unused _sessionStartHandled flag must be removed')
  })

  it('injects current state into the composed system prompt instead', async () => {
    // composeSystem appends stateBlock to the volatile tail so the model sees
    // live state without a get_state round-trip; guarded for state-not-loaded.
    const src = await chatSessionSource()
    assert.ok(src.includes('## Current State'),
      'current state must be injected under a "## Current State" heading')
    assert.ok(src.includes('function stateBlock'),
      'a stateBlock helper must render the state tail')
    assert.ok(src.includes('JSON.stringify(state.data)'),
      'state is serialized from state.data')
    assert.ok(src.includes('composeSystem'),
      'the composed system prompt must route through composeSystem')
  })
})
