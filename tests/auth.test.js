import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAuthMiddleware } from '../server/lib/auth.js'

describe('Auth middleware', () => {
  function mockReqRes(headers = {}) {
    const req = { headers, userName: null, isAgent: false }
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
  })

  it('reads X-GS-User-Email header', () => {
    const auth = createAuthMiddleware(null)
    const { req, res } = mockReqRes({ 'x-gs-user-email': 'alice@example.com' })
    let called = false
    auth(req, res, () => { called = true })
    assert.equal(req.userName, 'alice')
    assert.equal(req.isAgent, false)
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
  })
})
