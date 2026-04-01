const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' }

export class CircuitOpenError extends Error {
  constructor(url, remainingSeconds, lastError) {
    super(`endpoint ${url} circuit open, retry in ${remainingSeconds}s`)
    this.isCircuitOpen = true
    this.url = url
    this.remainingSeconds = remainingSeconds
    this.lastError = lastError || null
  }
}

export class CircuitBreaker {
  constructor({ threshold = 3, initialCooldown = 30000, maxCooldown = 1800000 } = {}) {
    this.threshold = threshold
    this.initialCooldown = initialCooldown
    this.maxCooldown = maxCooldown
    this.endpoints = new Map()
  }

  _getEndpoint(url) {
    if (!this.endpoints.has(url)) {
      this.endpoints.set(url, {
        state: STATES.CLOSED,
        failures: 0,
        cooldown: this.initialCooldown,
        openedAt: null,
        probing: false,
      })
    }
    return this.endpoints.get(url)
  }

  isOpen(url) {
    const ep = this._getEndpoint(url)

    if (ep.state === STATES.CLOSED) return false

    if (ep.state === STATES.OPEN) {
      const elapsed = Date.now() - ep.openedAt
      if (elapsed >= ep.cooldown) {
        ep.state = STATES.HALF_OPEN
        ep.probing = false
        console.log(`[circuit-breaker] ${url} OPEN -> HALF_OPEN (cooldown expired, probing)`)
      } else {
        return true
      }
    }

    if (ep.state === STATES.HALF_OPEN) {
      if (ep.probing) return true
      ep.probing = true
      return false
    }

    return false
  }

  remainingCooldown(url) {
    const ep = this._getEndpoint(url)
    if (ep.state !== STATES.OPEN) return 0
    const elapsed = Date.now() - ep.openedAt
    return Math.max(0, ep.cooldown - elapsed)
  }

  recordSuccess(url) {
    const ep = this._getEndpoint(url)
    if (ep.state === STATES.HALF_OPEN) {
      console.log(`[circuit-breaker] ${url} HALF_OPEN -> CLOSED (probe succeeded)`)
    }
    ep.state = STATES.CLOSED
    ep.failures = 0
    ep.cooldown = this.initialCooldown
    ep.probing = false
    ep.lastSuccess = Date.now()
  }

  recordFailure(url, errorMessage) {
    const ep = this._getEndpoint(url)
    if (errorMessage) ep.lastError = errorMessage

    if (ep.state === STATES.HALF_OPEN) {
      ep.cooldown = Math.min(ep.cooldown * 2, this.maxCooldown)
      ep.state = STATES.OPEN
      ep.openedAt = Date.now()
      ep.probing = false
      console.log(`[circuit-breaker] ${url} HALF_OPEN -> OPEN (probe failed, cooldown ${Math.round(ep.cooldown / 1000)}s)`)
      return
    }

    // Reset consecutive count if there was a recent success (intermittent, not dead)
    if (ep.lastSuccess && Date.now() - ep.lastSuccess < this.initialCooldown) {
      ep.failures = 1
    } else {
      ep.failures++
    }

    if (ep.failures >= this.threshold) {
      ep.state = STATES.OPEN
      ep.openedAt = Date.now()
      ep.probing = false
      console.log(`[circuit-breaker] ${url} CLOSED -> OPEN (${ep.failures} consecutive failures, cooldown ${Math.round(ep.cooldown / 1000)}s)`)
    }
  }

  lastError(url) {
    const ep = this._getEndpoint(url)
    return ep.lastError || null
  }
}

// Shared singleton — all sessions share circuit state
export default new CircuitBreaker({ threshold: 5, initialCooldown: 5000, maxCooldown: 60000 })
