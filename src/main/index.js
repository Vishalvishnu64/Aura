import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, desktopCapturer, screen, nativeImage, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import {
  initMemoryService,
  stopMemoryService,
  searchMemory,
  setMemoryPaused,
  getMemoryStatus,
  clearMemory,
  onMemoryStatus
} from './memoryService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const INITIAL_WIDTH = 680             // starting width; user-adjustable 480-1000
const MIN_WIDTH = 480
const MAX_WIDTH = 1000
const MIN_HEIGHT = 180                 // enough room for the composer and status row
const INITIAL_HEIGHT = 236
const MAX_HEIGHT = 900
const HOTKEY = 'CommandOrControl+Shift+Space'
const HOTKEY_LABEL = process.platform === 'darwin' ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space'
const STEALTH_HOTKEY = 'CommandOrControl+Shift+U'
const STEALTH_HOTKEY_LABEL = process.platform === 'darwin' ? 'Cmd+Shift+U' : 'Ctrl+Shift+U'
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_LENGTH = 20 * 1024 * 1024

// Tray icon embedded as base64 (32x32 violet circle, generated at build time)
// so the repository stays free of binary assets.
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABE0lEQVR4nM2XPQ6EIBCFvca2trbewXtQ09pSm8wRbE3mHtbewUtYTeH+JM+EsOquP2QoXkOA9zEDA2RMkmlK1fwMQM4kFZMYJqmZxEE12ir0uR2gZBLLJC2T9EwyMsn0Np+hCW09+liMuQzwwMo6GDz/1IgxBnOcAigQ3uGAcagBcxRHAT4DmoOr3otGswWxFXZ3k7kP4dbSsQZgLoZ9Lx3mF0CJzXO3+aIuPB0hgL059GupsFsAOc5wLPNFrV+sfIAKhSQ2QA+vLwATOfx+GswaQI2SGhtggtcXgENdjw0wwys9APUUqG9C9WOoXojUS3ESl5H6dZzEg0T9SZbEo9RPh9qzPDwdKh+TUGpfs2hSB3gB/tLrw7Anf3kAAAAASUVORK5CYII='

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** @type {BrowserWindow | null} */
let win = null
/** @type {Tray | null} */
let tray = null
let isQuitting = false
// Electron exposes no getContentProtection() getter on BrowserWindow,
// so the stealth state is mirrored here (init matches createWindow).
let contentProtection = true

/**
 * When we hide the window programmatically (hotkey toggle / quit), a `blur`
 * event fires right after. This guard stops blur-to-hide from fighting with
 * our own visibility changes.
 */
let blurGuard = false

const shortcutStatus = {
  summon: {
    accelerator: HOTKEY,
    label: HOTKEY_LABEL,
    registered: false,
    error: null
  },
  stealth: {
    accelerator: STEALTH_HOTKEY,
    label: STEALTH_HOTKEY_LABEL,
    registered: false,
    error: null
  }
}

let audioStatus = {
  state: 'idle',
  channels: null,
  error: null
}
let removeMemoryStatusListener = null
const activeChatRequests = new Map()

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------
function isTrustedRenderer(event) {
  return Boolean(win && !win.isDestroyed() && event?.sender === win.webContents)
}

function describeDisplay(display) {
  if (!display) return null
  return {
    id: String(display.id),
    name: String(display.label || `Display ${display.id}`),
    bounds: {
      x: Number(display.bounds?.x ?? 0),
      y: Number(display.bounds?.y ?? 0),
      width: Number(display.bounds?.width ?? 0),
      height: Number(display.bounds?.height ?? 0)
    },
    scaleFactor: Number(display.scaleFactor || 1)
  }
}

function getOverlayDisplay() {
  if (win && !win.isDestroyed()) return screen.getDisplayMatching(win.getBounds())
  return screen.getPrimaryDisplay()
}

function getCaptureStatus() {
  let overlayDisplay = null
  let primaryDisplay = null
  try {
    overlayDisplay = describeDisplay(getOverlayDisplay())
    primaryDisplay = describeDisplay(screen.getPrimaryDisplay())
  } catch {
    /* Display information can be unavailable during very early startup. */
  }

  return {
    screen: {
      policy: 'display-hosting-overlay',
      display: overlayDisplay
    },
    systemAudio: {
      policy: 'loopback-from-display-hosting-overlay',
      display: overlayDisplay
    },
    memory: {
      policy: 'primary-display',
      display: primaryDisplay
    },
    overlayExcludedFromCapture: contentProtection
  }
}

