import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSecretBroker } from '../server/lib/secret-broker.js'

describe('secret broker', () => {
  const values = new Map([
    ['GITHUB_TOKEN', 'github-secret-value'],
    ['STRIPE_KEY', 'stripe-secret-value'],
  ])

  const broker = () => createSecretBroker({
    bindings: {
      github: {
        secret: 'GITHUB_TOKEN',
        hosts: ['api.github.com'],
        header: 'Authorization',
        prefix: 'Bearer ',
      },
      stripe: {
        secret: 'STRIPE_KEY',
        hosts: ['api.stripe.com'],
        header: 'X-Api-Key',
      },
    },
    resolveSecret: name => values.get(name) || null,
  })

  it('injects one configured credential for an exact HTTPS host', () => {
    assert.deepEqual(
      broker().headersFor('github', new URL('https://api.github.com/repos/openai/codex')),
      { Authorization: 'Bearer github-secret-value' },
    )
  })

  it('rejects subdomain confusion, plaintext HTTP, unknown bindings, and missing secrets', () => {
    assert.throws(
      () => broker().headersFor('github', new URL('https://api.github.com.attacker.test/')),
      /not allowed/i,
    )
    assert.throws(
      () => broker().headersFor('github', new URL('http://api.github.com/')),
      /https/i,
    )
    assert.throws(
      () => broker().headersFor('missing', new URL('https://api.github.com/')),
      /unknown secret binding/i,
    )
    const missing = createSecretBroker({
      bindings: { absent: { secret: 'NOPE', hosts: ['example.com'], header: 'Authorization' } },
      resolveSecret: () => null,
    })
    assert.throws(() => missing.headersFor('absent', new URL('https://example.com/')), (err) => {
      assert.match(err.message, /binding absent is not available/i)
      assert.doesNotMatch(err.message, /NOPE/)
      return true
    })
  })

  it('rejects unsafe binding configuration', () => {
    assert.throws(
      () => createSecretBroker({
        bindings: {
          bad: {
            secret: 'GITHUB_TOKEN',
            hosts: ['api.github.com'],
            header: 'Host',
          },
        },
        resolveSecret: () => 'x',
      }),
      /unsafe header/i,
    )
    assert.throws(
      () => createSecretBroker({
        bindings: {
          bad: {
            secret: 'GITHUB_TOKEN',
            hosts: ['*.github.com'],
            header: 'Authorization',
          },
        },
        resolveSecret: () => 'x',
      }),
      /invalid host/i,
    )
  })
})
