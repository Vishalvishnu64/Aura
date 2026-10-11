import { useCallback, useEffect, useId, useRef, useState } from 'react'

const RESULT_LIMIT = 50
const EMPTY_SEARCH = { phase: 'idle', id: null, query: '', results: [], info: null, error: null }
const BUTTON = 'rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-200 disabled:cursor-not-allowed disabled:opacity-50'
const FILE_ACTIONS = {
  filesOpen: { label: 'Open', busy: 'Opening', success: 'Sent to your default app', failure: 'open this file' },
  filesReveal: { label: 'Show in folder', busy: 'Showing in folder', success: 'Requested in your file manager', failure: 'show this file in its folder' },
  filesCopyPath: { label: 'Copy path', busy: 'Copying path', success: 'Path copied', failure: 'copy this file path' }
}

function callOverlay(method, ...args) {
  if (typeof window.overlay?.[method] !== 'function') throw new Error('FILES_BRIDGE_UNAVAILABLE')
  return window.overlay[method](...args)
}

function friendlyError(error, action) {
  const message = String(error?.message ?? error ?? '')
  if (message.includes('FILES_BRIDGE_UNAVAILABLE')) {
    return 'Local file controls are unavailable. Restart Aura and try again.'
  }
  if (/outside.*authorized|not authorized|permission|access.*denied|EACCES|EPERM/i.test(message)) {
    return `Could not ${action}. Check the folder permissions or authorize the folder again.`
  }
  if (/no longer exists|does not exist|not found|unavailable|ENOENT|ENOTDIR/i.test(message)) {
    return `Could not ${action}. The file or folder may have moved or been removed.`
  }
  return `Could not ${action}. Please try again.`
}

