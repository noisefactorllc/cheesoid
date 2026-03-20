import http from 'node:http'
import https from 'node:https'

const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30000

export class RoomClient {
  constructor(config, { agentName, onMessage }) {
    this.url = config.url
    this.roomName = config.name
    this.secret = config.secret
    this._isHttps = this.url.startsWith('https://')
    this.agentName = agentName
    this.onMessage = onMessage
    this.connected = false
    this._req = null
    this._retryMs = INITIAL_RETRY_MS
    this._destroyed = false
  }

  connect() {
    if (this._destroyed) return

    // Clean up existing connection before reconnecting
    if (this._req) {
      this._req.destroy()
      this._req = null
    }

    const streamUrl = new URL('/api/chat/stream', this.url)
    streamUrl.searchParams.set('name', this.agentName)

    const mod = this._isHttps ? https : http

    const options = {
      headers: {
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${this.secret}`,
      },
    }

    this._req = mod.get(streamUrl, options, (res) => {
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
      this.connected = false
      console.error(`[RoomClient:${this.roomName}] Connection error: ${err.message}`)
      this._scheduleReconnect()
    })
  }

  async sendBackchannel(text) {
    return this._post({ message: text, name: this.agentName, backchannel: true })
  }

  async sendMessage(text) {
    return this._post({ message: text, name: this.agentName })
  }

  async sendEvent(event) {
    const url = new URL('/api/chat/event', this.url)
    const body = JSON.stringify({ name: this.agentName, event })
    const mod = this._isHttps ? https : http

    return new Promise((resolve) => {
      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secret}`,
        },
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { resolve({ raw: data }) }
        })
      })
      req.on('error', (err) => {
        // Non-fatal — don't crash the agent loop for relay failures
        const msg = err.message || err.code || 'unknown error'
        console.error(`[RoomClient:${this.roomName}] Event relay error: ${msg}`)
        resolve({ error: msg })
      })
      req.write(body)
      req.end()
    })
  }

  async _post(payload) {
    const sendUrl = new URL('/api/chat/send', this.url)
    const body = JSON.stringify(payload)

    return new Promise((resolve, reject) => {
      const mod = this._isHttps ? https : http
      const req = mod.request(sendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.secret}`,
        },
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { resolve({ raw: data }) }
        })
      })
      req.on('error', reject)
      req.write(body)
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

    if (['presence', 'reset', 'error'].includes(event.type)) {
      return
    }

    this.onMessage({ ...event, room: this.roomName, scrollback: isScrollback })
  }

  _scheduleReconnect() {
    if (this._destroyed) return
    this._retryTimer = setTimeout(() => this.connect(), this._retryMs)
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
