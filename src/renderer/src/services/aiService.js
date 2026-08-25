/**
 * Minimal streaming client for any OpenAI-compatible chat API
 * (Groq, OpenAI, Together, LM Studio, Ollama with OLLAMA_ORIGINS=*, ...).
 *
 * Configuration lives in `.env` (Vite exposes VITE_* vars to the renderer):
 *   VITE_AI_BASE_URL  e.g. https://api.groq.com/openai/v1
 *   VITE_AI_API_KEY   your secret key (stays out of git via .gitignore)
 *   VITE_AI_MODEL     e.g. meta-llama/llama-4-scout-17b-16e-instruct
 */
const BASE_URL = import.meta.env.VITE_AI_BASE_URL ?? 'https://api.groq.com/openai/v1'
const API_KEY = import.meta.env.VITE_AI_API_KEY ?? ''
const MODEL = import.meta.env.VITE_AI_MODEL ?? 'qwen/qwen3.6-27b'

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
 * Shape the message list for the API. When a screenshot is attached, the
 * newest user message is upgraded to the multimodal content format:
 * [{ type: 'text' }, { type: 'image_url' }].
 *
 * @param {{role: string, content: string}[]} messages
 * @param {string | null} imageBase64 PNG data URL from captureScreen()
 */
function buildMessages(messages, imageBase64) {
  if (!imageBase64) return messages.map(({ role, content }) => ({ role, content }))

  return messages.map((message, index) => {
    const isLastUser = index === messages.length - 1 && message.role === 'user'
    if (!isLastUser) return { role: message.role, content: message.content }

    return {
      role: 'user',
      content: [
        { type: 'text', text: message.content },
        { type: 'image_url', image_url: { url: imageBase64 } }
      ]
    }
  })
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
  if (!API_KEY && /api\.(groq|openai)\.com/.test(BASE_URL)) {
    throw new Error('Missing VITE_AI_API_KEY - add it to .env and restart the dev server')
  }

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: buildMessages(messages, imageBase64)
    })
  })

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      /* body unreadable - fall through with status only */
    }
    throw new Error(`AI request failed (${response.status}): ${detail}`)
  }
  if (!response.body) throw new Error('AI response has no readable body')

  // --- Incremental Server-Sent-Events parsing ---
  // Network chunks can split SSE lines mid-way, so bytes are accumulated in a
  // buffer and only complete lines are consumed.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const filter = createThinkFilter(onChunk)
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trimEnd()
      buffer = buffer.slice(newlineIndex + 1)

      if (!line.startsWith('data:')) continue // skip comments / keep-alives
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        filter.flush()
        return
      }

      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content
        if (delta) filter.push(delta)
      } catch {
        /* ignore non-JSON lines (pings etc.) */
      }
    }
  }
  filter.flush()
}
