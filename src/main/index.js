import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, desktopCapturer, screen, nativeImage, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initMemoryService, stopMemoryService, searchMemory, setMemoryPaused } from './memoryService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const INITIAL_WIDTH = 680             // starting width; user-adjustable 480-1000
const MIN_WIDTH = 480
const MAX_WIDTH = 1000
const MIN_HEIGHT = 80                 // collapsed search-bar state
const MAX_HEIGHT = 900
const HOTKEY = 'CommandOrControl+Shift+Space'
const HOTKEY_LABEL = process.platform === 'darwin' ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space'

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

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------
function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea
  // Cap bounds to the spec'd limits without spilling off smaller displays
  const maxWidth = Math.min(MAX_WIDTH, workArea.width)
  const maxHeight = Math.min(MAX_HEIGHT, workArea.height)

  win = new BrowserWindow({
    width: INITIAL_WIDTH,
    height: 96,
    x: Math.round(workArea.x + (workArea.width - INITIAL_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height * 0.16),
    minWidth: MIN_WIDTH,
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
  win.webContents.on('render-process-gone', () => {
    if (win && !win.isDestroyed()) win.webContents.reload()
  })

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
    (_request, callback) => {
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then(
        (sources) => callback(sources.length ? { video: sources[0], audio: 'loopback' } : null),
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
        checked: false,
        click: (item) => setMemoryPaused(item.checked)
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
  // Renderer asked to dismiss the overlay
  ipcMain.handle('hide-window', () => {
    hideWindow()
    return true
  })

  /**
   * Dynamically grow/shrink the window as chat content expands.
   * Height comes from the renderer's ResizeObserver; clamped here so the
   * overlay can never exceed 80% of the work area.
   */
  ipcMain.handle('resize-window', (_event, height) => {
    if (!win) return false
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
  ipcMain.handle('capture-screen', async () => {
    const display = screen.getDisplayMatching(win.getBounds())
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
  ipcMain.handle('set-content-protection', (_event, enable) => {
    if (!win) return contentProtection
    if (enable !== undefined) {
      const next = Boolean(enable)
      win.setContentProtection(next)
      contentProtection = next
    }
    return contentProtection
  })

  /** Full-text search over the photographic-memory index. */
  ipcMain.handle('search-memory', (_event, keyword) => searchMemory(keyword))
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
    createTray()
    globalShortcut.register(HOTKEY, toggleWindow)
    try {
      initMemoryService()
    } catch (err) {
      console.warn('[memory] init failed:', err.message)
    }
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    stopMemoryService()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
