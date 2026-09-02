// public/ariang.js — Aria2 Monitor page logic
// Fixed: XSS via unescaped filenames, full-DOM rebuild every second,
// light-on-dark styling glitches, and listener churn.

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function fetchAria2Status() {
  try {
    const r = await fetch('/api/aria2/status');
    if (!r.ok) return { available: false };
    return await r.json();
  } catch (e) {
    return { available: false };
  }
}

async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return [];
    const tasks = await r.json();
    return tasks.filter(t => t.backend === 'aria2');
  } catch (e) {
    return [];
  }
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0; let value = Math.abs(bytes);
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  const dp = value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(dp)} ${units[index]}`;
}

function speedStr(bps) { // bytes/sec
  if (!bps) return '0 B/s';
  const units = ['B/s','KB/s','MB/s','GB/s'];
  let i = 0; let v = bps;
  while (v >= 1024 && i < units.length-1) { v /= 1024; i += 1; }
  const dp = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(dp)} ${units[i]}`;
}

// Incremental row cache: gid -> refs
const rowCache = new Map();

function buildRow(t) {
  const row = document.createElement('div');
  row.className = 'task';
  row.dataset.gid = t.aria2?.gid || '';
  row.innerHTML = `
    <div class="task-header">
      <strong class="task-name"></strong>
      <span class="task-state"></span>
    </div>
    ${t.note ? `<div class="info-note">${esc(t.note)}</div>` : ''}
    <div class="task-grid">
      <div>
        <div class="progress-bar"><div class="progress-fill"></div></div>
        <div class="task-details"><span class="d-pct">-</span><span class="d-size">-</span></div>
        <div class="segment-row"></div>
        <div class="task-details"><span class="d-split">-</span><span class="d-conn">-</span></div>
        <div class="task-details"><span>Avg / connection:</span><span class="d-avg">-</span></div>
        <div class="task-details d-options-wrap"><span>aria2 options:</span><span class="d-options">-</span></div>
      </div>
      <div style="text-align:right">
        <div class="small">Speed</div>
        <div class="speed d-speed">-</div>
      </div>
      <div style="text-align:right">
        <div class="small">Backend</div>
        <div>${esc(t.backend || 'aria2')}</div>
      </div>
    </div>
    <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-top:10px;">
      <div style="min-width:120px;">
        <div class="small">GID</div>
        <div class="d-gid">-</div>
      </div>
      <div class="d-buttons"></div>
      <div style="display:flex; gap:8px; align-items:center;">
        <label style="display:inline-flex; flex-direction:column; align-items:flex-start; font-size:0.9rem; color:#8c9bbd;">Split
          <input type="number" min="1" max="64" class="aria-split" style="width:80px; margin-top:4px;" />
        </label>
        <label style="display:inline-flex; flex-direction:column; align-items:flex-start; font-size:0.9rem; color:#8c9bbd;">Connections
          <input type="number" min="1" max="64" class="aria-maxconn" style="width:80px; margin-top:4px;" />
        </label>
        <button class="aria-update" data-gid="${esc(t.aria2?.gid || '')}">Update</button>
      </div>
      <button class="aria-debug" data-gid="${esc(t.aria2?.gid || '')}">Debug</button>
    </div>
  `;
  return {
    row,
    name: row.querySelector('.task-name'),
    state: row.querySelector('.task-state'),
    fill: row.querySelector('.progress-fill'),
    pct: row.querySelector('.d-pct'),
    size: row.querySelector('.d-size'),
    segments: row.querySelector('.segment-row'),
    splitLabel: row.querySelector('.d-split'),
    connLabel: row.querySelector('.d-conn'),
    avg: row.querySelector('.d-avg'),
    optionsWrap: row.querySelector('.d-options-wrap'),
    options: row.querySelector('.d-options'),
    speedEl: row.querySelector('.d-speed'),
    gidEl: row.querySelector('.d-gid'),
    buttons: row.querySelector('.d-buttons'),
    splitInput: row.querySelector('.aria-split'),
    maxConnInput: row.querySelector('.aria-maxconn')
  };
}

