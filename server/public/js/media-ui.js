// media-ui.js — file attach/drag/paste upload UX for the chat input.
//
// Loaded after chat.js as a plain <script type="module">. chat.js never
// reaches into this file; it only calls the two methods exposed on
// window.cheesoidMedia (see the "Harness add-on integration surface" note
// at the bottom of chat.js):
//   - takePending()              called inside send() to gather staged
//                                 attachments and clear the pending tray
//   - attachToMessage(el, atts)  called when rendering a message that
//                                 carries attachments
//
// Everything here is defensive: missing DOM elements or failed fetches
// degrade to a no-op + toast rather than throwing, since chat.js and the
// rest of the page must keep working even if this module can't fully wire
// itself up.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // mirrors server/lib/media.js MEDIA_MAX_BYTES

// Attachments that have finished uploading and are waiting to go out with
// the next sent message. Populated by onUploadDone(), drained by takePending().
let pending = []

// The pending-tray DOM node (strip of chips above the input row). May stay
// null if #input-area isn't found — upload/pending tracking still works,
// there's just nothing to render into.
let tray = null

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
    console.error('[media-ui] toast failed:', err)
  }
}

// -------------------------------------------------------------- helpers --

function escapeHtml(str) {
  try {
    if (window.cheesoidChat && typeof window.cheesoidChat.escapeHtml === 'function') {
      return window.cheesoidChat.escapeHtml(str)
    }
  } catch {}
  const div = document.createElement('div')
  div.textContent = str == null ? '' : String(str)
  return div.innerHTML
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function updateTrayVisibility() {
  if (!tray) return
  tray.classList.toggle('hidden', tray.children.length === 0)
}

// ------------------------------------------------------------ chip UI ---

function createSpinnerChip(name) {
  const chip = document.createElement('div')
  chip.className = 'media-chip media-chip-pending'

  const spinner = document.createElement('span')
  spinner.className = 'media-chip-spinner'
  chip.appendChild(spinner)

  const label = document.createElement('span')
  label.className = 'media-chip-name'
  label.textContent = name || 'file'
  label.title = name || 'file'
  chip.appendChild(label)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'media-chip-remove'
  cancelBtn.title = 'Cancel upload'
  cancelBtn.innerHTML = '<span class="hf-icon">close</span>'
  cancelBtn.addEventListener('click', () => {
    try { chip._controller?.abort() } catch {}
    chip.remove()
    updateTrayVisibility()
  })
  chip.appendChild(cancelBtn)

  return chip
}

function createDoneChip(media) {
  const chip = document.createElement('div')
  chip.className = 'media-chip media-chip-done'
  chip.dataset.mediaId = media.id

  const mime = typeof media.mime === 'string' ? media.mime : ''
  if (mime.startsWith('image/')) {
    const thumb = document.createElement('img')
    thumb.className = 'media-chip-thumb'
    thumb.src = `/api/media/${encodeURIComponent(media.id)}`
    thumb.alt = media.name || 'image'
    thumb.loading = 'lazy'
    chip.appendChild(thumb)
  } else {
    const icon = document.createElement('span')
    icon.className = 'hf-icon media-chip-icon'
    icon.textContent = mime.startsWith('audio/') ? 'music_note' : 'description'
    chip.appendChild(icon)
  }

  const label = document.createElement('span')
  label.className = 'media-chip-name'
  label.textContent = media.name || 'file'
  label.title = media.name || 'file'
  chip.appendChild(label)

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.className = 'media-chip-remove'
  removeBtn.title = 'Remove'
  removeBtn.innerHTML = '<span class="hf-icon">close</span>'
  removeBtn.addEventListener('click', () => {
    const idx = pending.findIndex((m) => m.id === media.id)
    if (idx !== -1) pending.splice(idx, 1)
    chip.remove()
    updateTrayVisibility()
  })
  chip.appendChild(removeBtn)

  return chip
}

function onUploadDone(spinnerChip, media) {
  pending.push(media)
  const doneChip = createDoneChip(media)
  if (spinnerChip.parentNode) {
    spinnerChip.replaceWith(doneChip)
  } else if (tray) {
    // The tray was cleared by takePending() while this upload was still in
    // flight. The attachment still belongs to the *next* message — show it
    // fresh rather than dropping it silently.
    tray.appendChild(doneChip)
  }
  updateTrayVisibility()
}

// ------------------------------------------------------------- upload ---

async function performUpload(file, mime) {
  const chip = createSpinnerChip(file.name)
  if (tray) tray.appendChild(chip)
  updateTrayVisibility()

  const controller = new AbortController()
  chip._controller = controller

  try {
    const res = await fetch('/api/media', {
      method: 'POST',
      headers: {
        'Content-Type': mime,
        'X-Media-Name': encodeURIComponent(file.name),
      },
      body: file,
      signal: controller.signal,
    })
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok || !data || data.error || !data.media) {
      throw new Error((data && data.error) || `upload failed (${res.status})`)
    }
    onUploadDone(chip, data.media)
  } catch (err) {
    if (err && err.name === 'AbortError') {
      chip.remove()
      updateTrayVisibility()
      return
    }
    chip.remove()
    updateTrayVisibility()
    showToast(`Upload failed: "${file.name}"${err && err.message ? ' — ' + err.message : ''}`)
  }
}

