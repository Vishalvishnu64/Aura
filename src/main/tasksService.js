import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

let db = null
let stmtList = null
let stmtInsert = null
let stmtGet = null
let stmtUpdate = null
let stmtDelete = null
let stmtClearCompleted = null

const TITLE_MAX_LENGTH = 500

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_completed_created ON tasks(completed, created_at DESC);
`

export function initTasksService() {
  if (db) return
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  const databasePath = path.join(app.getPath('userData'), 'tasks.db')
  db = new Database(databasePath)
  try {
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  stmtList = db.prepare(
    'SELECT id, title, completed, created_at, completed_at, updated_at FROM tasks ORDER BY completed ASC, created_at DESC, id DESC'
  )
  stmtInsert = db.prepare(
    'INSERT INTO tasks (title, completed, created_at, completed_at, updated_at) VALUES (?, 0, ?, NULL, ?)'
  )
  stmtGet = db.prepare(
    'SELECT id, title, completed, created_at, completed_at, updated_at FROM tasks WHERE id = ?'
  )
  stmtUpdate = db.prepare(
    'UPDATE tasks SET title = ?, completed = ?, completed_at = ?, updated_at = ? WHERE id = ?'
  )
  stmtDelete = db.prepare('DELETE FROM tasks WHERE id = ?')
  stmtClearCompleted = db.prepare('DELETE FROM tasks WHERE completed = 1')
  } catch (error) {
    stopTasksService()
    throw new Error('Task storage could not be initialized', { cause: error })
  }
}

export function stopTasksService() {
  if (db) db.close()
  db = null
  stmtList = null
  stmtInsert = null
  stmtGet = null
  stmtUpdate = null
  stmtDelete = null
  stmtClearCompleted = null
}

export function listTasks() {
  ensureReady()
  return stmtList.all().map(toTask)
}

export function createTask(title) {
  ensureReady()
  const normalized = normalizeTitle(title)
  const now = Date.now()
  const result = stmtInsert.run(normalized, now, now)
  return getTask(result.lastInsertRowid)
}

export function updateTask(id, patch = {}) {
  ensureReady()
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
      Object.keys(patch).some((key) => !['title', 'completed'].includes(key))) {
    throw new Error('Invalid task update')
  }
  if (patch.completed !== undefined && typeof patch.completed !== 'boolean') throw new Error('Task completion must be true or false')
  const current = getTask(id)
  if (!current) return null

  const title = patch.title === undefined ? current.title : normalizeTitle(patch.title)
  const completed = patch.completed === undefined ? current.completed : patch.completed
  const completedAt = completed ? (current.completedAt ?? Date.now()) : null
  stmtUpdate.run(title, completed ? 1 : 0, completedAt, Date.now(), normalizeId(id))
  return getTask(id)
}

export function deleteTask(id) {
  ensureReady()
  return stmtDelete.run(normalizeId(id)).changes > 0
}

export function clearCompletedTasks() {
  ensureReady()
  return stmtClearCompleted.run().changes
}

function getTask(id) {
  const row = stmtGet?.get(normalizeId(id))
  return row ? toTask(row) : null
}

function toTask(row) {
  return {
    id: Number(row.id),
    title: String(row.title),
    completed: Boolean(row.completed),
    createdAt: Number(row.created_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    updatedAt: Number(row.updated_at)
  }
}

function normalizeTitle(title) {
  if (typeof title !== 'string') throw new Error('Task title must be text')
  const value = title.replace(/\s+/g, ' ').trim()
  if (!value) throw new Error('Task title cannot be empty')
  if (value.length > TITLE_MAX_LENGTH) throw new Error(`Task title must be ${TITLE_MAX_LENGTH} characters or fewer`)
  return value
}

function normalizeId(id) {
  const value = typeof id === 'bigint' ? Number(id) : id
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid task id')
  return value
}

function ensureReady() {
  if (!db) throw new Error('Task storage is unavailable')
}
