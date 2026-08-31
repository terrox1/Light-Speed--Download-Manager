# ⚡ LSDM — Light Speed Download Manager Pro

A Windows download manager built with **Electron + Express + aria2**, featuring:

- 🚀 Multi-connection accelerated downloads (up to 16 connections per server, powered by [aria2](https://aria2.github.io/))
- 🧲 BitTorrent / magnet link support with DHT + public trackers
- 🎬 HLS (m3u8) video downloader with AES-128 decryption and parallel segment fetching
- 📁 Native Google Drive support (resolves virus-scan interstitials, forwards session cookies)
- 🧩 Chrome extension that sniffs videos/streams on any page and captures regular browser downloads
- 📋 Clipboard monitoring — copy a link, get a download prompt
- 🖥️ Custom dark UI with live progress, speed, ETA and per-task controls

## Project structure

```
main.js            Electron main process (window, tray, clipboard watcher, aria2 daemon)
server.js          Internal Express server + download engines (aria2 RPC, HLS, GDrive)
preload.js         Context-isolated IPC bridge
public/            UI (renderer)
extension/         Chrome extension (media sniffer + download capture)
tools/             aria2 installer script (binary itself is NOT committed)
```

## Getting started

### 1. Prerequisites

- [Node.js](https://nodejs.org/) 18+
- Windows 10/11

### 2. Install dependencies

```bash
npm install
```

### 3. Install the aria2 engine

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-aria2.ps1
```

This downloads `aria2c.exe` into `tools/aria2/` (the binary is not stored in this repo).

### 4. Run

```bash
npm start
```

The app opens at `http://127.0.0.1:3000` inside the Electron window.

### 5. (Optional) Install the browser extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder

## Building a Windows installer

```bash
npm i -D electron-builder
npm run dist
```

The installer is written to `dist/` (git-ignored).

## License

MIT — see [LICENSE](LICENSE).
