import { useCallback, useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { useGSAP } from '@gsap/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { streamChat } from './services/aiService'
import { startAudioLoopback } from './services/audioService'

gsap.registerPlugin(useGSAP, ScrollTrigger)

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
/* /recall - RAG bridge into the photographic-memory index             */
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
/* /recall - RAG bridge into the photographic-memory index             */
/* ------------------------------------------------------------------ */

const RECALL_RE = /^\/recall\s+(.+)$/i
const RECALL_MAX_RESULTS = 10

/**
 * Format memory search hits into the context block sent to the AI.
 * Snippets are flattened to one line each; UTC timestamps from SQLite are
 * rendered in the user's local time. The [..] markers inside snippets show
 * which terms matched - useful signal for the model, so they stay.
 */
function buildRecallPrompt(results, keyword) {
  const lines = results.slice(0, RECALL_MAX_RESULTS).map((r) => {
    const when = new Date(String(r.timestamp).replace(' ', 'T') + 'Z').toLocaleString()
    const snippetText = String(r.snippet ?? '').replace(/\s+/g, ' ').trim()
    return `- At ${when}: ${snippetText}`
  })
  return [
    "Context from User's Screen History:",
    ...lines,
    '',
    `User Request: Summarize what I was doing regarding "${keyword}".`
  ].join('\n')
}

/**
 * Commands offered by the autocomplete menu. `fill` is what lands in the
 * input when selected (trailing space marks commands that expect arguments).
 */
const SLASH_COMMANDS = [
  { command: '/recall', fill: '/recall ', label: '/recall <keyword>', desc: 'Search screen memory', exactSubmit: false },
  { command: '/code', fill: '/code', label: '/code', desc: 'Review visible code', exactSubmit: true },
  { command: '/explain', fill: '/explain', label: '/explain', desc: 'Summarize screen', exactSubmit: true }
]

function getSlashCommands(value) {
  const match = value.match(/^\/\S*$/)
  if (!match) return []
  const prefix = value.toLowerCase()
  return SLASH_COMMANDS.filter((command) => command.command.startsWith(prefix))
}

function formatUserError(error) {
  const message = String(error?.message ?? error ?? 'Something went wrong')
  if (/missing ai api key|api key/i.test(message)) return 'AI is not configured. Add your API key to .env and restart Aura.'
  if (/\b401\b|\b403\b/.test(message)) return 'The AI provider rejected the request. Check your API key and endpoint.'
  if (/\b429\b/.test(message)) return 'The AI provider is rate-limiting requests. Wait a moment and retry.'
  if (/failed to fetch|network|enotfound|econnrefused/i.test(message)) return 'Aura could not reach the AI provider. Check your connection and endpoint.'
  if (/timeout|timed out/i.test(message)) return 'The AI provider took too long to respond. Retry when ready.'
  return message
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
  const [showSlashMenu, setShowSlashMenu] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0) // highlighted autocomplete row
  const [preparingSubmit, setPreparingSubmit] = useState(false)
  const [audioBusy, setAudioBusy] = useState(false)
  const [stealthBusy, setStealthBusy] = useState(false)
  const [failedRequest, setFailedRequest] = useState(null)
  const [appStatus, setAppStatus] = useState(null)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [notice, setNotice] = useState(null)

  const cardRef = useRef(null) // outer chat card; used to measure the complete layout
  const cardPanelRef = useRef(null) // visible glass panel - stealth animation target
  const contentRef = useRef(null) // all panel content, including empty/error states
  const listRef = useRef(null) // scrollable conversation region
  const slashMenuRef = useRef(null)
  const inputRef = useRef(null)
  const listEndRef = useRef(null)
  const abortRef = useRef(null)
  const audioRef = useRef(null) // audio loopback controller ({stop})
  const audioActionRef = useRef(false)
  const stealthActionRef = useRef(false)
  const submitInFlightRef = useRef(false)
  const rafRef = useRef(0)
  // Distinguish user edge-drags from our own programmatic resizes so
  // auto-grow never fights the user while they drag the window borders.
  const programmaticUntil = useRef(0)
  const lastManualResizeAt = useRef(0)
  const animatedCountRef = useRef(0) // [data-message] nodes already revealed by GSAP
  const reducedMotionRef = useRef(false)

  const hasConversation = messages.length > 0
  const slashCommands = getSlashCommands(input)
  const activeSlashIndex = Math.min(slashIndex, Math.max(0, slashCommands.length - 1))
  const memoryStatus = appStatus?.memory ?? null

  /* Auto-grow: when the complete card no longer fits, ask Electron to enlarge
     the window (height only, width is the user's). Never shrinks - once the
     user sizes the window, that size wins until content overflows again. */
  const autoGrow = useCallback(() => {
    const card = cardRef.current
    const panel = cardPanelRef.current
    const content = contentRef.current
    const list = listRef.current
    const menu = slashMenuRef.current
    if (!card || !panel || !content || !window.overlay?.resizeWindow) return
    if (Date.now() - lastManualResizeAt.current < 800) return // user is dragging
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const panelHeight = panel.getBoundingClientRect().height
      const outerPadding = Math.max(0, card.offsetHeight - panel.offsetHeight)
      const listOverflow = list ? Math.max(0, list.scrollHeight - list.clientHeight) : 0
      const contentHeight = Math.max(content.scrollHeight, content.clientHeight)

      // A list owns its scrollbar, so its overflowing messages are not part of
      // the parent scrollHeight. Add that delta to the complete card measure.
      let desired = Math.max(panel.scrollHeight, panelHeight, contentHeight + listOverflow)

      // The command menu is positioned above the composer and therefore does
      // not contribute to scrollHeight. Grow only when the panel would clip it.
      if (menu) {
        const panelTop = panel.getBoundingClientRect().top
        const menuTop = menu.getBoundingClientRect().top
        desired += Math.max(0, Math.ceil(panelTop + 4 - menuTop))
      }

      desired = Math.ceil(desired + outerPadding)
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

  /* Track every content surface that can change the required card height
     (including the empty state, banners, attachment and slash menu). */
  useEffect(() => {
    const targets = [
      cardRef.current,
      cardPanelRef.current,
      contentRef.current,
      listRef.current,
      slashMenuRef.current
    ].filter(Boolean)
    if (targets.length === 0) return undefined
    const observer = new ResizeObserver(autoGrow)
    targets.forEach((target) => observer.observe(target))
    return () => {
      cancelAnimationFrame(rafRef.current)
      observer.disconnect()
    }
  }, [hasConversation, showSlashMenu, error, screenContext, autoGrow])

  /* Focus the input every time the overlay is summoned via hotkey/tray. */
  useEffect(() => {
    const unsubscribe = window.overlay?.onShown?.(() => inputRef.current?.focus())
    return unsubscribe
  }, [])

  /* Keep privacy, memory, shortcut, and display status visible and current. */
  useEffect(() => {
    let mounted = true
    const applyStatus = (status) => {
      if (!mounted || !status) return
      setAppStatus(status)
      if (!stealthActionRef.current && typeof status.capture?.overlayExcludedFromCapture === 'boolean') {
        setStealthMode(status.capture.overlayExcludedFromCapture)
      }
    }
    Promise.resolve(window.overlay?.getStatus?.()).then(applyStatus).catch(() => {})
    const unsubscribe = window.overlay?.onStatus?.(applyStatus)
    const poll = window.setInterval(() => {
      Promise.resolve(window.overlay?.getStatus?.()).then(applyStatus).catch(() => {})
    }, 10000)
    return () => {
      mounted = false
      unsubscribe?.()
      window.clearInterval(poll)
    }
  }, [])

  /* Escape hides the overlay no matter where focus sits. */
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') window.overlay?.hideWindow?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  /* Stop audio capture when the overlay is hidden or unmounted. This keeps
     microphone/system recording explicit and prevents hidden capture. */
  useEffect(() => {
    const stopOnHide = () => {
      audioRef.current?.stop()
      audioRef.current = null
      setListening(false)
      setAudioChannels(null)
    }
    const unsubscribe = window.overlay?.onHidden?.(stopOnHide)
    return () => {
      unsubscribe?.()
      audioRef.current?.stop()
    }
  }, [])

  /* Auto-grow the textarea while typing. */
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  /* Respect the user's reduced-motion preference for both CSS and GSAP. */
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return undefined
    const update = () => {
      reducedMotionRef.current = media.matches
    }
    update()
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  /* Keep the latest message in view while streaming - but only when the user
     is already near the bottom, so scrolling up to re-read isn't hijacked. */
  useEffect(() => {
    const list = listRef.current
    const nearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 48
    if (nearBottom) {
      listEndRef.current?.scrollIntoView({ behavior: reducedMotionRef.current ? 'auto' : 'smooth', block: 'end' })
    }
  }, [messages])

  /* Re-check fit whenever visible content changes (banners, thumbnails...). */
  useEffect(() => {
    autoGrow()
  }, [messages, error, screenContext, streaming, input, showSlashMenu, preparingSubmit, autoGrow])

  /* GSAP scope: selector text and contextSafe animations stay inside the card
     and are auto-cleaned on unmount. */
  const { contextSafe } = useGSAP(() => {}, { scope: cardRef })

  /* Cinematic reveal for NEW messages only. The element count grows when a
     message lands; streaming token updates change content but not count, so
     the animation never re-fires mid-stream. Transforms/opacity don't affect
     layout, keeping autoGrow + auto-scroll measurements exact. */
  useGSAP(() => {
    const nodes = cardRef.current?.querySelectorAll('[data-message]')
    if (!nodes) return
    if (nodes.length <= animatedCountRef.current) {
      animatedCountRef.current = nodes.length // clamp after error-path removal
      return
    }
    const fresh = Array.from(nodes).slice(animatedCountRef.current)
    if (reducedMotionRef.current) {
      gsap.set(fresh, { opacity: 1, y: 0 })
    } else {
      gsap.from(fresh, { opacity: 0, y: 20, duration: 0.45, ease: 'power2.out', stagger: 0.06 })
    }
    animatedCountRef.current = nodes.length
  }, { scope: cardRef, dependencies: [messages] })

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

  const toggleMemory = async () => {
    if (!memoryStatus || memoryBusy || !window.overlay?.setMemoryPaused) return
    setMemoryBusy(true)
    setNotice(null)
    try {
      const next = await window.overlay.setMemoryPaused(!memoryStatus.paused)
      setAppStatus((previous) => (previous ? { ...previous, memory: next } : previous))
    } catch (err) {
      setError(`Memory control failed: ${err?.message ?? 'unknown error'}`)
    } finally {
      setMemoryBusy(false)
    }
  }

  const clearMemoryHistory = async () => {
    if (!memoryStatus || memoryBusy || !memoryStatus.frameCount || !window.overlay?.clearMemoryHistory) return
    if (!window.confirm(`Delete ${memoryStatus.frameCount} stored screen frame${memoryStatus.frameCount === 1 ? '' : 's'}?`)) return
    setMemoryBusy(true)
    setNotice(null)
    try {
      const result = await window.overlay.clearMemoryHistory()
      if (result?.status) setAppStatus((previous) => (previous ? { ...previous, memory: result.status } : previous))
      setNotice('Screen memory cleared.')
    } catch (err) {
      setError(`Could not clear screen memory: ${err?.message ?? 'unknown error'}`)
    } finally {
      setMemoryBusy(false)
    }
  }

  const toggleListening = async () => {
    if (audioActionRef.current) return
    setError(null)
    if (audioRef.current) {
      stopListening()
      return
    }
    audioActionRef.current = true
    setAudioBusy(true)
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
    } finally {
      audioActionRef.current = false
      setAudioBusy(false)
    }
  }

  /* ------------------------- stealth mode ------------------------- */

  const toggleStealth = useCallback(async () => {
    if (stealthActionRef.current) return
    stealthActionRef.current = true
    setStealthBusy(true)
    console.log('[DEBUG] toggleStealth called - current stealthMode:', stealthMode)
    setError(null)
    try {
      const active = await window.overlay.setContentProtection(!stealthMode)
      console.log('[DEBUG] setContentProtection returned:', active)
      setStealthMode(Boolean(active)) // adopt main's authoritative state
      // Tactile response: shrink + dim when going dark, springy pop when shared.
      contextSafe((on) => {
        gsap.to(cardPanelRef.current, {
          scale: on ? 0.96 : 1,
          opacity: on ? 0.9 : 1,
          duration: reducedMotionRef.current ? 0 : on ? 0.35 : 0.6,
          ease: on ? 'power2.out' : 'back.out(1.7)'
        })
      })(Boolean(active))
      console.log('[DEBUG] stealth GSAP animation triggered')
    } catch (err) {
      console.log('[DEBUG] toggleStealth FAILED:', err.message)
      setError(`Stealth toggle failed: ${err.message}`)
    } finally {
      stealthActionRef.current = false
      setStealthBusy(false)
    }
  }, [stealthMode, contextSafe])

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

  /* Global Ctrl+Shift+U (registered in the main process) toggles stealth
     system-wide. DEBUG: loud logging at every hop of the chain. */
  useEffect(() => {
    if (!window.overlay?.onToggleStealth) {
      console.log('[DEBUG] renderer: overlay.onToggleStealth MISSING - stale preload, restart the app!')
      return undefined
    }
    console.log('[DEBUG] renderer: subscribing to stealth:toggle')
    const off = window.overlay.onToggleStealth(() => {
      console.log('[DEBUG] renderer: toggle event received -> calling toggleStealth()')
      toggleStealth()
    })
    return off
  }, [toggleStealth])

  const streamRequest = async ({ history, imageBase64, prompt, clearFailure = true }) => {
    if (clearFailure) setFailedRequest(null)
    setStreaming(true)
    setMessages([...history, { role: 'assistant', content: '' }]) // optimistic placeholder

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChat({
        messages: history,
        imageBase64,
        signal: controller.signal,
        onChunk: (token) =>
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (!last || last.role !== 'assistant') return prev
            const next = [...prev]
            next[next.length - 1] = { ...last, content: last.content + token }
            return next
          })
      })
      setFailedRequest(null)
    } catch (err) {
      if (err?.name !== 'AbortError') {
        setError(formatUserError(err))
        setFailedRequest({ history, imageBase64, prompt })
      }
      // Drop empty assistant placeholders left behind by errors/aborts.
      setMessages((prev) => prev.filter((m) => m.role !== 'assistant' || m.content !== ''))
    } finally {
      setStreaming(false)
      abortRef.current = null
      setScreenContext(null) // context is consumed after one send
    }
  }

  const submit = async () => {
    const text = input.trim()
    if (!text || streaming || preparingSubmit || submitInFlightRef.current) return

    submitInFlightRef.current = true
    setPreparingSubmit(true)
    setError(null)
    setFailedRequest(null)
    setShowSlashMenu(false)

    try {
      // --- slash commands: /recall (RAG), /code + /explain (screen vision) ---
      let outgoing = text
      let displayText = null
      let imageOverride = null
      const recallMatch = text.match(RECALL_RE)
      if (recallMatch) {
        const keyword = recallMatch[1].trim()
        if (!keyword) {
          setError('Usage: /recall <keyword>')
          return
        }
        let results
        try {
          results = (await window.overlay?.searchMemory?.(keyword)) ?? []
        } catch (err) {
        setError(`Memory search failed: ${formatUserError(err)}`)
          return
        }
        if (results.length === 0) {
          outgoing = `I tried to recall '${keyword}' from my screen history but found nothing.`
        } else {
          outgoing = buildRecallPrompt(results, keyword)
          displayText = `🔍 Recalled: ${keyword}`
        }
      } else if (text.toLowerCase() === '/code' || text.toLowerCase() === '/explain') {
        // Grab the screen right now and let the vision model work on it.
        let dataUrl
        try {
          dataUrl = await window.overlay.captureScreen()
        } catch (err) {
          setError(`Screen capture failed: ${formatUserError(err)}`)
          return
        }
        if (!dataUrl) {
          setError('Screen capture returned no data')
          return
        }
        imageOverride = dataUrl
        outgoing =
          text.toLowerCase() === '/code'
            ? 'Review the code visible on my screen. Explain what it does, spot bugs or issues, and suggest concrete improvements.'
            : 'Summarize what is currently on my screen. Describe the key content and call out anything important.'
        displayText = text
      }

      const history = [
        ...messages,
        {
          role: 'user',
          content: outgoing,
          // Compact bubble text for command turns; the AI still receives the
          // full context/prompt via `content` (and keeps it on follow-up turns).
          ...(displayText ? { display: displayText } : {})
        }
      ]
      const imageBase64 = imageOverride ?? screenContext
      setInput('')
      setPreparingSubmit(false)
      await streamRequest({ history, imageBase64, prompt: text })
    } catch (err) {
      // Preparation errors should leave the typed prompt and attachment intact.
      setError(formatUserError(err))
    } finally {
      setPreparingSubmit(false)
      submitInFlightRef.current = false
    }
  }

  const retryFailedRequest = async () => {
    const request = failedRequest
    if (!request || streaming || preparingSubmit || submitInFlightRef.current) return
    submitInFlightRef.current = true
    setError(null)
    try {
      await streamRequest({ ...request, clearFailure: false })
    } finally {
      submitInFlightRef.current = false
    }
  }

  const editFailedRequest = () => {
    if (!failedRequest) return
    setInput(failedRequest.prompt)
    setFailedRequest(null)
    setError(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const stopStreaming = () => abortRef.current?.abort()

  const resetConversation = () => {
    if (streaming || preparingSubmit || submitInFlightRef.current) return
    setMessages([])
    setInput('')
    setError(null)
    setFailedRequest(null)
    setScreenContext(null)
    setShowSlashMenu(false)
    setSlashIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /* Slash menu: fill the input with the selected command and refocus. */
  const selectCommand = (cmd) => {
    setInput(cmd.fill)
    setShowSlashMenu(false)
    setSlashIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const onInputChange = (e) => {
    const value = e.target.value
    setInput(value)
    // Menu shows while the line is a bare command and filters to its prefix.
    // It hides as soon as a space is entered (i.e. arguments are being typed).
    setShowSlashMenu(getSlashCommands(value).length > 0)
    setSlashIndex(0)
  }

  const onKeyDown = (e) => {
    if (showSlashMenu && slashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashCommands.length) % slashCommands.length)
        return
      }
      if (e.key === 'Escape') {
        // Close only the menu - the window-level Esc handler is stopped here.
        e.preventDefault()
        e.stopPropagation()
        setShowSlashMenu(false)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        const cmd = slashCommands[activeSlashIndex]
        if (!cmd) return
        if (cmd.exactSubmit && cmd.command === input.trim().toLowerCase()) {
          // /code and /explain are executable commands. Enter must submit them,
          // rather than replacing either one with the first menu row.
          setShowSlashMenu(false)
          if (e.key === 'Tab') e.preventDefault()
          if (e.key === 'Tab') return
          // Enter falls through to the submit handler below.
        } else {
          e.preventDefault()
          selectCommand(cmd)
          return
        }
      }
    }
    // Enter submits; Shift+Enter inserts a newline (native behavior)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  /* --------------------------- render ----------------------------- */

  return (
    <div ref={cardRef} className="flex h-full max-h-full w-full flex-col overflow-hidden p-1.5">
      <div ref={cardPanelRef} className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/90 shadow-2xl shadow-black/60 backdrop-blur-xl will-change-transform">

        {/* -------- drag bar (moves the frameless window) -------- */}
        <div
          className="flex h-4 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing [-webkit-app-region:drag]"
          title="Drag to move the overlay"
        >
          <div className="h-1 w-10 rounded-full bg-white/10" />
        </div>

        <div ref={contentRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* -------- compact conversation controls -------- */}
          <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">Aura</span>
              {memoryStatus ? (
                <button
                  type="button"
                  onClick={toggleMemory}
                  disabled={memoryBusy}
                  aria-pressed={Boolean(memoryStatus.active)}
                  aria-label={memoryStatus.paused ? 'Resume screen memory' : 'Pause screen memory'}
                  title={memoryStatus.consented
                    ? `Screen memory captures the primary display every ${Math.round((memoryStatus.intervalMs ?? 15000) / 1000)} seconds and keeps ${memoryStatus.retentionDays ?? 7} days${memoryStatus.capture?.display?.name ? ` (${memoryStatus.capture.display.name})` : ''}`
                    : 'Screen memory is off until you enable it. Click to enable local screen history.'}
                  className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-neutral-300 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${memoryStatus.active ? 'bg-emerald-400' : 'bg-amber-300'}`} />
                  <span className="truncate">{memoryStatus.active ? 'Memory on' : memoryStatus.systemPaused ? 'Memory paused' : memoryStatus.consented ? 'Memory off' : 'Memory off (opt-in)'}</span>
                  {memoryStatus.frameCount > 0 && <span className="text-neutral-500">{memoryStatus.frameCount}</span>}
                </button>
              ) : (
                <span className="text-[10px] text-neutral-500">Checking memory…</span>
              )}
              {memoryStatus?.frameCount > 0 && (
                <button
                  type="button"
                  onClick={clearMemoryHistory}
                  disabled={memoryBusy}
                  aria-label="Delete screen memory"
                  title="Delete stored screen memory"
                  className="rounded-md px-1.5 py-1 text-[10px] text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:cursor-wait disabled:opacity-40"
                >
                  Delete
                </button>
              )}
              {(appStatus?.shortcut?.summon?.error || appStatus?.shortcut?.stealth?.error) && (
                <span
                  className="shrink-0 rounded-md bg-amber-400/10 px-1.5 py-1 text-[10px] text-amber-200"
                  title={[appStatus.shortcut.summon.error, appStatus.shortcut.stealth.error].filter(Boolean).join(' • ')}
                >
                  Shortcut unavailable
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={resetConversation}
                disabled={streaming || preparingSubmit || submitInFlightRef.current}
                aria-label="Start a new chat"
                title="Start a new chat"
                className="rounded-md px-2 py-1 text-[10px] text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                New
              </button>
              <button
                type="button"
                onClick={resetConversation}
                disabled={(!hasConversation && !input && !screenContext && !error) || streaming || preparingSubmit || submitInFlightRef.current}
                aria-label="Clear conversation"
                title="Clear conversation"
                className="rounded-md px-2 py-1 text-[10px] text-neutral-400 transition-colors hover:bg-white/10 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear
              </button>
            </div>
          </div>

          {!stealthMode && (
            <div role="status" className="mx-4 mb-1 shrink-0 rounded-md border border-amber-300/20 bg-amber-300/10 px-2 py-1 text-[10px] text-amber-100">
              Shared mode is on — screen captures may include this overlay.
            </div>
          )}

          {/* -------- conversation / empty state -------- */}
          {hasConversation ? (
            <div
              ref={listRef}
              role="log"
              aria-label="Conversation"
              aria-live={streaming ? 'polite' : 'off'}
              aria-busy={streaming}
              className="thin-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pl-4 pr-1 pb-2 pt-3"
            >
              {messages.map((message, i) =>
                message.role === 'user' ? (
                  <div key={i} data-message className="flex justify-end">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-indigo-500/90 px-3.5 py-2 text-[13.5px] leading-relaxed text-white">
                      {message.display ?? message.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} data-message className="max-w-full pr-6 text-[13.5px] leading-relaxed text-neutral-200">
                    <Markdown content={message.content} />
                    {streaming && i === messages.length - 1 && (
                      <span className="ml-0.5 inline-block h-3.5 w-2 animate-pulse rounded-sm bg-indigo-400 align-middle" />
                    )}
                  </div>
                )
              )}
              <div ref={listEndRef} />
            </div>
          ) : (
            <div className="flex min-h-[7.5rem] flex-1 flex-col items-center justify-center px-6 py-4 text-center" aria-live="polite">
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl border border-indigo-300/20 bg-indigo-400/10 text-sm text-indigo-200" aria-hidden="true">
                ✦
              </div>
              <h1 className="m-0 text-sm font-medium text-neutral-100">Ready when you are</h1>
              <p className="mt-1.5 max-w-xs text-[11px] leading-relaxed text-neutral-400">
                Ask a question, paste an image, or use <span className="font-mono text-indigo-200">/</span> for screen and memory commands.
              </p>
              <button
                type="button"
                onClick={() => inputRef.current?.focus()}
                className="mt-3 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-neutral-300 transition-colors hover:bg-white/10 hover:text-white"
              >
                Start typing
              </button>
            </div>
          )}

          {/* -------- error banner -------- */}
          {error && (
            <div role="alert" aria-live="assertive" className="mx-4 mb-2 mt-3 flex shrink-0 items-start justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <div className="min-w-0 flex-1">
                <p className="m-0 break-words leading-relaxed">{error}</p>
                {failedRequest && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={retryFailedRequest}
                      disabled={streaming || preparingSubmit || submitInFlightRef.current}
                      className="rounded-md border border-red-300/30 bg-red-300/10 px-2 py-1 text-[11px] font-medium text-red-100 transition-colors hover:bg-red-300/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={editFailedRequest}
                      disabled={streaming || preparingSubmit || submitInFlightRef.current}
                      className="rounded-md px-2 py-1 text-[11px] text-red-100/80 transition-colors hover:bg-red-300/10 hover:text-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Edit prompt
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                title="Dismiss error"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-red-200/80 transition-colors hover:bg-red-300/10 hover:text-red-50"
              >
                ✕
              </button>
            </div>
          )}

          {notice && (
            <div role="status" className="mx-4 mb-2 mt-3 shrink-0 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-200">
              {notice}
            </div>
          )}

        {/* -------- pending attachment preview (screen capture or paste) -------- */}
          {screenContext && (
            <div className="mx-3 mb-1 flex shrink-0 items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-2">
              <img
                src={screenContext}
                alt="Pending screen attachment preview"
                className="h-16 shrink-0 rounded border border-white/15"
              />
              <span className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-300">
                Image attached &mdash; sent as vision context with your next message
              </span>
              <button
                type="button"
                onClick={() => setScreenContext(null)}
                aria-label="Remove pending attachment"
                title="Remove attachment"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-red-500/15 hover:text-red-200"
              >
                ✕
              </button>
          </div>
        )}

        {/* -------- composer (pinned to the bottom) -------- */}
        <div className="relative mt-auto flex shrink-0 items-end gap-2 px-3 pb-2 pt-3">
          {/* -------- slash command menu (floats above the input) -------- */}
          {showSlashMenu && slashCommands.length > 0 && (
            <div
              ref={slashMenuRef}
              id="slash-command-menu"
              role="listbox"
              aria-label="Slash commands"
              className="absolute bottom-full left-3 right-3 z-10 mb-2 overflow-hidden rounded-xl border border-white/10 bg-neutral-800/95 shadow-2xl shadow-black/50 backdrop-blur-xl"
            >
              {slashCommands.map((cmd, idx) => (
                <button
                  id={`slash-command-${cmd.command.slice(1)}`}
                  role="option"
                  aria-selected={idx === activeSlashIndex}
                  key={cmd.command}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault() // keep textarea focus
                    selectCommand(cmd)
                  }}
                  onMouseEnter={() => setSlashIndex(idx)}
                  className={`flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-xs transition-colors ${
                    idx === activeSlashIndex ? 'bg-indigo-500/25 text-white' : 'text-neutral-300'
                  }`}
                >
                  <span className="font-mono font-medium text-indigo-300">{cmd.label}</span>
                  <span className="ml-auto text-[11px] text-neutral-300">{cmd.desc}</span>
                </button>
              ))}
              <div className="border-t border-white/5 px-3.5 py-1.5 text-[10px] text-neutral-400">
                ↑↓ navigate &middot; Tab complete &middot; Enter choose/send &middot; Esc close
              </div>
            </div>
          )}
          {/* Audio loopback toggle */}
          <button
            type="button"
            onClick={toggleListening}
            disabled={audioBusy}
            aria-pressed={listening}
            aria-busy={audioBusy}
            aria-label={
              listening
                ? 'Stop listening'
                : 'Start microphone and system audio listening'
            }
            title={
              listening
                ? 'Stop listening - transcripts stop flowing into the input'
                : 'Listen to microphone + system audio; transcripts land in the input'
            }
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:cursor-wait disabled:opacity-60 ${
              listening
                ? 'border-red-400/40 bg-red-500/15 text-red-300'
                : 'border-white/10 bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-neutral-200'
            }`}
            >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                audioBusy ? 'animate-pulse bg-amber-300' : listening ? 'animate-pulse bg-red-400' : 'bg-neutral-500'
              }`}
            />
            <MicIcon />
            {audioBusy ? 'Starting…' : listening ? (audioChannels === 'mic' ? 'Mic only' : 'Mic+System') : 'Listen'}
          </button>

          {/* Screen context badge/toggle */}
          <button
            type="button"
            onClick={toggleScreenContext}
            disabled={capturing}
            aria-pressed={Boolean(screenContext)}
            aria-busy={capturing}
            aria-label={screenContext ? 'Remove screen attachment' : 'Attach current screen'}
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
            disabled={stealthBusy}
            aria-pressed={stealthMode}
            aria-busy={stealthBusy}
            aria-label={stealthMode ? 'Turn stealth mode off' : 'Turn stealth mode on'}
            title={
              stealthMode
                ? 'Stealth ON - overlay invisible to recordings & screen share (Ctrl+Shift+U)'
                : 'Shared - overlay visible to screen capture (Ctrl+Shift+U)'
            }
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors disabled:cursor-wait disabled:opacity-60 ${
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
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            autoFocus
            placeholder={capturing ? 'Capturing screen…' : 'Ask anything…'}
            spellCheck={false}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={showSlashMenu && slashCommands.length > 0 ? 'slash-command-menu' : undefined}
            aria-expanded={showSlashMenu && slashCommands.length > 0}
            aria-activedescendant={showSlashMenu && slashCommands.length > 0 ? `slash-command-${slashCommands[activeSlashIndex]?.command.slice(1)}` : undefined}
            aria-describedby="composer-hints"
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
          />

          {streaming ? (
            <button
              type="button"
              onClick={stopStreaming}
              aria-label="Stop generating"
              aria-busy={streaming}
              title="Stop generating"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-700 text-neutral-200 transition-colors hover:bg-neutral-600"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!input.trim() || preparingSubmit}
              aria-label={preparingSubmit ? 'Preparing message' : 'Send message'}
              aria-busy={preparingSubmit}
              title={preparingSubmit ? 'Preparing message…' : 'Send (Enter)'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500 text-white transition-colors enabled:hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-600"
            >
              {preparingSubmit ? <span className="text-xs" aria-hidden="true">…</span> : <SendIcon />}
            </button>
          )}
        </div>

        {/* -------- hints -------- */}
        <div id="composer-hints" className="shrink-0 px-4 pb-2 text-center text-[10px] text-neutral-400">
          Enter send &middot; Shift+Enter newline &middot; / commands &middot; Esc hide &middot; Ctrl+Shift+Space summon &middot; Ctrl+Shift+U stealth &middot; drag edges to resize
        </div>
        <div className="sr-only" aria-live="polite">
          {preparingSubmit ? 'Preparing your message.' : streaming ? 'Assistant is responding.' : error ? 'There is an error with the current request.' : ''}
        </div>
        </div>
      </div>
    </div>
  )
}
