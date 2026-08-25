import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { streamChat } from './services/aiService'
import { startAudioLoopback } from './services/audioService'

/* ------------------------------------------------------------------ */
/* Small inline SVG icons                                              */
/* ------------------------------------------------------------------ */

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  )
}

function ScreenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Markdown renderer                                                   */
/* ------------------------------------------------------------------ */

function Markdown({ content }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [messages, setMessages] = useState([]) // {role, content}[]
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [screenContext, setScreenContext] = useState(null) // base64 data URL | null
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState(null)
  const [listening, setListening] = useState(false)
  const [audioChannels, setAudioChannels] = useState(null) // 'mic+system' | 'mic'
  const [stealthMode, setStealthMode] = useState(true) // capture-exclusion on by default

  const cardRef = useRef(null) // chat card; used to measure non-list chrome
  const listRef = useRef(null) // scrollable conversation region
  const inputRef = useRef(null)
  const listEndRef = useRef(null)
  const abortRef = useRef(null)
  const audioRef = useRef(null) // audio loopback controller ({stop})
  const rafRef = useRef(0)
  // Distinguish user edge-drags from our own programmatic resizes so
  // auto-grow never fights the user while they drag the window borders.
  const programmaticUntil = useRef(0)
  const lastManualResizeAt = useRef(0)

  const hasConversation = messages.length > 0

  /* Auto-grow: when the conversation no longer fits, ask Electron to enlarge
     the window (height only, width is the user's). Never shrinks - once the
     user sizes the window, that size wins until content overflows again. */
  const autoGrow = useCallback(() => {
    const card = cardRef.current
    const list = listRef.current
    if (!card || !list || !window.overlay?.resizeWindow) return
    if (Date.now() - lastManualResizeAt.current < 800) return // user is dragging
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const chrome = card.offsetHeight - list.clientHeight // composer + hints + padding
      const desired = Math.ceil(list.scrollHeight + chrome)
      if (desired > window.innerHeight + 1) {
        programmaticUntil.current = Date.now() + 500
        window.overlay.resizeWindow(desired)
      }
    })
  }, [])

  /* Classify window resize events: anything not caused by our own
     resizeWindow call is treated as a manual user drag. */
  useEffect(() => {
    const onResize = () => {
      if (Date.now() < programmaticUntil.current) return
      lastManualResizeAt.current = Date.now()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* Track content size changes (reflow, new messages, width drags). */
  useEffect(() => {
    const list = listRef.current
    if (!list) return undefined
    const observer = new ResizeObserver(autoGrow)
    observer.observe(list)
    return () => {
      cancelAnimationFrame(rafRef.current)
      observer.disconnect()
    }
  }, [hasConversation, autoGrow])

  /* Focus the input every time the overlay is summoned via hotkey/tray. */
  useEffect(() => {
    const unsubscribe = window.overlay?.onShown?.(() => inputRef.current?.focus())
    return unsubscribe
  }, [])

  /* Escape hides the overlay no matter where focus sits. */
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') window.overlay?.hideWindow?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  /* Stop audio capture if the overlay ever unmounts. */
  useEffect(() => () => audioRef.current?.stop(), [])

  /* Auto-grow the textarea while typing. */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  /* Keep the latest message in view while streaming - but only when the user
     is already near the bottom, so scrolling up to re-read isn't hijacked. */
  useEffect(() => {
    const list = listRef.current
    const nearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 48
    if (nearBottom) listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  /* Re-check fit whenever visible content changes (banners, thumbnails...). */
  useEffect(() => {
    autoGrow()
  }, [messages, error, screenContext, streaming, input, autoGrow])

  /* ------------------------- actions ------------------------------ */

  const toggleScreenContext = async () => {
    setError(null)
    if (screenContext) {
      setScreenContext(null)
      return
    }
    setCapturing(true)
    try {
      const dataUrl = await window.overlay.captureScreen()
      if (!dataUrl) throw new Error('capture returned no data')
      setScreenContext(dataUrl)
    } catch (err) {
      setError(`Screen capture failed: ${err.message}`)
    } finally {
      setCapturing(false)
    }
  }

  /* Clipboard image paste: screenshots/photos land in the pending attachment
     slot. Plain-text paste is left to native behavior. */
  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageItem = items.find((item) => item.type.startsWith('image/'))
    if (!imageItem) return
    e.preventDefault()
    const file = imageItem.getAsFile()
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setScreenContext(reader.result) // base64 data URL
    reader.onerror = () => setError('Failed to read the pasted image')
    reader.readAsDataURL(file)
  }

  /* ----------------------- audio loopback ------------------------- */

  const stopListening = () => {
    audioRef.current?.stop()
    audioRef.current = null
    setListening(false)
    setAudioChannels(null)
  }

  const toggleListening = async () => {
    setError(null)
    if (audioRef.current) {
      stopListening()
      return
    }
    try {
      // Recording keeps running while the overlay is hidden (the renderer
      // stays alive in the tray), so transcripts accumulate in the background.
      audioRef.current = await startAudioLoopback({
        onReady: (channels) => {
          setAudioChannels(channels)
          setListening(true)
        },
        onTranscript: (text) => setInput((prev) => (prev ? `${prev} ${text}` : text)),
        onError: (message) => setError(message),
        onEnded: (reason) => {
          audioRef.current = null
          setListening(false)
          setAudioChannels(null)
          setError(reason)
        }
      })
    } catch (err) {
      audioRef.current = null
      setListening(false)
      setAudioChannels(null)
      setError(err.message)
    }
  }

  /* ------------------------- stealth mode ------------------------- */

  const toggleStealth = useCallback(async () => {
    setError(null)
    try {
      const active = await window.overlay.setContentProtection(!stealthMode)
      setStealthMode(Boolean(active)) // adopt main's authoritative state
    } catch (err) {
      setError(`Stealth toggle failed: ${err.message}`)
    }
  }, [stealthMode])

  /* Re-sync stealth state with the main process after a renderer reload
     (crash self-heal / dev HMR) so the badge can never drift from reality. */
  useEffect(() => {
    let cancelled = false
    window.overlay
      ?.setContentProtection?.()
      .then((active) => {
        if (!cancelled) setStealthMode(Boolean(active))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  /* Ctrl/Cmd+Alt+S toggles stealth while the overlay is focused. */
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        toggleStealth()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleStealth])

  const submit = async () => {
    const text = input.trim()
    if (!text || streaming) return

    const history = [...messages, { role: 'user', content: text }]
    setInput('')
    setError(null)
    setStreaming(true)
    setMessages([...history, { role: 'assistant', content: '' }]) // optimistic placeholder

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChat({
        messages: history,
        imageBase64: screenContext,
        signal: controller.signal,
        onChunk: (token) =>
          setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            next[next.length - 1] = { ...last, content: last.content + token }
            return next
          })
      })
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
      // Drop empty assistant placeholders left behind by errors/aborts
      setMessages((prev) => prev.filter((m) => m.role !== 'assistant' || m.content !== ''))
    } finally {
      setStreaming(false)
      abortRef.current = null
      setScreenContext(null) // context is consumed after one send
    }
  }

  const stopStreaming = () => abortRef.current?.abort()

  const onKeyDown = (e) => {
    // Enter submits; Shift+Enter inserts a newline (native behavior)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  /* --------------------------- render ----------------------------- */

  return (
    <div ref={cardRef} className="flex h-full max-h-full w-full flex-col overflow-hidden p-1.5">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/90 shadow-2xl shadow-black/60 backdrop-blur-xl">

        {/* -------- drag bar (moves the frameless window) -------- */}
        <div
          className="flex h-4 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing [-webkit-app-region:drag]"
          title="Drag to move the overlay"
        >
          <div className="h-1 w-10 rounded-full bg-white/10" />
        </div>

        {/* -------- conversation -------- */}
        {hasConversation && (
          <div ref={listRef} className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pl-4 pr-1 pb-2 pt-3">
            {messages.map((message, i) =>
              message.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-indigo-500/90 px-3.5 py-2 text-[13.5px] leading-relaxed text-white">
                    {message.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="max-w-full pr-6 text-[13.5px] leading-relaxed text-neutral-200">
                  <Markdown content={message.content} />
                  {streaming && i === messages.length - 1 && (
                    <span className="ml-0.5 inline-block h-3.5 w-2 animate-pulse rounded-sm bg-indigo-400 align-middle" />
                  )}
                </div>
              )
            )}
            <div ref={listEndRef} />
          </div>
        )}

        {/* -------- error banner -------- */}
        {error && (
          <div className="mx-4 mb-2 mt-3 flex shrink-0 items-start justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
            <span className="break-all">{error}</span>
            <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100">
              ✕
            </button>
          </div>
        )}

        {/* -------- pending attachment preview (screen capture or paste) -------- */}
        {screenContext && (
          <div className="mx-3 mb-1 flex shrink-0 items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-2">
            <img
              src={screenContext}
              alt="pending attachment"
              className="h-16 shrink-0 rounded border border-white/15"
            />
            <span className="flex-1 text-[11px] leading-snug text-neutral-400">
              Image attached &mdash; sent as vision context with your next message
            </span>
            <button
              type="button"
              onClick={() => setScreenContext(null)}
              title="Remove attachment"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-red-500/15 hover:text-red-300"
            >
              ✕
            </button>
          </div>
        )}

        {/* -------- composer (pinned to the bottom) -------- */}
        <div className="mt-auto flex shrink-0 items-end gap-2 px-3 pb-2 pt-3">
          {/* Audio loopback toggle */}
          <button
            type="button"
            onClick={toggleListening}
            title={
              listening
                ? 'Stop listening - transcripts stop flowing into the input'
                : 'Listen to microphone + system audio; transcripts land in the input'
            }
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              listening
                ? 'border-red-400/40 bg-red-500/15 text-red-300'
                : 'border-white/10 bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-neutral-200'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                listening ? 'animate-pulse bg-red-400' : 'bg-neutral-500'
              }`}
            />
            <MicIcon />
            {listening ? (audioChannels === 'mic' ? 'Mic only' : 'Mic+System') : 'Listen'}
          </button>

          {/* Screen context badge/toggle */}
          <button
            type="button"
            onClick={toggleScreenContext}
            disabled={capturing}
            title={screenContext ? 'Screen context active - click to remove' : 'Attach current screen as context'}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50 ${
              screenContext
                ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                : 'border-white/10 bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-neutral-200'
            } ${capturing ? 'animate-pulse' : ''}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${screenContext ? 'bg-emerald-400' : 'bg-neutral-500'}`} />
            <ScreenIcon />
            Screen
          </button>

          {/* Stealth mode toggle */}
          <button
            type="button"
            onClick={toggleStealth}
            title={
              stealthMode
                ? 'Stealth ON - overlay invisible to recordings & screen share (Ctrl+Alt+S)'
                : 'Shared - overlay visible to screen capture (Ctrl+Alt+S)'
            }
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
              stealthMode
                ? 'border-violet-400/40 bg-violet-500/15 text-violet-300'
                : 'border-amber-400/40 bg-amber-500/15 text-amber-300'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${stealthMode ? 'bg-violet-400' : 'bg-amber-400'}`} />
            {stealthMode ? <EyeOffIcon /> : <EyeIcon />}
            {stealthMode ? 'Stealth' : 'Shared'}
          </button>

          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            autoFocus
            placeholder={capturing ? 'Capturing screen…' : 'Ask anything…'}
            spellCheck={false}
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
          />

          {streaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              title="Stop generating"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-700 text-neutral-200 transition-colors hover:bg-neutral-600"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim()}
              title="Send (Enter)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500 text-white transition-colors enabled:hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
            >
              <SendIcon />
            </button>
          )}
        </div>

        {/* -------- hints -------- */}
        <div className="shrink-0 px-4 pb-2 text-center text-[10px] text-neutral-600">
          Enter send &middot; Shift+Enter newline &middot; Esc hide &middot; Ctrl+Shift+Space summon &middot; Ctrl+Alt+S stealth &middot; drag edges to resize
        </div>
      </div>
    </div>
  )
}
