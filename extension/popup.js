const button = document.getElementById('send');
const urlInput = document.getElementById('url');
const filenameInput = document.getElementById('filename');
const splitInput = document.getElementById('split');
const maxConnectionsInput = document.getElementById('maxConnections');
const status = document.getElementById('status');
const serverStatus = document.getElementById('serverStatus');
const openUiButton = document.getElementById('openUi');
const openMonitorButton = document.getElementById('openMonitor');
const autoCaptureToggle = document.getElementById('autoCapture');
const apiBase = 'http://127.0.0.1:3000';

// Auto-capture toggle — persisted so background worker reads the same setting
chrome.storage.local.get('autoCapture').then(({ autoCapture }) => {
  if (autoCaptureToggle) autoCaptureToggle.checked = autoCapture !== false;
});
autoCaptureToggle?.addEventListener('change', () => {
  chrome.storage.local.set({ autoCapture: autoCaptureToggle.checked });
});

async function getCookieStringForUrl(url) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ url }, (cookies) => {
        // Distinguish "no cookies" from API failure via lastError — silent
        // empty strings here cost us a whole debugging session earlier.
        if (chrome.runtime.lastError) {
          console.warn('[LSDM] cookies.getAll failed:', chrome.runtime.lastError.message);
          return resolve('');
        }
        if (!cookies || cookies.length === 0) {
          console.log('[LSDM] no cookies found for', url);
          return resolve('');
        }
        const cookiePairs = cookies.map(c => `${c.name}=${c.value}`);
        resolve(cookiePairs.join('; '));
      });
    } catch (e) {
      console.warn('[LSDM] cookies API threw (missing permission?):', e?.message || e);
      resolve('');
    }
  });
}

async function sendToFastDL(url, fileName, split, maxConnectionPerServer) {
  const headers = {};
  try {
    const cookieString = await getCookieStringForUrl(url);
    if (cookieString) headers.Cookie = cookieString;
  } catch (error) {
    // ignore cookie collection failures
  }

  const body = { url, headers, split, maxConnectionPerServer };
  if (fileName) body.fileName = fileName;

  return fetch(`${apiBase}/api/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function updateServerStatus() {
  // Fail fast: without a timeout, a hung server leaves the popup stuck on
  // the previous status forever instead of showing "offline".
  const fetchWithTimeout = (u, ms = 3000) => fetch(u, { signal: AbortSignal.timeout(ms) });
  try {
    const response = await fetchWithTimeout(`${apiBase}/api/status`);
    if (!response.ok) throw new Error('Server not reachable');
    const data = await response.json();
    try {
      const aria2Response = await fetchWithTimeout(`${apiBase}/api/aria2/status`);
      const aria2Data = aria2Response.ok ? await aria2Response.json() : { available: false };
      if (aria2Data.available) {
        const dl = Number(aria2Data.global?.downloadSpeed) || 0;
        const active = Number(aria2Data.global?.numActive) || 0;
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        let v = dl, i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        serverStatus.textContent = `LSDM running · aria2 connected · ${v.toFixed(1)} ${units[i]} · ${active} active`;
        serverStatus.className = 'info success';
      } else {
        serverStatus.textContent = 'LSDM server is running. aria2 is not connected.';
        serverStatus.className = 'info warning';
      }
    } catch (aria2Error) {
      serverStatus.textContent = 'LSDM server is running. aria2 is not connected.';
      serverStatus.className = 'info warning';
    }
  } catch (error) {
    serverStatus.textContent = 'LSDM is offline. Start the local server first.';
    serverStatus.className = 'info error';
  }
}

button.addEventListener('click', async () => {
  status.textContent = '';
  const url = urlInput.value.trim();
  if (!url) {
    status.textContent = 'Enter a valid URL.';
    status.className = 'info error';
    return;
  }

  button.disabled = true;
  try {
    const response = await sendToFastDL(url, filenameInput.value.trim(), Number(splitInput.value) || 16, Number(maxConnectionsInput.value) || 16);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Server returned ${response.status}`);
    }
    status.textContent = `Download started: ${body.id}`;
    status.className = 'info success';
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
    status.className = 'info error';
  } finally {
    button.disabled = false;
  }
});

openUiButton.addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:3000' });
});

openMonitorButton.addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:3000/ariang' });
});

updateServerStatus();
setInterval(updateServerStatus, 5000);
