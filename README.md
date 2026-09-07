# ⚡ LSDM — Light Speed Download Manager

A fast, **open-source download manager for Windows** with up to 16 parallel connections per file (powered by [aria2](https://aria2.github.io/)), BitTorrent & magnet-link support, HLS (m3u8) video downloads with AES-128 decryption, Google Drive handling, and a companion Chrome extension that captures streams and downloads — all inside a clean dark Electron UI.

![License: MIT](https://img.shields.io/badge/License-MIT-green)
![Platform: Windows 10/11](https://img.shields.io/badge/Platform-Windows_10%2F11-0078d6)
![Electron](https://img.shields.io/badge/Electron-43-black)
![Engine: aria2](https://img.shields.io/badge/Engine-aria2-purple)
[![CI — lint + tests](https://github.com/terrox1/Light-Speed--Download-Manager/actions/workflows/ci.yml/badge.svg)](https://github.com/terrox1/Light-Speed--Download-Manager/actions)

## Why this project exists

Browsers download slowly (single connection) and lose progress when the tab closes. Commercial managers are paid and closed-source. **LSDM is an open-source alternative that adds the pieces general-purpose managers lack:** HLS video saving, native Google Drive downloads, and browser integration through its own Chrome extension.

## Demo

### Main window

![LSDM main window](SS/Screenshot%202026-09-03%20160200.png)

### Walkthrough videos

- [🎬 **Download tutorial** — paste a link, watch multi-connection speed boost, download completes](SS/Download_Tutorial.mp4)
- [🧩 **Chrome extension tutorial** — capture a stream from a page and send it to LSDM](SS/Extension_Tutorial.mp4)

*Right-click → Save link as… to download the videos (GitHub doesn't inline-play MP4s in previews).*

## Features — and why they matter

- 🚀 **Multi-connection downloads** — up to 16 parallel connections per file via aria2 RPC, with chunked fetching and resume support. Visibly faster than any browser download.
- 🧲 **BitTorrent / magnet links** — DHT + public trackers, no separate torrent client needed.
- 🎬 **HLS (m3u8) downloads** — parallel segment fetching and AES-128 decryption for protected streams, saved as a playable file.
- 📁 **Google Drive support** — survives the virus-scan interstitial and forwards session cookies for reliable big-file downloads.
- 🧩 **Chrome extension** — sniffs video/stream URLs on any page and captures regular browser downloads into LSDM.
- 📋 **Clipboard monitoring** — copy any link, get an instant download prompt.
- 🖥️ **Dark dashboard UI** — live progress, speed and ETA per task, streamed over WebSocket.

## Tech stack

| Area | Technology |
|------|------------|
| Desktop shell | Electron 43 (main process, context-isolated preload, tray, clipboard watcher) |
| Backend | Node.js + Express (internal server on `127.0.0.1:3000`) |
| Real-time UI | WebSocket (`ws`) — live progress, speed, ETA |
| Download engine | aria2 RPC daemon, auto-provisioned via PowerShell script |
| Browser integration | Chrome extension (media sniffing + download capture) |
| Installer | electron-builder → NSIS (x64, Windows 10/11) |

## Architecture

```text
main.js          Electron main process — window, tray, clipboard watcher, aria2 daemon lifecycle
server.js        Express + WebSocket — download engines (aria2 RPC, HLS, Google Drive)
preload.js       Context-isolated IPC bridge (renderer ⇄ main)
public/          Renderer UI — dark dashboard
extension/       Chrome extension — media sniffer + download capture
tools/           install-aria2.ps1 — fetches aria2c.exe locally (binary not committed)
```

**Data flow:** you copy a link (or the Chrome extension captures one) → the server
selects the matching engine (aria2 RPC / HLS / Drive) → progress is streamed over
WebSocket → rendered live in the Electron UI.

## Getting started

**Prerequisites:** [Node.js](https://nodejs.org/) 18+, Windows 10/11.

```bash
npm install                               # 1. install dependencies
powershell -ExecutionPolicy Bypass -File tools\install-aria2.ps1   # 2. one-time aria2 engine
npm start                                 # 3. run the app
```

The app opens at `http://127.0.0.1:3000` inside the Electron window.

**Chrome extension (optional):** `chrome://extensions` → enable **Developer mode**
→ **Load unpacked** → select the `extension/` folder.

## Building an installer

```bash
npm run dist    # electron-builder is already in devDependencies
```

Writes an NSIS installer (x64, custom install directory, desktop + start-menu
shortcuts) to `release/` (git-ignored).

## Tests

```bash
npm test    # node --test tests/
```

Node's built-in test runner (zero extra dependencies) covers the server routes
and the download-engine core. Every push and pull request runs it on a fresh
Ubuntu runner — see the green **CI** badge at the top of this file.

## Run the engine on Linux — proof it's portable

The download engine (Express + WebSocket + aria2 RPC) isn't tied to Windows — it
runs unchanged on Linux. The repo includes a `Dockerfile`:

```bash
docker build -t lsdm-server .
docker run --rm -p 3000:3000 -p 6800:6800 lsdm-server
# then open http://localhost:3000 in a browser, or point the Electron shell at it
```

The same `server.js` that powers the desktop app runs headless in that container
— the Windows-only parts are just the Electron shell, NSIS installer and the aria2
provisioning script.

## Known limitations (honest)

- **Windows-only packaging** — the installed desktop app is a Windows build (NSIS +
  PowerShell aria2 provisioning), while the server engine itself runs anywhere
  (verified via Docker on Linux).
- **aria2 binary is downloaded on first setup** on Windows, not bundled — keeps the repo lean, but needs internet once.
- **No code signing** — Windows SmartScreen may warn on the installer until you sign it.

## Planned next steps

- Download queue with prioritization
- Portable ZIP build

## License

MIT — see [LICENSE](LICENSE).

---

Built with Electron, Express, WebSocket and aria2. Lots of aria2. ⚡

---

**⚡ LSDM — Light Speed Download Manager** · built by [Terrox1](https://github.com/terrox1)

Questions, feedback or bugs? Reach out: [Rk1276026@gmail.com](mailto:Rk1276026@gmail.com)