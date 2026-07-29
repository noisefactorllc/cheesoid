import { renderSafeMarkdown } from './safe-markdown.js'

// harness-panels.js — collapsible harness sidebar panels + peer approval
// banner. Loaded as a module AFTER chat.js. Builds only on the documented
// integration surface (window.cheesoidChat, window.cheesoidHooks) and
// same-origin JSON endpoints under /api — never reaches into chat.js
// internals, and chat.js never depends on this file.
//
// Sections: Tasks, Schedules, Peers, Secrets, Wiki. Each is collapsible;
// data is fetched on first expand and lightly polled (15s) only while
// expanded. A fixed banner surfaces inbound peer join requests as they
// arrive over the existing SSE event stream.

const POLL_MS = 15000

// Real, fail-CLOSED rendering helpers. This module owns a proper 5-character
// HTML escaper and imports the one sanitized-markdown boundary directly,
// rather than borrowing them from window.cheesoidChat during init(). The old
// borrow defaulted to identity functions and only upgraded `if (window
// .cheesoidChat)`, so any load order where chat.js had not finished turned
// every sink below into an injection point (fail-open).
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
const renderMarkdown = renderSafeMarkdown

// ---------------------------------------------------------------------------
// fetch helpers — every network call funnels through these three. None of
// them ever throw synchronously; failures surface as a rejected promise with
// a readable .message, which every call site below catches.
// ---------------------------------------------------------------------------

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  let data = null
  try { data = await res.json() } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data || {}
}

async function sendJSON(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  let data = null
  try { data = await res.json() } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data || {}
}

async function postJSON(url, body) { return sendJSON('POST', url, body) }

