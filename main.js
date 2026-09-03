// main.js
const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, dialog, Notification, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

// Create the RPC secret before loading server.js. The server can begin its
// reconciliation timer immediately, so it must never observe an empty secret.
const RPC_SECRET = process.env.ARIA2_SECRET || crypto.randomBytes(16).toString('hex');
process.env.ARIA2_SECRET = RPC_SECRET;

// Port sync fix: main.js and server.js used to each hard-code 3000. Set it
// HERE, before requiring server.js, so both processes share one constant.
const SERVER_PORT = 3000;
process.env.PORT = String(SERVER_PORT);

// Single-instance guard. Without this, two LSDM windows race for the same
// internal port and silently screw each other up. We acquire the lock BEFORE
// requiring server.js so the second instance never even opens a socket. The
// first instance gets a 'second-instance' event so it can pop its window.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // eslint-disable-next-line no-console
  console.log('[lsdm] another instance is already running — exiting.');
  app.exit(0);
  process.exit(0);
}

// Start internal Express server
require('./server.js');

// When a second instance is launched (e.g. a user double-clicked the .exe),
// surface the existing window instead of opening a duplicate.
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
});

let mainWindow = null;
let promptWindow = null;
let tray = null;
let ariaProcess = null;
let lastClipboardText = '';
let clipboardWatcher = null;

const ARIA_PORT = 6800;

// Auto-locate aria2c.exe inside tools directory.
// Packaging-aware: electron-builder unpacks tools/ to app.asar.unpacked so the
// spawned exe can actually execute (Windows can't exec from inside an asar).
function findAriaExecutable() {
  const candidates = [
    // electron-builder's asarUnpack location.
    __dirname.replace(/app\.asar(?:[\\/]|$)/, (match) =>
      match.replace('app.asar', 'app.asar.unpacked'),
    ),
    // Explicit resources path is more reliable for custom install layouts.
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked') : null,
    __dirname,
  ].filter(Boolean);
  for (const base of candidates) {
    const found = scan(path.join(base, 'tools'));
    if (found) return found;
  }
  return null;

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
}

