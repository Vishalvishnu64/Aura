/**
 * Dual-channel audio loopback capture.
 *
 * Captures the microphone AND the system output simultaneously, mixes them
 * with the Web Audio API, and records the result as a sequence of
 * self-contained .webm chunks handed to a transcription API.
 *
 * System audio: captured via getDisplayMedia, which the main process
 * auto-grants through setDisplayMediaRequestHandler({ audio: 'loopback' }) -
 * on Windows this yields the loopback of everything the speakers play.
 * (The legacy getUserMedia chromeMediaSource route is forbidden: it
 * terminates the renderer on recent Electron - bad IPC message, reason 263.)
 * macOS has no loopback without virtual audio drivers, so capture degrades
 * to mic-only there.
 *
 * Chunking strategy: MediaRecorder's timeslice mode produces corrupt files
 * after the first chunk (the webm header is written only once). Instead we
 * restart the recorder every CHUNK_MS, so EVERY blob is a complete,
 * API-ready file. Cost: a few milliseconds of audio at chunk boundaries.
 */
const CHUNK_MS = 5000

/**
 * Transcribe one audio chunk. Wired to any OpenAI-compatible
 * /audio/transcriptions endpoint - Groq Whisper works out of the box with
 * the existing .env credentials. Swap the body of this function to change
 * providers (the contract stays: Blob in, transcript string out).
 *
 * @param {Blob} blob Complete audio file (audio/webm;codecs=opus).
 * @returns {Promise<string>} Transcript text (may be empty for silence).
 */
export async function sendToTranscription(blob) {
  if (!blob || blob.size === 0) return ''
  if (!window.overlay?.sendToTranscription) {
    throw new Error('Transcription bridge unavailable - restart the application')
  }

  // ArrayBuffer is structured-cloneable across the preload bridge. The API
  // key and multipart request are assembled only in the main process.
  return window.overlay.sendToTranscription({
    data: await blob.arrayBuffer(),
    type: blob.type || 'audio/webm'
  })
}

function reportAudioStatus(status) {
  const pending = window.overlay?.reportAudioStatus?.(status)
  if (pending?.catch) void pending.catch(() => {})
}

/**
 * Request the system-audio loopback stream via getDisplayMedia. The main
 * process answers the request through setDisplayMediaRequestHandler with
 * audio: 'loopback', so no picker appears and no source id is needed.
 *
 * Never use the legacy getUserMedia({ chromeMediaSource: 'desktop' }) route
 * here: on recent Electron it terminates the renderer instantly (bad IPC
 * message, reason 263 - electron/electron#46369, #47512).
 *
 * @returns {Promise<MediaStream | null>} null when the platform has no loopback.
 */
async function getSystemAudioStream() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by the getDisplayMedia spec; the audio rides along
      audio: true
    })
    stream.getVideoTracks().forEach((t) => t.stop()) // we only wanted the audio
    return stream.getAudioTracks().length > 0 ? stream : null
  } catch {
    return null // no loopback on this platform (e.g. macOS) - mic-only fallback
  }
}

/**
 * Start dual-channel capture. Must be called from a user gesture (button
 * click) so the AudioContext is allowed to start.
 *
 * @param {object} handlers
 * @param {(channels: 'mic+system' | 'mic') => void} [handlers.onReady]
 *   Called once capture is live, reporting which channels were secured.
 * @param {(text: string) => void} [handlers.onTranscript]
 *   Called per transcribed chunk.
 * @param {(message: string) => void} [handlers.onError]
 *   Non-fatal errors (e.g. one chunk failed to transcribe); recording continues.
 * @param {(reason: string) => void} [handlers.onEnded]
 *   Recording terminated on its own (e.g. audio device disconnected).
 * @returns {Promise<{ stop: () => void }>} Controller - call stop() to end capture.
 */
export async function startAudioLoopback({ onReady, onTranscript, onError, onEnded } = {}) {
  let stopped = false
  let audioContext = null
  let recorder = null
  const streams = []
  reportAudioStatus({ state: 'starting' })

  // ------------------------- 1. Microphone -------------------------------
  let micStream
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    reportAudioStatus({ state: 'error', error: `Microphone unavailable: ${err.message}` })
    throw new Error(`Microphone unavailable: ${err.message}`, { cause: err })
  }
  streams.push(micStream)

  // ------------------------ 2. System audio ------------------------------
  // Starts as null; if the probe below throws we simply stay mic-only.
  let systemStream = null
  try {
    systemStream = await getSystemAudioStream()
  } catch {
    /* no loopback on this platform - continue with mic only */
  }
  if (systemStream) streams.push(systemStream)

  // --------------------------- 3. Mix ------------------------------------
  audioContext = new AudioContext()
  await audioContext.resume() // allowed: we are inside the click gesture
  const destination = audioContext.createMediaStreamDestination()
  audioContext.createMediaStreamSource(micStream).connect(destination)
  if (systemStream) audioContext.createMediaStreamSource(systemStream).connect(destination)
  // Deliberately NOT connected to audioContext.destination: monitoring would
  // play the system feed a second time (echo).

  // ------------------------ 4. Record chunks -----------------------------
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type)
  )
  recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined)

  recorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return
    try {
      const text = await sendToTranscription(event.data)
      if (text) onTranscript?.(text)
    } catch (err) {
      onError?.(err.message) // keep recording; only this chunk is lost
      reportAudioStatus({ state: 'error', channels: systemStream ? 'mic+system' : 'mic', error: err.message })
    }
  }

  // Restart-based segmentation: each stop() finalizes a complete webm file.
  recorder.onstop = () => {
    if (!stopped) recorder.start()
  }

  const chunkTimer = setInterval(() => {
    if (recorder && recorder.state === 'recording') recorder.stop()
  }, CHUNK_MS)

  // Auto-stop when an audio device disappears (unplug, switch, revoke).
  const handleDeviceLost = () => {
    if (!stopped) stop('Audio device disconnected - listening stopped.')
  }
  micStream.getAudioTracks().forEach((t) => (t.onended = handleDeviceLost))
  if (systemStream) systemStream.getAudioTracks().forEach((t) => (t.onended = handleDeviceLost))

  recorder.start()
  const channels = systemStream ? 'mic+system' : 'mic'
  reportAudioStatus({ state: 'active', channels })
  onReady?.(channels)

  function stop(reason = null) {
    if (stopped) return
    stopped = true
    clearInterval(chunkTimer)
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop() // fires a final ondataavailable -> last chunk still transcribes
    }
    streams.forEach((stream) => stream.getTracks().forEach((t) => t.stop()))
    audioContext?.close().catch(() => {})
    if (reason) onEnded?.(reason)
    reportAudioStatus({ state: reason ? 'ended' : 'idle', error: reason })
  }

  return { stop: () => stop(null) }
}
