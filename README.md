# Aura 🌌

> A stealthy, high-performance system-level AI assistant overlay built with Electron, React, Vite, and a photographic memory.

Aura lives quietly in your system tray and slides into view whenever you need it with a simple global shortcut (`Ctrl+Shift+Space` / `Cmd+Shift+Space`). It answers questions with streaming markdown, sees your screen, hears your microphone _and_ system audio, remembers everything it saw — and stays invisible to screen recordings while doing it.

---

## ✨ Features

- ⚡ **Instant Summon & Dismiss** — Toggle the overlay from anywhere with `Ctrl+Shift+Space`. `Esc` or click-away hides it; it keeps running quietly in the tray.
- 👻 **Stealth Mode** — `win.setContentProtection(true)` makes Aura invisible to OBS, Discord, Zoom, and Teams captures (`WDA_EXCLUDEFROMCAPTURE` on Windows). Toggle with `Ctrl+Shift+U` / `Cmd+Shift+U` or the composer badge.
- 📸 **Vision Context** — One click grabs your screen as context for vision-capable models. Clipboard image paste works too (screenshot from anywhere → `Ctrl+V`).
- 🎙️ **Dual-Channel Audio Loopback** — Captures your microphone _and_ system output simultaneously, mixes them via the Web Audio API, and transcribes 5-second chunks through Whisper. Transcripts land straight in the input box; listening stops when the overlay is hidden.
- 🧠 **Photographic Memory** — An opt-in background loop can screenshot your primary display every 15 seconds, OCR it with tesseract.js, and store it in a local SQLite database with full-text search (FTS5). Nothing leaves your machine.
- 🔎 **`/recall` — RAG on your own screen history** — Type `/recall github` and Aura searches its memory index, attaches the matches as context, and the AI summarizes what you were doing.
- 🎨 **Sleek Glassmorphic Design** — Frameless translucent window, drag-to-move, edge-resizable, auto-growing height, GFM markdown rendering, streaming caret.
- 🗂️ **Personal Command Center** — Ask, search authorized local folders, and manage a persistent offline task list from the same overlay. Use `/find <name>` and `/todo <task>` for quick actions.

---

## ⌨️ Shortcuts & Commands

| Input                                  | Description                                       |
| :------------------------------------- | :------------------------------------------------ |
| `Ctrl+Shift+Space` / `Cmd+Shift+Space` | Toggle Aura from anywhere in the OS               |
| `Ctrl+Shift+U` / `Cmd+Shift+U`          | Toggle **Stealth Mode** (capture exclusion)       |
| `/recall <keyword>`                    | Search screen history and let the AI summarize it |
| `/find <name>`                         | Search authorized local folders                   |
| `/todo <task>`                         | Add a local task                                   |
| `Enter`                                | Send message                                      |
| `Shift+Enter`                          | Newline in composer                               |
| `Esc`                                  | Hide overlay                                      |

Composer badges: **Listen** (mic + system audio) · **Screen** (vision context) · **Stealth/Shared** (capture visibility).