// In main.js
async function waitForAriaDaemon(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'aria2 did not respond';
  while (Date.now() < deadline) {
    if (!ariaProcess) break;
    try {
      const response = await fetch(`http://127.0.0.1:${ARIA_PORT}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'lsdm-ready',
          method: 'aria2.getVersion',
          params: [`token:${RPC_SECRET}`],
        }),
        signal: AbortSignal.timeout(1000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.result?.version) return true;
      lastError = payload?.error?.message || `HTTP ${response.status}`;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.error(`[lsdm] aria2 readiness check failed: ${lastError}`);
  return false;
}

function startAriaDaemon() {
  const ariaPath = findAriaExecutable();
  if (!ariaPath) {
    console.error('ERROR: aria2c.exe not found in tools folder');
    return;
  }

  const ariaDir = path.dirname(ariaPath);
  // `ariaDir` is app.asar.unpacked in production and may be under Program Files.
  // Keep mutable aria2 state in Electron's per-user data directory instead.
  const ariaStateDir = path.join(app.getPath('userData'), 'aria2');
  fs.mkdirSync(ariaStateDir, { recursive: true });
  const logPath = path.join(ariaStateDir, 'aria2.log');
  // Persistence: unfinished downloads are restored from the writable state dir.
  const sessionPath = path.join(ariaStateDir, 'aria2.session');

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
  // Do not set bt-request-peer-speed-limit: a high threshold rejects slower
  // peers, which is exactly what makes healthy swarms show peers but 0 B/s.
  '--bt-detach-seed-only=true',
  '--follow-torrent=true',
  // Speed tuning: keep more peers unchoked and request aggressively
  '--bt-max-open-files=256',
  '--bt-stop-timeout=0',
  '--bt-save-metadata=true',
  // Never force sequential piece requests: it serializes a torrent and can
  // leave available peers idle. aria2's default piece selector is parallel.
  '--force-sequential=false',
  '--bt-tracker-connect-timeout=10',
  '--bt-tracker-interval=60',
  '--bt-enable-hook-after-hash-check=true',
  // Faster DHT bootstrap: seed entry points so we join the swarm quickly
  // instead of slowly discovering the network on first run
  '--dht-entry-point=router.bittorrent.com:6881',
  '--dht-entry-point6=dht.transmissionbt.com:6881',
  '--dht-file-path=' + path.join(ariaStateDir, 'dht.dat'),
  // Resume support: aria2 reads this file at startup, restarts every task
  // that wasn't finished, and rewrites it every 30s. Combined with the
  // saveSession/shutdown RPC on graceful quit, no download is ever silently
  // orphaned between LSDM sessions.
  '--save-session=' + sessionPath,
  '--save-session-interval=30',
  '--bt-min-crypto-level=plain',
  '--bt-require-crypto=false',
  '--seed-time=0',
  '--max-overall-download-limit=0',
  '--max-download-limit=0',
  `--log=${logPath}`,
  '--log-level=notice'
];

  console.log('Spawning aria2 daemon at:', ariaPath);

  // Security: use the secret created before server.js was loaded so both sides
  // always authenticate the same daemon, including during startup recovery.
  const rpcSecret = RPC_SECRET;
  args.push(`--rpc-secret=${rpcSecret}`);

  ariaProcess = spawn(ariaPath, args, {
    cwd: ariaDir,
    windowsHide: true,
    env: { ...process.env, ARIA2_SECRET: rpcSecret },
  });

  // Pass the same secret to the internal Express server
  process.env.ARIA2_SECRET = rpcSecret;

  ariaProcess.stdout?.on('data', (d) => console.log(`[aria2] ${d}`));
  ariaProcess.stderr?.on('data', (d) => console.error(`[aria2 ERROR] ${d}`));

  ariaProcess.on('error', (err) => {
    console.error(`[lsdm] failed to start aria2c: ${err.message}. Executable: ${ariaPath}`);
  });
  ariaProcess.on('exit', (code, signal) => {
    console.error(`aria2c process exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}. Check ${logPath}`);
    ariaProcess = null;
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

  // Titlebar controls. The max handler also pushes the new state back to the
  // renderer so the titlebar glyph (▢ vs ❐) actually reflects what Windows
  // thinks, not what the renderer last clicked.
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    mainWindow.webContents.send(
      'window:maximized-state',
      mainWindow.isMaximized(),
    );
  });
  ipcMain.on('window:close', () => mainWindow?.hide());

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window:maximized-state', true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window:maximized-state', false);
  });
  mainWindow.on('resize', () => {
    // Defensive: Windows sometimes reports unmaximize without firing the
    // event after an OS-driven snap (Win+arrow). Always piggyback on resize.
    mainWindow.webContents.send(
      'window:maximized-state',
      mainWindow.isMaximized(),
    );
  });

  mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}`);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // Loads favicon.ico from public/ and rescales to the standard 16x16 tray
  // size so it stays crisp on Windows hi-DPI displays. We deliberately don't
  // bail if the file is missing — fall back to an airwatch icon so the tray
  // is always present (the user can still see LSDM is running).
  const icoPath = path.join(__dirname, 'public', 'favicon.ico');
  let img;
  try {
    img = nativeImage.createFromPath(icoPath);
    if (img.isEmpty()) img = nativeImage.createEmpty();
    else img = img.resize({ width: 16, height: 16 });
  } catch (err) {
    console.warn('[lsdm] tray icon load failed:', err?.message || err);
    img = nativeImage.createEmpty();
  }
  tray = new Tray(img);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open LSDM', click: () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.moveTop();
        mainWindow.focus();
      }
    },
    { label: 'Aria2 Monitor', click: () => shell.openExternal(`http://127.0.0.1:${SERVER_PORT}/ariang`) },
    { type: 'separator' },
    { label: 'Exit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('LSDM — Running');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
}

