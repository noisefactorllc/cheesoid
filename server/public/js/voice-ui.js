// voice-ui.js — mic input (speech-to-text) and TTS output for the chat UI.
//
// Loaded after chat.js (and, typically, media-ui.js) as a plain
// <script type="module">. Only activates if GET /api/harness reports
// voice:true; otherwise it renders nothing. Everything is defensive:
// missing DOM, missing browser APIs, and failed fetches degrade to a
// toast + disabled control rather than throwing.
//
// Integration surface (see the "Harness add-on integration surface" note
// at the bottom of chat.js):
//   - window.cheesoidChat.send(text)   used to auto-send in hands-free mode
//   - window.cheesoidHooks.onEvent     chained (not clobbered) to hear
//                                       assistant_message events for TTS
//   - window.cheesoidVoice.handsFree   read-only getter, mirrors internal
//                                       state for other add-ons to inspect

const MAX_RECORD_MS = 60000
const TARGET_SAMPLE_RATE = 16000
const MAX_TTS_CHARS = 800
const LONG_PRESS_MS = 600
const DBLCLICK_WINDOW_MS = 350

let micBtn = null
let ttsBtn = null

// Recording state
let isRecording = false
let handsFree = false
let audioCtx = null
let mediaStream = null
let sourceNode = null
let processorNode = null
let silentGain = null
let capturedChunks = [] // Float32Array chunks at audioCtx.sampleRate, mono
let autoStopTimer = null

// Mic click / dblclick / long-press disambiguation
let clickTimer = null
let longPressTimer = null
let longPressTriggered = false

// TTS state
let ttsEnabled = false
try { ttsEnabled = localStorage.getItem('cheesoid-tts') === '1' } catch {}

// ---------------------------------------------------------------- toast --

function showToast(message) {
  try {
    let toastTray = document.getElementById('cheesoid-toast-tray')
    if (!toastTray) {
      toastTray = document.createElement('div')
      toastTray.id = 'cheesoid-toast-tray'
      toastTray.className = 'cheesoid-toast-tray'
      document.body.appendChild(toastTray)
    }
    const el = document.createElement('div')
    el.className = 'cheesoid-toast'
    el.textContent = message
    toastTray.appendChild(el)
    requestAnimationFrame(() => el.classList.add('show'))
    setTimeout(() => {
      el.classList.remove('show')
      setTimeout(() => el.remove(), 300)
    }, 3500)
  } catch (err) {
    console.error('[voice-ui] toast failed:', err)
  }
}

// ---------------------------------------------------------- WAV encoding --

function concatFloat32(chunks) {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

// Simple linear-interpolation resampler — good enough for speech going to
// a transcription API, no need to pull in a real DSP library for this.
function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate || samples.length === 0) return samples
  const ratio = fromRate / toRate
  const newLength = Math.max(1, Math.round(samples.length / ratio))
  const result = new Float32Array(newLength)
  for (let i = 0; i < newLength; i++) {
    const srcPos = i * ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, samples.length - 1)
    const frac = srcPos - i0
    const s0 = samples[i0] ?? 0
    const s1 = samples[i1] ?? 0
    result[i] = s0 + (s1 - s0) * frac
  }
  return result
}

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

// Standard 44-byte RIFF/WAVE header + 16-bit PCM mono data. Layout:
//   0  'RIFF'            4  ChunkSize = 36 + dataLen
//   8  'WAVE'
//   12 'fmt '            16 Subchunk1Size = 16 (PCM)
//   20 AudioFormat = 1   22 NumChannels = 1
//   24 SampleRate        28 ByteRate = SampleRate * BlockAlign
//   32 BlockAlign = 2    34 BitsPerSample = 16
//   36 'data'            40 Subchunk2Size = dataLen
//   44 ... PCM16LE samples
function encodeWavPCM16(samples, sampleRate) {
  const numChannels = 1
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataLen = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buffer)

  writeAsciiString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeAsciiString(view, 8, 'WAVE')
  writeAsciiString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAsciiString(view, 36, 'data')
  view.setUint32(40, dataLen, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return buffer
}

// ------------------------------------------------------------- recording --

function updateMicVisual() {
  if (!micBtn) return
  micBtn.classList.toggle('voice-recording', isRecording)
  micBtn.classList.toggle('voice-hands-free', handsFree)
  micBtn.setAttribute('aria-pressed', String(isRecording))
  const icon = micBtn.querySelector('.hf-icon')
  if (icon) icon.textContent = isRecording ? 'stop' : 'mic'
  micBtn.title = isRecording
    ? 'Stop recording and send'
    : handsFree
      ? 'Hands-free listening — click to stop'
      : 'Record a voice message (long-press or double-click for hands-free)'
}

function cleanupAudioGraph() {
  try { if (processorNode) processorNode.onaudioprocess = null } catch {}
  try { processorNode?.disconnect() } catch {}
  try { silentGain?.disconnect() } catch {}
  try { sourceNode?.disconnect() } catch {}
  try { mediaStream?.getTracks().forEach((t) => t.stop()) } catch {}
  try { audioCtx?.close() } catch {}
  processorNode = null
  silentGain = null
  sourceNode = null
  mediaStream = null
  audioCtx = null
}