The **Files** tab searches only folders you explicitly authorize and supports Open, Show in folder, and Copy path. The **Tasks** tab stores a checklist locally on this device and works without an AI connection.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- On Windows, native-module builds may need [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (usually skipped — prebuilt binaries cover most setups)

### Installation

1. **Clone and install:**

   ```bash
   git clone https://github.com/Vishalvishnu64/Aura.git
   cd Aura
   npm install
   ```

2. **Rebuild the native SQLite module against Electron:**

   ```bash
   npx electron-rebuild -f -w better-sqlite3
   ```

3. **Configure your AI endpoint** — copy `.env.example` to `.env` and fill it in:

   ```env
   VITE_AI_BASE_URL=https://api.groq.com/openai/v1
   VITE_AI_API_KEY=your_api_key_here
   VITE_AI_MODEL=qwen/qwen3.8-27b
   VITE_TRANSCRIBE_MODEL=whisper-large-v3-turbo
   ```

   Any OpenAI-compatible endpoint works — Groq, OpenAI, Together, or a local Ollama/LM Studio server. These settings are loaded by Electron's main process at runtime; the API key is never bundled into the renderer. `AI_*` names are also accepted for deployments that do not use the `VITE_` prefix. Packaged deployments can set `AI_OVERLAY_ENV_FILE` to an environment-file path.

4. **Run:**
   ```bash
   npm run dev
   ```

---

## 🏗️ How It Works

Aura is split into three sandboxed layers that talk only through a tiny allowlisted IPC bridge:

```
┌─ Main process (Node) ──────────────────────────────────────┐
│ frameless transparent window · tray · global hotkeys       │
│ desktopCapturer · powerMonitor · better-sqlite3 + FTS5     │
│ tesseract.js worker · content protection · AI fetch/SSE    │
└──────────────▲──────────────────────────┬──────────────────┘
        ipcMain.handle          contextBridge
        (invoke-only)      window.overlay.* API
┌──────────────┴──────────────────────────▼──────────────────┐
│ Preload (sandboxed bridge) ── src/preload/index.js         │
└──────────────▲──────────────────────────┬──────────────────┘
┌──────────────┴──────────────────────────▼──────────────────┐
│ Renderer (React + Tailwind) ── src/renderer/               │
│ chat UI · streamed IPC chunks · WebAudio mixer ·           │
│ MediaRecorder chunking · markdown rendering                │
└─────────────────────────────────────────────────────────────┘
```

- **Streaming chat** — the Electron main process sends requests to any OpenAI-compatible `/chat/completions` endpoint with incremental SSE parsing; the renderer receives only streamed text and never receives the API key.
- **System audio** — granted through `setDisplayMediaRequestHandler` (`audio: 'loopback'`); mic and system streams are mixed into one `MediaStreamAudioDestinationNode` and recorded as self-contained 5-second `.webm` chunks.
- **Memory loop** — screenshots are skipped when the screen hasn't changed, OCR runs on a single shared worker, capture pauses on lock-screen/suspend, and a retention cron deletes anything older than 7 days (rows + image files).

### Project structure

```
src/
├─ main/
│  ├─ index.js            # window, tray, hotkeys, IPC, capture permissions
│  ├─ fileService.js       # authorized local-folder search and safe file actions
│  ├─ tasksService.js      # local checklist storage and mutations
│  └─ memoryService.js    # SQLite + FTS5, capture/OCR loop, retention, search
├─ preload/
│  └─ index.js            # contextBridge → window.overlay.*
└─ renderer/
   ├─ index.html          # strict CSP
   └─ src/
      ├─ App.jsx            # Ask/Files/Tasks tabs, chat, badges, slash commands
      ├─ components/
      │  ├─ FilesPanel.jsx  # authorized local file search UI
      │  └─ TasksPanel.jsx  # persistent local checklist UI
      └─ services/
         ├─ aiService.js    # streaming chat client (OpenAI-compatible)
         ├─ audioService.js # mic + loopback capture, chunking, Whisper
         └─ localCommands.js # deterministic /find and /todo routing
```

---

## 🔒 Data & Privacy

- **Stealth by default** — Aura excludes itself from all screen captures; it also never appears in its own memory frames.
- **Local-first memory** — screenshots, OCR text, and the database live in `%APPDATA%/ai-overlay/` (`memory_frames/`, `photographic-memory.db`). Memory is opt-in, can be paused or deleted from the overlay/tray, and a cron purges frames older than 7 days.
- **The only network traffic** is your own configured AI endpoint (chat, vision, transcription). The API key is read by the Electron main process from `.env` or environment variables and is not bundled into the renderer.
- **Memory is pausable** — tray → _Pause Photographic Memory_ stops the capture loop instantly.
- **File search is scoped** — Aura searches only folders you explicitly authorize; it does not search file contents, delete files, or send paths to the AI.
- **Tasks are local** — the checklist is stored separately in `tasks.db` and works without an AI connection.

---

## 🛠️ Built With

- **[Electron](https://www.electronjs.org/)** – desktop runtime and OS integration
- **[React 19](https://react.dev/)** – UI framework
- **[Vite](https://vitejs.dev/)** + **[electron-vite](https://electron-vite.org/)** – build tooling and HMR
- **[Tailwind CSS v4](https://tailwindcss.com/)** – styling
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** – local SQLite with FTS5 full-text search
- **[tesseract.js](https://tesseract.projectnaptha.com/)** – OCR engine (WASM)
- **[React Markdown](https://github.com/remarkjs/react-markdown)** – GFM rendering

---

## 📜 License

This project is licensed under the MIT License.
