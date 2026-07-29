/**
 * Auth middleware for groundsquirrel integration and agent bearer tokens.
 *
 * createAuthMiddleware(agents) — factory that returns middleware supporting:
 *   - Bearer token auth for agents (if agents configured)
 *   - X-GS-User-Email header (groundsquirrel proxy)
 *   - Passthrough for dev mode
 *
 * requireAuth — simple backward-compatible middleware (groundsquirrel only)
 */

const ANONYMOUS_PRINCIPAL = Object.freeze({
  kind: 'anonymous',
  name: null,
  email: null,
  source: 'none',
})

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress || req.connection?.remoteAddress || ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function setPrincipal(req, principal) {
  req.principal = principal
  req.isAgent = principal.kind === 'agent'
  req.userName = principal.name
  if (principal.email) req.userEmail = principal.email
}

export function createAuthMiddleware(agents, peerStore = null, options = {}) {
  const secretMap = new Map()
  const trustProxyHeaders = options.trustProxyHeaders === true
  if (agents && agents.length > 0) {
    for (const { name, secret } of agents) {
      secretMap.set(secret, name)
    }
  }

  return async function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization']

    // Check bearer token first
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7)

      if (secretMap.size > 0 || peerStore) {
        const agentName = secretMap.get(token)
        if (agentName) {
          setPrincipal(req, {
            kind: 'agent',
            name: agentName,
            email: null,
            source: 'configured-bearer',
          })
          return next()
        }
        // Runtime ad-hoc peers: approved secrets authenticate exactly like
        // config-declared agents (hash-compared inside the store).
        if (peerStore) {
          try {
            const peerName = await peerStore.authenticate(token)
            if (peerName) {
              setPrincipal(req, {
                kind: 'agent',
                name: peerName,
                email: null,
                source: 'runtime-peer-bearer',
              })
              return next()
            }
          } catch (err) {
            console.log(`[auth] peer authentication error: ${err.message}`)
          }
        }
        // With config agents declared, an unmatched token is a hard 401
        // (legacy behavior). Without them, preserve the legacy passthrough:
        // deployments that never configured agents may see unrelated Bearer
        // headers from their proxy stack, and runtime peers already got
        // their chance to match above.
        if (secretMap.size > 0) {
          return res.status(401).json({ error: 'Invalid bearer token' })
        }
        setPrincipal(req, ANONYMOUS_PRINCIPAL)
        return next()
      }

      // No agents configured — pass through
      setPrincipal(req, ANONYMOUS_PRINCIPAL)
      return next()
    }

    // Fall back to groundsquirrel header
    const email = trustProxyHeaders ? req.headers['x-gs-user-email'] : null
    if (email) {
      setPrincipal(req, {
        kind: 'human',
        name: email.split('@')[0],
        email,
        source: 'groundsquirrel',
      })
      return next()
    }

    const allowAnonymousOperator = options.allowAnonymousOperator
      ?? process.env.CHEESOID_ALLOW_ANONYMOUS_OPERATOR === '1'
    if (allowAnonymousOperator && !trustProxyHeaders && isLoopbackRequest(req)) {
      setPrincipal(req, {
        kind: 'human',
        name: 'local-operator',
        email: null,
        source: 'development-bypass',
      })
      return next()
    }

    setPrincipal(req, ANONYMOUS_PRINCIPAL)
    next()
  }
}

export function requireAuth(req, res, next) {
  const trustProxyHeaders = req.app?.locals?.persona?.config?.auth_proxy === true
  const email = trustProxyHeaders ? req.headers['x-gs-user-email'] : null
  if (email) {
    setPrincipal(req, {
      kind: 'human',
      name: email.split('@')[0],
      email,
      source: 'groundsquirrel',
    })
  } else {
    setPrincipal(req, ANONYMOUS_PRINCIPAL)
  }
  next()
}