// Delegated handlers — attached once
document.getElementById('list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  // Update/Debug buttons carry data-gid; fall back to the row's gid just in case
  const gid = btn.dataset.gid || btn.closest('.task')?.dataset.gid;
  if (!gid) return;

  if (btn.classList.contains('aria-pause')) {
    await fetch(`/api/aria2/${gid}/pause`, { method: 'POST' });
    setTimeout(loop, 500);
  } else if (btn.classList.contains('aria-resume')) {
    await fetch(`/api/aria2/${gid}/resume`, { method: 'POST' });
    setTimeout(loop, 500);
  } else if (btn.classList.contains('aria-cancel')) {
    if (!confirm('Cancel download and remove partial files?')) return;
    await fetch(`/api/aria2/${gid}/cancel`, { method: 'POST' });
    setTimeout(loop, 500);
  } else if (btn.classList.contains('aria-update')) {
    const wrap = btn.closest('.task');
    const split = Number(wrap.querySelector('.aria-split')?.value) || null;
    const maxConnectionPerServer = Number(wrap.querySelector('.aria-maxconn')?.value) || null;
    await fetch(`/api/aria2/${gid}/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ split, maxConnectionPerServer })
    });
    setTimeout(loop, 500);
  } else if (btn.classList.contains('aria-debug')) {
    const resp = await fetch(`/api/aria2/task/${gid}`);
    if (!resp.ok) {
      alert('Failed to fetch aria2 debug info');
      return;
    }
    const data = await resp.json();
    const debugText = JSON.stringify(data, null, 2);
    const debugWindow = window.open('', '_blank', 'width=900,height=600,scrollbars=yes');
    if (debugWindow) {
      debugWindow.document.write(`<pre style="background:#0b0f1f;color:#22e8ff;padding:16px;">${esc(debugText)}</pre>`);
    } else {
      alert(esc(debugText));
    }
  }
});

function render(tasks, aria2Status) {
  const el = document.getElementById('list');

  // Remove rows for finished/removed tasks
  const visibleGids = new Set(tasks.map(t => t.aria2?.gid).filter(Boolean));
  for (const [gid, refs] of rowCache) {
    if (!visibleGids.has(gid)) {
      refs.row.remove();
      rowCache.delete(gid);
    }
  }

  if (!tasks || tasks.length === 0) {
    el.innerHTML = aria2Status && aria2Status.available
      ? '<p>No aria2-managed downloads yet. Start a download from the main UI or extension.</p>'
      : '<p>No aria2-managed downloads yet. Aria2 is not connected.</p>';
    return;
  }

  tasks.forEach(t => {
    const gid = t.aria2?.gid;
    if (!gid) return;

    let refs = rowCache.get(gid);
    if (!refs) {
      refs = buildRow(t);
      rowCache.set(gid, refs);
      el.appendChild(refs.row);
    }

    const speed = t.speed || 0;
    const connections = t.connections || 0;
    const avgPerConnection = connections ? Math.round((speed / connections) * 10) / 10 : 0;
    const splitCount = Number(t.options?.split || t.split || 1);
    const maxConn = Number(t.options?.['max-connection-per-server'] || t.maxConnectionPerServer || 1);
    const progress = Math.min(100, Math.max(0, t.progress || 0));

    // Patch in place — no innerHTML rebuild per tick
    const nameText = t.fileName || t.url || '-';
    if (refs.name.textContent !== nameText) {
      refs.name.textContent = nameText;
      refs.name.title = nameText;
    }
    refs.state.textContent = t.state || '';

    refs.fill.style.width = `${progress}%`;
    refs.pct.textContent = t.progress != null ? `${progress}%` : '-';
    refs.size.textContent = `${formatBytes(t.downloaded || 0)} / ${t.total ? formatBytes(t.total) : '-'}`;

    // Segment bars only rebuilt when count changes
    if (Number(refs.segments.dataset.count) !== splitCount) {
      refs.segments.dataset.count = String(splitCount);
      refs.segments.innerHTML = Array.from({ length: splitCount }, () =>
        `<div class="segment"></div>`).join('');
    }
    const filledSegments = Math.round(progress * splitCount / 100);
    Array.from(refs.segments.children).forEach((seg, i) =>
      seg.classList.toggle('filled', i < filledSegments));

    refs.splitLabel.textContent = `Split: ${splitCount}`;
    refs.connLabel.textContent = `Connections: ${connections || maxConn}`;
    refs.avg.textContent = speedStr(avgPerConnection);

    if (t.options) {
      refs.optionsWrap.style.display = '';
      refs.options.textContent = `split=${t.options.split || splitCount}, max-conn=${t.options['max-connection-per-server'] || maxConn}`;
    } else {
      refs.optionsWrap.style.display = 'none';
    }

    refs.speedEl.textContent = speedStr(speed);
    refs.gidEl.textContent = gid;

    // Buttons only rebuilt when state changes
    const stateKey = t.state || '';
    if (refs.buttons.dataset.state !== stateKey) {
      refs.buttons.dataset.state = stateKey;
      refs.buttons.innerHTML =
        `<button data-gid="${esc(gid)}" class="aria-pause">Pause</button> ` +
        `<button data-gid="${esc(gid)}" class="aria-resume">Resume</button> ` +
        `<button data-gid="${esc(gid)}" class="aria-cancel">Cancel</button>`;
    }

    // Inputs only set when not focused (avoid fighting the user's typing)
    if (document.activeElement !== refs.splitInput && Number(refs.splitInput.value) !== splitCount) {
      refs.splitInput.value = splitCount;
    }
    if (document.activeElement !== refs.maxConnInput && Number(refs.maxConnInput.value) !== maxConn) {
      refs.maxConnInput.value = maxConn;
    }
    refs.splitInput.dataset.gid = gid;
    refs.maxConnInput.dataset.gid = gid;
  });
}

async function loop() {
  const aria2Status = await fetchAria2Status();
  const statusEl = document.getElementById('aria2-status');
  if (!aria2Status.available) {
    statusEl.innerHTML = '<strong>Aria2 status:</strong> unavailable. Make sure aria2 is running and RPC is enabled on http://127.0.0.1:6800/jsonrpc.';
  } else {
    const downloadSpeed = Number(aria2Status.global?.downloadSpeed) || 0;
    const active = Number(aria2Status.global?.numActive) || 0;
    const avgPerConn = active ? Math.round((downloadSpeed / active) * 10) / 10 : 0;
    statusEl.innerHTML = `<strong>Aria2 status:</strong> connected. Download speed: ${speedStr(downloadSpeed)} / Upload: ${speedStr(Number(aria2Status.global?.uploadSpeed) || 0)} / Active tasks: ${active} / Avg per task: ${speedStr(avgPerConn)}`;
  }
  const tasks = await fetchStatus();
  render(tasks, aria2Status);
}

loop();
setInterval(loop, 1000);
