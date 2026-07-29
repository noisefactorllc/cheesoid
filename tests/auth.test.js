import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAuthMiddleware } from '../server/lib/auth.js'

describe('Auth middleware', () => {
  function mockReqRes(headers = {}, remoteAddress = '127.0.0.1') {
    const req = { headers, userName: null, isAgent: false, socket: { remoteAddress } }
    const res = {
      status(code) { this._status = code; return this },
      json(body) { this._body = body },
    }
    return { req, res }
  }

  it('passes through with no auth headers', () => {
    const auth = createAuthMiddleware(null)
    const { req, res } = mockReqRes()
    let called = false
    auth(req, res, () => { called = true })
    assert.ok(called)
    assert.equal(req.isAgent, false)
    assert.deepEqual(req.principal, { kind: 'anonymous', name: null, email: null, source: 'none' })
  })

  it('reads X-GS-User-Email header', () => {
    const auth = createAuthMiddleware(null, null, { trustProxyHeaders: true })
    const { req, res } = mockReqRes({ 'x-gs-user-email': 'alice@example.com' })
    let called = false
    auth(req, res, () => { called = true })
    assert.equal(req.userName, 'alice')
    assert.equal(req.isAgent, false)
    assert.deepEqual(req.principal, {
      kind: 'human',
      name: 'alice',
      email: 'alice@example.com',
      source: 'groundsquirrel',
    })
  })

  it('does not trust proxy identity headers without explicit configuration', () => {
    const auth = createAuthMiddleware(null)
    const { req } = mockReqRes({ 'x-gs-user-email': 'spoofed@example.com' })
    let called = false
    auth(req, {}, () => { called = true })
    assert.ok(called)
    assert.deepEqual(req.principal, {
      kind: 'anonymous',
      name: null,
      email: null,
      source: 'none',
    })
  })

  it('authenticates agent via bearer token', () => {
    const agents = [{ name: 'Alice', secret: 'alice-secret-123' }]
    const auth = createAuthMiddleware(agents)
    const { req, res } = mockReqRes({ authorization: 'Bearer alice-secret-123' })
    let called = false
    auth(req, res, () => { called = true })
    assert.ok(called)
    assert.equal(req.userName, 'Alice')
    assert.equal(req.isAgent, true)
    assert.deepEqual(req.principal, {
      kind: 'agent',
      name: 'Alice',
      email: null,
      source: 'configured-bearer',
    })
  })

  it('rejects invalid bearer token', () => {
    const agents = [{ name: 'Alice', secret: 'alice-secret-123' }]
    const auth = createAuthMiddleware(agents)
    const { req, res } = mockReqRes({ authorization: 'Bearer wrong-token' })
    let called = false
    auth(req, res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res._status, 401)
  })

  it('passes through bearer when no agents configured', () => {
    const auth = createAuthMiddleware(null)
    const { req, res } = mockReqRes({ authorization: 'Bearer some-token' })
    let called = false
    auth(req, res, () => { called = true })
    assert.ok(called)
    assert.deepEqual(req.principal, { kind: 'anonymous', name: null, email: null, source: 'none' })
  })

  it('limits the anonymous operator bypass to direct loopback requests', () => {
    const auth = createAuthMiddleware(null, null, { allowAnonymousOperator: true })
    const local = mockReqRes({}, '127.0.0.1')
    auth(local.req, local.res, () => {})
    assert.equal(local.req.principal.kind, 'human')
    assert.equal(local.req.principal.source, 'development-bypass')

    const remote = mockReqRes({}, '203.0.113.10')
    auth(remote.req, remote.res, () => {})
    assert.equal(remote.req.principal.kind, 'anonymous')

    const proxied = createAuthMiddleware(null, null, {
      allowAnonymousOperator: true,
      trustProxyHeaders: true,
    })
    const proxyLoopback = mockReqRes({}, '127.0.0.1')
    proxied(proxyLoopback.req, proxyLoopback.res, () => {})
    assert.equal(proxyLoopback.req.principal.kind, 'anonymous')
  })
})
