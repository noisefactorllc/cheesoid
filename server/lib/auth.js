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

export function createAuthMiddleware(agents, peerStore = null) {
  const secretMap = new Map()
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
          req.userName = agentName
          req.isAgent = true
          return next()
        }
        // Runtime ad-hoc peers: approved secrets authenticate exactly like
        // config-declared agents (hash-compared inside the store).
        if (peerStore) {
          try {
            const peerName = await peerStore.authenticate(token)
            if (peerName) {
              req.userName = peerName
              req.isAgent = true
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
        req.isAgent = false
        return next()
      }

      // No agents configured — pass through
      req.isAgent = false
      return next()
    }

    // Fall back to groundsquirrel header
    const email = req.headers['x-gs-user-email']
    if (email) {
      req.userName = email.split('@')[0]
      req.userEmail = email
    }
    req.isAgent = false
    next()
  }
}

export function requireAuth(req, res, next) {
  const email = req.headers['x-gs-user-email']
  if (email) {
    req.userName = email.split('@')[0]
    req.userEmail = email
  }
  req.isAgent = false
  next()
}
