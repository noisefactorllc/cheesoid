import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

describe('chat-session scrollback replay annotates DMs', () => {
  it('source contains branch for entry.dm_from/dm_to in the replay loop', async () => {
    const src = await readFile(
      new URL('../server/lib/chat-session.js', import.meta.url),
      'utf8',
    )

    // The replay loop currently flattens every user_message into
    // `${prefix}: ${entry.text}` regardless of whether the entry was a DM.
    // This test pins the branch into place.
    assert.ok(
      src.includes('entry.dm_from') || src.includes('entry.dm_to'),
      'replay loop must branch on dm_from/dm_to to distinguish DMs',
    )
    assert.ok(
      src.includes('(system)') && src.includes('DM'),
      'DM replay entries must include a (system) ... DM annotation',
    )
  })
})