function getAppStatus() {
  return {
    shortcut: {
      summon: { ...shortcutStatus.summon },
      stealth: { ...shortcutStatus.stealth }
    },
    memory: getMemoryStatus(),
    audio: { ...audioStatus },
    capture: getCaptureStatus()
  }
}

function sendStatusToRenderer() {
  if (tray && !tray.isDestroyed()) {
    const memory = getMemoryStatus()
    const audio = audioStatus.state === 'active' ? ` · ${audioStatus.channels || 'audio'} listening` : ''
    tray.setToolTip(`AI Overlay (${HOTKEY_LABEL}) · Memory ${memory.active ? 'on' : 'paused'}${audio}`)
  }
  const wc = win?.webContents
  if (!wc || wc.isDestroyed() || wc.isLoading()) return false
  try {
    wc.send('overlay:status', getAppStatus())
    return true
  } catch {
    // A reload can dispose the frame between the guards and send(). The next
    // did-finish-load notification will deliver a fresh snapshot.
    return false
  }
}

function cancelChatRequestsForSender(sender) {
  for (const [key, request] of activeChatRequests) {
    if (request.sender !== sender) continue
    request.controller.abort()
    activeChatRequests.delete(key)
  }
}

function createAbortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function getEnvironment() {
  const values = {}
  const candidates = new Set([
    process.env.AI_OVERLAY_ENV_FILE,
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '.env.local')
  ].filter(Boolean))

  try {
    const appPath = app.getAppPath()
    candidates.add(path.join(appPath, '.env'))
    candidates.add(path.join(appPath, '.env.local'))
  } catch {
    /* app.getAppPath() is unavailable only before app readiness. */
  }

  for (const filePath of candidates) {
    try {
      const source = fs.readFileSync(filePath, 'utf8')
      for (const line of source.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_a-z][\w.-]*)\s*=\s*(.*?)\s*$/)
        if (!match || match[1].startsWith('#')) continue
        let value = match[2]
        if (
          value.length >= 2 &&
          ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'")))
        ) {
          value = value.slice(1, -1)
        }
        values[match[1]] = value
      }
    } catch {
      /* Missing .env files are valid; process environment still works. */
    }
  }

  return { ...values, ...process.env }
}

function getAiConfig() {
  const env = getEnvironment()
  return {
    baseUrl: String(env.AI_BASE_URL || env.VITE_AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    apiKey: String(env.AI_API_KEY || env.VITE_AI_API_KEY || ''),
    model: String(env.AI_MODEL || env.VITE_AI_MODEL || 'qwen/qwen3.8-27b'),
    transcribeModel: String(
      env.TRANSCRIBE_MODEL || env.VITE_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo'
    )
  }
}

function validateEndpoint(baseUrl) {
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('AI endpoint URL is invalid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('AI endpoint must use http or https')
  }
  return baseUrl
}

function requireApiKeyForPublicEndpoint(baseUrl, apiKey) {
  if (!apiKey && /(^|\.)api\.(groq|openai)\.com$/i.test(new URL(baseUrl).hostname)) {
    throw new Error('Missing AI API key - set VITE_AI_API_KEY in the main-process environment')
  }
}

function normalizeChatMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('AI request messages must be an array')
  return messages.slice(-100).map((message) => {
    if (!message || typeof message !== 'object') throw new Error('AI request contains an invalid message')
    const role = String(message.role || '')
    if (!['system', 'user', 'assistant'].includes(role)) throw new Error('AI request contains an invalid role')
    return { role, content: String(message.content ?? '') }
  })
}

function buildChatMessages(messages, imageBase64) {
  if (!imageBase64) return messages
  return messages.map((message, index) => {
    const isLastUser = index === messages.length - 1 && message.role === 'user'
    if (!isLastUser) return message
    return {
      role: 'user',
      content: [
        { type: 'text', text: message.content },
        { type: 'image_url', image_url: { url: imageBase64 } }
      ]
    }
  })
}

