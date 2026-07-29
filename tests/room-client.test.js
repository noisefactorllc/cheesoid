import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RoomClient } from '../server/lib/room-client.js'

describe('RoomClient', () => {
  it('constructs with config', () => {
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: () => {},
    })
    assert.equal(client.roomName, 'test-room')
    assert.equal(client.url, 'http://localhost:3001')
    assert.equal(client.connected, false)
  })

  it('parses SSE data lines', () => {
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: () => {},
    })
    const event = client._parseSSE('data: {"type":"user_message","name":"alice","text":"hello"}')
    assert.deepEqual(event, { type: 'user_message', name: 'alice', text: 'hello' })
  })

  it('returns null for non-data SSE lines', () => {
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: () => {},
    })
    assert.equal(client._parseSSE(''), null)
    assert.equal(client._parseSSE(':comment'), null)
    assert.equal(client._parseSSE('event: ping'), null)
  })

  it('filters echo messages (own name)', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({ type: 'user_message', name: 'alice', text: 'hello' })
    client._handleEvent({ type: 'user_message', name: 'Alice', text: 'my own echo' })
    assert.equal(received.length, 1)
    assert.equal(received[0].name, 'alice')
    assert.equal(received[0].room, 'test-room')
  })

  it('tags events with room name', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({ type: 'user_message', name: 'alice', text: 'hello' })
    assert.equal(received[0].room, 'test-room')
  })

  it('processes scrollback messages and tags them as scrollback', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({
      type: 'scrollback',
      messages: [
        { type: 'user_message', name: 'alice', text: 'earlier' },
        { type: 'assistant_message', text: 'response' },
        { type: 'user_message', name: 'Alice', text: 'my echo' },
      ],
    })
    assert.equal(received.length, 2)
    assert.equal(received[0].type, 'user_message')
    assert.equal(received[0].scrollback, true)
    assert.equal(received[1].type, 'assistant_message')
    assert.equal(received[1].scrollback, true)
  })

  it('tags live events as non-scrollback', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({ type: 'user_message', name: 'alice', text: 'live' })
    assert.equal(received[0].scrollback, false)
  })

  it('selects https module for https URLs', () => {
    const client = new RoomClient({
      url: 'https://example.com',
      name: 'secure-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: () => {},
    })
    assert.equal(client._isHttps, true)
  })

  it('selects http module for http URLs', () => {
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: () => {},
    })
    assert.equal(client._isHttps, false)
  })

  it('sendEvent posts to /api/chat/event', async () => {
    const http = await import('node:http')
    let receivedBody = null
    const srv = http.createServer((req, res) => {
      let data = ''
      req.on('data', c => data += c)
      req.on('end', () => {
        receivedBody = JSON.parse(data)
        res.end(JSON.stringify({ status: 'ok' }))
      })
    })
    await new Promise(r => srv.listen(0, r))
    const port = srv.address().port

    const client = new RoomClient({
      url: `http://localhost:${port}`,
      name: 'test-room',
      secret: 'test-secret',
      allow_private: true,
    }, {
      agentName: 'Alice',
      onMessage: () => {},
    })

    await client.sendEvent({ type: 'text_delta', text: 'hello' })
    srv.close()

    assert.deepEqual(receivedBody, {
      name: 'Alice',
      event: { type: 'text_delta', text: 'hello' },
    })
  })

  it('sendEvent resolves on network error instead of rejecting', async () => {
    const client = new RoomClient({
      url: 'http://localhost:1', // nothing listening
      name: 'dead-room',
      secret: 'test-secret',
      allow_private: true,
    }, {
      agentName: 'Alice',
      onMessage: () => {},
    })

    // Should resolve, not reject — relay failures are non-fatal
    const result = await client.sendEvent({ type: 'text_delta', text: 'hello' })
    assert.ok(result.error)
  })

  it('sendBackchannel passes trigger flag in payload', async () => {
    const http = await import('node:http')
    let postedBody = null
    const server = http.createServer((req, res) => {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => {
        postedBody = JSON.parse(data)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"status":"sent"}')
      })
    })
    await new Promise(r => server.listen(0, r))
    const port = server.address().port

    const client = new RoomClient(
      { name: 'test', url: `http://localhost:${port}`, secret: 's', allow_private: true },
      { agentName: 'Agent', onMessage: () => {} },
    )

    await client.sendBackchannel('delegate this', { trigger: true })
    server.close()

    assert.equal(postedBody.backchannel, true)
    assert.equal(postedBody.trigger, true)
    assert.equal(postedBody.message, 'delegate this')
  })

  it('validates and pins the target for every outbound request', async () => {
    let validations = 0
    const client = new RoomClient(
      { name: 'blocked', url: 'https://peer.example', secret: 's' },
      {
        agentName: 'Agent',
        onMessage: () => {},
        resolveTarget: async () => {
          validations++
          throw new Error('refusing non-global address 127.0.0.1')
        },
      },
    )

    await assert.rejects(() => client.sendMessage('one'), /non-global/)
    await assert.rejects(() => client.sendMessage('two'), /non-global/)
    assert.equal(validations, 2)
  })

  it('includes target resolution in the request deadline', async () => {
    const client = new RoomClient(
      {
        name: 'slow-dns',
        url: 'https://peer.example',
        secret: 's',
        request_timeout_ms: 30,
      },
      {
        agentName: 'Agent',
        onMessage: () => {},
        resolveTarget: async () => new Promise(() => {}),
      },
    )
    await assert.rejects(() => client.sendMessage('one'), /timed out after 30ms/)
  })

  it('bounds JSON responses from a peer', async () => {
    const http = await import('node:http')
    const server = http.createServer((_req, res) => {
      res.end('x'.repeat(2048))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new RoomClient({
      name: 'bounded',
      url: `http://127.0.0.1:${server.address().port}`,
      secret: 'test-secret',
      allow_private: true,
      max_response_bytes: 1024,
    }, { agentName: 'Agent', onMessage: () => {} })
    try {
      await assert.rejects(() => client.sendMessage('hello'), /exceeds 1024 byte limit/)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('times out peer POST requests that never respond', async () => {
    const http = await import('node:http')
    const server = http.createServer(() => {})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new RoomClient({
      name: 'timeout',
      url: `http://127.0.0.1:${server.address().port}`,
      secret: 'test-secret',
      allow_private: true,
      request_timeout_ms: 25,
    }, { agentName: 'Agent', onMessage: () => {} })
    try {
      await assert.rejects(() => client.sendMessage('hello'), /timed out/)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('enforces a total peer POST deadline against trickle responses', async () => {
    const http = await import('node:http')
    const server = http.createServer((_req, res) => {
      res.writeHead(200)
      const timer = setInterval(() => res.write('x'), 10)
      res.on('close', () => clearInterval(timer))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new RoomClient({
      name: 'trickle',
      url: `http://127.0.0.1:${server.address().port}`,
      secret: 'test-secret',
      allow_private: true,
      request_timeout_ms: 40,
    }, { agentName: 'Agent', onMessage: () => {} })
    try {
      await assert.rejects(() => client.sendMessage('hello'), /timed out after 40ms/)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('drops a peer stream whose unterminated SSE line exceeds the buffer cap', async () => {
    const http = await import('node:http')
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${'x'.repeat(2048)}`)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new RoomClient({
      name: 'oversized-stream',
      url: `http://127.0.0.1:${server.address().port}`,
      secret: 'test-secret',
      allow_private: true,
      max_sse_buffer_bytes: 1024,
    }, { agentName: 'Agent', onMessage: () => {} })
    try {
      client.connect()
      const deadline = Date.now() + 1000
      while (!client._retryTimer && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.ok(client._retryTimer, 'oversized stream must be destroyed and scheduled for retry')
      assert.equal(client.connected, false)
    } finally {
      client.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('ignores presence/reset/error events from remote rooms', () => {
    const received = []
    const client = new RoomClient({
      url: 'http://localhost:3001',
      name: 'test-room',
      secret: 'test-secret',
    }, {
      agentName: 'Alice',
      onMessage: (msg) => received.push(msg),
    })
    client._handleEvent({ type: 'presence', participants: ['alice'] })
    client._handleEvent({ type: 'reset' })
    client._handleEvent({ type: 'error', message: 'something' })
    assert.equal(received.length, 0)
  })
})
