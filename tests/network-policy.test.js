import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowPrivatePeers,
  isGlobalAddress,
  requestPublic,
  resolvePublicTarget,
} from '../server/lib/network-policy.js'

describe('outbound network policy', () => {
  it('rejects private, reserved, documentation, multicast, and mapped addresses', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.0.1',
      '192.0.2.10',
      '198.18.0.1',
      '198.51.100.10',
      '203.0.113.10',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::127.0.0.1',
      '::ffff:127.0.0.1',
      'fec0::1',
      '2001::1',
      '2001:20::1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      '2002:7f00:1::',
      '3fff::1',
      'ff02::1',
    ]) {
      assert.equal(isGlobalAddress(address), false, `${address} must not be public`)
    }
    assert.equal(isGlobalAddress('8.8.8.8'), true)
    assert.equal(isGlobalAddress('2606:4700:4700::1111'), true)
  })

  it('resolves once, validates every answer, and pins the selected address', async () => {
    let resolutions = 0
    const target = await resolvePublicTarget(new URL('https://example.com/path'), {
      lookup: async () => {
        resolutions++
        return [
          { address: '93.184.216.34', family: 4 },
          { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        ]
      },
    })
    assert.equal(resolutions, 1)

    const pinned = await new Promise((resolve, reject) => {
      target.lookup('example.com', { all: true }, (err, addresses) => {
        if (err) reject(err)
        else resolve(addresses)
      })
    })
    assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }])
    assert.equal(resolutions, 1, 'socket lookup must not resolve DNS a second time')
  })

  it('rejects the whole resolution when any DNS answer is non-global', async () => {
    await assert.rejects(
      () => resolvePublicTarget(new URL('https://rebind.example/'), {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
      }),
      /non-global|private/i,
    )
  })

  it('allows private targets only through an explicit feature override', async () => {
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }]
    await assert.rejects(
      () => resolvePublicTarget(new URL('http://localhost:3000/'), { lookup }),
      /private|non-global/i,
    )
    const allowed = await resolvePublicTarget(
      new URL('http://localhost:3000/'),
      { lookup, allowPrivate: true },
    )
    assert.equal(allowed.address, '127.0.0.1')
  })

  it('requires an exact config or deployment opt-in for private peers', () => {
    assert.equal(allowPrivatePeers({}, {}), false)
    assert.equal(allowPrivatePeers({ network: { allow_private_peers: false } }, {
      CHEESOID_ALLOW_PRIVATE_PEERS: 'true',
    }), false)
    assert.equal(allowPrivatePeers({ network: { allow_private_peers: true } }, {}), true)
    assert.equal(allowPrivatePeers({}, { CHEESOID_ALLOW_PRIVATE_PEERS: '1' }), true)
  })

  it('enforces a total request deadline against trickle responses', async () => {
    const http = await import('node:http')
    const server = http.createServer((_req, res) => {
      res.writeHead(200)
      const timer = setInterval(() => res.write('x'), 10)
      res.on('close', () => clearInterval(timer))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await assert.rejects(
        () => requestPublic(`http://127.0.0.1:${server.address().port}/`, {
          allowPrivate: true,
          timeoutMs: 40,
        }),
        /timed out after 40ms/,
      )
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('includes DNS resolution in the total request deadline', async () => {
    await assert.rejects(
      () => requestPublic('https://slow-dns.example/', {
        timeoutMs: 30,
        lookup: async () => new Promise(() => {}),
      }),
      /timed out after 30ms/,
    )
  })
})
