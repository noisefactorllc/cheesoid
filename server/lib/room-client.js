import http from 'node:http'
import https from 'node:https'
import { resolvePublicTarget } from './network-policy.js'

const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30000
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024
const DEFAULT_SSE_BUFFER_MAX_BYTES = 1024 * 1024

function positiveLimit(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

async function beforeDeadline(promise, deadlineAt, message) {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new Error(message)
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), remaining)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class RoomClient {
  constructor(config, { agentName, onMessage, resolveTarget = resolvePublicTarget }) {
    this.url = config.url
    this.roomName = config.name
    this.secret = config.secret
    this._isHttps = this.url.startsWith('https://')
    this.agentName = agentName
    this.onMessage = onMessage
    this._resolveTarget = resolveTarget
    this._allowPrivate = config.allow_private === true
    this._requestTimeoutMs = positiveLimit(config.request_timeout_ms, DEFAULT_REQUEST_TIMEOUT_MS)
    this._maxResponseBytes = positiveLimit(config.max_response_bytes, DEFAULT_RESPONSE_MAX_BYTES)
    this._maxSseBufferBytes = positiveLimit(config.max_sse_buffer_bytes, DEFAULT_SSE_BUFFER_MAX_BYTES)
    this.connected = false
    this._req = null
    this._retryMs = INITIAL_RETRY_MS
    this._destroyed = false
  }

  connect() {
    this._connect().catch((err) => {
      if (this._destroyed) return
      this.connected = false
      console.error(`[RoomClient:${this.roomName}] Connection refused: ${err.message}`)
      this._scheduleReconnect()
    })
  }

  async _connect() {
    if (this._destroyed) return

    // Clean up existing connection before reconnecting
    if (this._req) {
      this._req.destroy()
      this._req = null
    }

    const streamUrl = new URL('/api/chat/stream', this.url)
    streamUrl.searchParams.set('name', this.agentName)
    const deadlineAt = Date.now() + this._requestTimeoutMs
    const timeoutMessage = `peer connection timed out after ${this._requestTimeoutMs}ms`
    const target = await beforeDeadline(
      this._resolveTarget(streamUrl, { allowPrivate: this._allowPrivate }),
      deadlineAt,
      timeoutMessage,
    )
    if (this._destroyed) return

    const mod = this._isHttps ? https : http

    const options = {
      headers: {
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${this.secret}`,
      },
      agent: false,
      lookup: target.lookup,
      servername: streamUrl.hostname,
    }

    const connectionDeadline = setTimeout(() => {
      this._req?.destroy(new Error(timeoutMessage))
    }, Math.max(1, deadlineAt - Date.now()))
    connectionDeadline.unref?.()
    this._req = mod.get(streamUrl, options, (res) => {
      clearTimeout(connectionDeadline)
      if (res.statusCode !== 200) {
        console.error(`[RoomClient:${this.roomName}] HTTP ${res.statusCode}, retrying...`)
        res.resume()
        this._scheduleReconnect()
        return
      }

      this.connected = true
      this._retryMs = INITIAL_RETRY_MS
      console.log(`[RoomClient:${this.roomName}] Connected to ${this.url}`)

      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop()
        if (Buffer.byteLength(buffer, 'utf8') > this._maxSseBufferBytes) {
          const err = new Error(`SSE buffer exceeds ${this._maxSseBufferBytes} byte limit`)
          res.destroy(err)
          this._req?.destroy(err)
          return
        }
        for (const line of lines) {
          const event = this._parseSSE(line)
          if (event) this._handleEvent(event)
        }
      })

      res.on('end', () => {
        this.connected = false
        console.log(`[RoomClient:${this.roomName}] Connection closed, reconnecting...`)
        this._scheduleReconnect()
      })

      res.on('error', (err) => {
        this.connected = false
        console.error(`[RoomClient:${this.roomName}] Stream error: ${err.message}`)
        this._scheduleReconnect()
      })
    })

    this._req.on('error', (err) => {
      clearTimeout(connectionDeadline)
      this.connected = false
      console.error(`[RoomClient:${this.roomName}] Connection error: ${err.message}`)
      this._scheduleReconnect()
    })
  }

  async sendBackchannel(text, options = {}) {
    return this._post({ message: text, name: this.agentName, backchannel: true, ...options })
  }

  async sendMessage(text, options = {}) {
    return this._post({ message: text, name: this.agentName, ...options })
  }

  async sendReaction(messageId, emoji, action = 'add') {
    const reactUrl = new URL('/api/chat/react', this.url)
    const body = JSON.stringify({ name: this.agentName, messageId, emoji, action })
    try {
      return await this._requestJson(reactUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secret}`,
        },
      }, body)
    } catch (err) {
      const msg = err.message || err.code || 'unknown error'
      console.error(`[RoomClient:${this.roomName}] Reaction relay error: ${msg}`)
      return { error: msg }
    }
  }

  async sendDMResponse(to, text, model) {
    const payload = { message: text, name: this.agentName, dm_to: to }
    if (model) payload.model = model
    return this._post(payload)
  }

  async sendEvent(event, room) {
    const url = new URL('/api/chat/event', this.url)
    const body = JSON.stringify({ name: this.agentName, event, room })

    try {
      return await this._requestJson(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secret}`,
        },
      }, body)
    } catch (err) {
      // Non-fatal — don't crash the agent loop for relay failures
      const msg = err.message || err.code || 'unknown error'
      console.error(`[RoomClient:${this.roomName}] Event relay error: ${msg}`)
      return { error: msg }
    }
  }

  async _post(payload) {
    const sendUrl = new URL('/api/chat/send', this.url)
    const body = JSON.stringify(payload)
    return this._requestJson(sendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.secret}`,
      },
    }, body)
  }

  async _requestJson(url, options, body) {
    if (body != null && Buffer.byteLength(body, 'utf8') > this._maxResponseBytes) {
      throw new Error(`request exceeds ${this._maxResponseBytes} byte limit`)
    }
    const deadlineAt = Date.now() + this._requestTimeoutMs
    const timeoutMessage = `peer request timed out after ${this._requestTimeoutMs}ms`
    const target = await beforeDeadline(
      this._resolveTarget(url, { allowPrivate: this._allowPrivate }),
      deadlineAt,
      timeoutMessage,
    )
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) throw new Error(timeoutMessage)
    return new Promise((resolve, reject) => {
      const mod = this._isHttps ? https : http
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        reject(err)
      }
      const req = mod.request(url, {
        ...options,
        agent: false,
        lookup: target.lookup,
        servername: url.hostname,
      }, (res) => {
        const chunks = []
        let received = 0
        res.on('data', (chunk) => {
          received += chunk.length
          if (received > this._maxResponseBytes) {
            const err = new Error(`response exceeds ${this._maxResponseBytes} byte limit`)
            res.destroy(err)
            req.destroy(err)
            fail(err)
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          const data = Buffer.concat(chunks).toString('utf8')
          try { resolve(JSON.parse(data)) }
          catch { resolve({ raw: data }) }
        })
        res.on('error', fail)
      })
      const deadline = setTimeout(() => {
        req.destroy(new Error(timeoutMessage))
      }, remaining)
      deadline.unref?.()
      req.on('error', fail)
      if (body != null) req.write(body)
      req.end()
    })
  }

  _parseSSE(line) {
    if (!line.startsWith('data: ')) return null
    try {
      return JSON.parse(line.slice(6))
    } catch {
      return null
    }
  }

  _handleEvent(event, isScrollback = false) {
    if (event.type === 'scrollback') {
      for (const msg of event.messages) {
        this._handleEvent(msg, true)
      }
      return
    }

    if (event.type === 'user_message' && event.name === this.agentName) {
      return
    }

    // Webhooks are for the host agent only — don't relay to connected agents
    if (event.type === 'user_message' && event.name === 'webhook') {
      return
    }

    if (['presence', 'reset', 'error'].includes(event.type)) {
      return
    }

    // Preserve host's room tag if present, fall back to client room name
    this.onMessage({ ...event, room: event.room || this.roomName, scrollback: isScrollback })
  }

  _scheduleReconnect() {
    if (this._destroyed) return
    if (this._retryTimer) return
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      this.connect()
    }, this._retryMs)
    this._retryMs = Math.min(this._retryMs * 2, MAX_RETRY_MS)
  }

  destroy() {
    this._destroyed = true
    this.connected = false
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
    if (this._req) {
      this._req.destroy()
      this._req = null
    }
  }
}
