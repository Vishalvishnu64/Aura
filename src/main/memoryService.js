import { app, desktopCapturer, screen, powerMonitor } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import Database from 'better-sqlite3'
import { createWorker } from 'tesseract.js'

/**
 * Photographic Memory Loop
 *
 * Captures the primary screen every INTERVAL_MS, saves a compressed JPEG to
 * userData/memory_frames, extracts its text with a shared tesseract.js
 * worker, and stores everything in a better-sqlite3 database with an FTS5
 * full-text index for instant searching.
 *
 * Self-protections:
 * - busy-skip: a tick is dropped if the previous OCR is still running
 * - unchanged-screen skip: a 96x54 bitmap compare skips idle screens entirely
 * - power awareness: capture pauses on lock-screen / suspend
 * - retention cron: frames older than RETENTION_DAYS are purged (row + file)
 */

// --- Tunables -------------------------------------------------------------
const INTERVAL_MS = 15_000
const RETENTION_DAYS = 7
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const FRAME_WIDTH = 1600 // px, capture width (height follows display aspect)
const JPEG_QUALITY = 60
const CHANGE_CHECK = { width: 96, height: 54 } // tiny bitmap for change detect
const SEARCH_LIMIT = 50

// --- State -----------------------------------------------------------------
let db = null
let worker = null
let captureTimer = null
let cleanupTimer = null
let isProcessing = false
let lastChangeHash = null // Buffer of the tiny bitmap from the previous frame
let userPaused = false // tray toggle
let systemPaused = false // lock-screen / suspend

let framesDir = null
let tessdataDir = null
let stmtInsert = null
let stmtCleanupSelect = null
let stmtCleanupDelete = null
let stmtSearch = null

const powerListeners = {
  pause: () => {
    systemPaused = true
  },
  resume: () => {
    systemPaused = false
  }
}

// --- Schema ----------------------------------------------------------------
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memory_frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    image_path TEXT,
    ocr_text TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_frames_timestamp ON memory_frames(timestamp);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    ocr_text, content='memory_frames', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS memory_frames_ai AFTER INSERT ON memory_frames BEGIN
    INSERT INTO memory_fts(rowid, ocr_text) VALUES (new.id, new.ocr_text);
  END;
  CREATE TRIGGER IF NOT EXISTS memory_frames_ad AFTER DELETE ON memory_frames BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, ocr_text) VALUES ('delete', old.id, old.ocr_text);
  END;