function uploadFile(file) {
  try {
    if (!file) return
    // file.type is '' for anything the browser can't sniff. Rather than
    // send it as application/octet-stream (which the server's ALLOWED_MIME
    // gate rejects anyway), skip it client-side with an explanatory toast.
    const mime = file.type || 'application/octet-stream'
    if (mime === 'application/octet-stream') {
      showToast(`Skipped "${file.name}" — unknown file type`)
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast(`Skipped "${file.name}" — over 20MB`)
      return
    }
    performUpload(file, mime)
  } catch (err) {
    console.error('[media-ui] uploadFile failed:', err)
  }
}

// ------------------------------------------------------- public surface --

function takePending() {
  const result = pending.slice()
  pending = []
  if (tray) {
    tray.querySelectorAll('.media-chip-done').forEach((el) => el.remove())
    updateTrayVisibility()
  }
  return result
}

function attachToMessage(msgEl, attachments) {
  try {
    if (!msgEl || !Array.isArray(attachments) || !attachments.length) return
    const container = document.createElement('div')
    container.className = 'message-attachments'

    for (const att of attachments) {
      if (!att || !att.id) continue
      const mime = typeof att.mime === 'string' ? att.mime : ''
      const url = `/api/media/${encodeURIComponent(att.id)}`

      if (mime.startsWith('image/')) {
        const link = document.createElement('a')
        link.className = 'attachment-image-link'
        link.href = url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        const img = document.createElement('img')
        img.className = 'attachment-image'
        img.src = url
        img.loading = 'lazy'
        img.alt = att.name || 'attachment'
        link.appendChild(img)
        container.appendChild(link)
      } else if (mime.startsWith('audio/')) {
        const audio = document.createElement('audio')
        audio.className = 'attachment-audio'
        audio.controls = true
        audio.src = url
        container.appendChild(audio)
      } else {
        const link = document.createElement('a')
        link.className = 'attachment-file-chip'
        link.href = url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        if (att.name) link.download = att.name
        const nameHtml = escapeHtml(att.name || 'file')
        const sizeHtml = Number.isFinite(att.bytes)
          ? `<span class="attachment-file-size">${escapeHtml(formatBytes(att.bytes))}</span>`
          : ''
        link.innerHTML = `<span class="hf-icon">description</span><span class="attachment-file-name">${nameHtml}</span>${sizeHtml}`
        container.appendChild(link)
      }
    }

    if (container.children.length) msgEl.appendChild(container)
  } catch (err) {
    console.error('[media-ui] attachToMessage failed:', err)
  }
}

window.cheesoidMedia = { takePending, attachToMessage }

// -------------------------------------------------------------- wiring --

function init() {
  const sendBtn = document.getElementById('send-btn')
  const inputEl = document.getElementById('input')
  const messagesEl = document.getElementById('messages')
  const inputArea = document.getElementById('input-area')

  // Attach button + hidden file input, inserted right before Send.
  if (sendBtn && sendBtn.parentNode) {
    const attachBtn = document.createElement('button')
    attachBtn.type = 'button'
    attachBtn.id = 'media-attach-btn'
    attachBtn.className = 'hf-btn hf-btn-ghost'
    attachBtn.title = 'Attach files'
    attachBtn.innerHTML = '<span class="hf-icon">attach_file</span>'
    sendBtn.parentNode.insertBefore(attachBtn, sendBtn)

    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.id = 'media-file-input'
    fileInput.multiple = true
    fileInput.hidden = true
    sendBtn.parentNode.insertBefore(fileInput, sendBtn)

    attachBtn.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || [])
      fileInput.value = ''
      files.forEach(uploadFile)
    })
  }

  // Pending tray — a horizontal strip directly above the input row.
  if (inputArea && inputArea.parentNode) {
    tray = document.createElement('div')
    tray.id = 'media-pending-tray'
    tray.className = 'media-pending-tray hidden'
    inputArea.parentNode.insertBefore(tray, inputArea)
  }

  // Drag-and-drop onto the message list. dragDepth tracks nested
  // dragenter/dragleave pairs (children of #messages fire their own) so the
  // highlight doesn't flicker while the pointer crosses child elements.
  if (messagesEl) {
    let dragDepth = 0
    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))
    messagesEl.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
    messagesEl.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth++
      messagesEl.classList.add('media-drag-over')
    })
    messagesEl.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) messagesEl.classList.remove('media-drag-over')
    })
    messagesEl.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth = 0
      messagesEl.classList.remove('media-drag-over')
      const files = Array.from(e.dataTransfer?.files || [])
      files.forEach(uploadFile)
    })
  }

  // Paste images from the clipboard directly into the input.
  if (inputEl) {
    inputEl.addEventListener('paste', (e) => {
      try {
        const items = e.clipboardData?.items
        if (!items) return
        for (const item of items) {
          if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) uploadFile(file)
          }
        }
      } catch (err) {
        console.error('[media-ui] paste handling failed:', err)
      }
    })
  }
}

try {
  init()
} catch (err) {
  console.error('[media-ui] init failed:', err)
}
