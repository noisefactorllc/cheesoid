import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgent } from '../server/lib/agent.js'

test('runAgent propagates AbortSignal into provider streaming', async () => {
  const controller = new AbortController()
  let received
  const provider = {
    async streamMessage(params) {
      received = params.signal
      await new Promise((resolve, reject) => {
        params.signal.addEventListener('abort', () => reject(params.signal.reason), { once: true })
      })
    },
  }
  const run = runAgent(
    'system',
    [{ role: 'user', content: 'work' }],
    { definitions: [], execute: async () => ({ output: '' }) },
    { provider, model: 'test', signal: controller.signal },
    () => {},
  )
  controller.abort(new Error('shutdown'))
  await assert.rejects(run, /shutdown/)
  assert.equal(received, controller.signal)
})
