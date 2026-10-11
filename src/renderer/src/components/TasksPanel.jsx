import { useCallback, useEffect, useId, useRef, useState } from 'react'

const TITLE_LIMIT = 500
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' }
]

function getTasksBridge() {
  const bridge = window.overlay
  const methods = ['tasksList', 'tasksCreate', 'tasksUpdate', 'tasksDelete', 'tasksClearCompleted']
  return methods.every((method) => typeof bridge?.[method] === 'function') ? bridge : null
}

function isTask(task) {
  return Number.isSafeInteger(task?.id) && task.id > 0 &&
    typeof task.title === 'string' && typeof task.completed === 'boolean' &&
    Number.isFinite(task.createdAt) && Number.isFinite(task.updatedAt) &&
    (task.completedAt === null || Number.isFinite(task.completedAt))
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => Number(a.completed) - Number(b.completed) ||
    b.createdAt - a.createdAt || b.id - a.id)
}

function errorMessage(error) {
  return String(error?.message ?? error ?? 'Task storage did not respond.')
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/, '')
}

function isComposing(event) {
  return event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229
}

export default function TasksPanel({ active, createdTask }) {
  const instanceId = useId()
  const [tasks, setTasks] = useState([])
  const [title, setTitle] = useState('')
  const [filter, setFilter] = useState('all')
  const [loadState, setLoadState] = useState('loading')
  const [loadError, setLoadError] = useState('')
  const [hasLoaded, setHasLoaded] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(null)
  const [editing, setEditing] = useState(null)
  const [deleteConfirmation, setDeleteConfirmation] = useState(null)
  const [clearConfirmation, setClearConfirmation] = useState(false)
  const [highlightedId, setHighlightedId] = useState(null)

  const mountedRef = useRef(false)
  const activeRef = useRef(false)
  const readyRef = useRef(false)
  const refreshSequenceRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const queuedRefreshRef = useRef(false)
  // The ref locks synchronously, before React renders disabled controls.
  const mutationRef = useRef(null)
  const lastCreatedIdRef = useRef(null)
  const revealPendingRef = useRef(false)
  const addInputRef = useRef(null)
  const editInputRef = useRef(null)
  const rowRefs = useRef(new Map())
  const clearButtonRef = useRef(null)
  const clearCancelRef = useRef(null)
  const focusFrameRef = useRef(0)
  const revealFrameRef = useRef(0)

  const createdTaskId = createdTask?.id ?? null
  const editingId = editing?.id ?? null
  const completedCount = tasks.filter((task) => task.completed).length
  const counts = { all: tasks.length, active: tasks.length - completedCount, completed: completedCount }
  const visibleTasks = tasks.filter((task) => filter === 'all' ||
    (filter === 'completed' ? task.completed : !task.completed))
  const busy = pending !== null
  const writable = loadState === 'ready' && !busy
  const missingEdit = editing !== null && !tasks.some((task) => task.id === editing.id)

  const scheduleFocus = useCallback((getElement) => {
    window.cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = window.requestAnimationFrame(() => {
      if (mountedRef.current && activeRef.current) getElement()?.focus()
    })
  }, [])

  const focusAddInput = useCallback(() => {
    scheduleFocus(() => addInputRef.current)
  }, [scheduleFocus])

  const refreshTasks = useCallback(async () => {
    if (!mountedRef.current) return
    const sequence = ++refreshSequenceRef.current
    // An App /todo or tab change during a write gets one fresh read afterward.
    if (mutationRef.current) {
      queuedRefreshRef.current = true
      return
    }
    queuedRefreshRef.current = false
    readyRef.current = false
    setLoadError('')
    const bridge = getTasksBridge()
    if (!bridge) {
      setLoadState('unavailable')
      return
    }
    refreshInFlightRef.current = true
    setLoadState('loading')
    try {
      const result = await bridge.tasksList()
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return
      if (!Array.isArray(result) || !result.every(isTask) ||
        new Set(result.map((task) => task.id)).size !== result.length) {
        throw new Error('Task storage returned an invalid list.')
      }
      setTasks(sortTasks(result))
      setHasLoaded(true)
      setDeleteConfirmation((id) => result.some((task) => task.id === id) ? id : null)
      if (!result.some((task) => task.completed)) setClearConfirmation(false)
      readyRef.current = true
      setLoadState('ready')
    } catch (error) {
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return
      setLoadError(errorMessage(error))
      setLoadState('error')
    } finally {
      if (sequence === refreshSequenceRef.current) refreshInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshSequenceRef.current += 1
      window.cancelAnimationFrame(focusFrameRef.current)
      window.cancelAnimationFrame(revealFrameRef.current)
    }
  }, [])

  useEffect(() => {
    activeRef.current = Boolean(active)
    if (active) focusAddInput()
  }, [active, focusAddInput])

  useEffect(() => {
    const unsubscribe = window.overlay?.onShown?.(() => {
      if (activeRef.current) focusAddInput()
    })
    return typeof unsubscribe === 'function' ? unsubscribe : undefined
  }, [focusAddInput])

  useEffect(() => {
    if (lastCreatedIdRef.current === createdTaskId) return
    lastCreatedIdRef.current = createdTaskId
    if (createdTaskId === null) return
    setFilter('all')
    setHighlightedId(createdTaskId)
    revealPendingRef.current = true
    setNotice('Task added from /todo.')
  }, [createdTaskId])

  useEffect(() => {
    void refreshTasks()
  }, [active, createdTaskId, refreshTasks])

  useEffect(() => {
    if (editingId === null) return
    scheduleFocus(() => editInputRef.current)
  }, [editingId, scheduleFocus])

  useEffect(() => {
    if (!active || loadState !== 'ready' || !revealPendingRef.current) return
    const row = rowRefs.current.get(highlightedId)
    if (!row) return
    revealFrameRef.current = window.requestAnimationFrame(() => {
      if (!activeRef.current || !mountedRef.current) return
      row.scrollIntoView({ block: 'nearest', behavior: 'auto' })
      revealPendingRef.current = false
    })
    return () => window.cancelAnimationFrame(revealFrameRef.current)
  }, [active, filter, highlightedId, loadState, tasks])

  const focusTaskAction = (id, action) => {
    scheduleFocus(() => rowRefs.current.get(id)?.querySelector(`[data-task-${action}]`) || addInputRef.current)
  }

  const runMutation = async (operation, persist, onSaved, successNotice) => {
    if (mutationRef.current || !readyRef.current) return
    const bridge = getTasksBridge()
    if (!bridge) {
      readyRef.current = false
      setLoadState('unavailable')
      return
    }
    // If a read is already in flight, re-read after the write so its stale
    // response cannot leave this view in an old/loading state.
    queuedRefreshRef.current = refreshInFlightRef.current
    mutationRef.current = operation
    refreshSequenceRef.current += 1
    setPending(operation)
    setActionError(null)
    setNotice('')
    try {
      const result = await persist(bridge)
      if (!mountedRef.current) return
      onSaved(result)
      setNotice(typeof successNotice === 'function' ? successNotice(result) : successNotice)
    } catch (error) {
      if (!mountedRef.current) return
      const labels = {
        create: 'Could not add task', edit: 'Could not save changes',
        toggle: 'Could not change task', delete: 'Could not delete task',
        clear: 'Could not clear completed tasks'
      }
      const draftHelp = operation.kind === 'create' || operation.kind === 'edit' ? ' Your title is kept here; try again.' : ''
      setActionError({ kind: operation.kind, message: `${labels[operation.kind]}: ${errorMessage(error)}${draftHelp}` })
    } finally {
      mutationRef.current = null
      if (mountedRef.current) {
        setPending(null)
        if (queuedRefreshRef.current) void refreshTasks()
      }
    }
  }

  const mergeSavedTask = (saved) => {
    setTasks((previous) => sortTasks([...previous.filter((task) => task.id !== saved.id), saved]))
  }

  const createTask = () => {
    const draft = title
    const nextTitle = draft.trim()
    if (!nextTitle) return
    void runMutation({ kind: 'create' }, async (bridge) => {
      const saved = await bridge.tasksCreate(nextTitle)
      if (!isTask(saved)) throw new Error('Storage did not return a saved task.')
      return saved
    }, (saved) => {
      mergeSavedTask(saved)
      setTitle((current) => current === draft ? '' : current)
      setFilter('all')
      setHighlightedId(saved.id)
      revealPendingRef.current = true
      focusAddInput()
    }, 'Task added.')
  }

  const toggleTask = (task) => {
    void runMutation({ kind: 'toggle', id: task.id }, async (bridge) => {
      const saved = await bridge.tasksUpdate(task.id, { completed: !task.completed })
      if (saved === null) throw new Error('This task no longer exists. Reload the list.')
      if (!isTask(saved) || saved.id !== task.id) throw new Error('Storage did not return the updated task.')
      return saved
    }, (saved) => {
      mergeSavedTask(saved)
      scheduleFocus(() => rowRefs.current.get(saved.id)?.querySelector('input[type="checkbox"]') || addInputRef.current)
    }, (saved) => saved.completed ? 'Task completed.' : 'Task marked active.')
  }

  const startEdit = (task) => {
    if (mutationRef.current || !readyRef.current) return
    setDeleteConfirmation(null)
    setClearConfirmation(false)
    setActionError(null)
    setEditing({ id: task.id, title: task.title })
  }

  const cancelEdit = () => {
    if (!editing || mutationRef.current?.kind === 'edit') return
    const id = editing.id
    setEditing(null)
    setActionError(null)
    focusTaskAction(id, 'edit')
  }

  const saveEdit = () => {
    if (!editing || missingEdit || !editing.title.trim()) return
    const draft = editing
    void runMutation({ kind: 'edit', id: draft.id }, async (bridge) => {
      const saved = await bridge.tasksUpdate(draft.id, { title: draft.title.trim() })
      if (saved === null) throw new Error('This task no longer exists. Reload the list or copy your draft.')
      if (!isTask(saved) || saved.id !== draft.id) throw new Error('Storage did not return the updated task.')
      return saved
    }, (saved) => {
      mergeSavedTask(saved)
      setEditing(null)
      focusTaskAction(saved.id, 'edit')
    }, 'Task title saved.')
  }

  const beginDelete = (task) => {
    if (mutationRef.current || !readyRef.current) return
    setClearConfirmation(false)
    setDeleteConfirmation(task.id)
    setActionError(null)
    scheduleFocus(() => rowRefs.current.get(task.id)?.querySelector('[data-cancel-delete]'))
  }

  const cancelDelete = () => {
    if (mutationRef.current?.kind === 'delete') return
    const id = deleteConfirmation
    setDeleteConfirmation(null)
    focusTaskAction(id, 'delete')
  }

  const deleteTask = (task) => {
    if (deleteConfirmation !== task.id) return
    void runMutation({ kind: 'delete', id: task.id }, async (bridge) => {
      const deleted = await bridge.tasksDelete(task.id)
      if (deleted !== true) throw new Error('This task was not deleted. Reload the list and try again.')
    }, () => {
      setTasks((previous) => previous.filter((item) => item.id !== task.id))
      setDeleteConfirmation(null)
      if (highlightedId === task.id) setHighlightedId(null)
      focusAddInput()
    }, 'Task deleted.')
  }

  const beginClear = () => {
    if (mutationRef.current || !readyRef.current || completedCount === 0) return
    setDeleteConfirmation(null)
    setClearConfirmation(true)
    setActionError(null)
    scheduleFocus(() => clearCancelRef.current)
  }

  const cancelClear = () => {
    if (mutationRef.current?.kind === 'clear') return
    setClearConfirmation(false)
    scheduleFocus(() => clearButtonRef.current || addInputRef.current)
  }

  const clearCompleted = () => {
    if (!clearConfirmation) return
    void runMutation({ kind: 'clear' }, async (bridge) => {
      const deleted = await bridge.tasksClearCompleted()
      if (!Number.isSafeInteger(deleted) || deleted < 0) throw new Error('Storage did not confirm the deletion.')
      return deleted
    }, () => {
      setTasks((previous) => previous.filter((task) => !task.completed))
      setClearConfirmation(false)
      focusAddInput()
    }, (deleted) => `${deleted} completed task${deleted === 1 ? '' : 's'} cleared.`)
  }

  const cancelOnEscape = (event, cancel) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  const renderEditor = (missing = false) => (
    <div className="min-w-0 flex-1" onKeyDown={(event) => {
      cancelOnEscape(event, cancelEdit)
      if (event.key === 'Enter' && event.target === editInputRef.current && !isComposing(event)) {
        event.preventDefault()
        saveEdit()
      }
    }}>
      {missing && (
        <p className="mb-2 text-[11px] text-amber-200">This task is no longer in the list. Your draft is kept below so you can copy it.</p>
      )}
      <label htmlFor={`${instanceId}-edit`} className="sr-only">Edit task title</label>
      <input
        ref={editInputRef}
        id={`${instanceId}-edit`}
        type="text"
        value={editing.title}
        onChange={(event) => {
          const value = event.target.value
          setEditing((previous) => previous ? { ...previous, title: value } : previous)
        }}
        maxLength={TITLE_LIMIT}
        readOnly={busy}
        autoComplete="off"
        aria-invalid={actionError?.kind === 'edit'}
        aria-describedby={actionError?.kind === 'edit' ? `${instanceId}-error` : undefined}
        className="w-full min-w-0 rounded-md border border-indigo-300/30 bg-neutral-950/50 px-2 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={saveEdit}
          disabled={!writable || missing || !editing.title.trim()}
          className="rounded-md bg-indigo-500 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors enabled:hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending?.kind === 'edit' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={cancelEdit}
          disabled={pending?.kind === 'edit'}
          className="rounded-md px-2.5 py-1.5 text-[11px] text-neutral-300 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
        >Cancel</button>
        <span className="text-[10px] text-neutral-400">Enter save · Esc cancel</span>
      </div>
    </div>
  )

  const retryButton = (
    <button
      type="button"
      onClick={() => { void refreshTasks() }}
      disabled={busy || loadState === 'loading'}
      className="shrink-0 rounded-md border border-white/15 bg-white/5 px-2.5 py-1.5 text-[11px] text-neutral-100 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
    >Retry</button>
  )

  return (
    <section aria-label="Local tasks" className="flex h-full min-h-[300px] w-full max-w-[480px] min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-2 pt-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-medium text-neutral-100">Tasks</h2>
          <span className="rounded-md border border-emerald-300/15 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-200">Local</span>
        </div>
        <span className="text-[10px] text-neutral-400">{loadState === 'loading' ? 'Loading…' : `${counts.active} active`}</span>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
        <label htmlFor={`${instanceId}-add`} className="sr-only">New task title</label>
        <input
          ref={addInputRef}
          id={`${instanceId}-add`}
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isComposing(event)) {
              event.preventDefault()
              if (editingId === null) createTask()
            }
          }}
          maxLength={TITLE_LIMIT}
          readOnly={pending?.kind === 'create'}
          autoComplete="off"
          placeholder="Add a task…"
          aria-invalid={actionError?.kind === 'create'}
          aria-describedby={`${instanceId}-help${actionError?.kind === 'create' ? ` ${instanceId}-error` : ''}`}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-neutral-100 placeholder:text-neutral-500 focus:border-indigo-300/40"
        />
        <button
          type="button"
          onClick={createTask}
          disabled={!writable || editingId !== null || !title.trim()}
          className="shrink-0 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-medium text-white transition-colors enabled:hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-400"
        >{pending?.kind === 'create' ? 'Adding…' : 'Add'}</button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pb-2">
        <div role="group" aria-label="Filter tasks" className="flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              aria-pressed={filter === item.value}
              disabled={!hasLoaded || busy || editingId !== null || deleteConfirmation !== null || clearConfirmation}
              className={`rounded-md px-2 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${filter === item.value ? 'bg-indigo-400/15 text-indigo-200' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'}`}
            >
              {item.label} <span className="ml-1 tabular-nums">{hasLoaded ? counts[item.value] : '—'}</span>
            </button>
          ))}
        </div>
        <button
          ref={clearButtonRef}
          type="button"
          onClick={beginClear}
          disabled={!writable || completedCount === 0 || editingId !== null || clearConfirmation}
          className="rounded-md px-1.5 py-1.5 text-[10px] text-neutral-400 transition-colors enabled:hover:bg-red-400/10 enabled:hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
        >Clear completed</button>
      </div>

      {clearConfirmation && (
        <div role="group" aria-label="Confirm clearing completed tasks" onKeyDown={(event) => cancelOnEscape(event, cancelClear)} className="mx-4 mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-red-300/20 bg-red-400/5 px-3 py-2">
          <p className="min-w-0 flex-1 text-[11px] text-neutral-200">Delete {completedCount} completed task{completedCount === 1 ? '' : 's'}?</p>
          <button type="button" onClick={clearCompleted} disabled={!writable || completedCount === 0} className="rounded-md bg-red-400/15 px-2.5 py-1.5 text-[11px] text-red-200 hover:bg-red-400/25 disabled:cursor-wait disabled:opacity-50">
            {pending?.kind === 'clear' ? 'Clearing…' : 'Delete completed'}
          </button>
          <button ref={clearCancelRef} type="button" onClick={cancelClear} disabled={pending?.kind === 'clear'} className="rounded-md px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-white/10 disabled:cursor-wait disabled:opacity-50">Cancel</button>
        </div>
      )}

      {actionError && (
        <div id={`${instanceId}-error`} role="alert" className="mx-4 mb-2 shrink-0 rounded-lg border border-red-400/25 bg-red-400/10 px-3 py-2 text-[11px] text-red-200">
          <p className="max-h-20 overflow-y-auto break-words leading-relaxed">{actionError.message}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <button type="button" onClick={() => { void refreshTasks() }} disabled={busy || loadState === 'loading'} className="rounded-md px-2 py-1 text-red-100 hover:bg-red-300/10 disabled:opacity-50">Reload tasks</button>
            <button type="button" onClick={() => setActionError(null)} className="rounded-md px-2 py-1 text-red-100/80 hover:bg-red-300/10">Dismiss</button>
          </div>
        </div>
      )}

      {hasLoaded && (loadState === 'error' || loadState === 'unavailable') && (
        <div role="alert" className="mx-4 mb-2 flex shrink-0 items-start gap-2 rounded-lg border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-[11px] text-amber-100">
          <p className="min-w-0 flex-1 break-words leading-relaxed">
            {loadState === 'unavailable' ? 'The desktop task bridge is unavailable. Restart Aura if retry does not help.' : `Could not refresh tasks: ${loadError}`}
            {' '}Showing the last loaded list. Retry to enable changes.
          </p>
          {retryButton}
        </div>
      )}

      <div aria-busy={loadState === 'loading' || busy} className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        {!hasLoaded ? (
          <div className="flex h-full min-h-[120px] flex-col items-center justify-center px-3 py-5 text-center">
            {loadState === 'loading' ? (
              <p className="text-xs text-neutral-400">Loading saved tasks…</p>
            ) : (
              <>
                <h3 className="text-sm font-medium text-neutral-100">{loadState === 'unavailable' ? 'Task storage is unavailable' : 'Could not load tasks'}</h3>
                <p className="mb-3 mt-2 max-w-xs break-words text-[11px] leading-relaxed text-neutral-400">
                  {loadState === 'unavailable'
                    ? 'Tasks need the Aura desktop bridge. Open the desktop app, or restart Aura if the bridge is missing.'
                    : loadError}
                  {' '}Your typed title is kept here.
                </p>
                {retryButton}
              </>
            )}
          </div>
        ) : visibleTasks.length > 0 || missingEdit ? (
          <ul aria-label={`${filter === 'all' ? 'All' : filter === 'active' ? 'Active' : 'Completed'} tasks`} className="space-y-2 py-1">
            {visibleTasks.map((task) => (
              <li
                key={task.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(task.id, node)
                  else rowRefs.current.delete(task.id)
                }}
                data-task-id={task.id}
                data-highlighted={highlightedId === task.id ? '' : undefined}
                className={`rounded-lg border px-2.5 py-2.5 transition-colors ${highlightedId === task.id ? 'border-indigo-300/40 bg-indigo-400/10' : 'border-white/5 bg-white/[0.025]'}`}
              >
                <div className="flex items-start gap-2.5">
                  <input
                    id={`${instanceId}-check-${task.id}`}
                    type="checkbox"
                    checked={task.completed}
                    onChange={() => toggleTask(task)}
                    disabled={!writable || editingId !== null || deleteConfirmation !== null || clearConfirmation}
                    aria-label={`${task.completed ? 'Mark active' : 'Complete'} task: ${task.title}`}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  {editingId === task.id ? renderEditor() : (
                    <>
                      <div className="min-w-0 flex-1">
                        <label htmlFor={`${instanceId}-check-${task.id}`} className={`block cursor-pointer select-text whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere] ${task.completed ? 'text-neutral-400 line-through decoration-neutral-500' : 'text-neutral-200'}`}>
                          {task.title}
                        </label>
                        {highlightedId === task.id && <span className="mt-1 inline-block rounded bg-indigo-400/15 px-1.5 py-0.5 text-[9px] text-indigo-200">New task</span>}
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        <button
                          data-task-edit=""
                          type="button"
                          onClick={() => startEdit(task)}
                          disabled={!writable || editingId !== null || deleteConfirmation !== null || clearConfirmation}
                          aria-label={`Edit task: ${task.title}`}
                          className="rounded-md px-1.5 py-1 text-[10px] text-neutral-400 transition-colors enabled:hover:bg-white/10 enabled:hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                        >Edit</button>
                        <button
                          data-task-delete=""
                          type="button"
                          onClick={() => beginDelete(task)}
                          disabled={!writable || editingId !== null || deleteConfirmation !== null || clearConfirmation}
                          aria-label={`Delete task: ${task.title}`}
                          className="rounded-md px-1.5 py-1 text-[10px] text-neutral-400 transition-colors enabled:hover:bg-red-400/10 enabled:hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                        >Delete</button>
                      </div>
                    </>
                  )}
                </div>
                {deleteConfirmation === task.id && (
                  <div role="group" aria-label={`Confirm deleting task: ${task.title}`} onKeyDown={(event) => cancelOnEscape(event, cancelDelete)} className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/5 pt-2">
                    <span className="min-w-0 flex-1 text-[11px] text-neutral-300">Delete this task?</span>
                    <button type="button" onClick={() => deleteTask(task)} disabled={!writable} aria-label={`Confirm delete task: ${task.title}`} className="rounded-md bg-red-400/15 px-2.5 py-1.5 text-[11px] text-red-200 hover:bg-red-400/25 disabled:cursor-wait disabled:opacity-50">
                      {pending?.kind === 'delete' && pending.id === task.id ? 'Deleting…' : 'Delete'}
                    </button>
                    <button data-cancel-delete="" type="button" onClick={cancelDelete} disabled={pending?.kind === 'delete'} className="rounded-md px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-white/10 disabled:cursor-wait disabled:opacity-50">Cancel</button>
                  </div>
                )}
              </li>
            ))}
            {missingEdit && (
              <li className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2.5">
                <h3 className="mb-2 text-xs font-medium text-neutral-200">Unsaved edit</h3>
                {renderEditor(true)}
              </li>
            )}
          </ul>
        ) : (
          <div className="flex h-full min-h-[120px] flex-col items-center justify-center px-3 py-5 text-center">
            <span aria-hidden="true" className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg border border-indigo-300/20 bg-indigo-400/10 text-indigo-200">✓</span>
            <h3 className="text-sm font-medium text-neutral-100">{filter === 'all' ? 'No tasks yet' : filter === 'active' ? 'No active tasks' : 'No completed tasks'}</h3>
            <p className="mt-1.5 max-w-xs text-[11px] leading-relaxed text-neutral-400">
              {filter === 'completed' ? 'Completed tasks will appear here. Use a checkbox to finish a task.' : filter === 'active' && tasks.length > 0 ? 'All caught up. Add a task when you are ready.' : 'Add a title above, or create a task from Chat with /todo <title>.'}
            </p>
            {filter !== 'completed' && <button type="button" onClick={focusAddInput} className="mt-3 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] text-neutral-300 hover:bg-white/10">Add a task</button>}
          </div>
        )}
      </div>

      <p id={`${instanceId}-help`} className="shrink-0 border-t border-white/5 px-4 py-2 text-[10px] leading-relaxed text-neutral-400">
        Enter to add · Space to toggle a checkbox. Stored on this device, works offline, and stays separate from screen memory. No AI required.
      </p>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {loadState === 'loading' ? (hasLoaded ? 'Refreshing tasks.' : 'Loading saved tasks.') : pending ? 'Saving task changes.' : notice}
      </div>
    </section>
  )
}
