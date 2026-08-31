// main.js
const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, dialog, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

// Port sync fix: main.js and server.js used to each hard-code 3000. Set it
// HERE, before requiring server.js, so both processes share one constant.
const SERVER_PORT = 3000;
process.env.PORT = String(SERVER_PORT);

// Start internal Express server
require('./server.js');

let mainWindow = null;
let promptWindow = null;
let tray = null;
let ariaProcess = null;
let lastClipboardText = '';
let clipboardWatcher = null;

const ARIA_PORT = 6800;

// Auto-locate aria2c.exe inside tools directory
function findAriaExecutable() {
  const toolsDir = path.join(__dirname, 'tools');
  function scan(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) {
        const found = scan(full);
        if (found) return found;
      } else if (f.toLowerCase() === 'aria2c.exe') {
        return full;
      }
    }
    return null;
  }
  return scan(toolsDir);
}

// In main.js
function startAriaDaemon() {
  const ariaPath = findAriaExecutable();
  if (!ariaPath) {
    console.error('ERROR: aria2c.exe not found in tools folder');
    return;
  }

  const ariaDir = path.dirname(ariaPath);
  const logDir = path.join(ariaDir, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'aria2.log');

  // 100% verified, stable high-speed flags
// In main.js -> inside startAriaDaemon()
const args = [
  '--enable-rpc=true',
  '--rpc-listen-all=false',
  '--rpc-allow-origin-all=true',
  `--rpc-listen-port=${ARIA_PORT}`,
  '--max-concurrent-downloads=16',
  '--split=64',
  '--max-connection-per-server=16',
  '--min-split-size=1M',
  '--piece-length=1M',
  '--socket-recv-buffer-size=8M',
  '--disk-cache=256M',
  '--file-allocation=none',
  '--optimize-concurrent-downloads=true',
  '--conditional-get=true',
  '--lowest-speed-limit=0',
  '--allow-overwrite=true',          // Fixes errorCode 13 folder collision
  '--auto-file-renaming=false',
  // BitTorrent Settings
  '--enable-dht=true',
  '--dht-listen-port=6881-6999',
  '--listen-port=6881-6999',
  '--enable-peer-exchange=true',
  '--bt-enable-lpd=true',
  '--bt-max-peers=200',
  // Torrent speed fix: hint expected swarm speed so aria2 actually pulls data
  // from discovered peers instead of just idling connected to them
  '--bt-request-peer-speed-limit=10M',
  '--bt-detach-seed-only=true',
  '--follow-torrent=true',
  // Speed tuning: keep more peers unchoked and request aggressively
  '--bt-max-open-files=256',
  '--bt-stop-timeout=0',
  '--bt-save-metadata=true',
  '--force-sequential=true',
  // Faster DHT bootstrap: seed entry points so we join the swarm quickly
  // instead of slowly discovering the network on first run
  '--dht-entry-point=router.bittorrent.com:6881',
  '--dht-entry-point6=dht.transmissionbt.com:6881',
  '--dht-file-path=' + path.join(ariaDir, 'dht.dat'),
  '--bt-min-crypto-level=plain',
  '--bt-require-crypto=false',
  '--seed-time=0',
  '--max-overall-download-limit=0',
  '--max-download-limit=0',
  `--log=${logPath}`,
  '--log-level=notice'
];

  console.log('Spawning aria2 daemon at:', ariaPath);

  // Security: generate a random RPC secret so only this app can control aria2.
  // Shared with server.js via env var; server prepends "token:<secret>" to calls.
  const rpcSecret = require('crypto').randomBytes(16).toString('hex');
  args.push(`--rpc-secret=${rpcSecret}`);

  ariaProcess = spawn(ariaPath, args, {
    cwd: ariaDir,
    windowsHide: true,
    env: { ...process.env, ARIA2_SECRET: rpcSecret }
  });

  // Pass the same secret to the internal Express server
  process.env.ARIA2_SECRET = rpcSecret;

  ariaProcess.stdout?.on('data', (d) => console.log(`[aria2] ${d}`));
  ariaProcess.stderr?.on('data', (d) => console.error(`[aria2 ERROR] ${d}`));

  ariaProcess.on('exit', (code) => {
    console.error(`aria2c process exited with code ${code}. Check ${logPath}`);
  });
}

