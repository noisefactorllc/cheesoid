import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPeerStore,
  isLegacyPeerLifecycleEntry,
  PENDING_TTL_MS,
  peerFingerprint,
  MAX_PENDING_PEERS,
} from '../server/lib/peering.js'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('peering store', () => {
  async function makeRuntimeDir() {
    return await mkdtemp(join(tmpdir(), 'cheesoid-peering-'))
  }

  const SECRET_A = 'a-very-long-secret-1234'
  const SECRET_B = 'another-long-secret-5678'

  it('identifies legacy peer lifecycle records that must stay out of model context', () => {
    assert.equal(isLegacyPeerLifecycleEntry({
      type: 'system',
      text: 'Peer join request from "margo-test" (http://margo:3003) — awaiting approval by a room owner.',
    }), true)
    assert.equal(isLegacyPeerLifecycleEntry({
      type: 'system',
      text: 'Peer "margo-test" approved by alex.',
    }), true)
    assert.equal(isLegacyPeerLifecycleEntry({
      type: 'system',
      text: 'ordinary operator note',
    }), false)
  })

  it('requestJoin creates a pending peer and returns a public record', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    const rec = await store.requestJoin({ name: 'Alice', secret: SECRET_A, url: 'https://alice.example', note: 'hi' })
    assert.equal(rec.name, 'Alice')
    assert.equal(rec.state, 'pending')
    assert.equal(rec.url, 'https://alice.example')
    assert.equal(rec.note, 'hi')
    assert.equal(rec.approvedBy, null)
    assert.equal(rec.approved, null)
    assert.ok(rec.requested)
    assert.equal(rec.salt, undefined)
    assert.equal(rec.hash, undefined)
  })

  it('list shows the pending peer without secret/hash/salt fields', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Bob', secret: SECRET_A })
    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'Bob')
    assert.equal(list[0].state, 'pending')
    const serialized = JSON.stringify(list)
    assert.ok(!serialized.includes(SECRET_A))
    assert.ok(!serialized.toLowerCase().includes('hash'))
    assert.ok(!serialized.toLowerCase().includes('salt'))
  })

  it('persists new peer secrets with a memory-hard KDF marker', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'ScryptPeer', secret: SECRET_A })
    const [stored] = JSON.parse(await readFile(join(dir, 'peers.json'), 'utf8'))
    assert.equal(stored.kdf, 'scrypt')
    assert.match(stored.tokenLookup, /^[a-f0-9]{64}$/)
    assert.ok(stored.salt.length >= 32)
    assert.ok(stored.hash.length >= 64)
  })

  it('authenticate fails while pending', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Carol', secret: SECRET_A })
    assert.equal(await store.authenticate(SECRET_A), null)
  })

  it('approve moves peer to approved and authenticate returns its name', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Dave', secret: SECRET_A })
    const approved = await store.approve('Dave', 'owner-user')
    assert.equal(approved.state, 'approved')
    assert.equal(approved.approvedBy, 'owner-user')
    assert.ok(approved.approved)
    assert.equal(await store.authenticate(SECRET_A), 'Dave')
  })

  it('wrong secret does not authenticate an approved peer', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Eve', secret: SECRET_A })
    await store.approve('Eve', 'owner-user')
    assert.equal(await store.authenticate(SECRET_B), null)
  })

  it('approve throws for an unknown or already-non-pending peer', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await assert.rejects(() => store.approve('Ghost', 'owner'), /no pending peer: Ghost/)

    await store.requestJoin({ name: 'Frank', secret: SECRET_A })
    await store.approve('Frank', 'owner')
    await assert.rejects(() => store.approve('Frank', 'owner'), /no pending peer: Frank/)
  })

  it('deny removes a pending peer', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Grace', secret: SECRET_A })
    assert.equal(await store.deny('Grace'), true)
    assert.deepEqual(await store.list(), [])
    assert.equal(await store.deny('Grace'), false)
  })

  it('deny does not remove an approved peer', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Hank', secret: SECRET_A })
    await store.approve('Hank', 'owner')
    assert.equal(await store.deny('Hank'), false)
    assert.equal(await store.authenticate(SECRET_A), 'Hank')
  })

  it('remove revokes an approved peer', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Ivy', secret: SECRET_A })
    await store.approve('Ivy', 'owner')
    assert.equal(await store.authenticate(SECRET_A), 'Ivy')

    assert.equal(await store.remove('Ivy'), true)
    assert.equal(await store.authenticate(SECRET_A), null)
    assert.equal(await store.remove('Ivy'), false)
  })

  it('rejects a name collision case-insensitively across pending, approved, and outbound states', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)

    await store.requestJoin({ name: 'Jill', secret: SECRET_A })
    await assert.rejects(() => store.requestJoin({ name: 'jill', secret: SECRET_B }), /peer name taken: jill/)

    await store.approve('Jill', 'owner')
    await assert.rejects(() => store.requestJoin({ name: 'JILL', secret: SECRET_B }), /peer name taken: JILL/)

    await store.addOutbound({ name: 'Kim', url: 'https://kim.example', addedBy: 'owner' })
    await assert.rejects(() => store.requestJoin({ name: 'kim', secret: SECRET_B }), /peer name taken: kim/)
    await assert.rejects(() => store.addOutbound({ name: 'KIM', url: 'https://kim2.example', addedBy: 'owner' }), /peer name taken: KIM/)
  })

  it('rejects a secret shorter than 16 characters', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await assert.rejects(() => store.requestJoin({ name: 'Leo', secret: 'short' }), /secret too short \(min 16 chars\)/)
  })

  it('bounds unauthenticated peer credentials and validates advertised URLs', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await assert.rejects(
      () => store.requestJoin({ name: 'Huge', secret: 'x'.repeat(1025) }),
      /secret too long/,
    )
    await assert.rejects(
      () => store.requestJoin({
        name: 'Script',
        secret: SECRET_A,
        url: 'javascript:alert(1)',
      }),
      /invalid peer url/,
    )
    await assert.rejects(
      () => store.requestJoin({
        name: 'Credentials',
        secret: SECRET_A,
        url: 'https://user:password@example.com/',
      }),
      /invalid peer url/,
    )
  })

  it('prunes pending peers older than PENDING_TTL_MS on list()', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Mona', secret: SECRET_A })

    // Backdate the request timestamp directly on disk, as if 25h had passed.
    const filePath = join(dir, 'peers.json')
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    raw[0].requested = new Date(Date.now() - PENDING_TTL_MS - 60 * 60 * 1000).toISOString()
    await writeFile(filePath, JSON.stringify(raw, null, 2))

    // A fresh instance must pick up the backdated file and prune on list().
    const store2 = createPeerStore(dir)
    assert.deepEqual(await store2.list(), [])
  })

  it('does not prune pending peers within PENDING_TTL_MS', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Nora', secret: SECRET_A })

    const filePath = join(dir, 'peers.json')
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    raw[0].requested = new Date(Date.now() - PENDING_TTL_MS + 60 * 60 * 1000).toISOString()
    await writeFile(filePath, JSON.stringify(raw, null, 2))

    const store2 = createPeerStore(dir)
    const list = await store2.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'Nora')
  })

  it('expired pending peers never authenticate', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Otto', secret: SECRET_A })

    const filePath = join(dir, 'peers.json')
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    raw[0].requested = new Date(Date.now() - PENDING_TTL_MS - 60 * 60 * 1000).toISOString()
    await writeFile(filePath, JSON.stringify(raw, null, 2))

    const store2 = createPeerStore(dir)
    assert.equal(await store2.authenticate(SECRET_A), null)
  })

  it('persists across store instances', async () => {
    const dir = await makeRuntimeDir()
    const store1 = createPeerStore(dir)
    await store1.requestJoin({ name: 'Oscar', secret: SECRET_A, url: 'https://oscar.example', note: 'friend' })

    const store2 = createPeerStore(dir)
    const list = await store2.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'Oscar')
    assert.equal(list[0].url, 'https://oscar.example')
    assert.equal(list[0].note, 'friend')

    await store2.approve('Oscar', 'owner')

    const store3 = createPeerStore(dir)
    assert.equal(await store3.authenticate(SECRET_A), 'Oscar')
  })

  it('addOutbound appears in list with state outbound and stores no secret', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    const rec = await store.addOutbound({ name: 'Paul', url: 'https://paul.example', addedBy: 'owner-user' })
    assert.equal(rec.state, 'outbound')
    assert.equal(rec.name, 'Paul')
    assert.equal(rec.url, 'https://paul.example')

    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].state, 'outbound')
    assert.equal(list[0].name, 'Paul')

    // No secret is ever stored for outbound peers.
    assert.equal(await store.authenticate('anything-long-enough-1234'), null)

    const onDisk = JSON.parse(await readFile(join(dir, 'peers.json'), 'utf8'))
    const paulRecord = onDisk.find(r => r.name === 'Paul')
    assert.equal(paulRecord.hash, null)
    assert.equal(paulRecord.salt, null)
  })

  it('list orders pending peers before approved/outbound peers', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Quinn', secret: SECRET_A })
    await store.requestJoin({ name: 'Rex', secret: SECRET_B })
    await store.approve('Quinn', 'owner')

    const list = await store.list()
    assert.equal(list[0].name, 'Rex')
    assert.equal(list[0].state, 'pending')
    assert.equal(list[1].name, 'Quinn')
    assert.equal(list[1].state, 'approved')
  })

  it('orders each group newest-first', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Tara', secret: SECRET_A })
    await new Promise(resolve => setTimeout(resolve, 5))
    await store.requestJoin({ name: 'Uma', secret: SECRET_B })

    let list = await store.list()
    assert.equal(list[0].name, 'Uma')
    assert.equal(list[1].name, 'Tara')

    await store.approve('Tara', 'owner')
    await store.approve('Uma', 'owner')
    list = await store.list()
    assert.equal(list[0].name, 'Uma')
    assert.equal(list[1].name, 'Tara')
  })

  it('starts empty and logs a warning when the peers file is corrupt', async () => {
    const dir = await makeRuntimeDir()
    await writeFile(join(dir, 'peers.json'), '{ not valid json')

    const originalLog = console.log
    let loggedWarning = false
    console.log = (...args) => { loggedWarning = true; originalLog(...args) }
    try {
      const store = createPeerStore(dir)
      assert.deepEqual(await store.list(), [])
      assert.equal(loggedWarning, true)
    } finally {
      console.log = originalLog
    }
  })

  it('creates the runtime directory on demand', async () => {
    const base = await makeRuntimeDir()
    const nested = join(base, 'nested', 'runtime')
    const store = createPeerStore(nested)
    await store.requestJoin({ name: 'Sam', secret: SECRET_A })
    const onDisk = JSON.parse(await readFile(join(nested, 'peers.json'), 'utf8'))
    assert.equal(onDisk.length, 1)
    assert.equal(onDisk[0].name, 'Sam')
  })

  it('exports PENDING_TTL_MS as 24 hours', () => {
    assert.equal(PENDING_TTL_MS, 24 * 60 * 60 * 1000)
  })

  // --- Finding #5: name-squatting — public record carries a comparable fingerprint ---
  it('peerFingerprint is a deterministic, non-reversible short digest of the secret', () => {
    assert.equal(typeof peerFingerprint, 'function')
    const fp = peerFingerprint(SECRET_A)
    assert.match(fp, /^[a-f0-9]{12}$/)
    assert.equal(peerFingerprint(SECRET_A), fp)          // deterministic
    assert.notEqual(peerFingerprint(SECRET_B), fp)       // secret-specific
    assert.ok(!fp.includes(SECRET_A))                    // never the secret itself
  })

  it('publicRecord exposes the fingerprint and never leaks salt/hash/tokenLookup/secret', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    const rec = await store.requestJoin({ name: 'Fingerling', secret: SECRET_A })
    // The operator can compare this against a value the peer shared out-of-band.
    assert.equal(rec.fingerprint, peerFingerprint(SECRET_A))
    // The public projection still carries no secret material.
    assert.equal(rec.salt, undefined)
    assert.equal(rec.hash, undefined)
    assert.equal(rec.tokenLookup, undefined)
    const serialized = JSON.stringify(rec)
    assert.ok(!serialized.includes(SECRET_A))
    // The fingerprint is derived from the secret but is not the stored digests.
    const [stored] = JSON.parse(await readFile(join(dir, 'peers.json'), 'utf8'))
    assert.notEqual(rec.fingerprint, stored.hash)
    assert.notEqual(rec.fingerprint, stored.tokenLookup)
    assert.notEqual(rec.fingerprint, stored.salt)
  })

  it('the fingerprint survives approval and shows up in list()', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Fritz', secret: SECRET_A })
    const [pending] = await store.list()
    assert.equal(pending.fingerprint, peerFingerprint(SECRET_A))
    const approved = await store.approve('Fritz', 'owner')
    assert.equal(approved.fingerprint, peerFingerprint(SECRET_A))
  })

  // --- Finding #6: global cap on pending peers ---
  it('caps the number of pending peer requests', async () => {
    const dir = await makeRuntimeDir()
    assert.equal(typeof MAX_PENDING_PEERS, 'number')
    assert.ok(MAX_PENDING_PEERS > 0)
    // Pre-seed the store at the cap by writing pending records straight to disk
    // (same technique the prune tests use). The cap counts pending records, so
    // this avoids paying scrypt per record while still exercising the ceiling.
    const seeded = Array.from({ length: MAX_PENDING_PEERS }, (_, i) => ({
      name: `pending-${i}`,
      state: 'pending',
      requested: new Date().toISOString(),
    }))
    await writeFile(join(dir, 'peers.json'), JSON.stringify(seeded))
    const store = createPeerStore(dir)
    await assert.rejects(
      () => store.requestJoin({ name: 'one-too-many', secret: 'pending-secret-overflow-01' }),
      /too many pending peer requests/,
    )
    // Approving one drains a slot, so a fresh request fits again.
    await store.approve('pending-0', 'owner')
    const rec = await store.requestJoin({ name: 'now-there-is-room', secret: 'pending-secret-after-approve' })
    assert.equal(rec.state, 'pending')
  })

  // --- Finding #7: peers.json mode 0600, constant-time tokenLookup ---
  it('persists peers.json with 0600 permissions', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Locky', secret: SECRET_A })
    assert.equal((await stat(join(dir, 'peers.json'))).mode & 0o777, 0o600)
    // A rewrite (approve persists again) must not widen the mode.
    await store.approve('Locky', 'owner')
    assert.equal((await stat(join(dir, 'peers.json'))).mode & 0o777, 0o600)
  })

  it('authenticate behavior is unchanged for valid and invalid secrets (constant-time lookup)', async () => {
    const dir = await makeRuntimeDir()
    const store = createPeerStore(dir)
    await store.requestJoin({ name: 'Timmy', secret: SECRET_A })
    await store.approve('Timmy', 'owner')
    assert.equal(await store.authenticate(SECRET_A), 'Timmy')  // right secret authenticates
    assert.equal(await store.authenticate(SECRET_B), null)     // wrong secret rejected
    assert.equal(await store.authenticate('short'), null)      // trivially invalid rejected
  })
})
