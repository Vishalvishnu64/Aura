/**
 * Renderer-side contract for the main-process streaming chat bridge.
 *
 * The renderer deliberately contains no endpoint or API-key configuration.
 * `window.overlay.startChat()` sends the request through the allowlisted
 * preload bridge; the main process owns environment loading, fetch, SSE
 * parsing, and the secret API key.
 */

/**
 * Many open models (Qwen3, DeepSeek-R1, ...) inline their chain-of-thought
 * as <think>...</think> inside the streamed content. This filter strips such
 * blocks on the fly, tolerating tags that arrive split across chunks.
 * Leading whitespace before the first visible token is trimmed as well.
 *
 * @param {(token: string) => void} onChunk
 */
function createThinkFilter(onChunk) {
  const OPEN = '<think>'
  const CLOSE = '</think>'
  let insideThink = false
  let pending = ''
  let emitted = false

  const emit = (text) => {
    if (!text) return
    if (!emitted) {
      text = text.replace(/^\s+/, '')
      if (!text) return
      emitted = true
    }
    onChunk(text)
  }

  return {
    /** Feed one streamed delta through the filter. */
    push(text) {
      pending += text
      while (pending) {
        if (insideThink) {
          const end = pending.indexOf(CLOSE)
          if (end === -1) {
            // Hold back a tail that could be a partial closing tag
            pending = pending.slice(Math.max(0, pending.length - (CLOSE.length - 1)))
            return
          }
          pending = pending.slice(end + CLOSE.length)
          insideThink = false
        } else {
          const start = pending.indexOf(OPEN)
          if (start === -1) {
            // Emit everything except a possible partial opening tag
            const keep = Math.min(pending.length, OPEN.length - 1)
            emit(pending.slice(0, pending.length - keep))
            pending = pending.slice(pending.length - keep)
            return
          }
          emit(pending.slice(0, start))
          pending = pending.slice(start + OPEN.length)
          insideThink = true
        }
      }
    },
    /** Call once the stream ends to release any held-back text. */
    flush() {
      if (!insideThink) emit(pending)
      pending = ''
    }
  }
}

/**
 * Stream a chat completion, invoking `onChunk` for every text delta.
 *
 * @param {object} options
 * @param {{role: string, content: string}[]} options.messages Full conversation history.
 * @param {string | null} [options.imageBase64] Optional screen-context screenshot.
 * @param {(token: string) => void} options.onChunk Called per streamed text delta.
 * @param {AbortSignal} [options.signal] Wire this to a Stop button.
 * @returns {Promise<void>} Resolves when the stream finishes ([DONE] or EOF).
 */
export async function streamChat({ messages, imageBase64 = null, signal, onChunk }) {
  const bridge = window.overlay
  if (!bridge?.startChat || !bridge?.onChatChunk) {
    throw new Error('AI bridge unavailable - restart the application')
  }

  const requestId = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const filter = createThinkFilter(onChunk)
  const removeChunkListener = bridge.onChatChunk(requestId, (delta) => filter.push(delta))

  const abort = () => {
    // Cancellation is best-effort: the main process owns the actual network
    // AbortController and will stop emitting chunks as soon as it receives it.
    const pending = bridge.cancelChat?.(requestId)
    if (pending?.catch) void pending.catch(() => {})
  }

  if (signal?.aborted) {
    removeChunkListener?.()
    throw createAbortError()
  }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    await bridge.startChat({ requestId, messages, imageBase64 })
    if (signal?.aborted) throw createAbortError()
    filter.flush()
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw createAbortError()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    removeChunkListener?.()
  }
}

function createAbortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}