async function deleteJSON(url) {
  const res = await fetch(url, { method: 'DELETE' })
  let data = null
  try { data = await res.json() } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data || {}
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function pad2(n) { return String(n).padStart(2, '0') }

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function formatHM(hour, minute) {
  const h = Number(hour)
  const m = Number(minute)
  if (Number.isNaN(h) || Number.isNaN(m)) return ''
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${pad2(m)} ${ampm}`
}

function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${formatHM(d.getHours(), d.getMinutes())}`
}

// Best-effort humanization of the common 5-field cron shapes this framework
// actually produces (see server/lib/wakeup.js parseCron: minute hour dom
// month dow). Anything past "daily / weekly / hourly / every minute" falls
// back to showing the raw expression rather than guessing.
function describeCron(cron) {
  if (typeof cron !== 'string' || !cron.trim()) return ''
  const trimmed = cron.trim()
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return trimmed
  const [min, hour, dom, month, dow] = parts
  const numMin = /^\d+$/.test(min)
  const numHour = /^\d+$/.test(hour)

  if (trimmed === '* * * * *') return 'every minute'
  if (dom === '*' && month === '*' && dow === '*' && hour === '*' && numMin) {
    return `hourly at :${pad2(Number(min))}`
  }
  if (dom === '*' && month === '*' && dow === '*' && numMin && numHour) {
    return `daily at ${formatHM(hour, min)}`
  }
  if (dom === '*' && month === '*' && /^[0-6]$/.test(dow) && numMin && numHour) {
    return `every ${DOW_NAMES[Number(dow)]} at ${formatHM(hour, min)}`
  }
  return `cron ${trimmed}`
}

function describeSchedule(s) {
  if (s.cron) return describeCron(s.cron)
  if (s.at) return `once at ${formatDateTime(s.at)}`
  return ''
}

// ---------------------------------------------------------------------------
// small DOM utilities
// ---------------------------------------------------------------------------

// Event delegation bound once to a stable container — sections replace only
// their list's innerHTML on refresh, never the container itself, so a
// listener attached here survives every refresh.
function delegate(container, selector, handler) {
  container.addEventListener('click', (e) => {
    const el = e.target.closest(selector)
    if (el && container.contains(el)) handler(el, e)
  })
}

// Collapsible sidebar section scaffold shared by all five panels. Handles
// expand/collapse, refresh-on-open, and polling only while expanded — the
// per-section builders below only need to supply body markup and a
// setRefresh(fn) data loader.
function createSection({ id, title }) {
  const wrap = document.createElement('div')
  wrap.className = 'harness-section'
  wrap.id = `harness-section-${id}`

  const header = document.createElement('button')
  header.type = 'button'
  header.className = 'harness-section-header sidebar-section-label hf-label'
  header.setAttribute('aria-expanded', 'false')

  const titleEl = document.createElement('span')
  titleEl.className = 'harness-section-title'
  titleEl.textContent = title

  const caret = document.createElement('span')
  caret.className = 'harness-section-caret'
  caret.setAttribute('aria-hidden', 'true')
  caret.textContent = '▸' // ▸

  header.appendChild(titleEl)
  header.appendChild(caret)

  const body = document.createElement('div')
  body.className = 'harness-section-body hidden'

  wrap.appendChild(header)
  wrap.appendChild(body)

  let expanded = false
  let pollHandle = null
  let refreshFn = async () => {}
  let inFlight = false

  function stopPolling() {
    if (pollHandle) {
      clearInterval(pollHandle)
      pollHandle = null
    }
  }

  function startPolling() {
    stopPolling()
    pollHandle = setInterval(trigger, POLL_MS)
  }

  // Guards against overlapping fetches (a poll tick landing mid-action, or
  // vice versa) so a slow, stale response can never clobber a fresher one.
  function trigger() {
    if (inFlight) return
    inFlight = true
    Promise.resolve()
      .then(() => refreshFn())
      .catch(() => {})
      .finally(() => { inFlight = false })
  }

  header.addEventListener('click', () => {
    expanded = !expanded
    header.setAttribute('aria-expanded', String(expanded))
    caret.textContent = expanded ? '▾' : '▸' // ▾ : ▸
    body.classList.toggle('hidden', !expanded)
    if (expanded) {
      trigger()
      startPolling()
    } else {
      stopPolling()
    }
  })

  return {
    wrap,
    body,
    setRefresh(fn) { refreshFn = fn },
    // Public trigger for external callers (SSE-driven updates). Only acts
    // while the section is actually visible — matches the "poll only while
    // expanded" rule; a collapsed section gets fresh data the moment it
    // opens anyway.
    refresh() { if (expanded) trigger() },
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_STATUSES = new Set(['running', 'done', 'failed', 'stopped'])

function statusDotHtml(status) {
  const cls = TASK_STATUSES.has(status) ? status : 'stopped'
  return `<span class="harness-status-dot is-${cls}" aria-hidden="true"></span>`
}

function renderTaskRow(t) {
  const id = t.id || ''
  const name = t.name || id || 'task'
  const status = t.status || 'unknown'
  const kind = t.kind || ''

  let timeInfo = ''
  if (status === 'running') {
    timeInfo = t.started ? `started ${formatDateTime(t.started)}` : ''
  } else {
    const when = t.finished || t.started
    const exit = t.exitCode != null ? `exit ${t.exitCode}` : ''
    timeInfo = [exit, when ? formatDateTime(when) : ''].filter(Boolean).join(' · ')
  }
  const sub = [status, kind, timeInfo].filter(Boolean).join(' · ')

  const stopBtn = status === 'running'
    ? `<button type="button" class="harness-icon-btn harness-stop-btn" data-id="${escapeHtml(id)}" title="Stop task">×</button>`
    : ''

  return `<li class="harness-list-item">
    ${statusDotHtml(status)}
    <span class="harness-item-main">
      <span class="harness-item-title">${escapeHtml(name)}</span>
      <span class="harness-item-sub">${escapeHtml(sub)}</span>
    </span>
    <span class="harness-item-actions">${stopBtn}</span>
  </li>`
}

function buildTasksSection() {
  const section = createSection({ id: 'tasks', title: 'Tasks' })
  section.body.innerHTML = '<ul class="harness-list hf-scrollbar"></ul>'
  const listEl = section.body.querySelector('.harness-list')

  delegate(listEl, '.harness-stop-btn', async (btn) => {
    const id = btn.dataset.id
    if (!id) return
    btn.disabled = true
    try {
      await postJSON(`/api/tasks/${encodeURIComponent(id)}/stop`, {})
    } catch (err) {
      console.error('[harness-panels] stop task failed:', err.message)
    }
    section.refresh()
  })

  async function load() {
    try {
      const data = await getJSON('/api/tasks')
      const tasks = Array.isArray(data.tasks) ? data.tasks.slice(0, 8) : []
      listEl.innerHTML = tasks.length
        ? tasks.map(renderTaskRow).join('')
        : '<li class="harness-empty">No tasks</li>'
    } catch {
      listEl.innerHTML = '<li class="harness-empty">(unavailable)</li>'
    }
  }

  section.setRefresh(load)
  return section
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function renderScheduleRow(s) {
  const name = s.name || '(unnamed)'
  const desc = describeSchedule(s)
  const next = s.next ? `next ${formatDateTime(s.next)}` : ''
  const sub = [desc, next].filter(Boolean).join(' · ')
  const canDelete = s.id != null

  const delBtn = canDelete
    ? `<button type="button" class="harness-icon-btn harness-delete-btn" data-id="${escapeHtml(String(s.id))}" title="Delete schedule">×</button>`
    : ''

  return `<li class="harness-list-item">
    <span class="harness-item-main">
      <span class="harness-item-title">${escapeHtml(name)}</span>
      <span class="harness-item-sub">${escapeHtml(sub)}</span>
    </span>
    <span class="harness-item-actions">${delBtn}</span>
  </li>`
}

function buildSchedulesSection() {
  const section = createSection({ id: 'schedules', title: 'Schedules' })
  section.body.innerHTML = '<ul class="harness-list hf-scrollbar"></ul>'
  const listEl = section.body.querySelector('.harness-list')

  delegate(listEl, '.harness-delete-btn', async (btn) => {
    const id = btn.dataset.id
    if (!id) return
    btn.disabled = true
    try {
      await deleteJSON(`/api/schedules/${encodeURIComponent(id)}`)
    } catch (err) {
      console.error('[harness-panels] delete schedule failed:', err.message)
    }
    section.refresh()
  })

  async function load() {
    try {
      const data = await getJSON('/api/schedules')
      const schedules = Array.isArray(data.schedules) ? data.schedules : []
      listEl.innerHTML = schedules.length
        ? schedules.map(renderScheduleRow).join('')
        : '<li class="harness-empty">No schedules</li>'
    } catch {
      listEl.innerHTML = '<li class="harness-empty">(unavailable)</li>'
    }
  }

  section.setRefresh(load)
  return section
}

// ---------------------------------------------------------------------------
// Peers (+ shared state with the approval banner)
// ---------------------------------------------------------------------------

let peersSectionApi = null
let currentBannerPeerName = null

function renderPendingPeerRow(p) {
  const name = p.name || ''
  const sub = p.url || ''
  return `<li class="harness-list-item harness-peer-pending-row">
    <span class="harness-item-main">
      <span class="harness-item-title">${escapeHtml(name)}</span>
      ${sub ? `<span class="harness-item-sub">${escapeHtml(sub)}</span>` : ''}
    </span>
    <span class="harness-item-actions">
      <button type="button" class="hf-btn hf-btn-primary harness-btn-xs harness-approve-btn" data-name="${escapeHtml(name)}">Approve</button>
      <button type="button" class="hf-btn hf-btn-ghost harness-btn-xs harness-deny-btn" data-name="${escapeHtml(name)}">Deny</button>
    </span>
  </li>`
}

function renderOtherPeerRow(p) {
  const name = p.name || ''
  const state = p.state || ''
  const sub = [state, p.url].filter(Boolean).join(' · ')
  const canRevoke = state !== 'config'
  const revokeBtn = canRevoke
    ? `<button type="button" class="harness-icon-btn harness-revoke-btn" data-name="${escapeHtml(name)}" title="Revoke peer">×</button>`
    : ''
  return `<li class="harness-list-item">
    <span class="harness-item-main">
      <span class="harness-item-title">${escapeHtml(name)}</span>
      <span class="harness-item-sub">${escapeHtml(sub)}</span>
    </span>
    <span class="harness-item-actions">${revokeBtn}</span>
  </li>`
}

function buildPeersSection() {
  const section = createSection({ id: 'peers', title: 'Peers' })
  section.body.innerHTML = `
    <ul class="harness-list harness-peers-pending hf-scrollbar hidden"></ul>
    <ul class="harness-list harness-peers-other hf-scrollbar"></ul>
    <div class="harness-peer-join">
      <button type="button" class="harness-join-toggle">Join remote room…</button>
      <form class="harness-inline-form harness-join-form hidden">
        <input type="text" class="harness-input hf-text" data-field="url" placeholder="https://remote-room-url" autocomplete="off">
        <input type="password" class="harness-input hf-text" data-field="secret" placeholder="secret" autocomplete="off">
        <input type="text" class="harness-input hf-text" data-field="name" placeholder="name (optional)" autocomplete="off">
        <button type="submit" class="hf-btn hf-btn-primary harness-btn-xs">Join</button>
        <span class="harness-form-status"></span>
      </form>
    </div>
  `

  const pendingEl = section.body.querySelector('.harness-peers-pending')
  const otherEl = section.body.querySelector('.harness-peers-other')
  const joinToggle = section.body.querySelector('.harness-join-toggle')
  const joinForm = section.body.querySelector('.harness-join-form')
  const joinStatus = joinForm.querySelector('.harness-form-status')

  joinToggle.addEventListener('click', () => {
    joinForm.classList.toggle('hidden')
    joinStatus.textContent = ''
  })

  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const url = joinForm.querySelector('[data-field="url"]').value.trim()
    const secret = joinForm.querySelector('[data-field="secret"]').value
    const name = joinForm.querySelector('[data-field="name"]').value.trim()
    joinStatus.textContent = ''
    if (!url || !secret) {
      joinStatus.textContent = 'url and secret required'
      return
    }
    const submitBtn = joinForm.querySelector('button[type="submit"]')
    submitBtn.disabled = true
    try {
      const result = await postJSON('/api/peer/join-remote', { url, secret, name: name || undefined })
      joinStatus.textContent = result.status === 'connecting' ? 'connecting…' : (result.status || 'requested')
      joinForm.reset()
      joinForm.classList.add('hidden')
      section.refresh()
    } catch (err) {
      joinStatus.textContent = `failed: ${err.message}`
    } finally {
      submitBtn.disabled = false
    }
  })

  async function resolvePeer(btn, action) {
    const name = btn.dataset.name
    if (!name) return
    const row = btn.closest('.harness-list-item')
    const buttons = row ? Array.from(row.querySelectorAll('button')) : [btn]
    buttons.forEach((b) => { b.disabled = true })
    try {
      await postJSON(`/api/peer/${action}`, { name })
      if (currentBannerPeerName === name) hidePeerBanner()
      section.refresh()
    } catch (err) {
      console.error(`[harness-panels] ${action} peer failed:`, err.message)
      buttons.forEach((b) => { b.disabled = false })
    }
  }

  delegate(pendingEl, '.harness-approve-btn', (btn) => resolvePeer(btn, 'approve'))
  delegate(pendingEl, '.harness-deny-btn', (btn) => resolvePeer(btn, 'deny'))

  delegate(otherEl, '.harness-revoke-btn', async (btn) => {
    const name = btn.dataset.name
    if (!name) return
    btn.disabled = true
    try {
      await deleteJSON(`/api/peers/${encodeURIComponent(name)}`)
    } catch (err) {
      console.error('[harness-panels] revoke peer failed:', err.message)
    }
    section.refresh()
  })

  async function load() {
    try {
      const data = await getJSON('/api/peers')
      const peers = Array.isArray(data.peers) ? data.peers : []
      const pending = peers.filter((p) => p.state === 'pending')
      const other = peers.filter((p) => p.state !== 'pending')

      pendingEl.classList.toggle('hidden', pending.length === 0)
      pendingEl.innerHTML = pending.map(renderPendingPeerRow).join('')
      otherEl.innerHTML = other.length
        ? other.map(renderOtherPeerRow).join('')
        : '<li class="harness-empty">No peers</li>'
    } catch {
      pendingEl.classList.add('hidden')
      pendingEl.innerHTML = ''
      otherEl.innerHTML = '<li class="harness-empty">(unavailable)</li>'
    }
  }

  section.setRefresh(load)
  peersSectionApi = section
  return section
}

// ---------------------------------------------------------------------------
// Secrets (write-only — see server/lib/secrets.js; values never come back
// from the API, and this UI never attempts to display one)
// ---------------------------------------------------------------------------

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/

function renderSecretRow(s) {
  const name = s.name || ''
  const updated = s.updated ? formatDateTime(s.updated) : ''
  return `<li class="harness-list-item">
    <span class="harness-item-main">
      <span class="harness-item-title harness-mono">${escapeHtml(name)}</span>
      ${updated ? `<span class="harness-item-sub">updated ${escapeHtml(updated)}</span>` : ''}
    </span>
    <span class="harness-item-actions">
      <button type="button" class="harness-icon-btn harness-secret-delete-btn" data-name="${escapeHtml(name)}" title="Delete secret">×</button>
    </span>
  </li>`
}

function buildSecretsSection() {
  const section = createSection({ id: 'secrets', title: 'Secrets' })
  section.body.innerHTML = `
    <ul class="harness-list harness-secrets-list hf-scrollbar"></ul>
    <form class="harness-inline-form harness-secret-form">
      <input type="text" class="harness-input hf-text harness-secret-name" placeholder="NAME" autocomplete="off" spellcheck="false">
      <input type="password" class="harness-input hf-text harness-secret-value" placeholder="value" autocomplete="new-password">
      <button type="submit" class="hf-btn hf-btn-primary harness-btn-xs">Add secret</button>
      <span class="harness-form-status"></span>
    </form>
  `

  const listEl = section.body.querySelector('.harness-secrets-list')
  const form = section.body.querySelector('.harness-secret-form')
  const nameInput = form.querySelector('.harness-secret-name')
  const valueInput = form.querySelector('.harness-secret-value')
  const statusEl = form.querySelector('.harness-form-status')
  const submitBtn = form.querySelector('button[type="submit"]')

  // Auto-uppercase as you type, preserving caret position rather than
  // letting the browser's default "reassigning .value moves caret to end"
  // behavior fight the user mid-word.
  nameInput.addEventListener('input', () => {
    const upper = nameInput.value.toUpperCase()
    if (upper !== nameInput.value) {
      const pos = nameInput.selectionStart
      nameInput.value = upper
      try { nameInput.setSelectionRange(pos, pos) } catch { /* input not focused/selectable */ }
    }
  })

  delegate(listEl, '.harness-secret-delete-btn', async (btn) => {
    const name = btn.dataset.name
    if (!name) return
    btn.disabled = true
    try {
      await deleteJSON(`/api/secrets/${encodeURIComponent(name)}`)
    } catch (err) {
      console.error('[harness-panels] delete secret failed:', err.message)
    }
    section.refresh()
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    statusEl.textContent = ''
    const name = nameInput.value.trim().toUpperCase()
    const value = valueInput.value

    if (!SECRET_NAME_RE.test(name)) {
      statusEl.textContent = 'name must match [A-Z][A-Z0-9_]*'
      return
    }
    if (!value) {
      statusEl.textContent = 'value required'
      return
    }

    // Clear the value field immediately, before the network round trip —
    // the plaintext value never needs to linger in the DOM a moment longer
    // than it takes to read it into this closure.
    valueInput.value = ''
    submitBtn.disabled = true
    try {
      await postJSON('/api/secrets', { name, value })
      statusEl.textContent = 'stored (write-only)'
      nameInput.value = ''
      section.refresh()
    } catch (err) {
      statusEl.textContent = `failed: ${err.message}`
    } finally {
      submitBtn.disabled = false
    }
  })

  async function load() {
    try {
      const data = await getJSON('/api/secrets')
      const secrets = Array.isArray(data.secrets)
        ? [...data.secrets].sort((a, b) => String(a.name).localeCompare(String(b.name)))
        : []
      listEl.innerHTML = secrets.length
        ? secrets.map(renderSecretRow).join('')
        : '<li class="harness-empty">No secrets</li>'
    } catch {
      listEl.innerHTML = '<li class="harness-empty">(unavailable)</li>'
    }
  }

  section.setRefresh(load)
  return section
}

// ---------------------------------------------------------------------------
// Wiki (+ full-screen markdown overlay)
// ---------------------------------------------------------------------------

let wikiOverlayEls = null

function ensureWikiOverlay() {
  if (wikiOverlayEls) return wikiOverlayEls

  const root = document.createElement('div')
  root.className = 'harness-overlay hidden'
  root.id = 'harness-wiki-overlay'

  const scrim = document.createElement('div')
  scrim.className = 'harness-overlay-scrim'

  const panel = document.createElement('div')
  panel.className = 'harness-overlay-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')

  const header = document.createElement('div')
  header.className = 'harness-overlay-header'

  const titleEl = document.createElement('span')
  titleEl.className = 'harness-overlay-title'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'harness-overlay-close'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.textContent = '×'

  header.appendChild(titleEl)
  header.appendChild(closeBtn)

  const bodyEl = document.createElement('div')
  bodyEl.className = 'harness-overlay-body hf-scrollbar'

  panel.appendChild(header)
  panel.appendChild(bodyEl)
  root.appendChild(scrim)
  root.appendChild(panel)
  document.body.appendChild(root)

  function close() {
    root.classList.add('hidden')
    document.removeEventListener('keydown', onKeydown)
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close()
  }

  closeBtn.addEventListener('click', close)
  scrim.addEventListener('click', close)

  // In-overlay navigation for [[wiki]] and [[memory:*.md]] links.
  bodyEl.addEventListener('click', (e) => {
    const link = e.target.closest?.('.harness-wiki-link')
    if (!link) return
    e.preventDefault()
    if (link.dataset.wiki) openWikiPage(link.dataset.wiki, link.dataset.wiki)
    else if (link.dataset.memory) openMemoryFile(link.dataset.memory)
  })

  function open() {
    root.classList.remove('hidden')
    document.addEventListener('keydown', onKeydown)
  }

  wikiOverlayEls = { titleEl, bodyEl, open, close }
  return wikiOverlayEls
}

// Turn the agent's [[slug]] wiki links and [[memory:file.md]] memory
// references into in-overlay navigation, so users can drill from a wiki page
// down into the memory topics it cites.
//
// SECURITY: this runs on already-DOMPurify-sanitized HTML and rewrites ONLY
// text nodes. The previous version ran the regex over the whole HTML string —
// attribute values included — so a `[[ref]]` inside e.g. `title="[[a]]"` was
// turned into an <a> that broke out of the attribute (and past the sanitizer,
// which had already run). A TreeWalker never visits attributes, so walking
// text nodes closes that sink structurally and leaves real anchors — including
// the sanitizer's rel="nofollow noopener noreferrer" hook output — untouched.
const WIKI_REF_RE = /\[\[memory:([\w][\w.-]{0,100}\.md)\]\]|\[\[([a-z0-9][a-z0-9-]{0,79})\]\]/g

function buildWikiLink(memoryFile, slug) {
  const a = document.createElement('a')
  a.href = '#'
  a.className = 'harness-wiki-link'
  if (memoryFile) {
    a.dataset.memory = memoryFile
    a.textContent = `memory/${memoryFile}`
  } else {
    a.dataset.wiki = slug
    a.textContent = slug
  }
  return a
}

function linkifyTextNode(node) {
  const text = node.nodeValue
  WIKI_REF_RE.lastIndex = 0
  if (!WIKI_REF_RE.test(text)) return
  const frag = document.createDocumentFragment()
  let last = 0
  let m
  WIKI_REF_RE.lastIndex = 0
  while ((m = WIKI_REF_RE.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)))
    frag.appendChild(buildWikiLink(m[1], m[2]))
    last = m.index + m[0].length
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
  node.parentNode.replaceChild(frag, node)
}

