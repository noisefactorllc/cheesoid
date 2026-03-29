const namePrompt = document.getElementById('name-prompt')
const nameInput = document.getElementById('name-input')
const nameBtn = document.getElementById('name-btn')
const chat = document.getElementById('chat')
const messages = document.getElementById('messages')
const input = document.getElementById('input')
const sendBtn = document.getElementById('send-btn')
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
let thinkingEl = null
let sending = false
let reconnectTimer = null
const visitorStreams = new Map() // agentName → { element, buffer }

let hubMode = false
let hostedRooms = []
let currentView = null  // '#general', 'dm:username', or null (legacy)
const roomBuffers = new Map()  // room/dm → { unread: 0 }

// Configure marked for chat rendering
if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true })
}

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

// Boot — check if instance uses auth proxy, skip name prompt if so
;(async () => {
  let presenceData = null
  try {
    const res = await fetch('/api/presence')
    presenceData = await res.json()
  } catch {}

  if (presenceData?.auth_proxy && presenceData.user) {
    myName = presenceData.user
    localStorage.setItem('cheesoid-name', myName)
  }

  if (myName) {
    enterRoom(presenceData)
  } else {
    namePrompt.classList.remove('hidden')
    nameInput.focus()
  }
})()

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

async function enterRoom(presenceData) {
  namePrompt.classList.add('hidden')
  chat.classList.remove('hidden')

  // Load presence (use pre-fetched data if available)
  try {
    const data = presenceData || await fetch('/api/presence').then(r => r.json())
    personaLabel = data.persona || 'Cheesoid'
    personaName.textContent = personaLabel
    document.title = personaLabel

    const s = data.state
    if (s.mood && s.mood !== 'neutral') {
      presenceStatus.textContent = s.mood
      presenceStatus.className = 'active'
    } else {
      presenceStatus.textContent = 'present'
      presenceStatus.className = 'active'
    }

    // Hub mode detection
    if (data.hosted_rooms && data.hosted_rooms.length > 0) {
      hubMode = true
      hostedRooms = data.hosted_rooms
      currentView = data.hosted_rooms[0] // default to first room (#general)
      document.getElementById('sidebar-rooms').classList.remove('hidden')
      renderRoomsList(data.hosted_rooms)
      document.getElementById('channel-name').textContent = currentView
    } else {
      document.getElementById('channel-name').textContent = (data.persona || 'cheesoid') + "'s office"
    }

    if (data.participants) updateParticipants(data.participants)
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

  // In hub mode, route events to correct view
  if (hubMode && event.type !== 'scrollback' && event.type !== 'presence') {
    const eventView = event.to
      ? (event.from === myName ? `dm:${event.to}` : `dm:${event.from}`)
      : event.room

    // Track unread for background views
    if (eventView && eventView !== currentView && event.type === 'user_message') {
      if (!roomBuffers.has(eventView)) roomBuffers.set(eventView, { unread: 0 })
      roomBuffers.get(eventView).unread++
      updateUnreadBadges()
    }

    // Only render events for current view (or unscoped events like presence)
    if (eventView && eventView !== currentView) return
  }

  switch (event.type) {
    case 'scrollback':
      messages.innerHTML = ''
      lastSender = null
      assistantEl = null
      assistantBuffer = ''
      thinkingEl = null
      idleEl = null
      idleBuffer = ''
      for (const msg of event.messages) {
        if (msg.type === 'user_message') {
          appendMessage('user', msg.text, msg.name, msg.timestamp)
        } else if (msg.type === 'assistant_message') {
          if (msg.name) {
            // Visiting agent message with optional tool summary
            const el = appendMessage('assistant', '', msg.name, msg.timestamp, true)
            el.classList.add('visitor-message')
            el.style.borderLeftColor = nameColor(msg.name)
            const body = el.querySelector('.message-body')
            if (body) {
              let content = ''
              if (msg.tools && msg.tools.length > 0) {
                content += `<div class="visitor-tools-summary">used: ${msg.tools.join(', ')}</div>`
              }
              content += renderMarkdown(msg.text)
              body.innerHTML = content
            }
          } else {
            const el = appendMessage('assistant', '', null, msg.timestamp)
            const body = el.querySelector('.message-body')
            if (body) body.innerHTML = renderMarkdown(msg.text)
          }
        } else if (msg.type === 'idle_thought' || msg.type === 'system') {
          const el = document.createElement('div')
          el.className = msg.type === 'system' ? 'system-message' : 'idle-thought'
          el.innerHTML = renderMarkdown(msg.text)
          messages.appendChild(el)
          lastSender = null
        }
      }
      forceScrollToBottom()
      break

    case 'user_message':
      // If this visiting agent had a tool stream, clean it up — the final
      // message replaces the tool-use placeholder
      if (event.fromAgent && visitorStreams.has(event.name)) {
        const vs = visitorStreams.get(event.name)
        for (const tc of vs.element.querySelectorAll('.tool-call')) tc.remove()
        const body = vs.element.querySelector('.message-body')
        if (body) body.innerHTML = renderMarkdown(event.text)
        visitorStreams.delete(event.name)
      } else {
        appendMessage('user', event.text, event.name, null, event.fromAgent)
      }
      if (!event.fromAgent) {
        assistantEl = appendMessage('assistant', '')
        assistantBuffer = ''
        thinkingEl = document.createElement('div')
        thinkingEl.className = 'thinking-indicator'
        thinkingEl.innerHTML = '<span>thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div>'
        assistantEl.appendChild(thinkingEl)
      }
      break

    case 'thinking_delta':
      // Indicator already shown from user_message — nothing extra needed
      break

    case 'text_delta':
      if (assistantEl) {
        if (thinkingEl) {
          thinkingEl.remove()
          thinkingEl = null
        }
        assistantBuffer += event.text
        const body = assistantEl.querySelector('.message-body')
        if (body) body.innerHTML = renderMarkdown(assistantBuffer)
        scrollToBottom()
      }
      break

    case 'tool_start':
      if (thinkingEl) {
        thinkingEl.remove()
        thinkingEl = null
      }
      if (event.visiting) {
        const agentName = event.agentName
        if (!visitorStreams.has(agentName)) {
          const el = appendMessage('assistant', '', agentName, null, true)
          el.classList.add('visitor-message')
          el.style.borderLeftColor = nameColor(agentName)
          visitorStreams.set(agentName, { element: el, buffer: '' })
        }
        appendTool(visitorStreams.get(agentName).element, `Using tool: ${event.name}...`)
      } else if (assistantEl && !event.idle) {
        appendTool(assistantEl, `Using tool: ${event.name}...`)
      }
      break

    case 'tool_result':
      if (event.visiting) {
        const vs = visitorStreams.get(event.agentName)
        if (vs) appendTool(vs.element, `${event.name}: ${truncate(JSON.stringify(event.result), 200)}`)
      } else if (assistantEl && !event.idle) {
        appendTool(assistantEl, `${event.name}: ${truncate(JSON.stringify(event.result), 200)}`)
        // Re-show thinking indicator after tool result — agent is processing
        if (!thinkingEl) {
          thinkingEl = document.createElement('div')
          thinkingEl.className = 'thinking-indicator'
          thinkingEl.innerHTML = '<span>thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div>'
          assistantEl.appendChild(thinkingEl)
        }
      }
      break

    case 'done':
      if (thinkingEl) {
        thinkingEl.remove()
        thinkingEl = null
      }
      if (assistantEl) {
        for (const tc of assistantEl.querySelectorAll('.tool-call')) tc.remove()
        // Extract thought tags and render as idle thoughts
        if (assistantBuffer.includes('<thought>')) {
          const thoughts = []
          assistantBuffer = assistantBuffer.replace(/<thought>([\s\S]*?)<\/thought>/g, (_, content) => {
            thoughts.push(content.trim())
            return ''
          })
          for (const thought of thoughts) {
            const el = document.createElement('div')
            el.className = 'idle-thought'
            el.innerHTML = renderMarkdown(thought)
            messages.appendChild(el)
          }
        }
        // Strip backchannel tags from visible output
        if (assistantBuffer.includes('<backchannel>')) {
          assistantBuffer = assistantBuffer.replace(/<backchannel>[\s\S]*?<\/backchannel>/g, '')
        }
        assistantBuffer = assistantBuffer.trim()
        const body = assistantEl.querySelector('.message-body')
        if (body) body.innerHTML = renderMarkdown(assistantBuffer)
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

    case 'backchannel': {
      const el = document.createElement('div')
      el.className = 'idle-thought agent-backchannel'
      el.innerHTML = `<span class="backchannel-label">[backchannel/${event.name}]</span> ${renderMarkdown(event.text)}`
      messages.appendChild(el)
      lastSender = null
      break
    }

    case 'presence':
      if (hubMode && event.room) {
        // Hub mode: presence arrives per-room, re-fetch aggregated
        refreshPresence()
      } else {
        updateParticipants(event.participants)
      }
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
    li.className = hubMode ? 'participant-item' : ''
    if (hubMode && currentView === `dm:${name}`) li.classList.add('active')
    li.dataset.name = name
    const dot = document.createElement('span')
    dot.className = 'participant-dot'
    li.appendChild(dot)
    li.appendChild(document.createTextNode(name))
    if (hubMode) {
      li.style.cursor = 'pointer'
      li.addEventListener('click', () => switchView(`dm:${name}`))
    }
    participantsEl.appendChild(li)
  }
}

function renderRoomsList(rooms) {
  const roomsList = document.getElementById('rooms-list')
  roomsList.innerHTML = ''
  for (const room of rooms) {
    const li = document.createElement('li')
    li.className = 'room-item'
    if (room === currentView) li.classList.add('active')
    li.dataset.room = room
    li.textContent = room
    li.addEventListener('click', () => switchView(room))
    roomsList.appendChild(li)
  }
}

function switchView(view) {
  if (view === currentView) return
  currentView = view
  messages.innerHTML = ''
  lastSender = null
  assistantEl = null
  assistantBuffer = ''
  thinkingEl = null

  // Update active states in sidebar
  for (const li of document.querySelectorAll('.room-item')) {
    li.classList.toggle('active', li.dataset.room === view)
  }
  for (const li of document.querySelectorAll('.participant-item')) {
    li.classList.toggle('active', 'dm:' + li.dataset.name === view)
  }

  // Update channel name
  const channelName = document.getElementById('channel-name')
  if (view.startsWith('dm:')) {
    channelName.textContent = view.replace('dm:', '')
  } else {
    channelName.textContent = view
  }

  // Clear unread for this view
  const buf = roomBuffers.get(view)
  if (buf) {
    buf.unread = 0
    updateUnreadBadges()
  }
}

function updateUnreadBadges() {
  // Room badges
  for (const li of document.querySelectorAll('.room-item')) {
    const room = li.dataset.room
    const buf = roomBuffers.get(room)
    let badge = li.querySelector('.unread-badge')
    if (buf && buf.unread > 0) {
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'unread-badge'
        li.appendChild(badge)
      }
      badge.textContent = buf.unread
    } else if (badge) {
      badge.remove()
    }
  }
  // Participant DM badges
  for (const li of document.querySelectorAll('.participant-item')) {
    const dmView = `dm:${li.dataset.name}`
    const buf = roomBuffers.get(dmView)
    let badge = li.querySelector('.unread-badge')
    if (buf && buf.unread > 0) {
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'unread-badge'
        li.appendChild(badge)
      }
      badge.textContent = buf.unread
    } else if (badge) {
      badge.remove()
    }
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
    if (data.participants) updateParticipants(data.participants)
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
    const body = { message: text, name: myName }
    if (hubMode && currentView) {
      if (currentView.startsWith('dm:')) {
        body.to = currentView.replace('dm:', '')
      } else {
        body.room = currentView
      }
    }
    await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

function formatTime(timestamp) {
  if (!timestamp) return ''
  const d = new Date(timestamp)
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

function appendMessage(role, text, name, timestamp, fromAgent = false) {
  const el = document.createElement('div')
  el.className = 'message'
  if (fromAgent) el.classList.add('agent-message')

  const senderKey = role === 'user' ? (name || 'anon') : (fromAgent && name ? `visitor:${name}` : '__assistant__')
  const isFirst = lastSender !== senderKey

  if (isFirst) {
    el.classList.add('message-first')

    // Avatar
    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    if (role === 'assistant') {
      if (fromAgent && name) {
        avatar.style.background = nameColor(name)
        avatar.textContent = name.charAt(0).toUpperCase()
      } else {
        avatar.classList.add('bot-avatar')
        avatar.textContent = personaLabel.charAt(0).toUpperCase()
      }
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
      if (fromAgent && name) {
        nameSpan.style.color = nameColor(name)
        nameSpan.textContent = name
      } else {
        nameSpan.classList.add('bot-name')
        nameSpan.textContent = personaLabel
      }
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
  body.innerHTML = renderMarkdown(text)
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
  const threshold = 150
  const isNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < threshold
  if (isNearBottom) {
    messages.scrollTop = messages.scrollHeight
  }
}

function forceScrollToBottom() {
  messages.scrollTop = messages.scrollHeight
}

function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    return marked.parse(text)
  }
  // Fallback if marked not loaded
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