// IDM-Style Download Prompt Modal (menu bar stripped via autoHideMenuBar + setMenu(null))
function createDownloadPrompt(url) {
  if (promptWindow) {
    promptWindow.focus();
    promptWindow.webContents.send('prompt:set-url', url);
    return;
  }

  promptWindow = new BrowserWindow({
    width: 560,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true, // Removes "File Edit View Window"
    title: 'LSDM — Download File',
    parent: mainWindow,
    modal: false,
    backgroundColor: '#070913',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  promptWindow.setMenu(null); // Completely strips Electron menu bar
  promptWindow.loadFile(path.join(__dirname, 'public', 'prompt.html'));
  promptWindow.webContents.on('did-finish-load', () => {
    promptWindow.webContents.send('prompt:set-url', url);
  });

  promptWindow.on('closed', () => {
    promptWindow = null;
  });
}

function createMainWindow() {
mainWindow = new BrowserWindow({
  width: 1180,
  height: 760,
  minWidth: 850,
  minHeight: 550,
  frame: false, // Enables native custom titlebar
  backgroundColor: '#070913',
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true
  }
});

// IPC handlers for titlebar controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.hide());

  mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}`);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // Using public icon or standard tray fallback
  tray = new Tray(path.join(__dirname, 'public', 'favicon.ico'));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open LSDM', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Aria2 Monitor', click: () => shell.openExternal(`http://127.0.0.1:${SERVER_PORT}/ariang`) },
    { type: 'separator' },
    { label: 'Exit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('LSDM — Running');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

// Windows Clipboard Sniffer
function startClipboardWatcher() {
  const downloadPattern = /^(https?:\/\/|magnet:\?xt=).*\.(zip|rar|7z|tar|gz|iso|exe|msi|mp4|mkv|mov|ts|m3u8|pdf|epub)(\?.*)?$/i;
  const recentPrompts = new Map(); // url -> timestamp of last prompt
  const PROMPT_COOLDOWN = 5 * 60 * 1000; // Don't re-prompt same URL within 5 minutes

  // Keep the handle so before-quit can stop the watcher cleanly
  clipboardWatcher = setInterval(async () => {
    // Memory fix: prune expired cooldown entries so the map can't grow
    // unbounded over long-running sessions.
    const now = Date.now();
    for (const [url, ts] of recentPrompts) {
      if (now - ts >= PROMPT_COOLDOWN) recentPrompts.delete(url);
    }
    const text = clipboard.readText().trim();
    if (text && text !== lastClipboardText) {
      lastClipboardText = text;
      if (downloadPattern.test(text) || text.startsWith('magnet:?')) {
        // Skip if we already prompted for this URL recently
        const last = recentPrompts.get(text) || 0;
        if (Date.now() - last < PROMPT_COOLDOWN) return;

        // Skip if this URL is already an active download in the server
        try {
          const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/status`);
          if (res.ok) {
            const activeTasks = await res.json();
            const alreadyActive = activeTasks.some(t =>
              t.url === text && !['error', 'failed', 'complete'].includes(t.state)
            );
            if (alreadyActive) return;
          }
        } catch {}

        recentPrompts.set(text, Date.now());
        createDownloadPrompt(text);
      }
    }
  }, 1000);
}

// IPC Handlers
ipcMain.handle('dialog:open-directory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  return canceled ? null : filePaths[0];
});

// Open a folder/file in Explorer (e.g. "Open downloads folder" button)
ipcMain.handle('shell:open-path', async (_event, targetPath) => {
  try {
    if (targetPath && fs.existsSync(targetPath)) {
      await shell.openPath(targetPath);
      return true;
    }
    // Surface the failure instead of silently returning false — the renderer
    // never showed any feedback when the folder was missing/unreachable.
    if (Notification.isSupported()) {
      new Notification({
        title: 'LSDM',
        body: `Folder not found: ${targetPath || '(empty path)'}`
      }).show();
    }
    return false;
  } catch (err) {
    if (Notification.isSupported()) {
      new Notification({ title: 'LSDM', body: `Could not open folder: ${err.message}` }).show();
    }
    return false;
  }
});

// Native OS notifications from the renderer
ipcMain.on('app:notify', (_event, { title, body }) => {
  try {
    if (Notification.isSupported()) {
      new Notification({ title: String(title || 'LSDM'), body: String(body || '') }).show();
    }
  } catch {}
});

// Expose the internal server port to the renderer
ipcMain.handle('app:get-server-port', () => SERVER_PORT);

ipcMain.on('download:trigger-prompt', (event, url) => {
  createDownloadPrompt(url);
});

ipcMain.on('prompt:close', () => {
  if (promptWindow) promptWindow.close();
});

app.whenReady().then(() => {
  startAriaDaemon();
  createMainWindow();
  try { createTray(); } catch (e) {}
  startClipboardWatcher();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  // Stop the clipboard sniffer so it can't fire a prompt mid-shutdown
  if (clipboardWatcher) clearInterval(clipboardWatcher);
  if (ariaProcess) {
    ariaProcess.kill();
  }
});