async function startRecording() {
  if (isRecording) return
  try {
    if (typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking) {
      showToast('Wait for the voice reply to finish')
      return
    }
  } catch {}

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Microphone not available in this browser')
    if (micBtn) micBtn.disabled = true
    return
  }

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    showToast('Microphone permission denied')
    if (micBtn) micBtn.disabled = true
    return
  }

  try {
    mediaStream = stream
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    sourceNode = audioCtx.createMediaStreamSource(mediaStream)
    // ScriptProcessorNode is deprecated but is the only capture path
    // available without shipping a separate AudioWorklet module file.
    processorNode = audioCtx.createScriptProcessor(4096, 1, 1)
    // Route through a zero-gain node rather than straight to destination
    // so capture fires without the mic being audible (feedback risk).
    silentGain = audioCtx.createGain()
    silentGain.gain.value = 0
    capturedChunks = []

    processorNode.onaudioprocess = (e) => {
      try {
        const buf = e.inputBuffer
        const nCh = buf.numberOfChannels
        const len = buf.length
        const mono = new Float32Array(len)
        if (nCh <= 1) {
          mono.set(buf.getChannelData(0))
        } else {
          for (let ch = 0; ch < nCh; ch++) {
            const data = buf.getChannelData(ch)
            for (let i = 0; i < len; i++) mono[i] += data[i] / nCh
          }
        }
        capturedChunks.push(mono)
      } catch (err) {
        console.error('[voice-ui] capture chunk failed:', err)
      }
    }

    sourceNode.connect(processorNode)
    processorNode.connect(silentGain)
    silentGain.connect(audioCtx.destination)

    isRecording = true
    updateMicVisual()

    autoStopTimer = setTimeout(() => {
      // 60s safety cutoff. Not a "click to stop" — leaves hands-free
      // state alone so the normal reply/TTS/restart loop continues.
      if (isRecording) stopRecording(true)
    }, MAX_RECORD_MS)
  } catch (err) {
    showToast('Could not start recording')
    cleanupAudioGraph()
  }
}

function stopRecording(send) {
  if (!isRecording) return
  isRecording = false
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null }
  updateMicVisual()

  const nativeRate = audioCtx ? audioCtx.sampleRate : 48000
  const chunks = capturedChunks
  capturedChunks = []
  cleanupAudioGraph()

  if (!send) return
  const mono = concatFloat32(chunks)
  if (mono.length < nativeRate * 0.2) {
    showToast('Recording too short')
    return
  }
  const resampled = resampleLinear(mono, nativeRate, TARGET_SAMPLE_RATE)
  const wavBuffer = encodeWavPCM16(resampled, TARGET_SAMPLE_RATE)
  sendVoice(wavBuffer)
}

async function sendVoice(wavBuffer) {
  if (micBtn) { micBtn.disabled = true; micBtn.classList.add('voice-busy') }
  try {
    const res = await fetch('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wavBuffer,
    })
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok || !data || data.error) {
      throw new Error((data && data.error) || `transcription failed (${res.status})`)
    }
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    if (!text) {
      showToast('No speech detected')
      return
    }
    if (handsFree) {
      window.cheesoidChat?.send?.(text)
    } else {
      const inputEl = document.getElementById('input')
      if (inputEl) {
        inputEl.value = text
        inputEl.dispatchEvent(new Event('input', { bubbles: true })) // let chat.js's auto-resize react
        inputEl.focus()
      }
    }
  } catch (err) {
    showToast(`Voice transcription failed${err && err.message ? ': ' + err.message : ''}`)
  } finally {
    if (micBtn) { micBtn.disabled = false; micBtn.classList.remove('voice-busy') }
  }
}

function onMicClick() {
  if (isRecording) {
    handsFree = false // spec: stopping recording via click always exits hands-free
    stopRecording(true)
  } else {
    startRecording()
  }
}

function toggleHandsFree() {
  handsFree = !handsFree
  updateMicVisual()
  showToast(handsFree ? 'Hands-free mode on' : 'Hands-free mode off')
  if (handsFree) {
    let speaking = false
    try { speaking = typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking } catch {}
    if (!isRecording && !speaking) startRecording()
  } else if (isRecording) {
    stopRecording(true)
  }
}

// ------------------------------------------------------------------ TTS --

// Crude markdown stripping for speech: fenced/inline code removed, links
// collapse to their visible text, remaining markdown punctuation dropped.
function stripMarkdown(text) {
  let t = String(text == null ? '' : text)
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/`[^`]*`/g, ' ')
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/[*_#`>]/g, '')
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

function onUtteranceEnd() {
  try {
    if (handsFree && !isRecording && !speechSynthesis.speaking) startRecording()
  } catch (err) {
    console.error('[voice-ui] hands-free restart failed:', err)
  }
}

