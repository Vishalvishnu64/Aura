import { app, clipboard, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

let foldersFile = null
let authorizedFolders = []
let ready = false
let searchGeneration = 0

const MAX_RESULTS = 50
const MAX_QUERY_LENGTH = 200
const MAX_ENTRIES = 20000
const SEARCH_BUDGET_MS = 5000
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'out', 'build', 'cache', 'temp', 'tmp',
  'windows', 'program files', 'program files (x86)', 'programdata',
  'appdata', '$recycle.bin', 'system volume information'
])
// Open is for documents, not launching programs/scripts/shortcuts. Other files
// can still be located and revealed so the user chooses what to do in Explorer.
const DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.log', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
  '.pdf', '.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.mp3', '.wav', '.mp4', '.mov'
])

export function initFileService() {
  ready = false
  authorizedFolders = []
  searchGeneration += 1
  foldersFile = path.join(app.getPath('userData'), 'authorized-folders.json')
  let parsed = []
  try {
    parsed = JSON.parse(fs.readFileSync(foldersFile, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw new Error('Could not load authorized folders. The saved file has not been changed.', { cause: error })
    }
  }
  if (!Array.isArray(parsed) || parsed.length > 32 || parsed.some((folder) => !validAbsolutePath(folder))) parsed = []
  // Do not discard unplugged drives, follow changed symlinks, or overwrite
  // settings during startup. Each root is checked again before searching it.
  authorizedFolders = parsed.map((folder) => path.resolve(folder))
    .filter((folder, index, all) => all.findIndex((other) => samePath(folder, other)) === index)
  ready = true
}

export function getAuthorizedFolders() {
  ensureReady()
  return authorizedFolders.map((folderPath) => ({ path: folderPath, name: path.basename(folderPath) || folderPath }))
}

export async function addAuthorizedFolder(folderPath) {
  ensureReady()
  assertAbsolutePath(folderPath)
  const realPath = await fsp.realpath(folderPath)
  if (!(await fsp.stat(realPath)).isDirectory()) throw new Error('Selected path is not a folder')
  if (isProtectedRoot(realPath)) throw new Error('Choose a personal folder, not a drive root, hidden folder, or system folder.')
  if (!authorizedFolders.some((folder) => samePath(folder, realPath))) {
    if (authorizedFolders.length >= 32) throw new Error('Remove a folder before adding another (32-folder limit).')
    saveFolders([...authorizedFolders, realPath])
  }
  return getAuthorizedFolders()
}

export function removeAuthorizedFolder(folderPath) {
  ensureReady()
  assertAbsolutePath(folderPath)
  saveFolders(authorizedFolders.filter((folder) => !samePath(folder, folderPath)))
  return getAuthorizedFolders()
}

function saveFolders(next) {
  const temporary = `${foldersFile}.tmp`
  try {
    fs.mkdirSync(path.dirname(foldersFile), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, foldersFile)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch { /* No temporary file to clean up. */ }
    throw new Error('Could not save folder permissions. Access has not changed; please retry.', { cause: error })
  }
  authorizedFolders = next
  searchGeneration += 1 // revocation invalidates in-flight results immediately
}

export async function searchFiles(query) {
  ensureReady()
  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) throw new Error('Use a search query of 200 characters or fewer.')
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const generation = ++searchGeneration
  const reply = { results: [], scanned: 0, skipped: 0, truncated: false, cancelled: false }
  if (!terms.length) return reply
  const deadline = Date.now() + SEARCH_BUDGET_MS
  const seen = new Set()
  let visited = 0
  // Avoid traversing the same subtree for overlapping permissions.
  const roots = authorizedFolders.filter((folder, index, all) =>
    !all.some((other, otherIndex) => otherIndex !== index && isInside(other, folder)))
  const pending = [...roots]
  while (pending.length) {
    if (generation !== searchGeneration) return { ...reply, results: [], cancelled: true }
    if (visited >= MAX_ENTRIES || Date.now() >= deadline) { reply.truncated = true; break }
    const folder = pending.pop()
    let directory
    try {
      await assertScopedPath(folder, true)
      directory = await fsp.opendir(folder)
    } catch {
      reply.skipped += 1
      continue
    }
    try {
      for await (const entry of directory) {
        if (generation !== searchGeneration) return { ...reply, results: [], cancelled: true }
        if (++visited > MAX_ENTRIES || Date.now() >= deadline || reply.results.length >= MAX_RESULTS) {
          reply.truncated = true
          break
        }
        if (entry.isSymbolicLink() || excludedName(entry.name, entry.isDirectory())) continue
        const entryPath = path.join(folder, entry.name)
        if (entry.isDirectory()) { pending.push(entryPath); continue }
        if (!entry.isFile()) continue
        reply.scanned += 1
        if (!terms.every((term) => entryPath.toLowerCase().includes(term))) continue
        try {
          const { realPath, stats } = await assertScopedPath(entryPath)
          const key = pathKey(realPath)
          if (seen.has(key)) continue
          seen.add(key)
          reply.results.push({
            name: entry.name, path: realPath, folder: path.dirname(realPath),
            extension: path.extname(entry.name).slice(1).toUpperCase() || 'FILE',
            size: stats.size, modifiedAt: stats.mtimeMs,
            canOpen: DOCUMENT_EXTENSIONS.has(path.extname(realPath).toLowerCase())
          })
        } catch { reply.skipped += 1 }
      }
    } catch { reply.skipped += 1 }
    if (reply.truncated) break
  }
  if (generation !== searchGeneration) return { ...reply, results: [], cancelled: true }
  reply.results.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path))
  return reply
}

