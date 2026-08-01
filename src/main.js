import './style.css'

// ============================================
// Configuration
// ============================================

const CONFIG = {
  // API configuration - these will be overridden by serverless function
  apiEndpoint: '/api/chat',  // Proxy through Vercel serverless function
  models: (import.meta.env.VITE_MODELS || 'chatgpt,gemini').split(',').map(m => m.trim()),
  defaultModel: import.meta.env.VITE_DEFAULT_MODEL || 'chatgpt',
  defaultEffort: 'medium',
  storageKey: 'ai-chatbot-history',
  maxMessageLength: 50000,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  allowedFileTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
}

// ============================================
// Model Display Labels
// ============================================

const MODEL_LABELS = {
  gemini: 'Gemini (3.1 Pro)',
  chatgpt: 'Chatgpt (GPT 5.5)',
}

function getModelLabel(model) {
  return MODEL_LABELS[model] || (model.charAt(0).toUpperCase() + model.slice(1))
}

// ============================================
// State
// ============================================

const state = {
  chats: [],           // All saved chats
  currentChatId: null, // Currently active chat ID
  currentModel: CONFIG.defaultModel,
  currentEffort: CONFIG.defaultEffort,
  isStreaming: false,
  attachedFiles: [],
  sidebarOpen: window.innerWidth > 768, // Auto-open on desktop
}

// ============================================
// DOM References
// ============================================

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => document.querySelectorAll(sel)

const dom = {
  sidebar: $('#sidebar'),
  sidebarToggle: $('#sidebar-toggle'),
  chatList: $('#chat-list'),
  newChatBtn: $('#new-chat-btn'),
  chatTitle: $('.chat-title'),
  clearAllBtn: $('#clear-all-btn'),
  searchChat: $('#search-chat'),
  chatCount: $('#chat-count'),

  modelSelect: $('#model-select'),
  effortSelect: $('#effort-select'),

  messagesContainer: $('#messages-container'),
  messages: $('#messages'),
  welcomeScreen: $('#welcome-screen'),

  messageInput: $('#message-input'),
  sendBtn: $('#send-btn'),
  attachBtn: $('#attach-btn'),
  fileInput: $('#file-input'),
  filePreview: $('#file-preview'),
  fileName: $('#file-name'),
  removeFileBtn: $('#remove-file'),

  typingIndicator: $('#typing-indicator'),

  modalOverlay: $('#modal-overlay'),
  modalCancel: $('#modal-cancel'),
  modalConfirm: $('#modal-confirm'),
}

// ============================================
// Storage
// ============================================

const storage = {
  getChats() {
    try {
      const data = localStorage.getItem(CONFIG.storageKey)
      return data ? JSON.parse(data) : []
    } catch {
      return []
    }
  },

  saveChats(chats) {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(chats))
    } catch (e) {
      console.error('Failed to save chats:', e)
      // If storage is full, try removing oldest chats
      if (e.name === 'QuotaExceededError') {
        chats.splice(0, Math.ceil(chats.length / 2))
        localStorage.setItem(CONFIG.storageKey, JSON.stringify(chats))
      }
    }
  },

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9)
  },

  formatTime(timestamp) {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now - date
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    if (days < 7) return `${days}d ago`
    
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  },

  getChatTitle(messages) {
    if (!messages || messages.length === 0) return 'New Chat'
    const firstUserMsg = messages.find(m => m.role === 'user')
    if (!firstUserMsg) return 'New Chat'
    const text = firstUserMsg.content
      .replace(/<[^>]*>/g, '')
      .replace(/\n/g, ' ')
      .trim()
    return text.length > 50 ? text.substring(0, 50) + '...' : text
  }
}

// ============================================
// Markdown Renderer (Simple)
// ============================================

