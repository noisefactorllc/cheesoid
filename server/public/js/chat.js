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
const idleStreams = new Map() // agentName → { el, buffer }
let lastSender = null
let personaLabel = 'Cheesoid'
let thinkingEl = null
let sending = false
let reconnectTimer = null
let currentModel = null
const visitorStreams = new Map() // agentName → { element, buffer }

let replyToId = null
let replyToName = null

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🔥', '👀', '💯']
const ALL_EMOJIS = [
  ...QUICK_EMOJIS,
  '😍', '🙏', '👏', '🎉', '😮', '😢', '😡', '🤔', '🤯',
  '💀', '✅', '❌', '⭐', '💡', '🚀', '🎯', '💪', '🫡',
  '👎', '😅', '🥳', '😎', '🤝', '💜', '🧡', '💚', '🩵',
  '⚡', '🌟', '🔧', '📌', '🎵', '☕', '🍕', '🐛',
]

let activeEmojiPicker = null

function showEmojiPicker(msgId, anchorEl) {
  closeEmojiPicker()
  const picker = document.createElement('div')
  picker.className = 'emoji-picker'

  const quickRow = document.createElement('div')
  quickRow.className = 'emoji-picker-quick'
  for (const emoji of QUICK_EMOJIS) {
    const btn = document.createElement('button')
    btn.className = 'emoji-pick-btn'
    btn.textContent = emoji
    btn.addEventListener('click', () => {
      sendReaction(msgId, emoji)
      closeEmojiPicker()
    })
    quickRow.appendChild(btn)
  }
  picker.appendChild(quickRow)

  const divider = document.createElement('hr')
  divider.className = 'emoji-picker-divider'
  picker.appendChild(divider)

  const grid = document.createElement('div')
  grid.className = 'emoji-picker-grid'
  for (const emoji of ALL_EMOJIS) {
    if (QUICK_EMOJIS.includes(emoji)) continue
    const btn = document.createElement('button')
    btn.className = 'emoji-pick-btn'
    btn.textContent = emoji
    btn.addEventListener('click', () => {
      sendReaction(msgId, emoji)
      closeEmojiPicker()
    })
    grid.appendChild(btn)
  }
  picker.appendChild(grid)

  // Position near the anchor
  const rect = anchorEl.getBoundingClientRect()
  picker.style.top = `${rect.bottom + 4}px`
  picker.style.right = `${window.innerWidth - rect.right}px`
  document.body.appendChild(picker)
  activeEmojiPicker = picker

  // Close on click outside (deferred so the initiating click doesn't close it)
  setTimeout(() => {
    document.addEventListener('click', closeEmojiPickerOnOutsideClick)
  }, 0)
}

function closeEmojiPicker() {
  if (activeEmojiPicker) {
    activeEmojiPicker.remove()
    activeEmojiPicker = null
    document.removeEventListener('click', closeEmojiPickerOnOutsideClick)
  }
}

function closeEmojiPickerOnOutsideClick(e) {
  if (activeEmojiPicker && !activeEmojiPicker.contains(e.target) && !e.target.closest('.react-btn')) {
    closeEmojiPicker()
  }
}

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

let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000