async function streamChatCompletion({ sender, requestId, request, controller }) {
  const config = getAiConfig()
  const baseUrl = validateEndpoint(config.baseUrl)
  requireApiKeyForPublicEndpoint(baseUrl, config.apiKey)
  const messages = normalizeChatMessages(request.messages)
  const imageBase64 = typeof request.imageBase64 === 'string' ? request.imageBase64 : null
  if (imageBase64 && imageBase64.length > MAX_IMAGE_LENGTH) throw new Error('Attached image is too large')

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      messages: buildChatMessages(messages, imageBase64)
    })
  })

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      /* Body unreadable - keep the status-only error. */
    }
    throw new Error(`AI request failed (${response.status}): ${detail}`)
  }
  if (!response.body) throw new Error('AI response has no readable body')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false

  const consumeLine = (line) => {
    if (!line.startsWith('data:')) return false
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return true
    let parsed
    try {
      parsed = JSON.parse(payload)
    } catch {
      // Providers occasionally send non-JSON keep-alive data lines.
      return false
    }
    const delta = parsed?.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) {
      if (controller.signal.aborted || sender.isDestroyed()) throw createAbortError()
      sender.send('ai:chat:chunk', { requestId, chunk: delta })
    }
    return false
  }

  while (!finished) {
    if (controller.signal.aborted) throw createAbortError()
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trimEnd()
      buffer = buffer.slice(newlineIndex + 1)
      if (consumeLine(line)) {
        finished = true
        break
      }
    }
  }

  if (!finished && buffer) consumeLine(buffer.trimEnd())
}

function toAudioBuffer(data) {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
}

function makeMultipartBody({ bytes, mimeType, model }) {
  const boundary = `----AuraFormBoundary${Date.now().toString(16)}`
  const field = (name, value) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.webm"\r\nContent-Type: ${mimeType}\r\n\r\n`
  )
  const end = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    boundary,
    body: Buffer.concat([field('model', model), field('response_format', 'json'), fileHeader, bytes, end])
  }
}

async function transcribeAudio(request) {
  const bytes = toAudioBuffer(request?.data)
  if (!bytes || bytes.length === 0) return ''
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error('Audio chunk is too large')

  const config = getAiConfig()
  const baseUrl = validateEndpoint(config.baseUrl)
  requireApiKeyForPublicEndpoint(baseUrl, config.apiKey)
  const mimeType = typeof request.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(request.type)
    ? request.type
    : 'audio/webm'
  const multipart = makeMultipartBody({ bytes, mimeType, model: config.transcribeModel })
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
    },
    body: multipart.body
  })

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 200)
    } catch {
      /* Body unreadable. */
    }
    throw new Error(`Transcription failed (${response.status}): ${detail}`)
  }

  const data = await response.json()
  return String(data?.text ?? '').trim()
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea
  // Cap bounds to the spec'd limits without spilling off smaller displays
  const maxWidth = Math.min(MAX_WIDTH, workArea.width)
  const maxHeight = Math.min(MAX_HEIGHT, workArea.height)
  const initialWidth = Math.min(INITIAL_WIDTH, maxWidth)
  const minWidth = Math.min(MIN_WIDTH, maxWidth)

  win = new BrowserWindow({
    width: initialWidth,
    height: INITIAL_HEIGHT,
    x: Math.round(workArea.x + (workArea.width - initialWidth) / 2),
    y: Math.round(workArea.y + workArea.height * 0.16),
    minWidth,
    maxWidth,
    minHeight: MIN_HEIGHT,
    maxHeight,
    show: false,
    // Frameless, transparent overlay look
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    // Overlay behaviour; user-resizable via edge dragging within min/max bounds
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  // Exclude the overlay from screen captures: OBS/Discord/Teams shares and
  // recordings won't show it (Windows: WDA_EXCLUDEFROMCAPTURE,
  // macOS: NSWindowSharingNone). Side effect: our own capture-screen IPC
  // can't see the overlay either - screenshots contain only what's behind it.
  win.setContentProtection(true)

  // Float above fullscreen apps / all virtual desktops where supported
  win.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // The app lives in the tray; closing the window just hides it
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      hideWindow()
    }
  })

  // Blur-to-hide: clicking anywhere outside the overlay dismisses it
  win.on('blur', () => {
    if (!blurGuard && !isQuitting && win.isVisible()) win.hide()
  })

  // Self-heal: if the renderer ever dies (crash, OOM, ...), reload it instead
  // of leaving a blank overlay floating on screen.
  win.webContents.on('did-start-loading', () => {
    // Abort requests owned by the old document before its preload listeners
    // disappear. This prevents chunks being sent into a disposed frame.
    cancelChatRequestsForSender(win.webContents)
  })
  win.webContents.on('did-finish-load', () => {
    sendStatusToRenderer()
  })
  win.webContents.on('render-process-gone', () => {
    cancelChatRequestsForSender(win.webContents)
    if (win && !win.isDestroyed() && !isQuitting) win.webContents.reload()
  })
  win.webContents.on('destroyed', () => cancelChatRequestsForSender(win?.webContents))

  // Send markdown links to the OS browser instead of spawning new windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Auto-grant mic/media so audio capture never hits a permission popup;
  // everything else (geolocation, notifications, ...) stays denied.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  // System-audio loopback via the SUPPORTED getDisplayMedia path. The legacy
  // getUserMedia({ chromeMediaSource: 'desktop' }) route instantly terminates
  // the renderer on recent Electron (bad IPC message, reason 263 - see
  // electron/electron#46369, #47512). We auto-grant the primary display with
  // loopback audio and never show a picker (seamless overlay).
  win.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      const display = getOverlayDisplay()
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then(
        (sources) => {
          const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0]
          if (!source) {
            callback(null)
            return
          }
          callback({
            ...(request.videoRequested ? { video: source } : {}),
            ...(request.audioRequested ? { audio: 'loopback' } : {})
          })
        },
        () => callback(null)
      )
    },
    { useSystemPicker: false }
  )

  if (process.env['ELECTRON_RENDERER_URL']) {
    // Dev server provided by electron-vite
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()

  // Nudge the renderer to focus its input field once we are on screen.
  // The frame can be mid-load (cold start / dev HMR reload) - sending IPC to
  // a disposed or uncommitted frame raises a "bad IPC message" (reason 263)
  // and Chromium terminates the renderer, so only send once the page is live.
  const wc = win.webContents
  const nudge = () => {
    try {
      if (!wc.isDestroyed() && !wc.isLoading()) wc.send('overlay:shown')
    } catch {
      /* frame raced a reload - the next summon focuses normally */
    }
  }
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => setTimeout(nudge, 60))
  } else {
    setTimeout(nudge, 60)
  }
}