function readFolders(response) {
  if (!Array.isArray(response)) throw new Error('Invalid folder response')
  const seen = new Set()
  return response.filter((folder) => {
    if (typeof folder?.path !== 'string' || !folder.path || seen.has(folder.path)) return false
    seen.add(folder.path)
    return true
  }).map((folder) => ({ path: folder.path, name: folder.name || folder.path }))
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function readSearch(response) {
  const legacy = Array.isArray(response)
  const rows = legacy ? response : response?.results
  if (!Array.isArray(rows)) throw new Error('Invalid search response')
  const seen = new Set()
  const results = rows.filter((file) => {
    if (typeof file?.path !== 'string' || !file.path || seen.has(file.path)) return false
    seen.add(file.path)
    return true
  }).map((file) => ({ ...file, name: file.name || file.path.split(/[\\/]/).pop() || file.path }))
  return {
    results,
    info: {
      truncated: !legacy && Boolean(response.truncated),
      limited: legacy && rows.length >= RESULT_LIMIT,
      cancelled: !legacy && Boolean(response.cancelled),
      skipped: legacy ? null : count(response.skipped),
      scanned: legacy ? null : count(response.scanned)
    }
  }
}

function searchSummary(search) {
  const total = search.results.length
  const { info } = search
  const parts = [`${total} file${total === 1 ? '' : 's'} found.`]
  if (info.scanned !== null) parts.push(`${info.scanned.toLocaleString()} files scanned.`)
  if (info.cancelled) parts.push('Search stopped; results may be incomplete.')
  if (info.truncated) parts.push('Search was limited; results may be incomplete. Refine your query.')
  else if (info.limited) parts.push(`${RESULT_LIMIT}-result limit reached. Refine your search for other matches.`)
  if (info.skipped) parts.push(`${info.skipped.toLocaleString()} entries could not be searched.`)
  return parts.join(' ')
}

function formatSize(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return 'Unknown'
  if (size === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unit = Math.max(0, Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1))
  const value = size / (1024 ** unit)
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`
}

function formatModified(value) {
  if (value == null || value === '') return { label: 'Unknown', iso: undefined }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? { label: 'Unknown', iso: undefined }
    : { label: date.toLocaleString(), iso: date.toISOString() }
}

function fileType(extension) {
  const type = typeof extension === 'string' ? extension.replace(/^\./, '').toUpperCase() : ''
  return type && type !== 'FILE' ? type : 'File (no extension)'
}

export default function FilesPanel({ active, searchRequest }) {
  const id = useId()
  const inputRef = useRef(null)
  const cancelRef = useRef(null)
  const mountedRef = useRef(false)
  const activeRef = useRef(false)
  const queryRef = useRef('')
  const foldersRef = useRef([])
  const foldersReadyRef = useRef(false)
  const folderActionRef = useRef(null)
  const fileActionRef = useRef(null)
  const searchInFlightRef = useRef(false)
  const searchIdRef = useRef(0)
  const pendingSearchRef = useRef(null)
  const lastRequestIdRef = useRef(null)

  const [query, setQuery] = useState('')
  const [folders, setFolders] = useState([])
  const [foldersLoaded, setFoldersLoaded] = useState(false)
  const [folderBusy, setFolderBusy] = useState('load')
  const [folderError, setFolderError] = useState(null)
  const [confirmFolder, setConfirmFolder] = useState(null)
  const [search, setSearch] = useState(EMPTY_SEARCH)
  const [searchBusy, setSearchBusy] = useState(false)
  const [fileBusy, setFileBusy] = useState(null)
  const [fileMessage, setFileMessage] = useState(null)
  const [folderNotice, setFolderNotice] = useState(null)

  const focusSearch = useCallback(() => {
    if (activeRef.current) inputRef.current?.focus()
  }, [])

  // Invalidate both displayed results and in-flight completions synchronously.
  // A new external request received during a folder change can be kept queued.
  const resetSearch = useCallback((keepPending = false) => {
    const nextId = ++searchIdRef.current
    const pending = keepPending ? pendingSearchRef.current : null
    pendingSearchRef.current = pending ? { ...pending, id: nextId } : null
    setSearch(pending ? { ...EMPTY_SEARCH, phase: 'queued', id: nextId, query: pending.query } : EMPTY_SEARCH)
    setFileMessage(null)
  }, [])

  // Only one filesSearch IPC call may run at a time. New request IDs replace
  // the pending intent; stale calls must settle before the latest one starts.
  const drainSearch = useCallback(async function drain() {
    if (!mountedRef.current || searchInFlightRef.current || folderActionRef.current || !foldersReadyRef.current) return
    const request = pendingSearchRef.current
    if (!request) return
    pendingSearchRef.current = null
    if (request.id !== searchIdRef.current) return
    if (!request.query || request.query.length > 200 || foldersRef.current.length === 0) {
      const error = !request.query
        ? 'Enter a file name, path or extension to search.'
        : request.query.length > 200
          ? 'Use a search query of 200 characters or fewer.'
          : 'Add an authorized folder before searching.'
      setSearch({ ...EMPTY_SEARCH, phase: 'error', id: request.id, query: request.query, error })
      return
    }
    searchInFlightRef.current = true
    setSearchBusy(true)
    setSearch({ ...EMPTY_SEARCH, phase: 'searching', id: request.id, query: request.query })
    try {
      const response = await callOverlay('filesSearch', request.query)
      if (!mountedRef.current || request.id !== searchIdRef.current) return
      const { results, info } = readSearch(response)
      setSearch({ phase: 'complete', id: request.id, query: request.query, results, info, error: null })
    } catch (error) {
      if (!mountedRef.current || request.id !== searchIdRef.current) return
      setSearch({ ...EMPTY_SEARCH, phase: 'error', id: request.id, query: request.query, error: friendlyError(error, 'search your files') })
    } finally {
      searchInFlightRef.current = false
      if (mountedRef.current) {
        setSearchBusy(false)
        void drain()
      }
    }
  }, [])

  const requestSearch = useCallback((value) => {
    const nextId = ++searchIdRef.current
    const nextQuery = value.trim()
    pendingSearchRef.current = { id: nextId, query: nextQuery }
    setSearch({ ...EMPTY_SEARCH, phase: 'queued', id: nextId, query: nextQuery })
    setFileMessage(null)
    void drainSearch()
  }, [drainSearch])

  const changeFolders = useCallback(async (kind, path) => {
    if (folderActionRef.current || fileActionRef.current) return
    if (kind !== 'load' && !foldersReadyRef.current) return
    folderActionRef.current = kind
    setFolderBusy(kind)
    setFolderError(null)
    setFolderNotice(null)
    if (kind !== 'load') {
      resetSearch()
      setConfirmFolder(null)
    }
    const method = kind === 'load' ? 'filesGetFolders' : kind === 'add' ? 'filesPickFolder' : 'filesRemoveFolder'
    try {
      const response = kind === 'remove' ? await callOverlay(method, path) : await callOverlay(method)
      if (!mountedRef.current) return
      const next = readFolders(response)
      const changed = next.length !== foldersRef.current.length || next.some((folder) => !foldersRef.current.some((previous) => previous.path === folder.path))
      if (changed) resetSearch(true)
      foldersRef.current = next
      foldersReadyRef.current = true
      setFolders(next)
      setFoldersLoaded(true)
      setConfirmFolder(null)
      if (kind === 'add' && changed) setFolderNotice('Folder access added. Search again to use the updated folder list.')
      if (kind === 'remove') setFolderNotice('Folder access removed. No files were deleted.')
    } catch (error) {
      if (mountedRef.current) {
        const action = kind === 'load' ? 'load your authorized folders' : kind === 'add' ? 'add this folder' : 'remove folder access'
        setFolderError(friendlyError(error, action))
      }
    } finally {
      folderActionRef.current = null
      if (mountedRef.current) {
        setFolderBusy(null)
        void drainSearch()
        if (kind !== 'load') focusSearch()
      }
    }
  }, [drainSearch, focusSearch, resetSearch])

  useEffect(() => {
    mountedRef.current = true
    void changeFolders('load')
    return () => {
      mountedRef.current = false
    }
  }, [changeFolders])

  useEffect(() => {
    activeRef.current = Boolean(active)
    focusSearch()
  }, [active, focusSearch])

  useEffect(() => {
    const unsubscribe = window.overlay?.onShown?.(focusSearch)
    return typeof unsubscribe === 'function' ? unsubscribe : undefined
  }, [focusSearch])

  const requestId = searchRequest?.id
  const requestQuery = searchRequest?.query
  useEffect(() => {
    if (requestId == null || requestId === lastRequestIdRef.current) return
    lastRequestIdRef.current = requestId
    const value = typeof requestQuery === 'string' ? requestQuery : ''
    queryRef.current = value
    setQuery(value)
    requestSearch(value)
  }, [requestId, requestQuery, requestSearch])

  useEffect(() => {
    if (confirmFolder && activeRef.current) cancelRef.current?.focus()
  }, [confirmFolder])

  const onQueryChange = (event) => {
    const value = event.target.value
    queryRef.current = value
    setQuery(value)
    resetSearch()
  }

  const onSearchSubmit = (event) => {
    event.preventDefault()
    if (searchInFlightRef.current || folderActionRef.current || !foldersReadyRef.current) return
    requestSearch(queryRef.current)
  }

  const cancelRemoval = () => {
    setConfirmFolder(null)
    focusSearch()
  }

  const performFileAction = async (method, file, resultId) => {
    if (fileActionRef.current || folderActionRef.current || resultId !== searchIdRef.current) return
    const action = { method, path: file.path, name: file.name }
    fileActionRef.current = action
    setFileBusy(action)
    setFileMessage(null)
    try {
      const response = await callOverlay(method, file.path)
      if (response === false) throw new Error('File action failed')
      if (mountedRef.current && resultId === searchIdRef.current) {
        setFileMessage({ error: false, text: `${FILE_ACTIONS[method].success}: ${file.name}.` })
      }
    } catch (error) {
      if (mountedRef.current && resultId === searchIdRef.current) {
        setFileMessage({ error: true, text: friendlyError(error, FILE_ACTIONS[method].failure) })
      }
    } finally {
      fileActionRef.current = null
      if (mountedRef.current) setFileBusy(null)
    }
  }

  let status = 'Enter a file name, path or extension, then press Enter or Search.'
  if (search.phase === 'queued') {
    status = folderBusy ? 'Search will start when your folder list is ready…' : searchBusy ? 'Waiting for the previous search to finish…' : 'Preparing local search…'
    if (!foldersLoaded && !folderBusy) status = 'Load your authorized folders to start this search.'
  } else if (search.phase === 'searching') status = 'Searching your authorized folders…'
  else if (search.phase === 'complete') status = searchSummary(search)
  else if (search.phase === 'error') status = 'Search did not finish. Your query is still in the input.'
  else if (searchBusy) status = 'Finishing the previous search…'
  else if (!foldersLoaded) status = folderBusy ? 'Loading authorized folders…' : 'Your folder list could not be loaded.'
  else if (!folders.length) status = 'Add a folder to enable local file search.'

  const foldersDisabled = Boolean(folderBusy || fileBusy)
  const incomplete = search.info && (search.info.cancelled || search.info.truncated || search.info.skipped)

  return (
    <div
      className="flex h-full min-h-[300px] min-w-0 flex-1 flex-col overflow-hidden text-[13px] text-neutral-200 [-webkit-app-region:no-drag]"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirmFolder) {
          event.preventDefault()
          event.stopPropagation()
          cancelRemoval()
        }
      }}
    >
      <form role="search" aria-label="Local files" onSubmit={onSearchSubmit} className="shrink-0 border-b border-white/5 px-4 pb-3 pt-2">
        <label htmlFor={`${id}-query`} className="mb-1.5 block font-medium text-neutral-100">Local file search</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            id={`${id}-query`}
            type="search"
            value={query}
            onChange={onQueryChange}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
            }}
            placeholder="File name, path or extension…"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            aria-describedby={`${id}-hint`}
            className="min-w-0 flex-[1_1_220px] rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[13px] text-neutral-100 placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-200"
          />
          <button
            type="submit"
            disabled={searchBusy || Boolean(folderBusy) || !foldersLoaded || !folders.length || !query.trim()}
            className={`${BUTTON} shrink-0 bg-indigo-500 text-white enabled:hover:bg-indigo-400`}
          >
            {search.phase === 'searching' ? 'Searching…' : 'Search'}
          </button>
        </div>
        <p id={`${id}-hint`} className="mt-2 text-[12px] leading-relaxed text-neutral-400">
          Names, paths and extensions only — no file contents. Search stays local and is not sent to AI.
        </p>
        <p role="status" aria-live="polite" aria-atomic="true" className="mt-1.5 break-words text-[12px] leading-relaxed text-neutral-300">
          {status}
        </p>
      </form>

      <div
        role="region"
        aria-label="Authorized folders and file results"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-200"
      >
        <section aria-labelledby={`${id}-folders-heading`} aria-busy={Boolean(folderBusy)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`${id}-folders-heading`} className="text-[13px] font-medium text-neutral-100">Authorized folders</h2>
            <button
              type="button"
              onClick={() => void changeFolders('add')}
              disabled={foldersDisabled || !foldersLoaded}
              className={`${BUTTON} border border-white/10 bg-white/5 text-neutral-200 enabled:hover:bg-white/10`}
            >
              {folderBusy === 'add' ? 'Choosing folder…' : 'Add folder'}
            </button>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">
            Aura searches only these saved folders. Removing access does not delete any files.
          </p>
          {folderError && (
            <div className="mt-2 rounded-lg border border-red-400/20 bg-red-400/10 p-2.5 text-[12px] text-red-200">
              <p role="alert" className="break-words leading-relaxed">{folderError}</p>
              <button
                type="button"
                onClick={() => void changeFolders('load')}
                disabled={foldersDisabled}
                className={`${BUTTON} mt-2 border border-red-300/20 text-red-100 enabled:hover:bg-red-300/10`}
              >
                {foldersLoaded ? 'Reload folders' : 'Try again'}
              </button>
            </div>
          )}
          {folderNotice && <p role="status" className="mt-2 break-words text-[12px] leading-relaxed text-emerald-200">{folderNotice}</p>}
          {folders.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {folders.map((folder) => (
                <li key={folder.path} className="min-w-0 rounded-lg border border-white/10 bg-white/[0.025] p-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-[1_1_180px] select-text break-words font-medium text-neutral-200">{folder.name}</p>
                    <button
                      type="button"
                      onClick={() => setConfirmFolder(folder.path)}
                      disabled={foldersDisabled}
                      aria-label={`Remove access to ${folder.name}`}
                      aria-expanded={confirmFolder === folder.path}
                      aria-controls={confirmFolder === folder.path ? `${id}-remove-confirmation` : undefined}
                      title="Revoke Aura's access to this folder. No files will be deleted."
                      className={`${BUTTON} shrink-0 text-neutral-300 enabled:hover:bg-red-400/10 enabled:hover:text-red-200`}
                    >
                      Remove
                    </button>
                  </div>
                  <p className="mt-1 select-text whitespace-pre-wrap break-all text-[12px] leading-relaxed text-neutral-400">{folder.path}</p>
                  {confirmFolder === folder.path && (
                    <div id={`${id}-remove-confirmation`} role="group" aria-label={`Confirm removing access to ${folder.name}`} className="mt-2 border-t border-white/10 pt-2">
                      <p className="text-[12px] leading-relaxed text-neutral-200">Remove Aura's access to this folder? The files will stay on your device.</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void changeFolders('remove', folder.path)}
                          disabled={foldersDisabled}
                          className={`${BUTTON} border border-red-300/20 bg-red-400/10 text-red-200 enabled:hover:bg-red-400/20`}
                        >
                          Remove access
                        </button>
                        <button ref={cancelRef} type="button" onClick={cancelRemoval} className={`${BUTTON} text-neutral-200 hover:bg-white/10`}>Cancel</button>
                      </div>
                      <p className="mt-1.5 text-[12px] text-neutral-400">Esc cancels this confirmation.</p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-lg border border-dashed border-white/10 p-3 text-[12px] leading-relaxed text-neutral-400">
              {folderBusy === 'load' ? 'Loading your saved folders…' : foldersLoaded ? 'No folders authorized yet. Choose Add folder to grant local search access.' : 'Reload your folder list to manage local access.'}
            </p>
          )}
        </section>

        <section aria-labelledby={`${id}-results-heading`} aria-busy={searchBusy || search.phase === 'queued'} className="mt-4 border-t border-white/10 pt-3">
          <h2 id={`${id}-results-heading`} className="text-[13px] font-medium text-neutral-100">Results</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-neutral-400">Up to {RESULT_LIMIT} results per search. Refine your query for more specific matches.</p>
          {search.error && (
            <p role="alert" className="mt-2 rounded-lg border border-red-400/20 bg-red-400/10 p-2.5 text-[12px] leading-relaxed text-red-200">{search.error}</p>
          )}
          {fileBusy && (
            <p role="status" className="mt-2 break-words text-[12px] leading-relaxed text-neutral-300">{FILE_ACTIONS[fileBusy.method].busy}: {fileBusy.name}…</p>
          )}
          {fileMessage && (
            <p role={fileMessage.error ? 'alert' : 'status'} className={`mt-2 break-words rounded-lg border p-2.5 text-[12px] leading-relaxed ${fileMessage.error ? 'border-red-400/20 bg-red-400/10 text-red-200' : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'}`}>
              {fileMessage.text}
            </p>
          )}
          {search.phase === 'complete' && search.results.length > 0 ? (
            <ul aria-label="Matching files" className="mt-2 space-y-2">
              {search.results.map((file) => {
                const modified = formatModified(file.modifiedAt)
                return (
                  <li key={file.path} className="min-w-0 rounded-xl border border-white/10 bg-white/[0.025] p-3">
                    <h3 className="select-text break-words text-[13px] font-medium text-neutral-100">{file.name}</h3>
                    <p className="mt-1 select-text whitespace-pre-wrap break-all text-[12px] leading-relaxed text-neutral-300">{file.path}</p>
                    <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] leading-relaxed">
                      <div className="flex min-w-0 flex-wrap gap-x-1">
                        <dt className="text-neutral-400">Type:</dt>
                        <dd className="break-words text-neutral-200">{fileType(file.extension)}</dd>
                      </div>
                      <div className="flex flex-wrap gap-x-1">
                        <dt className="text-neutral-400">Size:</dt>
                        <dd className="text-neutral-200">{formatSize(file.size)}</dd>
                      </div>
                      <div className="flex min-w-0 flex-wrap gap-x-1">
                        <dt className="text-neutral-400">Modified:</dt>
                        <dd className="text-neutral-200"><time dateTime={modified.iso}>{modified.label}</time></dd>
                      </div>
                    </dl>
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {Object.entries(FILE_ACTIONS).map(([method, action]) => (
                        <button
                          key={method}
                          type="button"
                          onClick={() => void performFileAction(method, file, search.id)}
                          disabled={Boolean(fileBusy || folderBusy) || (method === 'filesOpen' && file.canOpen === false)}
                          aria-label={`${action.label}: ${file.name}`}
                          title={method === 'filesOpen' && file.canOpen === false
                            ? 'Use Show in folder for this file type'
                            : undefined}
                          className={`${BUTTON} ${method === 'filesOpen' ? 'bg-indigo-500/20 text-indigo-100 enabled:hover:bg-indigo-500/30' : 'border border-white/10 bg-white/5 text-neutral-200 enabled:hover:bg-white/10'}`}
                        >
                          {fileBusy?.path === file.path && fileBusy.method === method
                            ? `${action.busy}…`
                            : method === 'filesOpen' && file.canOpen === false ? 'Open unavailable' : action.label}
                        </button>
                      ))}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : search.phase === 'complete' ? (
            <p className="mt-3 break-words rounded-lg border border-dashed border-white/10 p-3 text-[12px] leading-relaxed text-neutral-300">
              {incomplete ? 'No files returned. The search may be incomplete; try again or use a more specific query.' : <>No files match “<span className="select-text">{search.query}</span>”. Try a different name, path or extension.</>}
            </p>
          ) : search.phase === 'searching' || search.phase === 'queued' ? (
            <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">Looking for matching files in your authorized folders…</p>
          ) : !search.error ? (
            <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">Run a search above to see file details and actions here.</p>
          ) : null}
        </section>
      </div>
    </div>
  )
}