function connectSSE() {
  if (evtSource) evtSource.close()
  // Clear stale streaming state on reconnect
  viewCache.clear()
  assistantEl = null
  assistantBuffer = ''
  thinkingEl = null
  visitorStreams.clear()
  idleStreams.clear()
  lastSender = null
  currentModel = null

  evtSource = new EventSource(`/api/chat/stream?name=${encodeURIComponent(myName)}`)
  evtSource.onmessage = handleEvent
  evtSource.onerror = () => {
    if (evtSource) evtSource.close()
    if (reconnectTimer) return
    // Show connection lost banner
    const banner = document.getElementById('connection-status')
    if (banner) { banner.textContent = 'Connection lost. Reconnecting...'; banner.classList.remove('hidden') }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectSSE()
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
    }, reconnectDelay)
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
    if (eventView && eventView !== currentView) {
      // Invalidate cached HTML so fresh scrollback is fetched on switch
      viewCache.delete(eventView)
      return
    }
  }

  switch (event.type) {
    case 'scrollback':
      messages.innerHTML = ''
      lastSender = null
      assistantEl = null
      assistantBuffer = ''
      thinkingEl = null
      idleStreams.clear()
      // Reconnect succeeded — reset backoff and hide banner
      reconnectDelay = 1000
      { const banner = document.getElementById('connection-status'); if (banner) banner.classList.add('hidden') }
      for (const msg of event.messages) {
        // Filter by view: DMs to DM views, room messages to matching room views
        if (msg.dm_from || msg.dm_to) {
          // DM — must be a participant and in the correct DM view
          if (msg.dm_from !== myName && msg.dm_to !== myName) continue
          if (!currentView || !currentView.startsWith('dm:')) continue
          const dmPeer = msg.dm_from === myName ? msg.dm_to : msg.dm_from
          if (currentView !== `dm:${dmPeer}`) continue
        } else if (currentView && currentView.startsWith('dm:')) {
          // In DM view — skip non-DM messages
          continue
        } else if (msg.room && currentView && msg.room !== currentView) {
          // Room message — only show in matching channel
          continue
        } else if (!msg.room && currentView && hubMode) {
          // Untagged message (idle thoughts, system, old entries) — show in first room only
          if (currentView !== hostedRooms[0]) continue
        }
        if (msg.type === 'user_message') {
          const el = appendMessage('user', msg.text, msg.name, msg.timestamp, false, msg.model, msg.id)
          if (msg.replyTo) renderReplyHeader(el, msg.replyTo)
        } else if (msg.type === 'assistant_message') {
          if (msg.name) {
            // Visiting agent message with optional tool summary
            const el = appendMessage('assistant', '', msg.name, msg.timestamp, true, msg.model, msg.id)
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
            if (msg.replyTo) renderReplyHeader(el, msg.replyTo)
          } else {
            const el = appendMessage('assistant', '', null, msg.timestamp, false, msg.model, msg.id)
            const body = el.querySelector('.message-body')
            if (body) body.innerHTML = renderMarkdown(msg.text)
            if (msg.replyTo) renderReplyHeader(el, msg.replyTo)
          }
        } else if (msg.type === 'idle_thought' || msg.type === 'system') {
          const el = document.createElement('div')
          el.className = msg.type === 'system' ? 'system-message' : 'idle-thought'
          if (msg.type === 'idle_thought' && msg.name) {
            el.style.borderLeftColor = nameColor(msg.name)
            el.dataset.agent = msg.name
          }
          const nameHtml = (msg.type === 'idle_thought' && msg.name)
            ? `<span class="idle-thought-name" style="color:${nameColor(msg.name)}">${escapeHtml(msg.name)}</span>`
            : ''
          const metaHtml = `<div class="inline-meta">${nameHtml}<span class="message-time">${formatTime(msg.timestamp)}</span>${msg.model ? `<span class="message-model">${escapeHtml(msg.model)}</span>` : ''}</div>`
          el.innerHTML = metaHtml + renderMarkdown(msg.text)
          messages.appendChild(el)
          lastSender = null
        }
      }
      // Replay reactions after all messages are rendered
      for (const msg of event.messages) {
        if (msg.type === 'reaction') {
          updateReactionPills(msg.messageId, msg.emoji, msg.name, msg.action)
        }
      }
      // DM welcome header — always shown at top of DM views
      if (currentView && currentView.startsWith('dm:')) {
        const dmPeerName = currentView.replace('dm:', '')
        const header = document.createElement('div')
        header.className = 'dm-welcome'
        const avatar = document.createElement('div')
        avatar.className = 'dm-welcome-avatar'
        avatar.style.background = nameColor(dmPeerName)
        avatar.textContent = dmPeerName.charAt(0).toUpperCase()
        header.appendChild(avatar)
        const dmName = document.createElement('div')
        dmName.className = 'dm-welcome-name'
        dmName.textContent = dmPeerName
        header.appendChild(dmName)
        const desc = document.createElement('div')
        desc.className = 'dm-welcome-desc'
        desc.textContent = `This is the beginning of your chat with ${dmPeerName}.`
        header.appendChild(desc)
        const divider = document.createElement('hr')
        divider.className = 'dm-welcome-divider'
        header.appendChild(divider)
        messages.prepend(header)
      }
      forceScrollToBottom()
      break

    case 'user_message':
      // If this visiting agent had a tool stream, clean it up — the final
      // message replaces the tool-use placeholder
      if (event.fromAgent && visitorStreams.has(event.name)) {
        const vs = visitorStreams.get(event.name)
        if (event.id) {
          vs.element.dataset.messageId = event.id
          if (!vs.element.querySelector('.message-toolbar')) {
            vs.element.appendChild(createToolbar(event.id))
          }
        }
        const body = vs.element.querySelector('.message-body')
        if (body) body.innerHTML = renderMarkdown(event.text)
        // Attach model to the visitor message and its tool calls
        if (event.model) {
          const meta = vs.element.querySelector('.message-meta')
          if (meta && !meta.querySelector('.message-model')) {
            const modelSpan = document.createElement('span')
            modelSpan.className = 'message-model'
            modelSpan.textContent = event.model
            meta.appendChild(modelSpan)
          }
          for (const tc of vs.element.querySelectorAll('.tool-call:not(.has-model)')) {
            const modelSpan = document.createElement('span')
            modelSpan.className = 'message-model'
            modelSpan.textContent = event.model
            tc.appendChild(modelSpan)
            tc.classList.add('has-model')
          }
        }
        // Remove thinking indicator and collapse tool details
        if (vs.thinkingEl) {
          vs.thinkingEl.remove()
          vs.thinkingEl = null
        }
        const vToolDetails = vs.element.querySelector('details.tool-details')
        if (vToolDetails) vToolDetails.open = false
        visitorStreams.delete(event.name)
      } else if (event.to && event.from === personaLabel) {
        // DM response from the host agent — render as assistant and clean up thinking
        if (thinkingEl) {
          thinkingEl.remove()
          thinkingEl = null
        }
        if (assistantEl) {
          const body = assistantEl.querySelector('.message-body')
          if (body) body.innerHTML = renderMarkdown(event.text)
          if (event.model) {
            const meta = assistantEl.querySelector('.message-meta')
            if (meta && !meta.querySelector('.message-model')) {
              const modelSpan = document.createElement('span')
              modelSpan.className = 'message-model'
              modelSpan.textContent = event.model
              meta.appendChild(modelSpan)
            }
          }
          assistantEl = null
          assistantBuffer = ''
        } else {
          appendMessage('assistant', event.text, null, null, false, event.model)
        }
      } else {
        const msgEl = appendMessage('user', event.text, event.name || event.from, null, event.fromAgent, event.model, event.id)
        if (event.replyTo) renderReplyHeader(msgEl, event.replyTo)
      }
      // Show thinking indicator for room messages and DMs to the host agent
      // Skip if the floor excludes the host or moderator is another agent
      const isDMToHost = event.to && event.to === personaLabel
      const hostOnFloor = !event.floor || event.floor.includes(personaLabel)
      const hostIsModerator = !event.moderator || event.moderator === personaLabel
      if (!event.fromAgent && (!event.to || isDMToHost) && hostOnFloor && hostIsModerator && !assistantEl) {
        assistantEl = appendMessage('assistant', '')
        assistantBuffer = ''
        thinkingEl = document.createElement('div')
        thinkingEl.className = 'thinking-indicator'
        thinkingEl.innerHTML = '<span>thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div>'
        assistantEl.appendChild(thinkingEl)
      }
      break

    case 'response_model':
      // Model name arrives before any tool calls — set it so tools get labeled immediately
      currentModel = event.model || null
      if (assistantEl && currentModel) {
        const meta = assistantEl.querySelector('.message-meta')
        if (meta && !meta.querySelector('.message-model')) {
          const modelSpan = document.createElement('span')
          modelSpan.className = 'message-model'
          modelSpan.textContent = currentModel
          meta.appendChild(modelSpan)
        }
      }
      break

    case 'assistant_message_id':
      if (assistantEl) {
        assistantEl.dataset.messageId = event.id
        // Only add toolbar if not already present (guard against SSE reconnect double-render)
        if (!assistantEl.querySelector('.message-toolbar')) {
          assistantEl.appendChild(createToolbar(event.id))
        }
      }
      break

    case 'thinking_delta':
      // Indicator already shown from user_message — nothing extra needed
      break

    case 'text_delta':
      if (event.visiting) {
        const agentName = event.agentName
        if (!visitorStreams.has(agentName)) {
          const el = appendMessage('assistant', '', agentName, null, true)
          el.classList.add('visitor-message')
          el.style.borderLeftColor = nameColor(agentName)
          visitorStreams.set(agentName, { element: el, buffer: '', thinkingEl: null })
        }
        const vs = visitorStreams.get(agentName)
        if (vs.thinkingEl) { vs.thinkingEl.remove(); vs.thinkingEl = null }
        vs.buffer += event.text
        const vBody = vs.element.querySelector('.message-body')
        if (vBody) vBody.innerHTML = renderMarkdown(vs.buffer)
        scrollToBottom()
      } else {
        // Create assistant element if none exists
        if (!assistantEl) {
          assistantEl = appendMessage('assistant', '')
          assistantBuffer = ''
        }
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
          // Add thinking indicator for visitor
          const vThinking = document.createElement('div')
          vThinking.className = 'thinking-indicator'
          vThinking.innerHTML = '<span>thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div>'
          el.appendChild(vThinking)
          visitorStreams.set(agentName, { element: el, buffer: '', thinkingEl: vThinking })
        }
        // Remove visitor thinking indicator on first tool
        const vs = visitorStreams.get(agentName)
        if (vs.thinkingEl) {
          vs.thinkingEl.remove()
          vs.thinkingEl = null
        }
        appendTool(vs.element, `Using tool: ${event.name}...`, false, event.model)
      } else if (assistantEl && !event.idle) {
        appendTool(assistantEl, `Using tool: ${event.name}...`, false, event.model)
      }
      break

    case 'tool_result':
      if (event.visiting) {
        const vs = visitorStreams.get(event.agentName)
        if (vs) {
          appendTool(vs.element, `${event.name}: ${truncate(JSON.stringify(event.result), 200)}`, false, event.model)
          // Re-show thinking indicator for visitor
          if (!vs.thinkingEl) {
            vs.thinkingEl = document.createElement('div')
            vs.thinkingEl.className = 'thinking-indicator'
            vs.thinkingEl.innerHTML = '<span>thinking</span><div class="thinking-dots"><span></span><span></span><span></span></div>'
            vs.element.appendChild(vs.thinkingEl)
          }
        }
      } else if (assistantEl && !event.idle) {
        appendTool(assistantEl, `${event.name}: ${truncate(JSON.stringify(event.result), 200)}`, false, event.model)
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
      if (event.visiting) {
        const agentName = event.agentName
        const vs = visitorStreams.get(agentName)
        if (vs) {
          if (vs.thinkingEl) { vs.thinkingEl.remove(); vs.thinkingEl = null }
          if (event.model) {
            const meta = vs.element.querySelector('.message-meta')
            if (meta && !meta.querySelector('.message-model')) {
              const modelSpan = document.createElement('span')
              modelSpan.className = 'message-model'
              modelSpan.textContent = event.model
              meta.appendChild(modelSpan)
            }
          }
          const toolDetails = vs.element.querySelector('details.tool-details')
          if (toolDetails) toolDetails.open = false
        }
        break
      }
      if (thinkingEl) {
        thinkingEl.remove()
        thinkingEl = null
      }
      currentModel = event.model || null
      if (assistantEl) {
        // Add model to message meta
        if (currentModel) {
          const meta = assistantEl.querySelector('.message-meta')
          if (meta && !meta.querySelector('.message-model')) {
            const modelSpan = document.createElement('span')
            modelSpan.className = 'message-model'
            modelSpan.textContent = currentModel
            meta.appendChild(modelSpan)
          }
          // Also add model to all tool calls that were rendered during this response
          for (const tc of assistantEl.querySelectorAll('.tool-call:not(.has-model)')) {
            const modelSpan = document.createElement('span')
            modelSpan.className = 'message-model'
            modelSpan.textContent = currentModel
            tc.appendChild(modelSpan)
            tc.classList.add('has-model')
          }
        }
        // Collapse tool details now that streaming is done
        const toolDetails = assistantEl.querySelector('details.tool-details')
        if (toolDetails) toolDetails.open = false
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
            const metaHtml = `<div class="inline-meta"><span class="message-time">${formatTime(Date.now())}</span>${currentModel ? `<span class="message-model">${escapeHtml(currentModel)}</span>` : ''}</div>`
            el.innerHTML = metaHtml + renderMarkdown(thought)
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
        // Remove empty ghost elements (backchannel-only responses, no tools either)
        if (!assistantBuffer.trim() && !assistantEl.querySelector('.tool-call')) {
          assistantEl.remove()
        }
      }
      assistantEl = null
      assistantBuffer = ''
      refreshPresence()
      break

    case 'idle_text_delta': {
      const idleKey = event.name || '_default'
      let idle = idleStreams.get(idleKey)
      if (!idle) {
        const el = document.createElement('div')
        el.className = 'idle-thought'
        if (event.name) {
          el.style.borderLeftColor = nameColor(event.name)
          el.dataset.agent = event.name
        }
        const idleMeta = document.createElement('div')
        idleMeta.className = 'inline-meta'
        if (event.name) {
          const idleName = document.createElement('span')
          idleName.className = 'idle-thought-name'
          idleName.textContent = event.name
          idleName.style.color = nameColor(event.name)
          idleMeta.appendChild(idleName)
        }
        const idleTime = document.createElement('span')
        idleTime.className = 'message-time'
        idleTime.textContent = formatTime(Date.now())
        idleMeta.appendChild(idleTime)
        el.appendChild(idleMeta)
        const idleBody = document.createElement('span')
        idleBody.className = 'idle-thought-body'
        el.appendChild(idleBody)
        messages.appendChild(el)
        lastSender = null
        idle = { el, buffer: '' }
        idleStreams.set(idleKey, idle)
      }
      idle.buffer += event.text
      const idleBody = idle.el.querySelector('.idle-thought-body')
      if (idleBody) idleBody.innerHTML = renderMarkdown(idle.buffer)
      scrollToBottom()
      break
    }

    case 'idle_done': {
      const doneKey = event.name || '_default'
      const doneIdle = idleStreams.get(doneKey)
      if (doneIdle && event.model) {
        const meta = doneIdle.el.querySelector('.inline-meta')
        if (meta) {
          const modelSpan = document.createElement('span')
          modelSpan.className = 'message-model'
          modelSpan.textContent = event.model
          meta.appendChild(modelSpan)
        }
      }
      idleStreams.delete(doneKey)
      refreshPresence()
      break
    }

    case 'reaction':
      updateReactionPills(event.messageId, event.emoji, event.name, event.action)
      break

    case 'backchannel':
      // Backchannel is agent-only coordination — hidden from human users
      break

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
      el.innerHTML = `<span class="message-time">${formatTime(Date.now())}</span> ${escapeHtml(event.text)}`
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
        el.innerHTML = `<span class="message-time">${formatTime(Date.now())}</span> ${escapeHtml(event.message)}`
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

const viewCache = new Map() // view → saved innerHTML

function switchView(view) {
  if (view === currentView) return

  // Save current view's content
  if (currentView) {
    viewCache.set(currentView, messages.innerHTML)
  }

  currentView = view
  lastSender = null
  assistantEl = null
  assistantBuffer = ''
  thinkingEl = null
  replyToId = null
  replyToName = null
  if (typeof replyBanner !== 'undefined' && replyBanner) {
    replyBanner.classList.add('hidden')
  }

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

  // Restore cached content or fetch scrollback
  if (viewCache.has(view)) {
    messages.innerHTML = viewCache.get(view)
    forceScrollToBottom()
  } else {
    messages.innerHTML = ''
    {
      const scrollbackUrl = view.startsWith('dm:')
        ? '/api/chat/scrollback'
        : `/api/chat/scrollback?room=${encodeURIComponent(view)}`
      fetch(scrollbackUrl)
        .then(r => r.json())
        .then(data => {
          if (data.messages && currentView === view) {
            handleEvent({ data: JSON.stringify({ type: 'scrollback', messages: data.messages }) })
          }
        })
        .catch(() => {})
    }
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

// Reply banner — inserted above the input area
const replyBanner = document.createElement('div')
replyBanner.className = 'reply-banner hidden'
const replyBannerText = document.createElement('span')
replyBannerText.className = 'reply-banner-text'
const replyBannerClose = document.createElement('button')
replyBannerClose.className = 'reply-banner-close'
replyBannerClose.title = 'Cancel reply'
replyBannerClose.textContent = '✕'
replyBanner.appendChild(replyBannerText)
replyBanner.appendChild(replyBannerClose)
const inputArea = document.getElementById('input-area')
inputArea.parentElement.insertBefore(replyBanner, inputArea)

replyBannerClose.addEventListener('click', () => {
  replyToId = null
  replyToName = null
  replyBanner.classList.add('hidden')
})

messages.addEventListener('click', (e) => {
  const reactBtn = e.target.closest('.react-btn')
  if (reactBtn) {
    e.stopPropagation()
    showEmojiPicker(reactBtn.dataset.msgId, reactBtn)
    return
  }

  const pill = e.target.closest('.reaction-pill')
  if (pill) {
    const msgEl = pill.closest('.message')
    const messageId = msgEl?.dataset.messageId
    const emoji = pill.dataset.emoji
    if (!messageId || !emoji) return
    const names = JSON.parse(pill.dataset.names || '[]')
    const act = names.includes(myName) ? 'remove' : 'add'
    sendReaction(messageId, emoji, act)
    return
  }

  const replyHeader = e.target.closest('.reply-header-linked')
  if (replyHeader) {
    const targetId = replyHeader.dataset.replyTarget
    const target = document.querySelector(`[data-message-id="${targetId}"]`)
    if (target) {
      target.classList.add('reply-highlight')
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => target.classList.remove('reply-highlight'), 2000)
    }
    return
  }

  const replyBtn = e.target.closest('.reply-btn')
  if (replyBtn) {
    const msgEl = replyBtn.closest('.message')
    const msgId = replyBtn.dataset.msgId
    const senderEl = msgEl.querySelector('.sender-name')
    const bodyEl = msgEl.querySelector('.message-body')
    replyToId = msgId
    replyToName = senderEl ? senderEl.textContent : 'someone'
    const snippet = bodyEl ? bodyEl.textContent.slice(0, 100) : ''
    replyBannerText.textContent = `Replying to ${replyToName}: ${snippet}`
    replyBanner.classList.remove('hidden')
    input.focus()
  }
})

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
    if (replyToId) {
      body.replyTo = replyToId
      replyToId = null
      replyToName = null
      replyBanner.classList.add('hidden')
    }
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
    el.innerHTML = `<span class="message-time">${formatTime(Date.now())}</span> ${escapeHtml('Send failed: ' + err.message)}`
    messages.appendChild(el)
  }

  sending = false
  sendBtn.disabled = false
  input.focus()
}