function renderMarkdown(text) {
  if (!text) return ''

  // Escape HTML first
  let html = text
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')

  // Code blocks (must be before inline code)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const escaped = code.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
    return `<pre><code class="language-${lang || ''}">${escaped}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Bold and italic
  html = html.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>')

  // Strikethrough
  html = html.replace(/~~(.*?)~~/g, '<del>$1</del>')

  // Blockquotes
  html = html.replace(/^>\s?(.*)$/gm, '<blockquote>$1</blockquote>')

  // Images (must be before links)
  html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1" loading="lazy">')

  // Links
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  // Unordered lists
  html = html.replace(/^[\s]*[-*+]\s+(.*)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')

  // Ordered lists
  html = html.replace(/^[\s]*\d+\.\s+(.*)$/gm, '<li>$1</li>')
  html = html.replace(/(?:<li>.*<\/li>\n?)+/g, (match) => {
    if (!match.match(/<\/ul>|<ul>/)) {
      return '<ol>' + match + '</ol>'
    }
    return match
  })

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, '</p><p>')

  // Single newlines within paragraphs
  html = html.replace(/\n/g, '<br>')

  // Wrap in paragraph if not already wrapped
  if (!html.startsWith('<')) {
    html = '<p>' + html + '</p>'
  }

  // Clean up empty paragraphs and fix nested blockquotes
  html = html.replace(/<p><\/p>/g, '')
  html = html.replace(/<blockquote><\/blockquote>/g, '')

  return html
}

// ============================================
// Chat Management
// ============================================

function createNewChat() {
  // Reset thinking to the default (Medium) for every new chat
  state.currentEffort = CONFIG.defaultEffort
  dom.effortSelect.value = state.currentEffort

  const chat = {
    id: storage.generateId(),
    title: 'New Chat',
    messages: [],
    model: state.currentModel,
    effort: state.currentEffort,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  state.chats.unshift(chat)
  state.currentChatId = chat.id
  storage.saveChats(state.chats)
  renderChatList()
  loadChat(chat.id)
  updateChatCount()
  return chat
}

function loadChat(chatId) {
  const chat = state.chats.find(c => c.id === chatId)
  if (!chat) return

  state.currentChatId = chatId
  state.currentModel = chat.model || CONFIG.defaultModel
  state.currentEffort = chat.effort || CONFIG.defaultEffort

  // Update UI
  dom.modelSelect.value = state.currentModel
  dom.effortSelect.value = state.currentEffort
  dom.chatTitle.textContent = chat.messages.length > 0 ? chat.title : ''

  // Show messages
  if (chat.messages.length === 0) {
    showWelcomeScreen()
  } else {
    renderMessages(chat.messages)
  }

  // Update sidebar active state
  renderChatList()

  // Enable input if not streaming
  if (!state.isStreaming) {
    dom.messageInput.disabled = false
    dom.sendBtn.disabled = !dom.messageInput.value.trim()
  }
}

function deleteChat(chatId) {
  state.chats = state.chats.filter(c => c.id !== chatId)
  storage.saveChats(state.chats)

  if (state.currentChatId === chatId) {
    if (state.chats.length > 0) {
      loadChat(state.chats[0].id)
    } else {
      state.currentChatId = null
      showWelcomeScreen()
    }
  }

  renderChatList()
  updateChatCount()
}

function clearAllChats() {
  state.chats = []
  state.currentChatId = null
  storage.saveChats(state.chats)
  renderChatList()
  showWelcomeScreen()
  updateChatCount()
}

function getCurrentChat() {
  return state.chats.find(c => c.id === state.currentChatId)
}

// ============================================
// Rendering
// ============================================

function renderMessages(messages) {
  if (!messages || messages.length === 0) {
    showWelcomeScreen()
    return
  }

  hideWelcomeScreen()
  dom.messages.innerHTML = ''

  messages.forEach((msg, index) => {
    const isUser = msg.role === 'user'
    const isError = msg.role === 'error'
    const time = msg.timestamp ? storage.formatTime(msg.timestamp) : ''

    const messageEl = document.createElement('div')
    messageEl.className = `message ${isError ? 'message-error' : ''}`
    messageEl.dataset.index = index

    const avatarIcon = isUser ? 'fa-user' : (isError ? 'fa-exclamation-triangle' : 'fa-robot')
    const role = isUser ? 'You' : (isError ? 'Error' : 'AI')

    let bubbleContent = ''
    if (msg.fileAttachment) {
      if (msg.fileAttachment.type.startsWith('image/')) {
        bubbleContent += `<div class="message-file-attachment"><img src="${msg.fileAttachment.data}" alt="${msg.fileAttachment.name}"></div>`
      } else {
        bubbleContent += `<div class="message-file-attachment"><i class="fas fa-file"></i> ${msg.fileAttachment.name}</div>`
      }
    }
    bubbleContent += renderMarkdown(msg.content)

    messageEl.innerHTML = `
      <div class="message-avatar ${isUser ? 'user' : 'ai'}">
        <i class="fas ${avatarIcon}"></i>
      </div>
      <div class="message-content">
        <div class="message-header">
          <span class="message-role">${role}</span>
          <span class="message-time">${time}</span>
          <button class="copy-btn" title="Copy message"><i class="fas fa-copy"></i></button>
        </div>
        <div class="message-bubble ${isUser ? 'user' : 'ai'}">
          ${bubbleContent}
        </div>
      </div>
    `

    dom.messages.appendChild(messageEl)
  })

  scrollToBottom()
  attachCopyButtons()
}

function appendMessage(message) {
  const messagesEl = dom.messages
  const isUser = message.role === 'user'
  const isError = message.role === 'error'
  const time = message.timestamp ? storage.formatTime(message.timestamp) : ''

  const messageEl = document.createElement('div')
  messageEl.className = `message ${isError ? 'message-error' : ''}`
  messageEl.dataset.index = messagesEl.children.length

  const avatarIcon = isUser ? 'fa-user' : (isError ? 'fa-exclamation-triangle' : 'fa-robot')
  const role = isUser ? 'You' : (isError ? 'Error' : 'AI')

  let bubbleContent = ''
  if (message.fileAttachment) {
    if (message.fileAttachment.type.startsWith('image/')) {
      bubbleContent += `<div class="message-file-attachment"><img src="${message.fileAttachment.data}" alt="${message.fileAttachment.name}"></div>`
    } else {
      bubbleContent += `<div class="message-file-attachment"><i class="fas fa-file"></i> ${message.fileAttachment.name}</div>`
    }
  }
  bubbleContent += renderMarkdown(message.content)

  messageEl.innerHTML = `
    <div class="message-avatar ${isUser ? 'user' : 'ai'}">
      <i class="fas ${avatarIcon}"></i>
    </div>
    <div class="message-content">
      <div class="message-header">
        <span class="message-role">${role}</span>
        <span class="message-time">${time}</span>
        <button class="copy-btn" title="Copy message"><i class="fas fa-copy"></i></button>
      </div>
      <div class="message-bubble ${isUser ? 'user' : 'ai'}">
        ${bubbleContent}
      </div>
    </div>
  `

  messagesEl.appendChild(messageEl)
  scrollToBottom()
  attachCopyButtons()
}

function updateLastAIMessage(content) {
  const messagesEl = dom.messages
  const lastMessage = messagesEl.querySelector('.message:last-child .message-bubble.ai')
  if (lastMessage) {
    lastMessage.innerHTML = renderMarkdown(content)
    scrollToBottom()
  }
}

function getLastAIMessageEl() {
  const messagesEl = dom.messages
  return messagesEl.querySelector('.message:last-child .message-bubble.ai')
}

function showWelcomeScreen() {
  dom.welcomeScreen.style.display = 'flex'
  dom.messages.style.display = 'none'
  dom.messages.innerHTML = ''
  dom.chatTitle.textContent = ''
}

function hideWelcomeScreen() {
  dom.welcomeScreen.style.display = 'none'
  dom.messages.style.display = 'block'
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight
  })
}

function attachCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const bubble = btn.closest('.message').querySelector('.message-bubble')
      const text = bubble.textContent.trim()
      navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = '<i class="fas fa-check"></i>'
        setTimeout(() => {
          btn.innerHTML = '<i class="fas fa-copy"></i>'
        }, 2000)
      })
    })
  })
}

function renderChatList() {
  dom.chatList.innerHTML = ''

  if (state.chats.length === 0) {
    dom.chatList.innerHTML = `
      <div class="chat-list-empty">
        <i class="fas fa-comments"></i>
        <p>No chat history yet</p>
      </div>
    `
    return
  }

  const query = dom.searchChat.value.toLowerCase().trim()

  state.chats.forEach(chat => {
    if (query) {
      const titleMatch = chat.title.toLowerCase().includes(query)
      const msgMatch = chat.messages.some(m => m.content.toLowerCase().includes(query))
      if (!titleMatch && !msgMatch) return
    }

    const item = document.createElement('div')
    item.className = `chat-list-item ${chat.id === state.currentChatId ? 'active' : ''}`
    item.dataset.id = chat.id

    item.innerHTML = `
      <div class="chat-list-item-info">
        <div class="chat-list-item-title">${chat.title}</div>
        <div class="chat-list-item-preview">${chat.messages.length} messages</div>
        <div class="chat-list-item-time">${storage.formatTime(chat.updatedAt)}</div>
      </div>
      <button class="chat-item-delete" title="Delete chat" aria-label="Delete chat">
        <i class="fas fa-trash-alt"></i>
      </button>
    `

    item.addEventListener('click', () => {
      if (state.isStreaming) return
      loadChat(chat.id)
    })

    // Delete button
    item.querySelector('.chat-item-delete').addEventListener('click', (e) => {
      e.stopPropagation()
      deleteChat(chat.id)
    })

    // Right-click to delete
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      deleteChat(chat.id)
    })

    dom.chatList.appendChild(item)
  })

  updateChatCount()
}

function updateChatCount() {
  dom.chatCount.textContent = `${state.chats.length} chat${state.chats.length !== 1 ? 's' : ''}`
}

// ============================================
// File Handling
// ============================================

function handleFileSelect(files) {
  if (!files || files.length === 0) return

  // Limit to one attachment at a time for simplicity with current API
  const file = files[0]

  if (file.size > CONFIG.maxFileSize) {
    alert(`File too large. Maximum size is ${CONFIG.maxFileSize / 1024 / 1024}MB.`)
    return
  }

  if (!CONFIG.allowedFileTypes.includes(file.type)) {
    alert(`File type ${file.type} is not supported.`)
    return
  }

  const reader = new FileReader()
  reader.onload = (e) => {
    state.attachedFiles = [{
      name: file.name,
      type: file.type,
      data: e.target.result,
      size: file.size,
    }]

    dom.fileName.textContent = file.name
    dom.filePreview.style.display = 'block'
    dom.messageInput.focus()
  }
  reader.readAsDataURL(file)
}

function removeAttachedFile() {
  state.attachedFiles = []
  dom.filePreview.style.display = 'none'
  dom.fileInput.value = ''
}

// ============================================
// API Communication
// ============================================

async function sendMessage() {
  // If no active chat (e.g. after clearing all history), start one before sending
  if (!state.currentChatId) {
    createNewChat()
  }

  const chat = getCurrentChat()
  if (!chat || state.isStreaming) return

  const text = dom.messageInput.value.trim()
  const hasFile = state.attachedFiles.length > 0

  if (!text && !hasFile) return

  // Hide welcome screen on first message
  hideWelcomeScreen()

  // Create user message
  const userMessage = {
    role: 'user',
    content: text,
    timestamp: Date.now(),
    fileAttachment: state.attachedFiles.length > 0 ? state.attachedFiles[0] : null,
  }

  chat.messages.push(userMessage)
  chat.updatedAt = Date.now()
  chat.title = storage.getChatTitle(chat.messages)
  chat.model = state.currentModel
  chat.effort = state.currentEffort
  dom.chatTitle.textContent = chat.title

  storage.saveChats(state.chats)
  renderChatList()

  // Append user message to UI
  appendMessage(userMessage)

  // Clear input
  dom.messageInput.value = ''
  dom.messageInput.style.height = 'auto'
  dom.sendBtn.disabled = true
  removeAttachedFile()

  // Create placeholder AI message
  const aiMessage = {
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
  }
  chat.messages.push(aiMessage)

  // Append empty AI message (will be updated)
  hideWelcomeScreen()
  appendMessage({
    role: 'assistant',
    content: '...',
    timestamp: Date.now(),
  })

  // Show typing indicator
  state.isStreaming = true
  dom.typingIndicator.style.display = 'flex'
  dom.messageInput.disabled = true

  try {
    // Prepare messages for API
    const apiMessages = prepareAPIMessages(chat.messages)

    const response = await fetch(CONFIG.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: state.currentModel,
        effort: state.currentEffort,
        messages: apiMessages,
        stream: true,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(errorText || `API error: ${response.status}`)
    }

    // Handle streaming response
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let fullContent = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split('\n')

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const content = parsed.choices?.[0]?.delta?.content || ''
            const reasoningContent = parsed.choices?.[0]?.delta?.reasoning_content || ''
            fullContent += content + reasoningContent
            updateLastAIMessage(fullContent)
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }
    }

    // Update the AI message with complete content
    aiMessage.content = fullContent
    aiMessage.timestamp = Date.now()

  } catch (error) {
    console.error('API Error:', error)

    // Update the AI message as error
    aiMessage.role = 'error'
    aiMessage.content = `**Error:** ${error.message || 'Failed to get response from AI. Please try again.'}`

    // Re-render last message as error
    updateLastAIMessage(aiMessage.content)
  } finally {
    state.isStreaming = false
    dom.typingIndicator.style.display = 'none'
    dom.messageInput.disabled = false
    dom.messageInput.focus()

    // Save updated chat
    storage.saveChats(state.chats)
  }
}

function prepareAPIMessages(messages) {
  const apiMessages = []

  for (const msg of messages) {
    if (msg.role === 'error') continue

    if (msg.role === 'assistant' && !msg.content) continue

    if (msg.fileAttachment) {
      const file = msg.fileAttachment
      if (file.type.startsWith('image/')) {
        apiMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: msg.content || 'Analyze this image.' },
            { type: 'image_url', image_url: { url: file.data } },
          ],
        })
      } else {
        apiMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: msg.content || '' },
            { type: 'text', text: `[Attached file: ${file.name}]` },
          ],
        })
      }
    } else {
      apiMessages.push({
        role: msg.role,
        content: msg.content,
      })
    }
  }

  return apiMessages
}

// ============================================
// Event Listeners
// ============================================

function initEventListeners() {
  // New chat buttons
  dom.newChatBtn.addEventListener('click', () => {
    if (state.isStreaming) return
    createNewChat()
  })

  // Sidebar toggle
  dom.sidebarToggle.addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen
    dom.sidebar.classList.toggle('open', state.sidebarOpen)
  })

  // Auto-sync sidebar default with the viewport: open on desktop, closed on mobile
  let sidebarResizeTimer
  window.addEventListener('resize', () => {
    clearTimeout(sidebarResizeTimer)
    sidebarResizeTimer = setTimeout(() => {
      const shouldBeOpen = window.innerWidth > 768
      if (state.sidebarOpen !== shouldBeOpen) {
        state.sidebarOpen = shouldBeOpen
        dom.sidebar.classList.toggle('open', shouldBeOpen)
      }
    }, 100)
  })

  // Close sidebar when clicking outside on mobile
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 && state.sidebarOpen) {
      const isSidebar = dom.sidebar.contains(e.target)
      const isToggle = dom.sidebarToggle.contains(e.target)
      if (!isSidebar && !isToggle) {
        state.sidebarOpen = false
        dom.sidebar.classList.remove('open')
      }
    }
  })

  // Clear all chats
  dom.clearAllBtn.addEventListener('click', () => {
    if (state.chats.length === 0) return
    dom.modalOverlay.style.display = 'flex'
  })

  dom.modalCancel.addEventListener('click', () => {
    dom.modalOverlay.style.display = 'none'
  })

  dom.modalConfirm.addEventListener('click', () => {
    clearAllChats()
    dom.modalOverlay.style.display = 'none'
  })

  dom.modalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.modalOverlay) {
      dom.modalOverlay.style.display = 'none'
    }
  })

  // Search chats
  dom.searchChat.addEventListener('input', () => {
    renderChatList()
  })

  // Model selection
  dom.modelSelect.addEventListener('change', () => {
    state.currentModel = dom.modelSelect.value

    const chat = getCurrentChat()
    if (chat) {
      chat.model = state.currentModel
      storage.saveChats(state.chats)
    }
  })

  // Effort selection
  dom.effortSelect.addEventListener('change', () => {
    state.currentEffort = dom.effortSelect.value

    const chat = getCurrentChat()
    if (chat) {
      chat.effort = state.currentEffort
      storage.saveChats(state.chats)
    }
  })

  // Message input
  dom.messageInput.addEventListener('input', () => {
    // Auto-resize textarea
    dom.messageInput.style.height = 'auto'
    dom.messageInput.style.height = Math.min(dom.messageInput.scrollHeight, 120) + 'px'

    // Enable/disable send button
    const hasText = dom.messageInput.value.trim().length > 0
    const hasFile = state.attachedFiles.length > 0
    dom.sendBtn.disabled = !(hasText || hasFile)

    // Character limit check
    if (dom.messageInput.value.length > CONFIG.maxMessageLength) {
      dom.messageInput.value = dom.messageInput.value.substring(0, CONFIG.maxMessageLength)
    }
  })

  dom.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      dom.sendBtn.click()
    }
  })

  // Send button
  dom.sendBtn.addEventListener('click', sendMessage)

  // File attachment
  dom.attachBtn.addEventListener('click', () => {
    dom.fileInput.click()
  })

  dom.fileInput.addEventListener('change', () => {
    handleFileSelect(dom.fileInput.files)
  })

  dom.removeFileBtn.addEventListener('click', removeAttachedFile)

  // Drag and drop file support
  let dragCounter = 0

  document.addEventListener('dragenter', (e) => {
    e.preventDefault()
    dragCounter++
  })

  document.addEventListener('dragleave', (e) => {
    e.preventDefault()
    dragCounter--
  })

  document.addEventListener('dragover', (e) => {
    e.preventDefault()
  })

  document.addEventListener('drop', (e) => {
    e.preventDefault()
    dragCounter = 0
    handleFileSelect(e.dataTransfer.files)
  })

  // Quick action buttons
  document.querySelectorAll('.quick-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt
      if (!prompt) return

      if (!state.currentChatId) {
        createNewChat()
      }

      dom.messageInput.value = prompt
      dom.messageInput.dispatchEvent(new Event('input'))
      dom.sendBtn.click()
    })
  })
}

// ============================================
// Model Configuration
// ============================================

function initModels() {
  dom.modelSelect.innerHTML = ''

  CONFIG.models.forEach(model => {
    const option = document.createElement('option')
    option.value = model
    option.textContent = getModelLabel(model)
    dom.modelSelect.appendChild(option)
  })

  dom.modelSelect.value = CONFIG.defaultModel
  dom.effortSelect.value = CONFIG.defaultEffort
}

// ============================================
// Initialization
// ============================================

function init() {
  // Load models
  initModels()

  // Load chat history
  state.chats = storage.getChats()

  // Set sidebar state based on screen size
  dom.sidebar.classList.toggle('open', state.sidebarOpen)

  // Initialize event listeners
  initEventListeners()

  // Load last active chat or create a default chat
  if (state.chats.length > 0) {
    loadChat(state.chats[0].id)
  } else {
    createNewChat()
  }

  // Update chat count
  updateChatCount()
  renderChatList()
}

// Start the app
document.addEventListener('DOMContentLoaded', init)