function linkifyWikiRefs(html) {
  // Parse the (already-sanitized) HTML into a detached container. Setting
  // innerHTML never executes scripts, and the input carries no active content.
  const container = document.createElement('div')
  container.innerHTML = html
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes = []
  // Snapshot first — replacing a node mid-walk would disturb the traversal.
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n)
  for (const n of nodes) {
    // Never nest a wiki link inside an existing anchor.
    if (n.parentElement && n.parentElement.closest('a')) continue
    linkifyTextNode(n)
  }
  return container.innerHTML
}

async function openWikiPage(slug, title) {
  const overlay = ensureWikiOverlay()
  overlay.titleEl.textContent = title || slug
  overlay.bodyEl.innerHTML = '<p class="harness-empty">Loading…</p>'
  overlay.open()
  try {
    const data = await getJSON(`/api/wiki/${encodeURIComponent(slug)}`)
    // Sanctioned exception to "escape everything": wiki content is markdown
    // rendered the same way chat.js renders assistant markdown, via marked.
    overlay.bodyEl.innerHTML = linkifyWikiRefs(renderMarkdown(data.content || ''))
  } catch {
    overlay.bodyEl.innerHTML = '<p class="harness-empty">(unavailable)</p>'
  }
}

// Memory-topic drill-down: read-only view of a memory file cited by a wiki
// page (or listed nowhere else). Same overlay, breadcrumbed title.
async function openMemoryFile(filename) {
  const overlay = ensureWikiOverlay()
  overlay.titleEl.textContent = `memory / ${filename}`
  overlay.bodyEl.innerHTML = '<p class="harness-empty">Loading…</p>'
  overlay.open()
  try {
    const data = await getJSON(`/api/memory/${encodeURIComponent(filename)}`)
    overlay.bodyEl.innerHTML = linkifyWikiRefs(renderMarkdown(data.content || ''))
  } catch {
    overlay.bodyEl.innerHTML = '<p class="harness-empty">(unavailable)</p>'
  }
}

