import http from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const NON_GLOBAL = new BlockList()

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  NON_GLOBAL.addSubnet(network, prefix, 'ipv4')
}

for (const [network, prefix] of [
  ['::', 128],
  ['::', 96],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  // SRv6 (RFC 9602) and IPv4-translated (RFC 2765). NOTE: the IPv4-*mapped*
  // range ::ffff:0:0/96 is deliberately NOT added — Node's BlockList checks it
  // against IPv4 rules, so it would match every IPv4 address and block all v4
  // egress. Mapped addresses to private v4 are already caught by the v4 rules.
  ['5f00::', 16],
  ['::ffff:0:0:0', 96],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  NON_GLOBAL.addSubnet(network, prefix, 'ipv6')
}

const PRIVATE_HOSTNAME = /^(localhost|.*\.localhost|.*\.local|host\.docker\.internal|.*\.internal)$/i

export function allowPrivatePeers(config = {}, env = process.env) {
  return config.network?.allow_private_peers === true
    || env.CHEESOID_ALLOW_PRIVATE_PEERS === '1'
}

export function isGlobalAddress(address) {
  const family = isIP(address)
  if (family === 4) return !NON_GLOBAL.check(address, 'ipv4')
  if (family === 6) return !NON_GLOBAL.check(address, 'ipv6')
  return false
}

/**
 * The TLS SNI servername to use for a URL hostname, or `undefined` when it
 * should be omitted. `new URL('https://[::1]/').hostname` keeps the brackets,
 * which yields ERR_TLS_CERT_ALTNAME_INVALID if passed as `servername`; IPv4
 * literals additionally trigger DEP0123. For any IP literal we omit SNI
 * entirely (there's no certificate name to match); DNS names pass through.
 */
export function tlsServername(hostname) {
  const bare = String(hostname).replace(/^\[/, '').replace(/\]$/, '')
  return isIP(bare) ? undefined : hostname
}

/**
 * Resolve one HTTP(S) target, validate every DNS answer, and return a lookup
 * callback pinned to one validated address for the actual socket connection.
 */
export async function resolvePublicTarget(input, {
  lookup = hostname => dnsLookup(hostname, { all: true, verbatim: true }),
  allowPrivate = false,
} = {}) {
  const url = input instanceof URL ? input : new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`http(s) only: ${url.protocol}`)
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!allowPrivate && PRIVATE_HOSTNAME.test(hostname)) {
    throw new Error(`refusing private host ${hostname}`)
  }

  const literalFamily = isIP(hostname)
  let addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname)
  if (!Array.isArray(addresses)) addresses = [addresses]
  if (addresses.length === 0) throw new Error(`no addresses resolved for ${hostname}`)

  const normalized = addresses.map(({ address, family }) => ({
    address,
    family: Number(family) || isIP(address),
  }))
  for (const answer of normalized) {
    if (!answer.family || (!allowPrivate && !isGlobalAddress(answer.address))) {
      // Log the offending address server-side for diagnosis, but never echo it
      // back to the caller — returning the resolved internal IP turns refusals
      // into a DNS-rebinding oracle the model could use to map a private network.
      console.log(`[network-policy] refusing ${hostname}: resolved to non-global/private address ${answer.address}`)
      throw new Error(`refusing ${hostname} — resolves to a non-global/private address`)
    }
  }

  const selected = normalized[0]
  const pinnedLookup = (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    if (options?.all) callback(null, [selected])
    else callback(null, selected.address, selected.family)
  }

  return {
    ...selected,
    hostname,
    lookup: pinnedLookup,
  }
}

export async function resolveBeforeDeadline(input, options, deadlineAt, message) {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Error(message)
  let timer
  try {
    return await Promise.race([
      resolvePublicTarget(input, options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remaining)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Bounded native HTTP(S) request using a validated, pinned socket target.
 * Redirect handling belongs to the caller so credentials are re-authorized
 * for every hop.
 */
export async function requestPublic(input, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = 20_000,
  maxBytes = 1024 * 1024,
  allowPrivate = false,
  lookup,
  deadlineAt = Date.now() + timeoutMs,
} = {}) {
  const url = input instanceof URL ? input : new URL(input)
  const timeoutMessage = `request timed out after ${timeoutMs}ms`
  const target = await resolveBeforeDeadline(
    url,
    { lookup, allowPrivate },
    deadlineAt,
    timeoutMessage,
  )
  const transport = url.protocol === 'https:' ? https : http
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Error(timeoutMessage)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn(value)
    }
    const req = transport.request(url, {
      method,
      headers,
      // Never let the global keep-alive pool reuse a socket validated for an
      // earlier DNS answer. Each request must connect through this call's
      // freshly validated and pinned lookup.
      agent: false,
      lookup: target.lookup,
      servername: tlsServername(url.hostname),
    }, (res) => {
      const chunks = []
      let received = 0
      res.on('data', (chunk) => {
        received += chunk.length
        if (received > maxBytes) {
          req.destroy(new Error(`response exceeds ${maxBytes} byte limit`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        finish(resolve, {
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    const deadline = setTimeout(() => {
      req.destroy(new Error(timeoutMessage))
    }, remaining)
    deadline.unref?.()
    req.on('error', err => finish(reject, err))
    if (body != null) req.write(body)
    req.end()
  })
}
