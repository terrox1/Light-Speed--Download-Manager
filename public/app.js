// public/app.js
let currentCategory = "all";
let tasksCache = [];
const tableBody = document.getElementById("tasks-table-body");
const globalSpeedEl = document.getElementById("global-speed");
const globalThreadsEl = document.getElementById("global-threads");
const addModal = document.getElementById("add-modal");
const torrentFileInput = document.getElementById("modal-torrent-file");

// Settings Elements
const settingPathInput = document.getElementById("setting-download-path");
const btnBrowsePath = document.getElementById("btn-browse-path");
const settingThreadsInput = document.getElementById("setting-threads");
const settingCacheSelect = document.getElementById("setting-cache");
const btnSaveSettings = document.getElementById("btn-save-settings");

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = Math.abs(bytes);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // Two decimals for sub-10 values (precise), one decimal otherwise (clean).
  const dp = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(dp)} ${units[i]}`;
}

function esc(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// 1. WebSocket Live Stream
// Reconnect strategy: exponential backoff with jitter, capped so that a
// stuck server doesn't produce a barrage of timing-aligned retries (the
// classic dog-pile). After enough failures we also fire a fatal report to
// the main process so the user gets a notification + clear UI banner.
let wsBackoffMs = 0;
let wsFailureStreak = 0;
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  let opened = false;
  ws.onopen = () => {
    opened = true;
    wsBackoffMs = 0;
    wsFailureStreak = 0;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "TASKS_UPDATE") {
        tasksCache = msg.tasks || [];
        render();
      }
    } catch (error) {
      console.error("Failed to parse WebSocket message:", error);
    }
  };

  ws.onclose = () => {
    if (opened) wsFailureStreak = 0;
    else wsFailureStreak++;
    // Exponential backoff: 1s, 2s, 4s, … up to 15s, plus +/- 500ms jitter so
    // a herd of clients doesn't all retry on the same tick.
    const base = Math.min(15000, 1000 * 2 ** Math.min(wsFailureStreak, 4));
    const delay = base + Math.floor(Math.random() * 1000) - 500;
    renderServerHealth(delay);
    if (wsFailureStreak >= 5) {
      // Loud: tell main, show the user a banner, keep trying in background.
      window.electronAPI?.reportFatal?.(
        `Local server not responding after ${wsFailureStreak} attempts. Check the aria2 daemon and main process logs.`,
      );
      document.body.dataset.serverDown = "true";
    }
    setTimeout(connectWebSocket, Math.max(500, delay));
  };

  ws.onerror = () => {
    // onclose fires immediately after; nothing else to do here
  };
}
connectWebSocket();

function renderServerHealth(_retryIn) {
  // Hook used by future fatal banner. Kept as a no-op for now since the
  // .serverDown attribute on <body> already drives styling.
}

// 2. Tab Navigation
document.querySelectorAll(".sidebar .nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".sidebar .nav-item")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    currentCategory = tab;

    document
      .querySelectorAll(".tab-view")
      .forEach((v) => v.classList.remove("active"));
    if (tab === "extension")
      document.getElementById("view-extension").classList.add("active");
    else if (tab === "settings") {
      document.getElementById("view-settings").classList.add("active");
      loadSettings();
    } else {
      document.getElementById("view-downloads").classList.add("active");
      render();
    }
  });
});

// 3. Settings Logic (Folder Browse & Save)
async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const config = await res.json();
      if (settingPathInput) settingPathInput.value = config.downloadDir;
      if (settingThreadsInput) settingThreadsInput.value = config.defaultSplit;
      if (settingCacheSelect) settingCacheSelect.value = config.diskCache;
    }
  } catch {}
}

btnBrowsePath?.addEventListener("click", async () => {
  const selectedPath = await window.electronAPI?.selectDirectory?.();
  if (selectedPath && settingPathInput) {
    settingPathInput.value = selectedPath;
  }
});

btnSaveSettings?.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        downloadDir: settingPathInput.value,
        defaultSplit: Number(settingThreadsInput.value) || 16,
        diskCache: settingCacheSelect.value,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      alert("Settings saved successfully!");
    } else {
      // Surface the server's validation message (bad path, out-of-range threads…)
      alert(body.error || `Failed to save settings (HTTP ${res.status})`);
    }
  } catch (err) {
    alert(`Could not save settings: ${err.message}`);
  }
});

// 4. Native Titlebar Controls
document
  .getElementById("win-min")
  ?.addEventListener("click", () => window.electronAPI?.minimizeWindow?.());

// Maximize glyph toggle: ▢ when windowed, ❐ when full-screen. Driven by
// the IPC event so OS-driven maximizes (Win+Up arrow, drag-to-top) sync up
// too — the renderer-only click was bound to the wrong glyph before.
const maxBtn = document.getElementById("win-max");
function setMaxGlyph(isMaximized) {
  if (!maxBtn) return;
  maxBtn.textContent = isMaximized ? "\u274F" : "\u25A2";
  maxBtn.title = isMaximized ? "Restore" : "Maximize";
  maxBtn.dataset.state = isMaximized ? "maximized" : "normal";
}
setMaxGlyph(false);
maxBtn?.addEventListener("click", () => window.electronAPI?.maximizeWindow?.());
window.electronAPI?.onMaximizedStateChanged?.((isMax) => setMaxGlyph(isMax));

document
  .getElementById("win-close")
  ?.addEventListener("click", () => window.electronAPI?.closeWindow?.());

// 4b. Toolbar batch actions (Resume All / Pause All / Clear Finished).
// Each button POSTs to its batch endpoint and updates the global toolbar
// stats on completion. Disabled while a request is in flight to prevent
// double-fires when users spam-click.
async function callBatch(endpoint, label, opts = {}) {
  const baseIdMap = {
    "btn-resume-all": "resume",
    "btn-pause-all": "pause",
    "btn-clear-completed": "clear-completed",
  };
  for (const [btnId, action] of Object.entries(baseIdMap)) {
    if (endpoint.includes(action)) {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      const restore = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<span>⏳</span> ${label}…`;
      try {
        const r = await fetch(endpoint, { method: "POST" });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body.ok === false) {
          alert(body.error || `${label} failed (HTTP ${r.status})`);
        } else if (action === "clear-completed") {
          // Forces an immediate re-render so the table clears before WS tick
          tasksCache = (tasksCache || []).filter(
            (t) =>
              t.state !== "complete" &&
              t.state !== "error" &&
              t.state !== "failed" &&
              t.state !== "cancelled",
          );
          render();
        }
      } catch (err) {
        alert(`Network error: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = restore;
      }
      return;
    }
  }
}

document.getElementById("btn-resume-all")?.addEventListener("click", () =>
  callBatch("/api/all/resume", "Resume All"),
);
document.getElementById("btn-pause-all")?.addEventListener("click", () =>
  callBatch("/api/all/pause", "Pause All"),
);
document.getElementById("btn-clear-completed")?.addEventListener("click", () => {
  // Clear Finished is destructive (drops rows from the list) — confirm only
  // if there is actually something to clear, to avoid user fatigue.
  const finished = tasksCache.filter(
    (t) =>
      t.state === "complete" ||
      t.state === "error" ||
      t.state === "failed" ||
      t.state === "cancelled",
  ).length;
  if (finished === 0) {
    alert("Nothing to clear — no finished or failed downloads.");
    return;
  }
  if (!confirm(`Remove ${finished} finished/failed entries from the list? (Files on disk are kept)`)) {
    return;
  }
  callBatch("/api/completed/clear", "Clear Finished");
});

// 5. Add Modal Handlers
document.getElementById("btn-add-url")?.addEventListener("click", () => {
  addModal.classList.add("show");
  document.getElementById("modal-url").focus();
});

// Bonus: an explicit "Add from clipboard" button paths to the saved
// download:trigger-prompt IPC. Currently we let main.js' clipboard sniffer
// drive the prompt, but exposing a button is useful when the user has a
// URL they want to send and the auto-sniff didn't catch it (e.g. unusual
// extension).
const btnClip = document.getElementById("btn-clipboard-add");
btnClip?.addEventListener("click", async () => {
  try {
    const txt = await navigator.clipboard.readText();
    if (!txt || !/^https?:\/\//i.test(txt) && !txt.startsWith("magnet:?")) {
      alert("Clipboard doesn't contain a URL or magnet link.");
      return;
    }
    window.electronAPI?.triggerPrompt?.(txt);
  } catch (err) {
    alert(`Could not read clipboard: ${err.message}`);
  }
});

const closeModal = () => {
  addModal.classList.remove("show");
  document.getElementById("modal-url").value = "";
  document.getElementById("modal-filename").value = "";
  if (torrentFileInput) torrentFileInput.value = "";
  const errEl = document.getElementById("modal-error");
  if (errEl) {
    errEl.textContent = "";
    errEl.classList.remove("show");
  }
};

// Map server-side `reason` codes (returned by /api/download on failure) to
// friendly inline messages. Falls back to the raw server message when the
// reason is unknown. Keyed by the codes emitted in server.js.
const REASON_MESSAGES = {
  "invalid-url": "That doesn't look like a valid URL.",
  "not-google-drive": "That link isn't a Google Drive link.",
  "no-file-id": "Couldn't find a file ID in that Google Drive link.",
  "auth-required":
    'That Google Drive file needs sign-in. Ask the owner to share it as "Anyone with the link".',
  "quota-exceeded": "Google Drive download quota is full. Try again later.",
  private:
    'That Google Drive file is private. The owner must share it as "Anyone with the link".',
  network:
    "Network error talking to Google Drive. Check your connection and retry.",
  unknown: "Could not resolve that Google Drive link.",
};

function showModalError(message) {
  const errEl = document.getElementById("modal-error");
  if (errEl) {
    errEl.textContent = message;
    errEl.classList.add("show");
  } else {
    // Fallback for older markup that doesn't have the error element
    alert(message);
  }
}

document.getElementById("modal-close")?.addEventListener("click", closeModal);
document.getElementById("modal-cancel")?.addEventListener("click", closeModal);

document.getElementById("modal-start")?.addEventListener("click", async () => {
  const url = document.getElementById("modal-url").value.trim();
  const fileName = document.getElementById("modal-filename").value.trim();
  const split = Number(document.getElementById("modal-split").value) || 16;

  if (torrentFileInput?.files.length > 0) {
    const file = torrentFileInput.files[0];
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result.split(",")[1];
      try {
        const resp = await fetch("/api/torrent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ torrentBase64: base64, fileName: file.name }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          showModalError(body.error || "Failed to add torrent.");
          return;
        }
        closeModal();
      } catch (err) {
        showModalError(`Network error: ${err.message}`);
      }
    };
    reader.readAsDataURL(file);
    return;
  }

  if (url) {
    try {
      const resp = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          fileName,
          split,
          maxConnectionPerServer: split,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        // Use reason-keyed message when present, otherwise fall back to the
        // raw server error string.
        const reason = body.reason || "unknown";
        const message =
          (reason !== "unknown" && REASON_MESSAGES[reason]) ||
          body.error ||
          `Server returned HTTP ${resp.status}`;
        showModalError(message);
        return;
      }
      const result = await resp.json().catch(() => ({}));
      closeModal();
      window.electronAPI?.showNotification?.(
        "Download started",
        fileName || url,
      );
    } catch (err) {
      showModalError(`Network error: ${err.message}`);
    }
    return;
  }

  showModalError("Please enter a URL or choose a .torrent file.");
});

// 6. Dynamic Table Render Pipeline
// Speed/glitch fix: instead of rebuilding the entire DOM (and re-attaching all
// listeners) on every WebSocket tick (~400ms), we reuse existing row elements
// and only patch changed fields. Rows are keyed by task id.
const rowElements = new Map(); // taskId -> { row, refs }

function buildRow(t) {
  const row = document.createElement("div");
  row.className = "task-row-item";
  row.dataset.taskId = t.id;
  // data-overflow toggles the marquee animation. It's set in app.js by
  // measuring the rendered widths against the wrapper width; here it's
  // "unknown" so the first measurement pass can flip it cleanly.
  row.dataset.overflowMeasured = "false";
  row.innerHTML = `
    <!-- Top Row -->
    <div class="card-top-line">
      <div class="marquee-wrapper" title="">
        <span class="marquee-content"></span>
      </div>
      <span class="task-badge-pill" title=""></span>
    </div>

    <!-- Bottom Row -->
    <div class="card-bottom-line">
      <div class="metric-pct"></div>
      <div class="metric-size"></div>
      <div class="progress-container">
        <div class="progress-strip"><div class="progress-fill"></div></div>
        <div class="segment-mini-row"></div>
      </div>
      <div class="metric-speed"></div>
      <div class="metric-conns"></div>
      <div class="action-buttons"></div>
    </div>
  `;
  return {
    row,
    marquee: row.querySelector(".marquee-content"),
    wrapper: row.querySelector(".marquee-wrapper"),
    badge: row.querySelector(".task-badge-pill"),
    pct: row.querySelector(".metric-pct"),
    size: row.querySelector(".metric-size"),
    fill: row.querySelector(".progress-fill"),
    segments: row.querySelector(".segment-mini-row"),
    speed: row.querySelector(".metric-speed"),
    conns: row.querySelector(".metric-conns"),
    actions: row.querySelector(".action-buttons"),
  };
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Delegated click handling — attached ONCE, survives re-renders
tableBody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action], button.btn-cancel-task");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.classList.contains("btn-cancel-task")) {
    if (confirm("Cancel download and remove files from disk?")) {
      await fetch(`/api/task/${id}/cancel`, { method: "POST" });
    }
  } else {
    await fetch(`/api/task/${id}/${btn.dataset.action}`, { method: "POST" });
  }
});

function render() {
  const tasks = tasksCache;
  let totalSpeed = 0;
  let totalConnections = 0;
  let counts = { all: tasks.length, downloading: 0, completed: 0, torrents: 0 };
  // "Live" = a task that's actively consuming bandwidth right now. Paused,
  // errored, or completed tasks contribute 0 to the connections total so
  // the toolbar stat reflects real system activity, not stale state.
  const LIVE_STATES = new Set(["active", "downloading", "managed-by-aria2"]);

  tasks.forEach((t) => {
    // Only sum speed from live tasks so a paused-then-resumed torrent with
    // a stale speed=0 entry doesn't drag the global meter down.
    if (LIVE_STATES.has(t.state)) totalSpeed += t.speed || 0;
    if (LIVE_STATES.has(t.state)) totalConnections += t.connections || 0;
    if (t.state === "complete" || t.progress >= 100) counts.completed++;
    else if (LIVE_STATES.has(t.state)) counts.downloading++;
    if (
      t.isTorrent ||
      t.url?.startsWith("magnet:") ||
      t.url?.endsWith(".torrent")
    )
      counts.torrents++;
  });

  document.getElementById("badge-all").textContent = counts.all;
  document.getElementById("badge-downloading").textContent = counts.downloading;
  document.getElementById("badge-completed").textContent = counts.completed;
  document.getElementById("badge-torrents").textContent = counts.torrents;
  globalSpeedEl.textContent = `${formatBytes(totalSpeed)}/s`;
  globalThreadsEl.textContent = totalConnections;

  let filtered = tasks;
  if (currentCategory === "downloading")
    filtered = tasks.filter((t) => t.state !== "complete" && t.progress < 100);
  else if (currentCategory === "completed")
    filtered = tasks.filter((t) => t.state === "complete" || t.progress >= 100);
  else if (currentCategory === "torrents")
    filtered = tasks.filter((t) => t.isTorrent || t.url?.startsWith("magnet:"));
  else if (currentCategory === "videos")
    filtered = tasks.filter((t) =>
      /\.(mp4|mkv|ts|m3u8|webm)$/i.test(t.fileName) || t.isHls,
    );
  else if (currentCategory === "compressed")
    filtered = tasks.filter((t) => /\.(zip|rar|7z|tar|iso)$/i.test(t.fileName));
  else if (currentCategory === "programs")
    filtered = tasks.filter((t) => /\.(exe|msi|apk|dmg)$/i.test(t.fileName));

  // Remove rows for tasks no longer visible + any stale empty-message node
  const visibleIds = new Set(filtered.map((t) => t.id));
  for (const [id, refs] of rowElements) {
    if (!visibleIds.has(id)) {
      refs.row.remove();
      rowElements.delete(id);
    }
  }
  // Glitch fix: when transitioning empty -> non-empty, the "No downloads"
  // placeholder div would remain stuck above the rows
  tableBody.querySelectorAll(".empty-state-placeholder").forEach((el) => el.remove());

  if (filtered.length === 0) {
    rowElements.clear();
    tableBody.insertAdjacentHTML(
      "beforeend",
      `<div class="empty-state-placeholder" style="text-align:center; padding:30px; color:#526080;">No downloads in this category.</div>`,
    );
    return;
  }

  filtered.forEach((t) => {
    const progress = Math.min(100, Math.max(0, t.progress || 0));
    const splitCount = Math.max(1, Number(t.split) || 16);
    const isPaused = t.state === "paused";
    const isFinished = t.state === "complete" || progress >= 100;
    const displayName = t.originalFileName || t.fileName || "downloaded.file";
    const isError = t.state === "error";
    const engineType =
      t.isHls || t.backend === "HLS Engine"
        ? "HLS Stream"
        : t.isGDrive || t.backend === "GDrive Engine"
          ? "Google Drive"
          : t.isTorrent
            ? "BitTorrent · aria2"
            : t.backend === "aria2"
              ? "HTTP · aria2"
              : "Direct";

    let refs = rowElements.get(t.id);
    if (!refs) {
      refs = buildRow(t);
      rowElements.set(t.id, refs);
      tableBody.appendChild(refs.row);
    }

    // Patch fields in place — no innerHTML rebuild, no listener churn
    const nameText = `${t.isTorrent ? "🧲 " : t.isHls ? "🎬 " : ""}${displayName}`;
    // fileNameRevision lets the server nudge the renderer when torrent
    // metadata has resolved and the placeholder name should be replaced
    // (and similarly when a server-supplied filename overrides our basename).
    const rev = String(t.fileNameRevision ?? 0);
    if (refs.marquee.textContent !== nameText || refs.row.dataset.nameRev !== rev) {
      refs.marquee.textContent = nameText;
      refs.wrapper.title = displayName;
      refs.row.dataset.nameRev = rev;
      // Invalidate the cached overflow measurement so the next render pass
      // re-measures the new name against the wrapper.
      refs.row.dataset.overflowMeasured = "false";
    }

    const badgeText = isError
      ? `⚠️ ${t.error || "Failed"}`
      : `${t.state || "active"} · ${engineType}`;
    // ETA shown right before the state badge (e.g. "1h 11m left")
    const etaText = !isError && !isFinished ? formatEta(t.eta) : null;
    // Seeder count for torrents — SD:0 explains zero speed instantly
    const seedText = t.isTorrent ? `SD:${t.seeders ?? 0}` : null;
    const badgeBits = [etaText ? `${etaText} left` : null, seedText, badgeText]
      .filter(Boolean)
      .join(" · ");
    const fullBadgeText = badgeBits;
    if (refs.badge.textContent !== fullBadgeText) {
      refs.badge.textContent = fullBadgeText;
      refs.badge.title = t.error || "";
      refs.badge.className = isError
        ? "task-badge-pill error"
        : "task-badge-pill";
    }
    refs.row.className = "task-row-item" + (isError ? " error-card" : "");

    refs.pct.textContent = `${progress}%`;
    refs.size.textContent = `${formatBytes(t.downloaded || 0)} / ${t.total ? formatBytes(t.total) : "Unknown"}`;
    refs.fill.style.width = `${progress}%`;
    refs.fill.className = `progress-fill${isError ? " error-fill" : ""}`;

    // Rebuild segment bars only when split count changes
    if (Number(refs.segments.dataset.count) !== splitCount) {
      refs.segments.dataset.count = String(splitCount);
      refs.segments.innerHTML = "";
      for (let i = 0; i < splitCount; i++) {
        const seg = document.createElement("div");
        seg.className = "segment-mini";
        refs.segments.appendChild(seg);
      }
    }
    const filledCount = Math.round((progress / 100) * splitCount);
    Array.from(refs.segments.children).forEach((seg, i) => {
      seg.classList.toggle("filled", i < filledCount);
    });

    const speedText = isError
      ? "--"
      : t.speed
        ? formatBytes(t.speed) + "/s"
        : "-- B/s";
    if (refs.speed.textContent !== speedText)
      refs.speed.textContent = speedText;

    const connsText = `${isError ? "0" : t.connections || (t.isTorrent ? 0 : splitCount)} ${t.isTorrent ? "peers" : "conns"}${!t.isTorrent && t.rangeSupported === false && !isError ? "\u26a0\ufe0f" : ""}`;
    if (refs.conns.textContent !== connsText) {
      refs.conns.textContent = connsText;
      // Explain WHY splitting isn't multiplying speed on this host
      refs.conns.title =
        t.rangeSupported === false
          ? "This server does not support Range requests. It caps ALL connections to a single stream, so 16 connections share one pipe instead of adding up."
          : "";
    }

    // Rebuild action buttons only when state changes
    const actionsKey = `${isFinished}|${isError}|${isPaused}`;
    if (refs.actions.dataset.key !== actionsKey) {
      refs.actions.dataset.key = actionsKey;
      refs.actions.innerHTML = "";
      if (!isFinished && !isError) {
        refs.actions.innerHTML = `
          <button class="btn-action-icon btn-toggle-task" data-id="${t.id}" data-action="${isPaused ? "resume" : "pause"}" title="${isPaused ? "Resume" : "Pause"}">
            ${isPaused ? "▶" : "⏸"}
          </button>`;
      } else if (isError) {
        refs.actions.innerHTML = `
          <button class="btn-action-icon btn-toggle-task" data-id="${t.id}" data-action="resume" title="Retry">🔄</button>`;
      }
      refs.actions.insertAdjacentHTML(
        "beforeend",
        `<button class="btn-action-icon danger btn-cancel-task" data-id="${t.id}" title="Cancel & Delete File">🗑</button>`,
      );
    }
  });

  // Measure marquee overflow once per text/badge change. Browser can't
  // measure inline widths synchronously inside the patch pass, so we
  // schedule a single rAF that walks the dirty rows and sets the CSS
  // shift variable. Anything already measured is skipped.
  requestAnimationFrame(() => {
    for (const t of filtered) {
      const refs = rowElements.get(t.id);
      if (!refs || refs.row.dataset.overflowMeasured === "true") continue;
      const wrapperW = refs.wrapper.clientWidth;
      const contentW = refs.marquee.scrollWidth;
      const overflow = contentW > wrapperW + 4;
      refs.wrapper.dataset.overflow = overflow ? "true" : "false";
      if (overflow) {
        // Stop a touch before the wrapper's right edge so the fade mask
        // doesn't reveal the trailing characters.
        refs.marquee.style.setProperty(
          "--marquee-shift",
          `${-(contentW - wrapperW) + 8}px`,
        );
      } else {
        refs.marquee.style.setProperty("--marquee-shift", "0px");
      }
      refs.row.dataset.overflowMeasured = "true";
    }
  });
}