function hideWindow() {
  if (!win) return
  blurGuard = true
  win.hide()
  try {
    if (!win.webContents.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('overlay:hidden')
  } catch {
    /* The renderer may be reloading while the window is being hidden. */
  }
  setTimeout(() => {
    blurGuard = false
  }, 150)
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible()) hideWindow()
  else showWindow()
}

// ---------------------------------------------------------------------------
// Tray (the quiet background presence while hidden)
// ---------------------------------------------------------------------------
function createTray() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`)
  tray = new Tray(icon)
  tray.setToolTip(`AI Overlay (${HOTKEY_LABEL})`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Toggle AI Overlay (${HOTKEY_LABEL})`, click: toggleWindow },
      {
        label: 'Pause Photographic Memory',
        type: 'checkbox',
        checked: Boolean(getMemoryStatus().paused),
        click: (item) => {
          setMemoryPaused(item.checked)
          sendStatusToRenderer()
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', toggleWindow)
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpc() {
  removeMemoryStatusListener = onMemoryStatus(() => sendStatusToRenderer())

  // Renderer asked to dismiss the overlay
  ipcMain.handle('hide-window', (event) => {
    if (!isTrustedRenderer(event)) return false
    hideWindow()
    return true
  })

  /**
   * Dynamically grow/shrink the window as chat content expands.
   * Height comes from the renderer's ResizeObserver; clamped here so the
   * overlay can never exceed 80% of the work area.
   */
  ipcMain.handle('resize-window', (event, height) => {
    if (!isTrustedRenderer(event) || !win) return false
    const workArea = screen.getDisplayMatching(win.getBounds()).workArea
    const maxHeight = Math.min(MAX_HEIGHT, workArea.height)
    const nextHeight = Math.max(MIN_HEIGHT, Math.min(Math.ceil(Number(height) || MIN_HEIGHT), maxHeight))
    const [x, y] = win.getPosition() // keep top-left anchored
    const { width } = win.getBounds() // preserve user-chosen width
    win.setBounds({ x, y, width, height: nextHeight })
    return true
  })

  /**
   * Screenshot of the display hosting the overlay -> PNG data URL (base64).
   * The renderer forwards this straight into the vision-capable chat request.
   */
  ipcMain.handle('capture-screen', async (event) => {
    if (!isTrustedRenderer(event) || !win) throw new Error('Overlay window is unavailable')
    const display = getOverlayDisplay()
    const dpr = display.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.floor(display.size.width * dpr),
        height: Math.floor(display.size.height * dpr)
      }
    })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source) throw new Error('No screen capture source found')
    return source.thumbnail.toDataURL()
  })

  /**
   * Stealth mode: toggle (pass true/false) or query (pass undefined) whether
   * the overlay is excluded from screen captures (OBS, Discord, recordings).
   * Always returns the authoritative current state so the renderer can
   * re-sync its badge after a reload.
   */
  ipcMain.handle('set-content-protection', (event, enable) => {
    if (!isTrustedRenderer(event)) return contentProtection
    if (!win) return contentProtection
    if (enable !== undefined) {
      const next = Boolean(enable)
      win.setContentProtection(next)
      contentProtection = next
      sendStatusToRenderer()
    }
    return contentProtection
  })

  /** Full-text search over the photographic-memory index. */
  ipcMain.handle('search-memory', (event, keyword) => {
    if (!isTrustedRenderer(event)) return []
    return searchMemory(keyword)
  })

  /** Renderer-safe operational status snapshot and subscription source. */
  ipcMain.handle('get-app-status', (event) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer')
    return getAppStatus()
  })
  ipcMain.handle('get-memory-status', (event) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer')
    return getMemoryStatus()
  })
  ipcMain.handle('set-memory-paused', (event, paused) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer')
    setMemoryPaused(Boolean(paused))
    sendStatusToRenderer()
    return getMemoryStatus()
  })
  const clearMemoryHandler = async (event) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer')
    const result = await clearMemory()
    sendStatusToRenderer()
    return { ...result, status: getMemoryStatus() }
  }
  ipcMain.handle('clear-memory-history', clearMemoryHandler)
  ipcMain.handle('clear-memory', clearMemoryHandler)
  ipcMain.handle('get-capture-status', (event) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer')
    return getCaptureStatus()
  })

  /**
   * Main-process chat bridge. The renderer receives only text deltas; the API
   * key and network response remain in the main process.
   */
  ipcMain.handle('ai:chat:start', async (event, request) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer')
    const requestId = String(request?.requestId ?? '')
    if (!/^[\w:-]{1,160}$/.test(requestId)) throw new Error('Invalid AI request id')

    const key = `${event.sender.id}:${requestId}`
    const previous = activeChatRequests.get(key)
    if (previous) previous.controller.abort()
    const controller = new AbortController()
    activeChatRequests.set(key, { sender: event.sender, controller })

    try {
      await streamChatCompletion({
        sender: event.sender,
        requestId,
        request: request ?? {},
        controller
      })
      return { ok: true }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return { ok: false, aborted: true }
      throw new Error(error?.message || 'AI request failed', { cause: error })
    } finally {
      if (activeChatRequests.get(key)?.controller === controller) activeChatRequests.delete(key)
    }
  })

  ipcMain.handle('ai:chat:cancel', (event, requestId) => {
    if (!isTrustedRenderer(event)) return false
    const key = `${event.sender.id}:${String(requestId ?? '')}`
    const request = activeChatRequests.get(key)
    if (!request || request.sender !== event.sender) return false
    request.controller.abort()
    return true
  })

  ipcMain.handle('ai:transcribe', async (event, request) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer')
    return transcribeAudio(request)
  })

  ipcMain.handle('report-audio-status', (event, status) => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted renderer')
    const state = ['idle', 'starting', 'active', 'error', 'ended'].includes(status?.state)
      ? status.state
      : 'idle'
    const channels = ['mic', 'mic+system'].includes(status?.channels) ? status.channels : null
    audioStatus = {
      state,
      channels,
      error: typeof status?.error === 'string' ? status.error.slice(0, 300) : null
    }
    sendStatusToRenderer()
    return { ...audioStatus }
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Launching a second instance reveals the existing overlay instead
  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    if (process.platform === 'darwin') app.dock?.hide()
    registerIpc()
    createWindow()
    try {
      initMemoryService()
    } catch (err) {
      console.warn('[memory] init failed:', err.message)
    }
    createTray()

    const registerShortcut = (key, status, callback) => {
      try {
        const registered = globalShortcut.register(key, callback)
        status.registered = Boolean(registered && globalShortcut.isRegistered(key))
        status.error = status.registered ? null : `${status.label} is already registered by another application`
      } catch (error) {
        status.registered = false
        status.error = `${status.label} registration failed: ${error.message}`
      }
      if (!status.registered) console.warn(`[shortcut] ${status.error}`)
    }

    registerShortcut(HOTKEY, shortcutStatus.summon, toggleWindow)
    registerShortcut(STEALTH_HOTKEY, shortcutStatus.stealth, () => {
      const wc = win?.webContents
      if (!win || win.isDestroyed() || !wc || wc.isDestroyed() || wc.isLoading()) return
      try {
        wc.send('stealth:toggle')
      } catch {
        // Renderer reload cleanup will leave the authoritative state intact.
      }
    })
    sendStatusToRenderer()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    if (removeMemoryStatusListener) removeMemoryStatusListener()
    for (const request of activeChatRequests.values()) request.controller.abort()
    activeChatRequests.clear()
    stopMemoryService()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
