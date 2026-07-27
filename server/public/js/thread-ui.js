// Thread viewer — full reply-chain overlay backed by GET /api/chat/thread.
// Currently DORMANT by operator direction: the per-message 🧵 button and the
// search-hit thread action were both removed, so nothing opens this today.
// It stays wired (window.cheesoidThreads.show) as the ready-made surface if
// thread views come back. Add-on module: integrates only through DOM
// delegation and cheesoidChat.

const esc = (s) => window.cheesoidChat?.escapeHtml?.(s ?? '') ?? String(s ?? '')
const md = (s) => window.cheesoidChat?.renderMarkdown?.(s ?? '') ?? esc(s)

let overlay = null

function closeOverlay() {
  overlay?.remove()
  overlay = null
  document.removeEventListener('keydown', onKey)
}

function onKey(e) {
  if (e.key === 'Escape') closeOverlay()
}

function timeOf(ts) {
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return '' }
}

async function showThread(msgId) {
  let data
  try {
    const res = await fetch(`/api/chat/thread?id=${encodeURIComponent(msgId)}`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      data = { error: err.error || `thread lookup failed (${res.status})` }
    } else {
      data = await res.json()
    }
  } catch (err) {
    data = { error: err.message }
  }

  closeOverlay()
  overlay = document.createElement('div')
  overlay.className = 'thread-overlay'

  const panel = document.createElement('div')
  panel.className = 'thread-panel'

  const header = document.createElement('div')
  header.className = 'thread-panel-header'
  header.innerHTML = `<span>Thread ${esc(data.threadId || msgId)}</span>`
  const close = document.createElement('button')
  close.className = 'toolbar-btn'
  close.textContent = '✕'
  close.addEventListener('click', closeOverlay)
  header.appendChild(close)
  panel.appendChild(header)

  const body = document.createElement('div')
  body.className = 'thread-panel-body'
  if (data.error) {
    body.innerHTML = `<div class="thread-empty">${esc(data.error)}</div>`
  } else if (!data.messages || data.messages.length === 0) {
    body.innerHTML = '<div class="thread-empty">This message has no reply thread yet.</div>'
  } else {
    if (data.truncated) {
      const note = document.createElement('div')
      note.className = 'thread-empty'
      note.textContent = '(earliest messages truncated)'
      body.appendChild(note)
    }
    for (const m of data.messages) {
      const el = document.createElement('div')
      el.className = 'thread-entry' + (m.type === 'assistant_message' ? ' thread-entry-agent' : '')
      const who = m.name || (m.type === 'assistant_message' ? 'agent' : 'unknown')
      const replyBtn = m.id
        ? `<button type="button" class="toolbar-btn thread-reply-btn" data-id="${esc(m.id)}" data-name="${esc(who)}" title="Reply to this message — continues this thread">↩ reply</button>`
        : ''
      el.innerHTML =
        `<div class="thread-entry-meta"><strong>${esc(who)}</strong>` +
        `<span class="thread-entry-id">[${esc(m.id || '')}]</span>` +
        (m.replyTo ? `<span class="thread-entry-reply">↩ ${esc(m.replyTo)}</span>` : '') +
        `<span class="thread-entry-time">${esc(timeOf(m.timestamp))}</span>${replyBtn}</div>` +
        `<div class="thread-entry-text">${md(m.text || '')}</div>`
      el.dataset.snippet = (m.text || '').slice(0, 100)
      body.appendChild(el)
    }
  }
  // Replying from inside the thread view: arm the composer against the
  // chosen message and close — the reply carries full server-side context.
  body.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.thread-reply-btn')
    if (!btn) return
    const entry = btn.closest('.thread-entry')
    window.cheesoidChat?.startReply?.(btn.dataset.id, btn.dataset.name, entry?.dataset.snippet || '')
    closeOverlay()
  })
  panel.appendChild(body)
  overlay.appendChild(panel)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOverlay() })
  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)
}

document.getElementById('messages')?.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.thread-btn')
  if (btn?.dataset.msgId) {
    e.preventDefault()
    showThread(btn.dataset.msgId)
  }
})

// Other add-on modules (search-ui.js) open threads through this.
window.cheesoidThreads = { show: showThread }
