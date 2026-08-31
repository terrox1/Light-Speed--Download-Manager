// extension/background.js
const API_BASE = 'http://127.0.0.1:3000';

// MV3 fix: the service worker is killed after ~30s idle, which wiped the
// in-memory Map and made detected media vanish. Media is now persisted to
// chrome.storage.session (survives worker restarts, cleared when browser closes).
let mediaStreams = new Map(); // tabId -> Array of captured media objects

async function loadMedia() {
  try {
    const stored = await chrome.storage.session.get('mediaStreams');
    if (stored.mediaStreams) mediaStreams = new Map(stored.mediaStreams);
  } catch {}
}

let saveTimer = null;
function saveMedia() {
  // Debounced persistence — avoids a storage write on every single request
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({ mediaStreams: Array.from(mediaStreams.entries()) }).catch(() => {});
  }, 300);
}

loadMedia();

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return 'Unknown Size';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(bytes);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

async function getCookiesForUrl(url) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ url }, (cookies) => {
        if (!cookies || cookies.length === 0) return resolve('');
        resolve(cookies.map(c => `${c.name}=${c.value}`).join('; '));
      });
    } catch {
      resolve('');
    }
  });
}

function extractCleanFilename(rawUrl, headers = {}) {
  try {
    const parsed = new URL(rawUrl);
    let name = parsed.pathname.split('/').filter(Boolean).pop() || '';
    name = decodeURIComponent(name).replace(/[<>:"/\\|?*]/g, '_');
    if (name.includes('?')) name = name.split('?')[0];
    if (name && name.length > 5 && /\.(mp4|webm|mkv|m3u8|ts|mov)$/i.test(name)) {
      return name;
    }
  } catch {}
  return null;
}

// Probes raw direct video (MP4/MKV/WebM) headers for true file size and filename
async function probeMediaInfo(url, referer) {
  try {
    // Timeout fix: abort hung HEAD probes after 5s so detection never stalls
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { Referer: referer || url },
      signal: controller.signal
    });
    clearTimeout(timer);

    const size = res.headers.get('content-length');
    const disp = res.headers.get('content-disposition');
    let name = null;

    if (disp) {
      const match = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      if (match) name = decodeURIComponent(match[1].trim());
    }

    return {
      size: size ? Number(size) : null,
      sizeFormatted: formatBytes(size),
      serverName: name
    };
  } catch {
    return { size: null, sizeFormatted: 'Live Stream / Dynamic', serverName: null };
  }
}

// Parse Master M3U8 playlist with full resolution, bandwidth, and codec data
async function parseM3U8Resolutions(masterUrl, referer) {
  try {
    const res = await fetch(masterUrl, { headers: { Referer: referer || masterUrl } });
    if (!res.ok) return [{ quality: 'Auto / Adaptive', resolution: 'Master', sizeFormatted: 'HLS Stream', url: masterUrl }];
    const text = await res.text();

    if (!text.includes('#EXTM3U')) {
      return [{ quality: 'Direct Stream', resolution: 'Unknown', sizeFormatted: 'HLS Stream', url: masterUrl }];
    }

    const lines = text.split('\n');
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        let quality = '720p HD';
        let resolution = '';

        const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
        if (resMatch) {
          resolution = resMatch[1];
          const height = parseInt(resolution.split('x')[1], 10);
          if (height >= 1080) quality = `${height}p Full HD`;
          else if (height >= 720) quality = `${height}p HD`;
          else quality = `${height}p SD`;
        }

        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        let bitRate = '';
        if (bwMatch) {
          bitRate = `${Math.round(parseInt(bwMatch[1], 10) / 1000)} kbps`;
        }

        let streamUri = lines[i + 1]?.trim();
        if (streamUri && !streamUri.startsWith('#')) {
          if (!/^https?:\/\//i.test(streamUri)) {
            streamUri = new URL(streamUri, masterUrl).href;
          }
          variants.push({
            quality,
            resolution: resolution || bitRate || 'Stream',
            sizeFormatted: bitRate ? `Bitrate: ${bitRate}` : 'HLS Segmented',
            url: streamUri
          });
        }
      }
    }

    return variants.length > 0
      ? variants
      : [{ quality: 'Master Playlist', resolution: 'Auto', sizeFormatted: 'Adaptive HLS', url: masterUrl }];
  } catch {
    return [{ quality: 'Original Stream', resolution: 'Auto', sizeFormatted: 'Adaptive HLS', url: masterUrl }];
  }
}

