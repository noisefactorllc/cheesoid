import { test } from 'node:test'
import assert from 'node:assert'
import { transcribe } from '../server/lib/voice.js'

test('no transcription tier configured → 501', async () => {
  await assert.rejects(
    () => transcribe({ buffer: Buffer.from('x'), mime: 'audio/wav', config: {} }),
    (err) => err.status === 501 && /not configured/.test(err.message),
  )
})

test('no openrouter credentials → 501', async () => {
  const prev = process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_API_KEY
  try {
    await assert.rejects(
      () => transcribe({ buffer: Buffer.from('x'), mime: 'audio/wav', config: { transcription: ['m:openrouter'] } }),
      (err) => err.status === 501 && /OPENROUTER_API_KEY/.test(err.message),
    )
  } finally {
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev
  }
})

test('unsupported audio mime → 415 before any network call', async () => {
  const config = {
    transcription: ['m:openrouter'],
    providers: { openrouter: { type: 'openrouter', api_key: 'fake-key-never-used' } },
  }
  await assert.rejects(
    () => transcribe({ buffer: Buffer.from('x'), mime: 'video/avi', config }),
    (err) => err.status === 415 && /unsupported audio type/.test(err.message),
  )
})

test('provider-suffixed transcription resolves through the registry capability', async () => {
  const calls = []
  const provider = {
    async transcribeAudio(options) {
      calls.push(options)
      return { text: 'hello from the selected provider' }
    },
  }
  const registry = {
    resolve(modelString) {
      assert.equal(modelString, 'native-audio:custom')
      return { modelId: 'native-audio', provider }
    },
  }
  const result = await transcribe({
    buffer: Buffer.from('audio'),
    mime: 'audio/wav',
    config: { transcription: ['native-audio:custom'] },
    registry,
    hints: ['Cheesoid'],
  })
  assert.deepStrictEqual(result, {
    text: 'hello from the selected provider',
    model: 'native-audio:custom',
  })
  assert.equal(calls[0].model, 'native-audio')
  assert.equal(calls[0].mime, 'audio/wav')
})
