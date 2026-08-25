import { contextBridge, ipcRenderer } from 'electron'

/**
 * Secure IPC bridge.
 *
 * Only an explicit, allowlisted surface is exposed to the renderer:
 * - contextIsolation keeps React code in its own JS world
 * - every call goes through ipcRenderer.invoke (promise-based, no raw events)
 * - the renderer can never reach Node APIs or arbitrary channels
 */
contextBridge.exposeInMainWorld('overlay', {
  /** Dismiss the overlay window. */
  hideWindow: () => ipcRenderer.invoke('hide-window'),

  /** Capture the active display; resolves with a base64 PNG data URL. */
  captureScreen: () => ipcRenderer.invoke('capture-screen'),

  /** Grow/shrink the frameless window to fit the chat content. */
  resizeWindow: (height) => ipcRenderer.invoke('resize-window', height),

  /** Stealth mode: pass true/false to toggle capture-exclusion, nothing to query. */
  setContentProtection: (enable) => ipcRenderer.invoke('set-content-protection', enable),

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
  }
})