// Intercept Media Requests
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (!details.url || details.tabId < 0) return;
    const url = details.url;

    // Ignore tracker/ad requests + Google Drive interstitials (server resolves them)
    if (/doubleclick|google-analytics|googlesyndication|facebook\.com/i.test(url)) return;
    // Drive's virus-scan HTML page must never be captured as a "video"
    if (/drive\.usercontent\.google\.com|accounts\.google\.com/i.test(url)) return;

    const isM3U8 = /\.m3u8($|\?)/i.test(url);
    const isDirectMedia = /\.(mp4|webm|mkv|mov|avi)($|\?)/i.test(url);

    let contentType = '';
    const ctHeader = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type');
    if (ctHeader) contentType = ctHeader.value.toLowerCase();

    const isHlsHeader = contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl');
    const isVideoHeader = contentType.startsWith('video/') && !contentType.includes('mp2t');

    if (isM3U8 || isDirectMedia || isHlsHeader || isVideoHeader) {
      const tabId = details.tabId;
      if (!mediaStreams.has(tabId)) mediaStreams.set(tabId, []);

      const list = mediaStreams.get(tabId);
      if (list.some(item => item.rawUrl === url)) return;

      const isHls = isM3U8 || isHlsHeader;
      const referer = details.initiator || url;

      let qualities = [];
      let probed = { size: null, sizeFormatted: 'Probing...', serverName: null };

      if (isHls) {
        qualities = await parseM3U8Resolutions(url, referer);
      } else {
        probed = await probeMediaInfo(url, referer);
        // Ignore tiny video chunks/ads (< 1MB)
        if (probed.size && probed.size < 1024 * 1024) return;

        const ext = (url.match(/\.(mp4|webm|mkv|mov)/i)?.[1] || 'mp4').toUpperCase();
        qualities = [{
          quality: `${ext} Direct Video`,
          resolution: ext,
          sizeFormatted: probed.sizeFormatted,
          url: url
        }];
      }

      const cleanName = probed.serverName || extractCleanFilename(url) || null;

      const mediaItem = {
        id: `media-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        rawUrl: url,
        isHls,
        detectedName: cleanName,
        qualities
      };

      list.push(mediaItem);
      saveMedia();

      chrome.tabs.sendMessage(tabId, { type: 'LSDM_MEDIA_DETECTED', media: list }).catch(() => {});
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    mediaStreams.delete(tabId);
    saveMedia();
  }
});

// ---- Auto-capture regular browser downloads ----
// Intercepts Chrome's native download manager and redirects the file to LSDM
// instead. Toggleable via the popup (stored in chrome.storage.local).
let autoCaptureEnabled = true;

chrome.storage.local.get('autoCapture').then(({ autoCapture }) => {
  if (typeof autoCapture === 'boolean') autoCaptureEnabled = autoCapture;
});

// Replay fix: when the browser starts, Chrome AUTO-RESUMES every interrupted
// download from the previous session, firing onCreated for each one (100+
// with a big test history). The extension then cancelled each and re-posted
// ALL of them to LSDM as fresh tasks. We now remember every URL already sent
// to LSDM (persisted in chrome.storage.local, survives worker restarts and
// browser restarts) and skip duplicates.
let sentUrls = new Map(); // url -> timestamp of last send

async function loadSentUrls() {
  try {
    const stored = await chrome.storage.local.get('sentDownloadUrls');
    if (Array.isArray(stored.sentDownloadUrls)) {
      sentUrls = new Map(stored.sentDownloadUrls);
      // Prune entries older than 7 days so the list can't grow forever
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [u, ts] of sentUrls) {
        if (ts < cutoff) sentUrls.delete(u);
      }
    }
  } catch {}
}

let saveSentTimer = null;
function markSent(url) {
  sentUrls.set(url, Date.now());
  // Hard cap at 1000 entries (drop the oldest)
  if (sentUrls.size > 1000) {
    const oldest = [...sentUrls.entries()].sort((a, b) => a[1] - b[1]).slice(0, sentUrls.size - 1000);
    for (const [u] of oldest) sentUrls.delete(u);
  }
  clearTimeout(saveSentTimer);
  saveSentTimer = setTimeout(() => {
    chrome.storage.local.set({ sentDownloadUrls: Array.from(sentUrls.entries()) }).catch(() => {});
  }, 500);
}

loadSentUrls();

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (!autoCaptureEnabled) return;
  const url = downloadItem?.finalUrl || downloadItem?.url;
  if (!url) return;

  // Never capture our own API traffic or non-http sources (blob:, data:, etc.)
  if (!/^https?:\/\//i.test(url)) return;
  if (/127\.0\.0\.1:3000|localhost:3000/i.test(url)) return;

  // Only capture real files, not navigation/pixel beacons (< 100KB unknown)
  const size = downloadItem.totalBytes || 0;
  if (size > 0 && size < 100 * 1024) return;

  // Dedup: this URL was already handed to LSDM (covers Chrome's startup
  // re-download storm and repeated clicks on the same link)
  if (sentUrls.has(url)) {
    // Still cancel Chrome's duplicate native download so the user doesn't get
    // a second local copy — but do NOT create another LSDM task.
    await chrome.downloads.cancel(downloadItem.id).catch(() => {});
    return;
  }

  try {
    // Cancel Chrome's native download so LSDM takes over exclusively
    await chrome.downloads.cancel(downloadItem.id).catch(() => {});

    const cookieStr = await getCookiesForUrl(url);
    const referer = downloadItem.referrer || url;

    await fetch(`${API_BASE}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        // Don't send "download" as name for Drive links — server resolves the real one
        fileName: (downloadItem.filename && downloadItem.filename !== 'download')
          ? downloadItem.filename.split(/[\\/]/).pop()
          : undefined,
        category: 'General',
        headers: { Referer: referer, cookie: cookieStr }
      })
    });

    // Remember this URL so startup re-downloads don't spawn LSDM tasks again
    markSent(url);

    // Show a badge on the extension icon so the user knows capture happened
    chrome.action.setBadgeText({ text: '↓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22e8ff' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
  } catch {
    // LSDM offline — re-download natively as fallback so user never loses the file
    try { chrome.downloads.download({ url }); } catch {}
  }
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === 'GET_TAB_MEDIA') {
    const tabId = req.tabId || sender.tab?.id;
    // Read fresh from storage in case another worker instance wrote it
    loadMedia().then(() => {
      sendResponse({ media: mediaStreams.get(tabId) || [] });
    });
    return true;
 // In extension/background.js -> update START_MEDIA_DOWNLOAD handler:
  } else if (req.type === 'START_MEDIA_DOWNLOAD') {
    (async () => {
      const cookieStr = await getCookiesForUrl(req.url);
      const headers = {
        Referer: req.referer || req.url,
        cookie: cookieStr
      };

      const endpoint = req.isHls ? `${API_BASE}/api/hls/download` : `${API_BASE}/api/download`;

      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: req.url,
          fileName: req.fileName || 'video.mp4',
          category: 'Videos',
          headers
        })
      });
      // Mark as sent so the auto-capture interceptor doesn't create a
      // duplicate task if the browser also starts a native download for it
      markSent(req.url);
      sendResponse({ ok: true });
    })();
    return true;
  }
});