function speakText(text) {
  try {
    if (!ttsEnabled) return
    if (!('speechSynthesis' in window)) return
    let clean = stripMarkdown(text)
    if (!clean) return
    if (clean.length > MAX_TTS_CHARS) clean = clean.slice(0, MAX_TTS_CHARS) + '…truncated'
    const utter = new SpeechSynthesisUtterance(clean)
    utter.onend = onUtteranceEnd
    utter.onerror = onUtteranceEnd
    // Queue: never cancel in-flight/queued utterances here — multiple
    // assistant_message events just queue up and speak in order.
    speechSynthesis.speak(utter)
  } catch (err) {
    console.error('[voice-ui] speak failed:', err)
  }
}

function registerTtsHook() {
  const prev = window.cheesoidHooks?.onEvent
  window.cheesoidHooks = {
    ...(window.cheesoidHooks || {}),
    onEvent: (ev) => {
      try { prev?.(ev) } catch {}
      try {
        if (ev && ev.type === 'assistant_message' && typeof ev.text === 'string') {
          speakText(ev.text)
        }
      } catch (err) {
        console.error('[voice-ui] onEvent hook failed:', err)
      }
    },
  }
}

function updateTtsVisual() {
  if (!ttsBtn) return
  ttsBtn.classList.toggle('active', ttsEnabled)
  ttsBtn.setAttribute('aria-pressed', String(ttsEnabled))
  ttsBtn.title = ttsEnabled ? 'Voice replies on — click to mute' : 'Voice replies off — click to enable'
  const icon = ttsBtn.querySelector('.hf-icon')
  if (icon) icon.textContent = ttsEnabled ? 'volume_up' : 'volume_off'
}

// -------------------------------------------------------------- wiring --

function wireMicInteractions() {
  micBtn.addEventListener('pointerdown', () => {
    longPressTriggered = false
    longPressTimer = setTimeout(() => {
      longPressTriggered = true
      longPressTimer = null
      toggleHandsFree()
    }, LONG_PRESS_MS)
  })
  const cancelLongPress = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
  }
  micBtn.addEventListener('pointerup', cancelLongPress)
  micBtn.addEventListener('pointerleave', cancelLongPress)
  micBtn.addEventListener('pointercancel', cancelLongPress)

  // Single click starts/stops recording; double-click toggles hands-free.
  // The single-click action is delayed so a second click can cancel it
  // before it fires (standard click/dblclick disambiguation).
  micBtn.addEventListener('click', () => {
    if (longPressTriggered) { longPressTriggered = false; return }
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return }
    clickTimer = setTimeout(() => { clickTimer = null; onMicClick() }, DBLCLICK_WINDOW_MS)
  })
  micBtn.addEventListener('dblclick', (e) => {
    e.preventDefault()
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
    toggleHandsFree()
  })
}

function initVoiceUI() {
  const sendBtn = document.getElementById('send-btn')
  if (!sendBtn || !sendBtn.parentNode) return

  micBtn = document.createElement('button')
  micBtn.type = 'button'
  micBtn.id = 'voice-mic-btn'
  micBtn.className = 'hf-btn hf-btn-ghost'
  micBtn.setAttribute('aria-pressed', 'false')
  micBtn.innerHTML = '<span class="hf-icon">mic</span>'

  const anchor = document.getElementById('media-attach-btn')
  if (anchor && anchor.parentNode === sendBtn.parentNode) {
    anchor.insertAdjacentElement('afterend', micBtn)
  } else {
    sendBtn.parentNode.insertBefore(micBtn, sendBtn)
  }
  updateMicVisual()

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    micBtn.disabled = true
    micBtn.title = 'Microphone not available in this browser'
  } else {
    wireMicInteractions()
  }

  ttsBtn = document.createElement('button')
  ttsBtn.type = 'button'
  ttsBtn.id = 'voice-tts-btn'
  ttsBtn.className = 'hf-btn hf-btn-ghost'
  ttsBtn.innerHTML = '<span class="hf-icon">volume_off</span>'
  micBtn.insertAdjacentElement('afterend', ttsBtn)
  updateTtsVisual()

  if (!('speechSynthesis' in window)) {
    ttsBtn.disabled = true
    ttsBtn.title = 'Voice replies not supported in this browser'
  } else {
    ttsBtn.addEventListener('click', () => {
      ttsEnabled = !ttsEnabled
      try { localStorage.setItem('cheesoid-tts', ttsEnabled ? '1' : '0') } catch {}
      updateTtsVisual()
    })
    registerTtsHook()
  }
}

window.cheesoidVoice = {
  get handsFree() { return handsFree },
}

;(async function bootstrap() {
  try {
    const res = await fetch('/api/harness')
    if (!res.ok) return
    const data = await res.json()
    if (!data || data.voice !== true) return
    initVoiceUI()
  } catch (err) {
    // Harness check failed — render nothing, same as voice:false.
  }
})()
