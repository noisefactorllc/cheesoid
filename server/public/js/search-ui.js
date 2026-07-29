// History search — user-facing search over the agent's full chat history
// (GET /api/chat/search). Each hit has one action: reply — arming the
// composer against that message so the reply threads off it, with the
// referenced content carried server-side. Open with 🔍 or Cmd/Ctrl-K.

// Fail-CLOSED: own the escaper outright rather than borrowing chat.js's copy
// via window.cheesoidChat, whose optional-chaining fallback (`?? String(s)`)
// silently returned UNescaped text whenever chat.js had not finished — every
// interpolation below (names, rooms, query, ids) is an injection point.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

let overlay = null
let inputEl = null
let resultsEl = null
let debounceTimer = null
let lastQuery = ''
let requestSeq = 0

function close() {
  overlay?.classList.add('hidden')
}

function open() {
  ensureOverlay()
  overlay.classList.remove('hidden')
  inputEl.focus()
  inputEl.select()
}

function highlight(text, query) {
  const safe = esc(text)
  if (!query) return safe
  const safeQuery = esc(query)
  const rx = new RegExp(safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  return safe.replace(rx, (m) => `<mark>${m}</mark>`)
}

function timeOf(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
  } catch { return '' }
}

async function runSearch(query) {
  const seq = ++requestSeq
  if (query.trim().length < 2) {
    resultsEl.innerHTML = '<div class="search-hint">Type at least two characters to search the full history.</div>'
    return
  }
  try {
    const res = await fetch(`/api/chat/search?q=${encodeURIComponent(query)}&limit=40`)
    const data = await res.json()
    if (seq !== requestSeq) return // a newer query superseded this response
    renderResults(data.results || [], query)
  } catch (err) {
    if (seq !== requestSeq) return
    resultsEl.innerHTML = `<div class="search-hint">Search failed: ${esc(err.message)}</div>`
  }
}

function renderResults(results, query) {
  if (!results.length) {
    resultsEl.innerHTML = `<div class="search-hint">No matches for “${esc(query)}”.</div>`
    return
  }
  resultsEl.innerHTML = ''
  for (const r of results) {
    const el = document.createElement('div')
    el.className = 'search-hit' + (r.type === 'assistant_message' ? ' search-hit-agent' : '')
    const who = r.name || 'agent'
    const tags = [
      r.room ? `<span class="search-hit-tag">${esc(r.room)}</span>` : '',
      r.dm ? '<span class="search-hit-tag">DM</span>' : '',
      r.type === 'idle_thought' ? '<span class="search-hit-tag">thought</span>' : '',
      r.threadId ? `<span class="search-hit-tag search-hit-thread-tag">thread ${esc(r.threadId)}</span>` : '',
    ].filter(Boolean).join('')
    el.innerHTML =
      `<div class="search-hit-meta"><strong>${esc(who)}</strong>${tags}<span class="search-hit-time">${esc(timeOf(r.timestamp))}</span></div>` +
      `<div class="search-hit-text">${highlight(r.text, query)}</div>` +
      (r.id
        ? `<div class="search-hit-actions"><a href="#" class="search-reply-link" data-id="${esc(r.id)}" data-name="${esc(who)}">reply</a></div>`
        : '')
    el.dataset.snippet = (r.text || '').slice(0, 100)
    resultsEl.appendChild(el)
  }
}

function ensureOverlay() {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.className = 'search-overlay hidden'
  overlay.innerHTML = `
    <div class="search-panel">
      <div class="search-panel-header">
        <input type="text" class="hf-text search-input" placeholder="Search full chat history…" autocomplete="off">
        <button type="button" class="toolbar-btn search-close" title="Close">✕</button>
      </div>
      <div class="search-results hf-scrollbar"></div>
    </div>`
  document.body.appendChild(overlay)

  inputEl = overlay.querySelector('.search-input')
  resultsEl = overlay.querySelector('.search-results')

  inputEl.addEventListener('input', () => {
    const q = inputEl.value
    if (q === lastQuery) return
    lastQuery = q
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => runSearch(q), 250)
  })

  overlay.querySelector('.search-close').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

  // One action per hit: reply. Arms the composer against the hit and
  // closes; the server injects the referenced message's content with the
  // reply, so the agent always has the context.
  resultsEl.addEventListener('click', (e) => {
    const link = e.target.closest('.search-reply-link')
    if (!link) return
    e.preventDefault()
    const hit = link.closest('.search-hit')
    window.cheesoidChat?.startReply?.(link.dataset.id, link.dataset.name, hit?.dataset.snippet || '')
    close()
  })

}

// Cmd/Ctrl-K works before the button is ever clicked — registered at module
// scope, not inside ensureOverlay().
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (!overlay || overlay.classList.contains('hidden')) open()
    else close()
  } else if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) {
    close()
  }
})

// Inject the 🔍 button into the input row, alongside attach/mic.
function injectButton() {
  const sendBtn = document.getElementById('send-btn')
  if (!sendBtn || document.getElementById('history-search-btn')) return
  const btn = document.createElement('button')
  btn.id = 'history-search-btn'
  btn.className = 'hf-btn hf-btn-ghost'
  btn.title = 'Search history (⌘K)'
  btn.textContent = '🔍'
  btn.addEventListener('click', open)
  sendBtn.parentNode.insertBefore(btn, sendBtn)
}

injectButton()
// The input row exists at load, but retry once shortly after in case another
// add-on module reflows the row.
setTimeout(injectButton, 1000)