async function sendReaction(messageId, emoji, action = 'add') {
  try {
    const body = { messageId, emoji, action, name: myName }
    if (hubMode && currentView && !currentView.startsWith('dm:')) {
      body.room = currentView
    }
    await fetch('/api/chat/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error('Reaction failed:', err)
  }
}

function formatTime(timestamp) {
  if (timestamp == null) return ''
  const d = new Date(timestamp)
  const h = d.getHours()
  const m = d.getMinutes().toString().padStart(2, '0')
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m} ${ampm}`
}

function createToolbar(msgId) {
  const toolbar = document.createElement('div')
  toolbar.className = 'message-toolbar'
  const replyBtn = document.createElement('button')
  replyBtn.className = 'toolbar-btn reply-btn'
  replyBtn.title = 'Reply'
  replyBtn.dataset.msgId = msgId
  replyBtn.textContent = '↩'
  const reactBtn = document.createElement('button')
  reactBtn.className = 'toolbar-btn react-btn'
  reactBtn.title = 'React'
  reactBtn.dataset.msgId = msgId
  reactBtn.textContent = '☺'
  toolbar.appendChild(replyBtn)
  toolbar.appendChild(reactBtn)
  return toolbar
}

function appendMessage(role, text, name, timestamp, fromAgent = false, model = null, messageId = null) {
  const el = document.createElement('div')
  el.className = 'message'
  if (messageId) el.dataset.messageId = messageId
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

    if (model) {
      const modelSpan = document.createElement('span')
      modelSpan.className = 'message-model'
      modelSpan.textContent = model
      meta.appendChild(modelSpan)
    }

    el.appendChild(meta)
  }

  // Inline meta for continuation messages (non-first in a group)
  if (!isFirst) {
    const inlineMeta = document.createElement('div')
    inlineMeta.className = 'inline-meta'
    const timeSpan = document.createElement('span')
    timeSpan.className = 'message-time'
    timeSpan.textContent = formatTime(timestamp) || formatTime(Date.now())
    inlineMeta.appendChild(timeSpan)
    if (model) {
      const modelSpan = document.createElement('span')
      modelSpan.className = 'message-model'
      modelSpan.textContent = model
      inlineMeta.appendChild(modelSpan)
    }
    el.appendChild(inlineMeta)
  }

  lastSender = senderKey

  // Message body
  const body = document.createElement('div')
  body.className = 'message-body'
  body.innerHTML = renderMarkdown(text)
  el.appendChild(body)

  // Hover toolbar (reply + react)
  if (messageId) {
    el.appendChild(createToolbar(messageId))
  }

  messages.appendChild(el)
  scrollToBottom()
  return el
}

function renderReplyHeader(el, replyTo) {
  if (el.querySelector('.reply-header')) return
  const originalEl = document.querySelector(`[data-message-id="${replyTo}"]`)
  const header = document.createElement('div')
  header.className = 'reply-header'

  if (originalEl) {
    const senderEl = originalEl.querySelector('.sender-name')
    const bodyEl = originalEl.querySelector('.message-body')
    const name = senderEl ? senderEl.textContent : 'someone'
    const snippet = bodyEl ? bodyEl.textContent.slice(0, 100) : ''
    const nameSpan = document.createElement('span')
    nameSpan.className = 'reply-header-name'
    nameSpan.textContent = name
    const snippetSpan = document.createElement('span')
    snippetSpan.className = 'reply-header-snippet'
    snippetSpan.textContent = snippet
    header.appendChild(nameSpan)
    header.appendChild(document.createTextNode(' '))
    header.appendChild(snippetSpan)
    header.dataset.replyTarget = replyTo
    header.classList.add('reply-header-linked')
  } else {
    const nameSpan = document.createElement('span')
    nameSpan.className = 'reply-header-name'
    nameSpan.textContent = 'replying to a message'
    header.appendChild(nameSpan)
  }

  // Insert before the message body
  const body = el.querySelector('.message-body')
  if (body) el.insertBefore(header, body)
}

function updateReactionPills(messageId, emoji, name, action) {
  const msgEl = document.querySelector(`[data-message-id="${messageId}"]`)
  if (!msgEl) return

  let container = msgEl.querySelector('.reactions-container')
  if (!container) {
    container = document.createElement('div')
    container.className = 'reactions-container'
    msgEl.appendChild(container)
  }

  // Find existing pill for this emoji
  const pills = container.querySelectorAll('.reaction-pill')
  let pill = null
  for (const p of pills) {
    if (p.dataset.emoji === emoji) { pill = p; break }
  }

  if (action === 'add') {
    if (!pill) {
      pill = document.createElement('button')
      pill.className = 'reaction-pill'
      pill.dataset.emoji = emoji
      pill.dataset.names = JSON.stringify([name])
      const emojiSpan = document.createElement('span')
      emojiSpan.className = 'reaction-emoji'
      emojiSpan.textContent = emoji
      const countSpan = document.createElement('span')
      countSpan.className = 'reaction-count'
      countSpan.textContent = '1'
      pill.appendChild(emojiSpan)
      pill.appendChild(countSpan)
      pill.title = name
      container.appendChild(pill)
    } else {
      const names = JSON.parse(pill.dataset.names || '[]')
      if (!names.includes(name)) {
        names.push(name)
        pill.dataset.names = JSON.stringify(names)
        pill.querySelector('.reaction-count').textContent = String(names.length)
        pill.title = names.join(', ')
      }
    }
    if (pill) {
      const names = JSON.parse(pill.dataset.names || '[]')
      pill.classList.toggle('reaction-mine', names.includes(myName))
    }
  } else if (action === 'remove') {
    if (pill) {
      const existingNames = JSON.parse(pill.dataset.names || '[]')
      const names = existingNames.filter(n => n !== name)
      if (names.length === 0) {
        pill.remove()
        if (container.children.length === 0) container.remove()
      } else {
        pill.dataset.names = JSON.stringify(names)
        pill.querySelector('.reaction-count').textContent = String(names.length)
        pill.title = names.join(', ')
        pill.classList.toggle('reaction-mine', names.includes(myName))
      }
    }
  }
}

function getToolContainer(parentEl) {
  let details = parentEl.querySelector('details.tool-details')
  if (!details) {
    details = document.createElement('details')
    details.className = 'tool-details'
    details.open = true // open during streaming, collapsed on done
    const summary = document.createElement('summary')
    summary.className = 'tool-summary'
    summary.textContent = 'tools'
    details.appendChild(summary)
    // Insert before thinking indicator if present, else append
    const thinking = parentEl.querySelector('.thinking-indicator')
    if (thinking) {
      parentEl.insertBefore(details, thinking)
    } else {
      parentEl.appendChild(details)
    }
  }
  return details
}

function updateToolSummary(details) {
  const count = details.querySelectorAll('.tool-call').length
  const summary = details.querySelector('summary')
  if (summary) summary.textContent = `${count} tool call${count !== 1 ? 's' : ''}`
}

function appendTool(parentEl, text, isError = false, model = null) {
  const details = getToolContainer(parentEl)
  const el = document.createElement('div')
  el.className = isError ? 'tool-call error' : 'tool-call'
  const time = document.createElement('span')
  time.className = 'message-time'
  time.textContent = formatTime(Date.now())
  el.appendChild(time)
  const effectiveModel = model || currentModel
  if (effectiveModel) {
    const modelSpan = document.createElement('span')
    modelSpan.className = 'message-model'
    modelSpan.textContent = effectiveModel
    el.appendChild(modelSpan)
    el.classList.add('has-model')
  }
  el.appendChild(document.createTextNode(' ' + text))
  details.appendChild(el)
  updateToolSummary(details)
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

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}
