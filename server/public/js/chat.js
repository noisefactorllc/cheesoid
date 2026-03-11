const namePrompt = document.getElementById('name-prompt')
const nameInput = document.getElementById('name-input')
const nameBtn = document.getElementById('name-btn')
const chat = document.getElementById('chat')
const messages = document.getElementById('messages')
const input = document.getElementById('input')
const sendBtn = document.getElementById('send-btn')
const resetBtn = document.getElementById('reset-btn')
const personaName = document.getElementById('persona-name')
const presenceStatus = document.getElementById('presence-status')
const participantsEl = document.getElementById('participants')
const sidebar = document.getElementById('sidebar')
const sidebarToggle = document.getElementById('sidebar-toggle')
const sidebarOpen = document.getElementById('sidebar-open')

let myName = localStorage.getItem('cheesoid-name')
let evtSource = null
let assistantEl = null
let assistantBuffer = ''
let idleEl = null
let idleBuffer = ''
let lastSender = null
let personaLabel = 'Cheesoid'
let sending = false
let reconnectTimer = null

const AVATAR_COLORS = [
  'oklch(65% 0.15 0)',
  'oklch(65% 0.15 30)',
  'oklch(70% 0.15 90)',
  'oklch(65% 0.15 145)',
  'oklch(65% 0.15 200)',
  'oklch(65% 0.15 260)',
  'oklch(65% 0.15 300)',
  'oklch(65% 0.15 330)',
]

function nameColor(name) {
  let hash = 0
  for (const ch of name) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

// Sidebar toggle
const isMobile = () => window.matchMedia('(max-width: 768px)').matches

let sidebarOverlay = null

function closeSidebar() {
  sidebar.classList.add('collapsed')
  sidebarOpen.classList.remove('hidden')
  if (sidebarOverlay) {
    sidebarOverlay.remove()
    sidebarOverlay = null
  }
}

function openSidebar() {
  sidebar.classList.remove('collapsed')
  sidebar.classList.remove('mobile-default')
  sidebarOpen.classList.add('hidden')
  if (isMobile()) {
    sidebarOverlay = document.createElement('div')
    sidebarOverlay.className = 'sidebar-overlay'
    sidebarOverlay.addEventListener('click', closeSidebar)
    document.body.appendChild(sidebarOverlay)
  }
}

sidebarToggle.addEventListener('click', closeSidebar)
sidebarOpen.addEventListener('click', openSidebar)

// Start with sidebar collapsed on mobile
if (isMobile()) {
  sidebar.classList.add('collapsed')
  sidebarOpen.classList.remove('hidden')
}

// Boot
if (myName) {
  enterRoom()
} else {
  namePrompt.classList.remove('hidden')
  nameInput.focus()
}

nameBtn.addEventListener('click', submitName)
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitName()
})

function submitName() {
  const name = nameInput.value.trim()
  if (!name) return
  myName = name
  localStorage.setItem('cheesoid-name', name)
  enterRoom()
}

async function enterRoom() {
  namePrompt.classList.add('hidden')
  chat.classList.remove('hidden')

  // Load presence
  try {
    const res = await fetch('/api/presence')
    const data = await res.json()
    personaLabel = data.persona || 'Cheesoid'
    personaName.textContent = personaLabel
    document.title = personaLabel
    document.getElementById('channel-name').textContent = '# ' + (data.persona || 'cheesoid')
    const s = data.state
    if (s.mood && s.mood !== 'neutral') {
      presenceStatus.textContent = s.mood
      presenceStatus.className = 'active'
    } else {
      presenceStatus.textContent = 'present'
      presenceStatus.className = 'active'
    }
  } catch {}

  // Connect to SSE stream
  connectSSE()
}

function connectSSE() {
  if (evtSource) evtSource.close()
  evtSource = new EventSource(`/api/chat/stream?name=${encodeURIComponent(myName)}`)
  evtSource.onmessage = handleEvent
  evtSource.onerror = () => {
    // Close immediately to prevent browser auto-reconnect racing our manual reconnect
    if (evtSource) evtSource.close()
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectSSE()
    }, 3000)
  }

  input.focus()
}