function renderWikiRow(p) {
  const title = p.title && p.title.trim() ? p.title.trim() : p.slug
  return `<li class="harness-list-item harness-wiki-item" data-slug="${escapeHtml(p.slug)}" data-title="${escapeHtml(title)}" tabindex="0" role="button">
    <span class="harness-item-main">
      <span class="harness-item-title">${escapeHtml(title)}</span>
    </span>
  </li>`
}

function buildWikiSection() {
  const section = createSection({ id: 'wiki', title: 'Wiki' })
  section.body.innerHTML = '<ul class="harness-list hf-scrollbar"></ul>'
  const listEl = section.body.querySelector('.harness-list')

  function openFromEl(el) {
    const slug = el.dataset.slug
    if (!slug) return
    openWikiPage(slug, el.dataset.title || slug)
  }

  delegate(listEl, '.harness-wiki-item', openFromEl)
  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const el = e.target.closest('.harness-wiki-item')
    if (!el) return
    e.preventDefault()
    openFromEl(el)
  })

  async function load() {
    try {
      const data = await getJSON('/api/wiki')
      const pages = Array.isArray(data.pages) ? data.pages : []
      listEl.innerHTML = pages.length
        ? pages.map(renderWikiRow).join('')
        : '<li class="harness-empty">No pages</li>'
    } catch {
      listEl.innerHTML = '<li class="harness-empty">(unavailable)</li>'
    }
  }

  section.setRefresh(load)
  return section
}

