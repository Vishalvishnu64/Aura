import { contextBridge, ipcRenderer } from 'electron'

/**
 * Secure IPC bridge.
 *
 * Only an explicit, allowlisted surface is exposed to the renderer:
 * - contextIsolation keeps React code in its own JS world
 * - every command goes through ipcRenderer.invoke (promise-based)
 * - event subscriptions are bound to fixed, application-owned channels
 * - the renderer can never reach Node APIs or arbitrary channels
 */
contextBridge.exposeInMainWorld('overlay', {
  /** Dismiss the overlay window. */
  hideWindow: () => ipcRenderer.invoke('hide-window'),

  /** Capture the active display; resolves with a base64 PNG data URL. */
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  /** Grow/shrink the frameless window to fit the active panel. */
  resizeWindow: (height) => ipcRenderer.invoke('resize-window', height),

  /** Stealth mode: pass true/false to toggle capture-exclusion, nothing to query. */
  setContentProtection: (enable) => ipcRenderer.invoke('set-content-protection', enable),

  /** Renderer-safe operational state (shortcut, memory, audio, and capture policy). */
  getStatus: () => ipcRenderer.invoke('get-app-status'),

  /** Subscribe to renderer-safe operational state changes. */
  onStatus: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('overlay:status', listener)
    return () => ipcRenderer.removeListener('overlay:status', listener)
  },

  /** Memory status and local retention controls. */
  getMemoryStatus: () => ipcRenderer.invoke('get-memory-status'),
  setMemoryPaused: (paused) => ipcRenderer.invoke('set-memory-paused', Boolean(paused)),
  clearMemoryHistory: () => ipcRenderer.invoke('clear-memory-history'),

  /** Explicit display policy used by screen, loopback-audio, and memory capture. */
  getCaptureStatus: () => ipcRenderer.invoke('get-capture-status'),

  /** Send audio bytes to the main-process transcription bridge. */
  sendToTranscription: (request) => ipcRenderer.invoke('ai:transcribe', request),
  reportAudioStatus: (status) => ipcRenderer.invoke('report-audio-status', status),

  /** Start/cancel a main-process streaming chat request. */
  startChat: (request) => ipcRenderer.invoke('ai:chat:start', request),
  cancelChat: (requestId) => ipcRenderer.invoke('ai:chat:cancel', requestId),
  onChatChunk: (requestId, callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, payload) => {
      if (payload?.requestId === requestId && typeof payload.chunk === 'string') callback(payload.chunk)
    }
    ipcRenderer.on('ai:chat:chunk', listener)
    return () => ipcRenderer.removeListener('ai:chat:chunk', listener)
  },

  /** Full-text search over the photographic-memory index. */
  searchMemory: (keyword) => ipcRenderer.invoke('search-memory', keyword),

  /** Authorized local-file search and safe file actions. */
  filesGetFolders: () => ipcRenderer.invoke('files:get-folders'),
  filesPickFolder: () => ipcRenderer.invoke('files:pick-folder'),
  filesRemoveFolder: (folderPath) => ipcRenderer.invoke('files:remove-folder', folderPath),
  filesSearch: (query) => ipcRenderer.invoke('files:search', query),
  filesOpen: (filePath) => ipcRenderer.invoke('files:open', filePath),
  filesReveal: (filePath) => ipcRenderer.invoke('files:reveal', filePath),
  filesCopyPath: (filePath) => ipcRenderer.invoke('files:copy-path', filePath),

  /** Local checklist persistence. */
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  tasksCreate: (title) => ipcRenderer.invoke('tasks:create', title),
  tasksUpdate: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
  tasksDelete: (id) => ipcRenderer.invoke('tasks:delete', id),
  tasksClearCompleted: () => ipcRenderer.invoke('tasks:clear-completed'),

  /**
   * Fired by main every time the overlay is summoned via hotkey/tray,
   * so the renderer can focus the input field.
   * @param {() => void} callback
   * @returns {() => void} unsubscribe function
   */
  onShown: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('overlay:shown', listener)
    return () => ipcRenderer.removeListener('overlay:shown', listener)
  },

  /** Fired when the overlay is dismissed; active audio capture is stopped by the UI. */
  onHidden: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = () => callback()
    ipcRenderer.on('overlay:hidden', listener)
    return () => ipcRenderer.removeListener('overlay:hidden', listener)
  },

  /**
   * Fired by main when the global Ctrl/Cmd+Shift+U hotkey is pressed, so the
   * renderer can flip Stealth Mode from anywhere in the OS.
   * @param {() => void} callback
   * @returns {() => void} unsubscribe function
   */
  onToggleStealth: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = () => {
      callback()
    }
    ipcRenderer.on('stealth:toggle', listener)
    return () => ipcRenderer.removeListener('stealth:toggle', listener)
  }
})
