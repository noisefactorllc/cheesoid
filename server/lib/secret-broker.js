import { SECRET_NAME_RE } from './secrets.js'

const BINDING_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const UNSAFE_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'transfer-encoding',
])

/**
 * Resolve stored credentials only into a predeclared header for an exact,
 * HTTPS destination. The model chooses a binding name, never a secret name,
 * value, header, prefix, or host.
 */
export function createSecretBroker({ bindings = {}, resolveSecret }) {
  if (typeof resolveSecret !== 'function') {
    throw new Error('secret broker requires resolveSecret')
  }

  const normalized = new Map()
  for (const [name, binding] of Object.entries(bindings || {})) {
    if (!BINDING_NAME_RE.test(name)) {
      throw new Error(`invalid secret binding name: ${name}`)
    }
    if (!binding || !SECRET_NAME_RE.test(binding.secret || '')) {
      throw new Error(`invalid secret name for binding ${name}`)
    }
    if (!Array.isArray(binding.hosts) || binding.hosts.length === 0) {
      throw new Error(`binding ${name} requires at least one host`)
    }
    const hosts = new Set(binding.hosts.map((host) => {
      const normalizedHost = String(host).toLowerCase()
      if (!HOST_RE.test(normalizedHost)) {
        throw new Error(`invalid host for binding ${name}: ${host}`)
      }
      return normalizedHost
    }))
    const header = String(binding.header || '')
    if (!HEADER_RE.test(header) || UNSAFE_HEADERS.has(header.toLowerCase())) {
      throw new Error(`unsafe header for binding ${name}: ${header}`)
    }
    const prefix = binding.prefix == null ? '' : String(binding.prefix)
    if (/[\r\n]/.test(prefix)) {
      throw new Error(`invalid prefix for binding ${name}`)
    }
    normalized.set(name, {
      secret: binding.secret,
      hosts,
      header,
      prefix,
    })
  }

  return {
    names() {
      return [...normalized.keys()]
    },

    status() {
      return [...normalized.entries()].map(([name, binding]) => ({
        name,
        available: Boolean(resolveSecret(binding.secret)),
      }))
    },

    headersFor(name, url) {
      const binding = normalized.get(name)
      if (!binding) throw new Error(`unknown secret binding: ${name}`)
      if (!(url instanceof URL)) throw new Error('secret binding requires a URL')
      if (url.protocol !== 'https:') {
        throw new Error(`secret binding ${name} requires HTTPS`)
      }
      const hostname = url.hostname.toLowerCase()
      if (!binding.hosts.has(hostname)) {
        throw new Error(`host ${hostname} is not allowed for secret binding ${name}`)
      }
      const value = resolveSecret(binding.secret)
      if (!value) {
        throw new Error(`secret binding ${name} is not available`)
      }
      return { [binding.header]: `${binding.prefix}${value}` }
    },
  }
}