`

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------
export function initMemoryService() {
  const userData = app.getPath('userData')
  framesDir = path.join(userData, 'memory_frames')
  tessdataDir = path.join(userData, 'tessdata')
  fs.mkdirSync(framesDir, { recursive: true })
  fs.mkdirSync(tessdataDir, { recursive: true })

  db = new Database(path.join(userData, 'photographic-memory.db'))
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)

  stmtInsert = db.prepare('INSERT INTO memory_frames (image_path, ocr_text) VALUES (?, ?)')
  stmtCleanupSelect = db.prepare(
    'SELECT id, image_path FROM memory_frames WHERE timestamp < datetime(?, ?)'
  )
  stmtCleanupDelete = db.prepare(
    'DELETE FROM memory_frames WHERE timestamp < datetime(?, ?)'
  )
  stmtSearch = db.prepare(`
    SELECT f.id, f.timestamp, f.image_path,
           snippet(memory_fts, 0, '[', ']', '…', 12) AS snippet
    FROM memory_fts
    JOIN memory_frames f ON f.id = memory_fts.rowid
    WHERE memory_fts MATCH ?
    ORDER BY f.timestamp DESC
    LIMIT ${SEARCH_LIMIT}
  `)

  cleanupOldFrames()
  cleanupTimer = setInterval(cleanupOldFrames, CLEANUP_INTERVAL_MS)

  // Pause on lock-screen / suspend (Windows + macOS), resume afterwards
  powerMonitor.on('lock-screen', powerListeners.pause)
  powerMonitor.on('suspend', powerListeners.pause)
  powerMonitor.on('unlock-screen', powerListeners.resume)
  powerMonitor.on('resume', powerListeners.resume)

  captureTimer = setInterval(() => {
    captureTick().catch((err) => console.warn('[memory] tick failed:', err.message))
  }, INTERVAL_MS)

  console.log(`[memory] photographic memory loop started (every ${INTERVAL_MS / 1000}s)`)
}

export function stopMemoryService() {
  if (captureTimer) clearInterval(captureTimer)
  if (cleanupTimer) clearInterval(cleanupTimer)
  captureTimer = null
  cleanupTimer = null
  powerMonitor.removeListener('lock-screen', powerListeners.pause)
  powerMonitor.removeListener('suspend', powerListeners.pause)
  powerMonitor.removeListener('unlock-screen', powerListeners.resume)
  powerMonitor.removeListener('resume', powerListeners.resume)
  const jobs = []
  if (worker) jobs.push(worker.terminate().catch(() => {}))
  worker = null
  if (db) db.close()
  db = null
  return Promise.all(jobs)
}

/** Tray toggle: pause/resume capture while keeping the DB intact. */
export function setMemoryPaused(paused) {
  userPaused = Boolean(paused)
  console.log(`[memory] ${userPaused ? 'paused' : 'resumed'} by user`)
  return userPaused
}

export function isMemoryPaused() {
  return userPaused
}

// ---------------------------------------------------------------------------
// Capture + OCR loop
// ---------------------------------------------------------------------------
async function captureTick() {
  if (userPaused || systemPaused || isProcessing || !db) return
  isProcessing = true
  try {
    const display = screen.getPrimaryDisplay()
    const scale = FRAME_WIDTH / display.size.width
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: FRAME_WIDTH,
        height: Math.max(1, Math.round(display.size.height * scale))
      }
    })
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) return

    // Unchanged-screen skip: compare a tiny raw bitmap against the last frame.
    const hash = source.thumbnail.resize(CHANGE_CHECK).toBitmap()
    if (lastChangeHash && hash.equals(lastChangeHash)) return
    lastChangeHash = hash

    // Save compressed frame.
    const fileName = `frame-${Date.now()}.jpg`
    const filePath = path.join(framesDir, fileName)
    await fsp.writeFile(filePath, source.thumbnail.toJPEG(JPEG_QUALITY))

    // OCR (shared worker, lazy init on first use).
    let text = ''
    try {
      if (!worker) {
        worker = await createWorker('eng', 1, { cachePath: tessdataDir })
      }
      const result = await worker.recognize(filePath)
      text = (result?.data?.text ?? '').trim()
    } catch (err) {
      // First-run model download can fail offline - don't keep a dead file.
      console.warn('[memory] OCR failed:', err.message)
      await fsp.unlink(filePath).catch(() => {})
      return
    }

    stmtInsert.run(filePath, text)
  } finally {
    isProcessing = false
  }
}

// ---------------------------------------------------------------------------
// Retention cron
// ---------------------------------------------------------------------------
function cleanupOldFrames() {
  if (!db) return
  try {
    const cutoff = 'now'
    const offset = `-${RETENTION_DAYS} days`
    const stale = stmtCleanupSelect.all(cutoff, offset)
    for (const row of stale) {
      if (row.image_path) fsp.unlink(row.image_path).catch(() => {})
    }
    const info = stmtCleanupDelete.run(cutoff, offset)
    if (info.changes > 0) {
      console.log(`[memory] retention cleanup removed ${info.changes} frames (>${RETENTION_DAYS}d)`)
    }
  } catch (err) {
    console.warn('[memory] cleanup failed:', err.message)
  }
}

// ---------------------------------------------------------------------------
// Search (FTS5)
// ---------------------------------------------------------------------------
export function searchMemory(keyword) {
  if (!db) return []
  const tokens = String(keyword ?? '')
    .replace(/["'()*:^]/g, ' ') // strip FTS5 syntax characters
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
  if (tokens.length === 0) return []

  const match = tokens.map((t) => `"${t}"*`).join(' ') // prefix search per token
  try {
    return stmtSearch.all(match)
  } catch (err) {
    console.warn('[memory] search failed:', err.message)
    return []
  }
}