function handleEvent(e) {
  const event = JSON.parse(e.data)

  switch (event.type) {
    case 'scrollback':
      messages.innerHTML = ''
      lastSender = null
      assistantEl = null
      assistantBuffer = ''
      idleEl = null
      idleBuffer = ''
      for (const msg of event.messages) {
        if (msg.type === 'user_message') {
          appendMessage('user', msg.text, msg.name, msg.timestamp)
        } else if (msg.type === 'assistant_message') {
          const el = appendMessage('assistant', '', null, msg.timestamp)
          const body = el.querySelector('.message-body')
          if (body) body.innerHTML = renderMarkdown(msg.text)
        } else if (msg.type === 'idle_thought' || msg.type === 'system') {
          const el = document.createElement('div')
          el.className = msg.type === 'system' ? 'system-message' : 'idle-thought'
          el.innerHTML = renderMarkdown(msg.text)
          messages.appendChild(el)
          lastSender = null
        }
      }
      scrollToBottom()
      break

    case 'user_message':
      // Someone sent a message (could be us or someone else)
      appendMessage('user', event.text, event.name)
      // Prepare for assistant response (but not for visiting agent messages)
      if (!event.fromAgent) {
        assistantEl = appendMessage('assistant', '')
        assistantBuffer = ''
      }
      break

    case 'text_delta':
      if (assistantEl) {
        assistantBuffer += event.text
        const body = assistantEl.querySelector('.message-body')
        if (body) body.innerHTML = renderMarkdown(assistantBuffer)
        scrollToBottom()
      }
      break

    case 'tool_start':
      if (assistantEl && !event.idle) {
        appendTool(assistantEl, `Using tool: ${event.name}...`)
      }
      break

    case 'tool_result':
      if (assistantEl && !event.idle) {
        appendTool(assistantEl, `${event.name}: ${truncate(JSON.stringify(event.result), 200)}`)
      }
      break

    case 'done':
      if (assistantEl) {
        for (const tc of assistantEl.querySelectorAll('.tool-call')) tc.remove()
        // Strip only backchannel tags (private agent coordination) from visible output
        if (assistantBuffer.includes('<backchannel>')) {
          assistantBuffer = assistantBuffer.replace(/<backchannel>[\s\S]*?<\/backchannel>/g, '').trim()
          const body = assistantEl.querySelector('.message-body')
          if (body) body.innerHTML = renderMarkdown(assistantBuffer)
        }
        // Remove empty ghost elements (backchannel-only responses)
        if (!assistantBuffer.trim()) {
          assistantEl.remove()
        }
      }
      assistantEl = null
      assistantBuffer = ''
      refreshPresence()
      break

    case 'idle_text_delta':
      if (!idleEl) {
        idleEl = document.createElement('div')
        idleEl.className = 'idle-thought'
        messages.appendChild(idleEl)
        lastSender = null
      }
      idleBuffer += event.text
      idleEl.innerHTML = renderMarkdown(idleBuffer)
      scrollToBottom()
      break

    case 'idle_done':
      idleEl = null
      idleBuffer = ''
      refreshPresence()
      break

    case 'presence':
      updateParticipants(event.participants)
      break

    case 'reset':
      messages.innerHTML = ''
      assistantEl = null
      assistantBuffer = ''
      lastSender = null
      break

    case 'system': {
      const el = document.createElement('div')
      el.className = 'system-message'
      el.textContent = event.text
      messages.appendChild(el)
      lastSender = null
      scrollToBottom()
      break
    }

    case 'error':
      if (assistantEl) {
        appendTool(assistantEl, `Error: ${event.message}`, true)
      } else {
        const el = document.createElement('div')
        el.className = 'message error'
        el.textContent = event.message
        messages.appendChild(el)
        scrollToBottom()
      }
      break
  }
}