// ---------------------------------------------------------------------------
// Approval banner
// ---------------------------------------------------------------------------

let bannerEls = null

function ensureBanner() {
  if (bannerEls) return bannerEls

  const root = document.createElement('div')
  root.className = 'harness-peer-banner hidden'
  root.id = 'harness-peer-banner'
  root.setAttribute('role', 'alert')

  const text = document.createElement('span')
  text.className = 'harness-peer-banner-text'

  const actions = document.createElement('span')
  actions.className = 'harness-peer-banner-actions'

  const approveBtn = document.createElement('button')
  approveBtn.type = 'button'
  approveBtn.className = 'hf-btn hf-btn-primary harness-btn-xs'
  approveBtn.textContent = 'Approve'

  const denyBtn = document.createElement('button')
  denyBtn.type = 'button'
  denyBtn.className = 'hf-btn hf-btn-ghost harness-btn-xs'
  denyBtn.textContent = 'Deny'

  actions.appendChild(approveBtn)
  actions.appendChild(denyBtn)
  root.appendChild(text)
  root.appendChild(actions)
  document.body.appendChild(root)

  async function resolve(action) {
    const name = currentBannerPeerName
    if (!name) return
    approveBtn.disabled = true
    denyBtn.disabled = true
    try {
      await postJSON(`/api/peer/${action}`, { name })
      hidePeerBanner()
      if (peersSectionApi) peersSectionApi.refresh()
    } catch (err) {
      console.error(`[harness-panels] banner ${action} failed:`, err.message)
      approveBtn.disabled = false
      denyBtn.disabled = false
    }
  }

  approveBtn.addEventListener('click', () => resolve('approve'))
  denyBtn.addEventListener('click', () => resolve('deny'))

  bannerEls = { root, text, approveBtn, denyBtn }
  return bannerEls
}