export async function openFile(filePath) {
  const { realPath } = await assertScopedPath(filePath)
  if (!DOCUMENT_EXTENSIONS.has(path.extname(realPath).toLowerCase())) {
    throw new Error('Aura only opens documents directly. Use Show in folder for programs, scripts, shortcuts, or other file types.')
  }
  assertCurrentScope(realPath)
  const error = await shell.openPath(realPath)
  if (error) throw new Error('The default application could not open this file. Try Show in folder.')
  return true
}

export async function revealFile(filePath) {
  const { realPath } = await assertScopedPath(filePath)
  assertCurrentScope(realPath)
  shell.showItemInFolder(realPath)
  return true
}

export async function copyFilePath(filePath) {
  const { realPath } = await assertScopedPath(filePath)
  assertCurrentScope(realPath)
  clipboard.writeText(realPath)
  return realPath
}

async function assertScopedPath(candidate, directory = false) {
  ensureReady()
  assertAbsolutePath(candidate)
  assertCurrentScope(candidate) // reject traversal/out-of-scope input before filesystem access
  const stats = await fsp.lstat(candidate)
  if (stats.isSymbolicLink()) throw new Error('Symbolic links and junctions are not searched.')
  if (directory ? !stats.isDirectory() : !stats.isFile()) throw new Error('File or folder is unavailable')
  const realPath = await fsp.realpath(candidate)
  // Also prevents a parent directory being replaced with a junction since it
  // was authorized, or since a result was returned.
  if (!samePath(realPath, candidate)) throw new Error('The file or folder changed location. Authorize its actual folder again.')
  assertCurrentScope(realPath) // permissions may have been revoked during await
  return { realPath, stats }
}

function assertCurrentScope(candidate) {
  if (isProtectedRoot(candidate)) throw new Error('Hidden, system, and credential paths are excluded.')
  const allowed = authorizedFolders.some((folder) => {
    if (!isInside(folder, candidate)) return false
    const relative = path.relative(folder, candidate)
    return !relative.split(path.sep).filter(Boolean).some((part, index, parts) =>
      excludedName(part, index < parts.length - 1))
  })
  if (!allowed) throw new Error('That file is outside your authorized folders')
}

function excludedName(name, directory) {
  const value = name.toLowerCase()
  if (value.startsWith('.')) return true
  if (EXCLUDED_DIRECTORIES.has(value)) return true
  return !directory && (/\.(pem|key|p12|pfx|keystore|kdbx)$/.test(value) || /^(id_rsa|id_ed25519|credentials)(\.|$)/.test(value))
}

function isProtectedRoot(folder) {
  const normalized = path.resolve(folder)
  if (samePath(normalized, path.parse(normalized).root)) return true
  const parts = normalized.slice(path.parse(normalized).root.length).split(path.sep)
  return parts.some((part) => excludedName(part, true))
}

function validAbsolutePath(value) {
  if (typeof value !== 'string' || !value || value.length > 32767 || value.includes('\0') || !path.isAbsolute(value)) return false
  if (value.split(/[\\/]/).includes('..')) return false
  // Reject Windows device/UNC paths and alternate data streams. This MVP is
  // explicitly for local personal folders, not remote shares or devices.
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':'))) return false
  return true
}

function assertAbsolutePath(value) {
  if (!validAbsolutePath(value)) throw new Error('Use a valid absolute local path without traversal segments.')
}

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function pathKey(value) {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right)
}

function ensureReady() {
  if (!ready) throw new Error('Local file permissions are unavailable. Restart Aura and try again.')
}