// Windows Clipboard Sniffer
function startClipboardWatcher() {
  const downloadPattern = /^(https?:\/\/|magnet:\?xt=).*\.(zip|rar|7z|tar|gz|iso|exe|msi|mp4|mkv|mov|ts|m3u8|pdf|epub)(\?.*)?$/i;
  // url -> { lastPromptAt, lastSeenState }. Tracks BOTH the prompt cooldown
  // and the latest task state we observed for the URL — so we don't re-prompt
  // when the user re-copies a completed/failed URL a minute later, and don't
  // re-fire just because the task transitioned out of `downloading`.
  const recentPrompts = new Map();
  const PROMPT_COOLDOWN = 5 * 60 * 1000; // hard cap on repeated prompts
  // Terminal-state set: once a URL is in any of these, we won't prompt again
  // until the user actively removes the task or the cooldown window expires.
  const TERMINAL_STATES = new Set([
    'error', 'failed', 'complete', 'cancelled', 'removed',
  ]);

  // Keep the handle so before-quit can stop the watcher cleanly
  clipboardWatcher = setInterval(async () => {
    const now = Date.now();
    // Memory fix: prune expired cooldown entries so the map can't grow
    // unbounded over long-running sessions.
    for (const [url, info] of recentPrompts) {
      if (now - info.lastPromptAt >= PROMPT_COOLDOWN) recentPrompts.delete(url);
    }
    const text = clipboard.readText().trim();
    if (text && text !== lastClipboardText) {
      lastClipboardText = text;
      if (downloadPattern.test(text) || text.startsWith('magnet:?')) {
        // Skip if we already prompted for this URL recently
        const info = recentPrompts.get(text);
        if (info && now - info.lastPromptAt < PROMPT_COOLDOWN) return;

        // Skip if the URL matches an active or terminal-state task: the user
        // either already has it, or it just finished and we don't want to
        // pester them about a re-copy. They can re-add manually.
        try {
          const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/status`);
          if (res.ok) {
            const activeTasks = await res.json();
            const match = activeTasks.find((t) => t.url === text);
            if (match) {
              // Update lastSeenState so a race where the task goes terminal
              // *after* this check doesn't immediately re-fire.
              recentPrompts.set(text, {
                lastPromptAt: info?.lastPromptAt ?? 0,
                lastSeenState: match.state,
              });
              // We only swallow the prompt when the matching task is still
              // useful (downloading) or already terminal — those are the two
              // states where re-prompting would be useless/nagging.
              if (
                match.progress < 100 &&
                !TERMINAL_STATES.has(match.state) &&
                match.state !== 'paused'
              ) {
                return;
              }
              if (TERMINAL_STATES.has(match.state)) {
                // If the URL was already completed/failed, only re-prompt
                // after the cooldown window. lastPromptAt stays at its old
                // value so a fresh cooldown check applies.
                if (info && now - info.lastPromptAt < PROMPT_COOLDOWN) return;
              }
            }
          }
        } catch {}

        recentPrompts.set(text, { lastPromptAt: now, lastSeenState: null });
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

// Open a folder/file in Explorer (e.g. "Open downloads folder" button).
// SECURITY: we strictly refuse anything that isn't a directory. The renderer
// can pass ANY string here via XSS or a future bug, and shell.openPath()
// happily executes .exe paths on Windows — this used to be the only path
// between a compromised tab and `cmd.exe`.
ipcMain.handle('shell:open-path', async (_event, targetPath) => {
  try {
    if (!targetPath || typeof targetPath !== 'string') {
      if (Notification.isSupported()) {
        new Notification({ title: 'LSDM', body: 'No folder was provided.' }).show();
      }
      return false;
    }
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      if (Notification.isSupported()) {
        new Notification({
          title: 'LSDM',
          body: `Folder not found: ${targetPath}`,
        }).show();
      }
      return false;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      // Refuse files (incl. executables) so this can't be weaponised. The
      // only legitimate use is opening the downloads folder.
      if (Notification.isSupported()) {
        new Notification({
          title: 'LSDM',
          body: 'Only folders can be opened (not files).',
        }).show();
      }
      return false;
    }
    await shell.openPath(resolved);
    return true;
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

// Fires once on startup if the internal Express server failed to bind.
// Lets the renderer show a fatal banner instead of a perpetual spinner.
ipcMain.on('app:report-fatal', (_event, payload) => {
  console.error('[lsdm] renderer reports:', payload);
  if (Notification.isSupported()) {
    new Notification({
      title: 'LSDM — fatal error',
      body: payload?.message || 'Check the logs and restart LSDM.',
    }).show();
  }
});

// One-shot reply signal: the renderer probes this before declaring the UI
// dead. If the server is up but the page is responding, we know it's a
// renderer bug; if the server is down, it's a fatal Express/port issue.
ipcMain.handle('app:health-check', async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/status`, {
      signal: AbortSignal.timeout(1500),
    });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.on('download:trigger-prompt', (event, url) => {
  createDownloadPrompt(url);
});

ipcMain.on('prompt:close', () => {
  if (promptWindow) promptWindow.close();
});

// macOS traditionally keeps the app alive after the last window is closed
// (just hides the dock icon). On Windows/Linux the expectation is to fully
// quit. Without an explicit window-all-closed handler, the standard
// Electron default is to quit on non-darwin platforms — that's already
// correct, but it skips ORCHESTRATING our exit when the user closes the
// last window via the X. We honour app.isQuitting and route through the
// existing before-quit shutdown path so the aria2 session gets saved
// even on a 'window-X' quit.
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // Trigger our before-quit handler so aria2's session is saved before
  // the process dies. app.quit() chains into before-quit which honours
  // the isQuitting flag, so calling it directly is safe.
  if (!app.isQuitting) {
    app.isQuitting = true;
    app.quit();
  }
});

// On macOS, when the dock icon is clicked with no windows open, recreate
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  } else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  startAriaDaemon();
  // Do not expose a ready-looking window while the backend is still starting.
  // This removes the first-click race in packaged builds where aria2 may need
  // a few seconds to initialize its RPC listener and session file.
  const ariaReady = await waitForAriaDaemon();
  if (!ariaReady) {
    console.error('[lsdm] aria2 is unavailable; downloads will be reported as backend failures.');
  }
  createMainWindow();
  // Don't swallow tray creation errors. Tray APIs can fail when there's no
  // notification area visible (e.g. RDP without a taskbar, or a policy
  // block); surfacing the failure lets the user diagnose instead of wondering
  // why "Exit" is suddenly missing.
  try {
    createTray();
  } catch (err) {
    console.warn('[lsdm] tray creation failed (continuing without tray):', err?.message || err);
    if (Notification.isSupported()) {
      new Notification({
        title: 'LSDM',
        body: 'System tray unavailable — the app is running but you must use the window to control it.',
      }).show();
    }
  }
  startClipboardWatcher();
  // Note: 'activate' is registered above (module-level) so we don't
  // duplicate it here.
});