function showPeerBanner(ev) {
  const banner = ensureBanner()
  currentBannerPeerName = ev.name || null
  const name = escapeHtml(ev.name || '')
  const url = ev.url ? ` (${escapeHtml(ev.url)})` : ''
  banner.text.innerHTML = `Agent <strong>${name}</strong>${url} requests to join as a peer`
  banner.approveBtn.disabled = false
  banner.denyBtn.disabled = false
  banner.root.classList.remove('hidden')
}

function hidePeerBanner() {
  currentBannerPeerName = null
  if (bannerEls) bannerEls.root.classList.add('hidden')
}

// ---------------------------------------------------------------------------
// SSE hook + init
// ---------------------------------------------------------------------------

// Bring up the banner for any peer still pending — on page load (an
// approval must survive tab reloads and closed tabs) and again after each
// resolve, so queued concurrent requests surface one after another.
async function bootstrapPendingBanner() {
  try {
    const res = await fetch('/api/peers')
    if (!res.ok) return
    const data = await res.json()
    const pending = (data.peers || []).filter((p) => p.state === 'pending')
    if (pending.length === 0) return
    const newest = pending[0] // list() returns pending newest-first
    showPeerBanner({ name: newest.name, url: newest.url })
  } catch { /* banner bootstrap is best-effort; live events still work */ }
}