function updateParticipants(names) {
  participantsEl.innerHTML = ''
  for (const name of names) {
    const li = document.createElement('li')
    const dot = document.createElement('span')
    dot.className = 'participant-dot'
    li.appendChild(dot)
    li.appendChild(document.createTextNode(name))
    participantsEl.appendChild(li)
  }
}

async function refreshPresence() {
  try {
    const res = await fetch('/api/presence')
    const data = await res.json()
    const s = data.state
    if (s.mood && s.mood !== 'neutral') {
      presenceStatus.textContent = s.mood
      presenceStatus.className = 'active'
    }
  } catch {}
}

// Input history
const inputHistory = []
let historyIndex = -1

// Input handling
input.addEventListener('input', () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 200) + 'px'
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  } else if (e.key === 'ArrowUp' && input.selectionStart === 0 && !e.shiftKey) {
    if (inputHistory.length === 0) return
    if (historyIndex === -1) historyIndex = inputHistory.length
    if (historyIndex > 0) {
      historyIndex--
      input.value = inputHistory[historyIndex]
      e.preventDefault()
    }
  } else if (e.key === 'ArrowDown' && !e.shiftKey && historyIndex !== -1) {
    if (historyIndex < inputHistory.length - 1) {
      historyIndex++
      input.value = inputHistory[historyIndex]
    } else {
      historyIndex = -1
      input.value = ''
    }
    e.preventDefault()
  }
})

sendBtn.addEventListener('click', send)
resetBtn.addEventListener('click', reset)

async function send() {
  const text = input.value.trim()
  if (!text || sending) return

  sending = true
  inputHistory.push(text)
  historyIndex = -1
  input.value = ''
  input.style.height = 'auto'
  sendBtn.disabled = true

  try {
    await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, name: myName }),
    })
  } catch (err) {
    const el = document.createElement('div')
    el.className = 'message error'
    el.textContent = `Send failed: ${err.message}`
    messages.appendChild(el)
  }

  sending = false
  sendBtn.disabled = false
  input.focus()
}

async function reset() {
  await fetch('/api/chat/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

function formatTime(timestamp) {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

function appendMessage(role, text, name, timestamp) {
  const el = document.createElement('div')
  el.className = 'message'

  const senderKey = role === 'user' ? (name || 'anon') : '__assistant__'
  const isFirst = lastSender !== senderKey

  if (isFirst) {
    el.classList.add('message-first')

    // Avatar
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    if (role === 'assistant') {
      avatar.classList.add('bot-avatar')
      avatar.textContent = personaLabel.charAt(0).toUpperCase()
    } else {
      const displayName = name || 'anon'
      avatar.style.background = nameColor(displayName)
      avatar.textContent = displayName.charAt(0).toUpperCase()
    }
    el.appendChild(avatar)

    // Message meta (name + time)
    const meta = document.createElement('div')
    meta.className = 'message-meta'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'sender-name'
    if (role === 'assistant') {
      nameSpan.classList.add('bot-name')
      nameSpan.textContent = personaLabel
    } else {
      nameSpan.style.color = nameColor(name || 'anon')
      nameSpan.textContent = name || 'anon'
    }
    meta.appendChild(nameSpan)

    const timeSpan = document.createElement('span')
    timeSpan.className = 'message-time'
    timeSpan.textContent = formatTime(timestamp) || formatTime(Date.now())
    meta.appendChild(timeSpan)

    el.appendChild(meta)
  }

  lastSender = senderKey

  // Message body
  const body = document.createElement('div')
  body.className = 'message-body'
  if (role === 'user') {
    body.textContent = text
  } else {
    body.innerHTML = renderMarkdown(text)
  }
  el.appendChild(body)

  messages.appendChild(el)
  scrollToBottom()
  return el
}

function appendTool(parentEl, text, isError = false) {
  const el = document.createElement('div')
  el.className = isError ? 'tool-call error' : 'tool-call'
  el.textContent = text
  parentEl.appendChild(el)
  scrollToBottom()
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight
}

function renderMarkdown(text) {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>')
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '...' : str
}