// Best-effort graceful shutdown helper. Saves the aria2 session (so an
// aria2c restart can resume every unfinished download), then sends SIGTERM
// via aria2.shutdown and waits up to 5s. Falls back to SIGKILL only if the
// daemon ignores the request — this used to be the only path, which meant
// SIGKILL'd aria2 had no chance to flush state.
async function shutdownAriaDaemon() {
  if (!ariaProcess) return;
  const secret = process.env.ARIA2_SECRET;
  if (secret) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const r1 = await fetch('http://127.0.0.1:6800/jsonrpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'lsdm-save',
          method: 'aria2.saveSession',
          params: [`token:${secret}`],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      void r1; // result isn't actionable — saveSession returns "OK"
    } catch (err) {
      console.warn('[lsdm] aria2.saveSession failed:', err.message);
    }
    try {
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), 2000);
      const r2 = await fetch('http://127.0.0.1:6800/jsonrpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'lsdm-shutdown',
          method: 'aria2.shutdown',
          params: [`token:${secret}`],
        }),
        signal: ctrl2.signal,
      });
      clearTimeout(timer2);
      void r2;
    } catch (err) {
      console.warn('[lsdm] aria2.shutdown RPC failed (will SIGKILL):', err.message);
    }
  }
  // Wait up to 5s for aria2 to actually exit cleanly; SIGKILL otherwise.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    ariaProcess.once('exit', finish);
    const fallback = setTimeout(() => {
      try { ariaProcess.kill('SIGKILL'); } catch {}
      finish();
    }, 5000);
    ariaProcess.once('exit', () => clearTimeout(fallback));
  });
}

app.on('before-quit', async (event) => {
  if (app.isQuitting) return; // re-entrancy guard
  app.isQuitting = true;
  // Stop the clipboard sniffer so it can't fire a prompt mid-shutdown
  if (clipboardWatcher) clearInterval(clipboardWatcher);
  // Block quit until aria2 saved its session. The handler is async but
  // Electron only waits for it if we register on will-quit too — so we
  // also keep a fallback SIGKILL timer in case the RPC hangs.
  if (ariaProcess) {
    event.preventDefault();
    shutdownAriaDaemon()
      .catch((e) => console.warn('[lsdm] shutdownAriaDaemon error:', e?.message || e))
      .finally(() => app.exit(0));
  }
});