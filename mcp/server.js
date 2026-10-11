#!/usr/bin/env node
/**
 * aura-memory - MCP server exposing Aura's photographic screen memory.
 *
 * Gives AI clients (Cursor, Claude Desktop, Antigravity, ...) read-only
 * full-text search over the OCR'd screen history that the Aura overlay
 * captures every 15 seconds.
 *
 * - Transport: stdio (newline-delimited JSON-RPC). NEVER log to stdout -
 *   anything written there is parsed as protocol messages. Logs go to stderr.
 * - Database: opened READONLY so this server can never lock or corrupt the
 *   live database that the Electron app writes to (WAL allows concurrent
 *   readers).
 *
 * Config in the client (Cursor / Claude Desktop / Antigravity):
 *   { "mcpServers": { "aura-memory": {
 *       "command": "node", "args": ["<absolute path>/mcp/server.js"] } } }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import Database from 'better-sqlite3'

const log = (...args) => console.error('[aura-memory]', ...args)

// ---------------------------------------------------------------------------
// Database path resolution (mirrors Electron's app.getPath('userData'))
// ---------------------------------------------------------------------------
function resolveDbPath() {
  // Explicit override wins - useful for testing or portable setups.
  if (process.env.AURA_MEMORY_DB) return process.env.AURA_MEMORY_DB

  const home = os.homedir()
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : path.join(home, '.config')
  return path.join(base, 'ai-overlay', 'photographic-memory.db')
}

const DB_PATH = resolveDbPath()
if (!fs.existsSync(DB_PATH)) {
  log(`database not found at ${DB_PATH}`)
  log('run the Aura overlay app once to create it, or set AURA_MEMORY_DB=<path>')
  process.exit(1)
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
db.pragma('busy_timeout = 3000') // never fight the Electron writer for locks
log(`opened ${DB_PATH} (readonly)`)

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------
const SEARCH_SQL = `
  SELECT f.id, f.timestamp, f.image_path, f.ocr_text
  FROM memory_fts
  JOIN memory_frames f ON f.id = memory_fts.rowid
  WHERE memory_fts MATCH ?
  ORDER BY f.timestamp DESC
  LIMIT ?
`

/** Strip FTS5 syntax characters, then build per-token prefix queries. */
function sanitizeMatch(keyword) {
  return String(keyword ?? '')
    .replace(/["'()*:^]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => `"${t}"*`)
    .join(' ')
}

function searchMemory(keyword, limit) {
  const match = sanitizeMatch(keyword)
  if (!match) return []
  return db.prepare(SEARCH_SQL).all(match, limit)
}

/** Human-readable text block - this is what the AI client receives. */
function formatResults(keyword, rows) {
  if (rows.length === 0) {
    return `No screen-memory results found for "${keyword}".`
  }
  const blocks = rows.map((r) => {
    const text = String(r.ocr_text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const clipped = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
    return `[${r.timestamp}]\n${clipped || '(no readable text in this frame)'}`
  })
  const plural = rows.length === 1 ? '' : 's'
  return `Found ${rows.length} screen-memory result${plural} for "${keyword}" (newest first):\n\n${blocks.join('\n\n─────\n\n')}`
}

// ---------------------------------------------------------------------------
// MCP server + tool registration
// ---------------------------------------------------------------------------
const server = new McpServer({ name: 'aura-memory', version: '1.0.0' })

server.registerTool(
  'search_screen_memory',
  {
    title: 'Screen Memory Search',
    description:
      "Search the user's photographic screen memory: OCR text captured from their screen every 15 seconds by the Aura overlay. Use it to answer questions about what the user was doing, reading, or looking at. Returns timestamped text snippets, newest first.",
    inputSchema: {
      keyword: z.string().describe('Word or phrase to look for in screen history'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Maximum number of results to return (default 10)')
    }
  },
  ({ keyword, limit }) => {
    try {
      const rows = searchMemory(keyword, limit)
      return { content: [{ type: 'text', text: formatResults(keyword, rows) }] }
    } catch (err) {
      log('search failed:', err.message)
      return {
        content: [{ type: 'text', text: `Memory search failed: ${err.message}` }],
        isError: true
      }
    }
  }
)

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
const shutdown = () => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

await server.connect(new StdioServerTransport())
log(`aura-memory MCP server ready (stdio) - db: ${DB_PATH}`)
