# Aura 🌌

> A stealthy, high-performance system-level AI assistant overlay built with Electron, React, and Vite.

Aura lives quietly in your system tray and slides into view whenever you need it with a simple global shortcut (`Ctrl+Shift+Space` / `Cmd+Shift+Space`). Designed for fluid, non-intrusive workflows, it features screen context awareness, live voice/audio transcription, and screen-share exclusion mode (Stealth Mode).

---

## ✨ Features

- ⚡ **Instant Summon & Dismiss**: Toggle the overlay from anywhere using `Ctrl+Shift+Space` (or `Cmd+Shift+Space` on macOS). Press `Esc` or click outside to instantly hide.
- 👁️‍🗨️ **Stealth Mode (Screen Share Exclusion)**: Built-in capture protection (`win.setContentProtection(true)`) ensures Aura remains invisible during OBS recordings, Discord screen shares, Zoom, or Teams calls. Toggle anytime with `Ctrl+Alt+S`.
- 📸 **Screen Context Awareness**: Capture your current display with one click to send full visual context directly to vision-capable AI models. Also supports direct image pasting from clipboard.
- 🎙️ **Live Audio Loopback & Transcription**: Stream audio from both your microphone and system loopback directly into input text.
- 🎨 **Sleek Glassmorphic Design**: Frameless translucent window with dynamic auto-height adjustments, edge resizability, and full GitHub Flavored Markdown (GFM) support.

---

## ⌨️ Shortcuts & Hotkeys

| Shortcut | Description |
| :--- | :--- |
| `Ctrl+Shift+Space` / `Cmd+Shift+Space` | Toggle Aura overlay visibility from anywhere in your OS |
| `Ctrl+Alt+S` | Toggle **Stealth Mode** (screen capture exclusion on/off) |
| `Enter` | Send message |
| `Shift + Enter` | Insert newline in composer |
| `Esc` | Hide overlay |

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- `npm` or `yarn`

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Vishalvishnu64/Aura.git
   cd Aura
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory (refer to `.env.example` if available):
   ```env
   VITE_AI_API_KEY=your_api_key_here
   ```

4. **Run in Development Mode:**
   ```bash
   npm run dev
   ```

---

## 🛠️ Built With

- **[Electron](https://www.electronjs.org/)** – Cross-platform desktop app runtime
- **[React 19](https://react.dev/)** – UI framework
- **[Vite](https://vitejs.dev/)** + **[electron-vite](https://electron-vite.org/)** – Fast build tooling and HMR
- **[Tailwind CSS](https://tailwindcss.com/)** – Utility-first CSS styling
- **[React Markdown](https://github.com/remarkjs/react-markdown)** – Rich Markdown & GFM rendering

---

## 📜 License

This project is licensed under the MIT License.