function handleHarnessEvent(ev) {
  try {
    if (!ev || typeof ev !== 'object') return
    if (ev.type === 'peer_request') {
      showPeerBanner(ev)
      if (peersSectionApi) peersSectionApi.refresh()
    } else if (ev.type === 'peer_resolved') {
      hidePeerBanner()
      if (peersSectionApi) peersSectionApi.refresh()
      bootstrapPendingBanner() // surface the next pending request, if any
    }
  } catch (err) {
    console.error('[harness-panels] event handling failed:', err && err.message)
  }
}

function init() {
  const sidebar = document.getElementById('sidebar')
  if (!sidebar) return // headless page — nothing to attach to

  ensureBanner()
  ensureWikiOverlay()
  bootstrapPendingBanner()

  const sections = [
    buildTasksSection(),
    buildSchedulesSection(),
    // Peers section disabled for now (operator call, 2026-07-27). The
    // approval BANNER below stays live — it is the required human-approval
    // path for inbound ad-hoc peer joins. Re-enable by restoring
    // buildPeersSection() here; everything else is null-guarded.
    buildSecretsSection(),
    buildWikiSection(),
  ]

  // Append after the existing sections but before #sidebar-toggle, which is
  // pinned to the bottom of the flex column via margin-top:auto — appending
  // literally last in DOM order would push these sections past it and, given
  // #sidebar's (overridden, still bounded) box, out of easy reach.
  const toggle = document.getElementById('sidebar-toggle')
  const frag = document.createDocumentFragment()
  for (const s of sections) frag.appendChild(s.wrap)
  if (toggle && toggle.parentNode === sidebar) {
    sidebar.insertBefore(frag, toggle)
  } else {
    sidebar.appendChild(frag)
  }

  // Chain onto the shared event hook without clobbering anything another
  // add-on module (media-ui.js, voice-ui.js) may have already registered.
  const prev = window.cheesoidHooks?.onEvent
  window.cheesoidHooks = { ...(window.cheesoidHooks || {}), onEvent: (ev) => { try { prev?.(ev) } catch {} handleHarnessEvent(ev) } }
}

init()
