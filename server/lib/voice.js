import { tierChain } from './model-policy.js'

const TRANSCRIBE_TIMEOUT_MS = 45 * 1000

/**
 * Voice input: transcribe an audio clip via the transcription tier.
 *
 * Follows the web-search.js pattern of talking to OpenRouter's API directly
 * rather than through the streaming provider stack — transcription is a
 * one-shot multimodal call, not a conversation turn. Vocabulary hints (the
 * persona and participant names) are passed so proper nouns survive; that
 * difference is what put gemini-3.5-flash-lite ahead in the STT eval.
 *
 * @returns {{ text: string, model: string }}
 * @throws {Error} err.status is set for HTTP-shaped failures
 */
export async function transcribe({ buffer, mime, config, registry = null, hints = [], signal = null }) {
  const chain = tierChain(config, 'transcription') || []
  if (!chain.length) {
    const err = new Error('voice transcription not configured (no transcription tier — set OPENROUTER_API_KEY or a transcription model)')
    err.status = 501
    throw err
  }

  const format = formatFromMime(mime)
  if (!format) {
    const err = new Error(`unsupported audio type: ${mime} (send audio/wav, audio/webm, audio/ogg, or audio/mpeg)`)
    err.status = 415
    throw err
  }

  const hintText = hints.filter(Boolean).length
    ? ` Names that may appear: ${[...new Set(hints.filter(Boolean))].join(', ')}.`
    : ''

  if (registry) {
    let lastErr = null
    for (const modelString of chain) {
      try {
        const { modelId, provider } = registry.resolve(modelString)
        if (typeof provider.transcribeAudio !== 'function') {
          throw new Error(`provider for ${modelString} does not support audio transcription`)
        }
        const result = await provider.transcribeAudio({
          buffer,
          mime,
          format,
          model: modelId,
          hints,
          prompt: `Transcribe this audio verbatim. Output ONLY the transcription text, nothing else.${hintText}`,
          signal,
          timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        })
        const text = String(result?.text || '').trim()
        if (!text) throw new Error('empty transcription')
        return { text, model: modelString }
      } catch (err) {
        signal?.throwIfAborted()
        lastErr = err
        console.log(`[voice] ${modelString} transcription failed (${err.message}) — trying next`)
      }
    }
    const err = new Error(`transcription failed: ${lastErr?.message || 'no models available'}`)
    err.status = 502
    throw err
  }

  const { baseUrl, apiKey } = resolveOpenRouterCreds(config)
  if (!apiKey) {
    const err = new Error('voice transcription needs an OpenRouter-compatible provider or OPENROUTER_API_KEY')
    err.status = 501
    throw err
  }

  let lastErr = null
  for (const modelString of chain) {
    const modelId = modelString.replace(/:[a-z0-9_-]+$/i, '')
    try {
      const timeoutSignal = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: requestSignal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: `Transcribe this audio verbatim. Output ONLY the transcription text, nothing else.${hintText}` },
              { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format } },
            ],
          }],
          max_tokens: 4000,
        }),
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error).slice(0, 200))
      const text = (json.choices?.[0]?.message?.content || '').trim()
      if (!text) throw new Error('empty transcription')
      return { text, model: modelId }
    } catch (err) {
      signal?.throwIfAborted()
      lastErr = err
      console.log(`[voice] ${modelId} transcription failed (${err.message}) — trying next`)
    }
  }

  const err = new Error(`transcription failed: ${lastErr?.message || 'no models available'}`)
  err.status = 502
  throw err
}

function formatFromMime(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.includes('wav')) return 'wav'
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('mp4')) return 'mp4'
  return null
}

function resolveOpenRouterCreds(config) {
  for (const p of Object.values(config.providers || {})) {
    const type = p.type || 'openai-compat'
    if (type === 'openrouter') {
      return { baseUrl: 'https://openrouter.ai/api/v1', apiKey: p.api_key || process.env.OPENROUTER_API_KEY }
    }
    if (type === 'openai-compat' && String(p.base_url || '').includes('openrouter.ai') && p.api_key) {
      return { baseUrl: p.base_url.replace(/\/$/, ''), apiKey: p.api_key }
    }
  }
  return { baseUrl: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY || null }
}
