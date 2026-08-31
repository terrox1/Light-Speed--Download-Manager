// server.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const port = process.env.PORT || 3000;
const appRoot = process.pkg ? path.dirname(process.execPath) : __dirname;
const configPath = path.resolve(appRoot, "config.json");

// Load or initialize settings
let appConfig = {
  downloadDir: path.resolve(appRoot, "downloads"),
  defaultSplit: 16,
  diskCache: "128M",
};

if (fs.existsSync(configPath)) {
  try {
    Object.assign(appConfig, JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch {}
}
if (!fs.existsSync(appConfig.downloadDir))
  fs.mkdirSync(appConfig.downloadDir, { recursive: true });

let tasks = {};

app.use(express.json({ limit: "50mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use("/static", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);
app.get("/ariang", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "ariang.html")),
);
app.get("/api/status", (req, res) => res.json(Object.values(tasks)));

// ---- Aria2 Monitor API (used by /ariang page & extension popup) ----
app.get("/api/aria2/status", async (req, res) => {
  const resp = await aria2Request("aria2.getGlobalStat");
  if (!resp?.result) return res.json({ available: false });
  res.json({
    available: true,
    global: {
      downloadSpeed: Number(resp.result.downloadSpeed) || 0,
      uploadSpeed: Number(resp.result.uploadSpeed) || 0,
      numActive: Number(resp.result.numActive) || 0,
      numWaiting: Number(resp.result.numWaiting) || 0,
      numStopped: Number(resp.result.numStopped) || 0,
    },
  });
});

app.get("/api/aria2/task/:gid", async (req, res) => {
  const resp = await aria2Request("aria2.tellStatus", [req.params.gid]);
  if (!resp?.result)
    return res
      .status(404)
      .json({ error: resp?.error?.message || "GID not found" });
  res.json(resp.result);
});

app.post("/api/aria2/:gid/pause", async (req, res) => {
  const resp = await aria2Request("aria2.forcePause", [req.params.gid]);
  if (!resp?.result)
    return res
      .status(502)
      .json({ ok: false, error: resp?.error?.message || "aria2 RPC failed" });
  for (const t of Object.values(tasks)) {
    if (t.aria2?.gid === req.params.gid) {
      t.state = "paused";
      t.speed = 0;
    }
  }
  broadcastTasks();
  res.json({ ok: true });
});

app.post("/api/aria2/:gid/resume", async (req, res) => {
  const resp = await aria2Request("aria2.unpause", [req.params.gid]);
  if (!resp?.result)
    return res
      .status(502)
      .json({ ok: false, error: resp?.error?.message || "aria2 RPC failed" });
  for (const t of Object.values(tasks)) {
    if (t.aria2?.gid === req.params.gid) t.state = "downloading";
  }
  broadcastTasks();
  res.json({ ok: true });
});

app.post("/api/aria2/:gid/cancel", async (req, res) => {
  const gid = req.params.gid;
  const rm = await aria2Request("aria2.forceRemove", [gid]);
  if (!rm?.result)
    return res
      .status(502)
      .json({ ok: false, error: rm?.error?.message || "aria2 RPC failed" });
  await aria2Request("aria2.removeDownloadResult", [gid]);

  // Clean up partial files for the matching task
  for (const [id, t] of Object.entries(tasks)) {
    if (t.aria2?.gid === gid) {
      try {
        const files = await fsp.readdir(appConfig.downloadDir);
        for (const f of files) {
          if (
            f === t.fileName ||
            f.startsWith(t.fileName + ".") ||
            f.startsWith(id)
          ) {
            await fsp
              .unlink(path.join(appConfig.downloadDir, f))
              .catch(() => {});
          }
        }
      } catch {}
      delete tasks[id];
    }
  }
  broadcastTasks();
  res.json({ ok: true });
});

app.post("/api/aria2/:gid/options", async (req, res) => {
  const { split, maxConnectionPerServer } = req.body;
  const opts = {};
  if (split != null)
    opts.split = String(Math.min(64, Math.max(1, Number(split))));
  if (maxConnectionPerServer != null)
    opts["max-connection-per-server"] = String(
      Math.min(16, Math.max(1, Number(maxConnectionPerServer))),
    );
  if (Object.keys(opts).length === 0)
    return res.json({ ok: false, error: "No options provided" });

  // changeUri trick: aria2 can only change some options on active downloads;
  // split/max-conn require the download to be paused or applied to new tasks.
  const resp = await aria2Request("aria2.changeOption", [req.params.gid, opts]);
  if (!resp?.result) {
    // Fallback: pause -> change -> resume so the new split takes effect
    await aria2Request("aria2.forcePause", [req.params.gid]);
    const resp2 = await aria2Request("aria2.changeOption", [
      req.params.gid,
      opts,
    ]);
    await aria2Request("aria2.unpause", [req.params.gid]);
    if (!resp2?.result)
      return res.json({
        ok: false,
        error: resp2?.error?.message || "Failed to update options",
      });
  }
  res.json({ ok: true });
});

// Settings API
app.get("/api/settings", (req, res) => res.json(appConfig));
app.post("/api/settings", (req, res) => {
  const { downloadDir, defaultSplit, diskCache } = req.body;
  try {
    if (downloadDir) {
      const resolved = path.resolve(String(downloadDir).trim());
      // Validation fix: any garbage string used to be persisted verbatim,
      // after which EVERY download failed silently. Verify we can create/use
      // the directory BEFORE saving it as the app-wide download dir.
      if (!path.isAbsolute(resolved))
        return res
          .status(400)
          .json({
            ok: false,
            error: "Download folder must be an absolute path.",
          });
      fs.mkdirSync(resolved, { recursive: true }); // throws on invalid drive / permission denied
      appConfig.downloadDir = resolved;
    }
    if (defaultSplit != null) {
      const n = Number(defaultSplit);
      if (!Number.isFinite(n) || n < 1 || n > 64)
        return res
          .status(400)
          .json({ ok: false, error: "Threads must be between 1 and 64." });
      appConfig.defaultSplit = Math.round(n);
    }
    if (diskCache) appConfig.diskCache = String(diskCache);

    fs.writeFileSync(configPath, JSON.stringify(appConfig, null, 2));
    res.json({ ok: true, config: appConfig });
  } catch (err) {
    res
      .status(400)
      .json({
        ok: false,
        error: `Could not use that download folder: ${err.message}`,
      });
  }
});

// Top High-Speed Public BitTorrent Trackers (expanded list for max peer discovery)
const DEFAULT_BT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://explodie.org:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://p4p.arenabg.com:1337/announce",
  "udp://tracker.moeking.me:6969/announce",
  "udp://opentracker.i2p.rocks:6969/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://tracker.coppersurfer.tk:6969/announce",
  "http://tracker.openbittorrent.com:80/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://opentor.org:2710/announce",
  "udp://tracker.ccc.de:6969/announce",
  "udp://tracker.blackunicorn.xyz:6969/announce",
  "udp://tracker.leechers-paradise.org:6969/announce",
  "udp://tracker.internetwarriors.net:1337/announce",
  "udp://ipv4.tracker.harry.lu:80/announce",
  "http://tracker.files.fm:6969/announce",
  "https://tracker.tamersunion.org:443/announce",
  "udp://tracker.bittor.pw:1337/announce",
  "udp://tracker.theoks.net:6969/announce",
  "https://tracker.gbitt.info:443/announce",
  "http://tracker.gbitt.info:80/announce",
].join(",");

const aria2RpcUrl = process.env.ARIA2_RPC || "http://127.0.0.1:6800/jsonrpc";
// Security hardening: when spawned by Electron main.js, a random RPC secret is
// shared via ARIA2_SECRET so only our app can control the local aria2 daemon.
// Read on each call (not cached) because main.js may set the env var AFTER
// requiring this module — a cached const would capture an empty string and every
// RPC call would be rejected with an auth error.
function getAria2Secret() {
  return process.env.ARIA2_SECRET || "";
}

const defaultHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
};

function normalizeHeaders(headers = {}) {
  const result = Object.assign({}, defaultHeaders, headers || {});
  if (result.cookie && !result.Cookie) result.Cookie = result.cookie;
  if (result.referer && !result.Referer) result.Referer = result.referer;
  return result;
}

function formatBytesSafe(bytes) {
  if (!bytes && bytes !== 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0,
    v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function sanitizeFileName(name) {
  if (!name) return "downloaded.file";
  let s = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim()
    .replace(/\s+/g, " ");
  return s.slice(0, 200) || "downloaded.file";
}

// Validate user-supplied download URLs. Returns { ok: true } or { ok: false, error }.
// Rejects protocol-relative paths, file://, javascript:, data:, and other shapes
// the old `^https?:\/\//` regex would silently accept, and requires magnet links
// to carry a real info hash (xt=urn:btih:... or xt=urn:btmh:...).
function validateDownloadUrl(rawUrl) {
  if (!rawUrl) return { ok: false, error: "URL is required" };

  if (rawUrl.startsWith("magnet:?")) {
    if (!/xt=urn:(btih|btmh):[a-zA-Z0-9]{20,}/i.test(rawUrl)) {
      return {
        ok: false,
        error: "Magnet link is missing a valid info hash (xt parameter)",
      };
    }
    return { ok: true };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      error: "URL is not a valid HTTP/HTTPS URL or magnet link",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `URL protocol "${parsed.protocol}" is not supported (use http, https, or magnet)`,
    };
  }
  if (!parsed.hostname || !parsed.hostname.includes(".")) {
    return { ok: false, error: "URL is missing a valid hostname" };
  }
  return { ok: true };
}

async function aria2Request(method, params = []) {
  try {
    // Prepend the RPC secret token when one is configured
    const secret = getAria2Secret();
    const finalParams = secret ? [`token:${secret}`, ...params] : params;
    const body = {
      jsonrpc: "2.0",
      id: `req-${Date.now()}`,
      method,
      params: finalParams,
    };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(aria2RpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// In server.js -> Replace app.post('/api/hls/download') with this robust engine:
app.post("/api/hls/download", async (req, res) => {
  const { url, fileName, headers = {} } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const safeName = sanitizeFileName(fileName || `hls_video_${Date.now()}.mp4`);
  const destPath = path.join(appConfig.downloadDir, safeName);
  const id = `hls-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  tasks[id] = {
    id,
    url,
    fileName: safeName,
    originalFileName: safeName,
    state: "downloading",
    progress: 0,
    downloaded: 0,
    total: null,
    split: 16,
    category: "Videos",
    backend: "HLS Engine",
    isHls: true,
    speed: 0,
    connections: 16,
  };

  res.json({ id });
  broadcastTasks();

  (async () => {
    const t = tasks[id];
    let fileHandle = null;
    let speedMeter = null;

    try {
      // 1. Build Exact Browser Video Request Headers
      const requestHeaders = {
        "User-Agent": defaultHeaders["User-Agent"],
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Connection: "keep-alive",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      };

      const rawReferer = headers.Referer || headers.referer || url;
      requestHeaders["Referer"] = rawReferer;
      try {
        requestHeaders["Origin"] = new URL(rawReferer).origin;
      } catch {}

      if (headers.Cookie || headers.cookie) {
        requestHeaders["Cookie"] = headers.Cookie || headers.cookie;
      }

      // 2. Recursive Playlist Traversal with Status Code Validation
      async function fetchPlaylist(targetUrl) {
        const response = await fetch(targetUrl, {
          headers: requestHeaders,
          redirect: "follow",
        });
        if (!response.ok) {
          throw new Error(
            `Server returned HTTP ${response.status} (${response.statusText})`,
          );
        }

        let text = await response.text();
        text = text.replace(/^\uFEFF/, "").trim(); // Remove UTF-8 BOM

        if (!text.toUpperCase().includes("#EXTM3U")) {
          throw new Error("Remote URL did not return a valid M3U8 manifest.");
        }

        // If it's a Master Playlist containing multiple variants, resolve the best quality
        if (text.includes("#EXT-X-STREAM-INF:")) {
          const lines = text.split("\n");
          let bestStreamUri = null;
          let maxBandwidth = -1;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith("#EXT-X-STREAM-INF:")) {
              const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
              const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
              let uri = lines[i + 1]?.trim();
              if (uri && !uri.startsWith("#") && bw >= maxBandwidth) {
                maxBandwidth = bw;
                bestStreamUri = /^https?:\/\//i.test(uri)
                  ? uri
                  : new URL(uri, targetUrl).href;
              }
            }
          }
          if (bestStreamUri) return fetchPlaylist(bestStreamUri);
        }

        return { finalUrl: response.url || targetUrl, text };
      }

      const leaf = await fetchPlaylist(url);
      const lines = leaf.text.split("\n");

      // 3. Parse Segments & Encryption Keys (AES-128)
      const segmentUrls = [];
      let currentKey = null;
      let currentIv = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Check for AES-128 stream encryption
        if (line.startsWith("#EXT-X-KEY:")) {
          const methodMatch = line.match(/METHOD=([^,\s]+)/i);
          const uriMatch = line.match(/URI="([^"]+)"/i);
          const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);

          if (
            methodMatch &&
            methodMatch[1].toUpperCase() === "AES-128" &&
            uriMatch
          ) {
            const keyUrl = /^https?:\/\//i.test(uriMatch[1])
              ? uriMatch[1]
              : new URL(uriMatch[1], leaf.finalUrl).href;
            const keyRes = await fetch(keyUrl, { headers: requestHeaders });
            if (keyRes.ok) {
              currentKey = Buffer.from(await keyRes.arrayBuffer());
              if (ivMatch) currentIv = Buffer.from(ivMatch[1], "hex");
            }
          }
        }

        if (line && !line.startsWith("#")) {
          const segUrl = /^https?:\/\//i.test(line)
            ? line
            : new URL(line, leaf.finalUrl).href;
          segmentUrls.push({
            url: segUrl,
            key: currentKey,
            iv: currentIv,
            seq: segmentUrls.length,
          });
        }
      }

      if (segmentUrls.length === 0) {
        throw new Error(
          "No playable video chunks found in the resolved stream.",
        );
      }

      const totalSegments = segmentUrls.length;
      let completedSegments = 0;
      let downloadedBytes = 0;
      let lastBytes = 0;

      speedMeter = setInterval(() => {
        t.speed = downloadedBytes - lastBytes;
        lastBytes = downloadedBytes;
        broadcastTasks();
      }, 1000);

      fileHandle = await fsp.open(destPath, "w");
      const segmentBuffers = new Array(totalSegments);
      // Speed fix: scale concurrency with stream length (capped) so long videos
      // download much faster than a fixed 16 connections
      const concurrency = Math.min(
        32,
        Math.max(16, Math.ceil(totalSegments / 50)),
      );
      let currentIdx = 0;
      let writePointer = 0;

      // Background writer: decouples disk I/O from network workers so slow
      // disk flushes never stall segment downloads
      let writeError = null;
      const failedSegments = new Set(); // segments that exhausted all retries
      const writerLoop = (async () => {
        try {
          while (writePointer < totalSegments) {
            if (!segmentBuffers[writePointer]) {
              // Skip-over fix: a segment that failed all 3 retries will NEVER
              // fill its slot, so the old code spun here forever and the task
              // hung at ~97% "downloading" for eternity. Skip it so the file
              // gets finalized (and possibly marked as partial/error below).
              if (failedSegments.has(writePointer)) {
                writePointer++;
                continue;
              }
              if (t.state === "cancelled") break;
              await new Promise((r) => setTimeout(r, 25));
              continue;
            }
            await fileHandle.write(segmentBuffers[writePointer]);
            segmentBuffers[writePointer] = null;
            writePointer++;
          }
        } catch (err) {
          writeError = err;
        }
      })();

      async function worker() {
        while (currentIdx < totalSegments && !writeError) {
          if (t.state === "cancelled") break;
          // Pause support: workers idle-wait while task is paused
          if (t.state === "paused") {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          const idx = currentIdx++;
          const segInfo = segmentUrls[idx];

          // Retry failed segments up to 3 times instead of silently skipping
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const segRes = await fetch(segInfo.url, {
                headers: requestHeaders,
              });
              if (!segRes.ok) throw new Error(`HTTP ${segRes.status}`);

              let chunkBuf = Buffer.from(await segRes.arrayBuffer());

              // Decrypt if stream is AES-128 encrypted
              if (segInfo.key) {
                let iv = segInfo.iv;
                if (!iv) {
                  iv = Buffer.alloc(16);
                  iv.writeUInt32BE(segInfo.seq, 12);
                }
                const decipher = crypto.createDecipheriv(
                  "aes-128-cbc",
                  segInfo.key,
                  iv,
                );
                chunkBuf = Buffer.concat([
                  decipher.update(chunkBuf),
                  decipher.final(),
                ]);
              }

              segmentBuffers[idx] = chunkBuf;
              downloadedBytes += chunkBuf.length;
              completedSegments++;

              t.downloaded = downloadedBytes;
              t.progress = Math.round(
                (completedSegments / totalSegments) * 100,
              );
              break;
            } catch (err) {
              if (attempt === 2) {
                console.error(
                  `Segment ${idx} fetch failed after retries:`,
                  err.message,
                );
                // Mark as permanently failed so the writer can skip past it
                // instead of waiting forever (task-hang fix)
                failedSegments.add(idx);
              } else
                await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
          }
        }
      }

      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);
      await writerLoop;
      if (writeError) throw writeError;
      await fileHandle.close();
      fileHandle = null;
      clearInterval(speedMeter);

      if (t.state === "cancelled") {
        // Cancelled mid-stream: remove the partial file like the cancel
        // endpoint expects, and don't lie with a "complete" state.
        await fsp.unlink(destPath).catch(() => {});
      } else if (failedSegments.size > 0) {
        // Permanently-failed segments mean the written file has holes —
        // surface it instead of marking a corrupt file as 100% complete.
        t.state = "error";
        t.error = `${failedSegments.size} of ${totalSegments} video segments failed to download. The saved file is incomplete — try re-adding the stream.`;
        t.speed = 0;
      } else {
        t.state = "complete";
        t.progress = 100;
        t.speed = 0;
      }
      broadcastTasks();
    } catch (error) {
      if (speedMeter) clearInterval(speedMeter);
      if (fileHandle) await fileHandle.close().catch(() => {});
      t.state = "error";
      t.error = error.message;
      t.speed = 0;
      broadcastTasks();
    }
  })();
});

// Resolve Google Drive share links to direct-download URLs.
// Without this, aria2 downloads Drive's ~37KB virus-scan HTML warning page
// instead of the actual file. Session cookies captured here MUST be forwarded
// to aria2, otherwise Google redirects to accounts.google.com/CookieMismatch.
//
// Returns either { ok: true, url, fileName, cookie } or
// { ok: false, reason, message } so the caller can surface a useful error
// to the user instead of a generic "could not resolve" failure.
// Google Drive's virus-scan interstitial (>100MB files) is a <form> with
// hidden fields (id, export, confirm, uuid). The old single uuid= regex broke
// whenever Google changed markup, causing the ~37KB HTML page itself to be
// saved as the "file". Parse ALL hidden inputs and rebuild the download URL.
function buildGDriveConfirmUrl(currentUrl, fileId, html) {
  try {
    const formMatch = html.match(
      /<form[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i,
    );
    if (!formMatch) return null;
    const [, action, inner] = formMatch;
    // Fall back to the current URL when the action is relative/empty
    const base = /https?:\/\//i.test(action)
      ? action
      : new URL(action || "", currentUrl).href;
    const params = new URLSearchParams();
    const inputRe = /<input[^>]*type=["']hidden["'][^>]*>/gi;
    let m;
    while ((m = inputRe.exec(inner)) !== null) {
      const name = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
      const value = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
      if (name) params.set(name, value);
    }
    // Belt & braces: make sure the essentials are present even if the form
    // omitted them (Google has done this in some A/B variants)
    if (!params.has("id")) params.set("id", fileId);
    if (!params.has("export")) params.set("export", "download");
    if (!params.has("confirm")) params.set("confirm", "t");
    const u = new URL(base);
    u.search = params.toString();
    return u.href;
  } catch {
    return null;
  }
}

async function resolveGoogleDriveUrl(rawUrl, incomingCookie = null) {
  const fail = (reason, message) => ({ ok: false, reason, message });

  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return fail("invalid-url", "Not a valid URL.");
  }
  if (!/\.google\.com$/.test(u.hostname)) {
    return fail("not-google-drive", "URL is not a Google Drive link.");
  }

  // Short-circuit: the extension captures FULLY-RESOLVED download links
  // (confirm=t & uuid= & at=<auth token>). These are one-time URLs that
  // ALREADY work — re-running the confirm flow would consume/reject them.
  // Use them verbatim and forward the browser's session cookies.
  if (
    u.hostname === "drive.usercontent.google.com" &&
    u.searchParams.has("confirm") &&
    u.searchParams.has("uuid")
  ) {
    let fileName = null;
    try {
      // Best-effort name from the source page's title param if present
      const title = u.searchParams.get("title");
      if (title) fileName = decodeURIComponent(title);
    } catch {}
    console.log(
      `[GDrive] using pre-resolved usercontent link (cookie forwarded: ${!!incomingCookie})`,
    );
    return { ok: true, url: rawUrl, fileName, cookie: incomingCookie || null };
  }

  let fileId = null;
  // Covers: /file/d/<id>, /uc?id=<id>, /open?id=<id>, /document/d/<id> etc.
  const pathMatch =
    u.pathname.match(/\/file\/d\/([\w-]{20,})/) ||
    u.pathname.match(/\/document\/d\/([\w-]{20,})/) ||
    u.pathname.match(/\/presentation\/d\/([\w-]{20,})/) ||
    u.pathname.match(/\/spreadsheets\/d\/([\w-]{20,})/);
  if (pathMatch) {
    fileId = pathMatch[1];
  } else if (u.searchParams.get("id")) {
    fileId = u.searchParams.get("id");
  }
  if (!fileId)
    return fail(
      "no-file-id",
      "Could not extract a Google Drive file ID from the URL.",
    );

  // Collect cookies across every hop so aria2 presents the same session
  const cookieJar = new Set();

  function harvestCookies(res) {
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const sc of setCookies) {
      const pair = sc.split(";")[0].trim();
      if (pair) cookieJar.add(pair);
    }
  }

  try {
    // Step 1: hit the usercontent download endpoint directly
    let dlUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    let res = await fetch(dlUrl, {
      headers: defaultHeaders,
      redirect: "manual",
    });
    harvestCookies(res);

    // Follow redirect chain manually, collecting cookies at each hop
    let hops = 0;
    while (
      res.status >= 300 &&
      res.status < 400 &&
      res.headers.get("location") &&
      hops < 5
    ) {
      dlUrl = new URL(res.headers.get("location"), dlUrl).href;
      // If Google bounces to accounts.* it means auth is required -> fail early
      if (/accounts\.google\.com/.test(dlUrl)) {
        return fail(
          "auth-required",
          'This file requires Google sign-in. Use a "Anyone with the link" share link.',
        );
      }
      res = await fetch(dlUrl, {
        headers: {
          ...defaultHeaders,
          Cookie: Array.from(cookieJar).join("; "),
        },
        redirect: "manual",
      });
      harvestCookies(res);
      hops++;
    }

    // If we got HTML instead of the file, extract the uuid confirm token
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html")) {
      const text = await res.text();
      const confirmUrl = buildGDriveConfirmUrl(dlUrl, fileId, text);
      if (confirmUrl) {
        dlUrl = confirmUrl;
        res = await fetch(dlUrl, {
          headers: {
            ...defaultHeaders,
            Cookie: Array.from(cookieJar).join("; "),
          },
          redirect: "manual",
        });
        harvestCookies(res);
        // follow remaining redirects
        let h2 = 0;
        while (
          res.status >= 300 &&
          res.status < 400 &&
          res.headers.get("location") &&
          h2 < 5
        ) {
          dlUrl = new URL(res.headers.get("location"), dlUrl).href;
          if (/accounts\.google\.com/.test(dlUrl)) {
            return fail(
              "auth-required",
              'This file requires Google sign-in. Use a "Anyone with the link" share link.',
            );
          }
          res = await fetch(dlUrl, {
            headers: {
              ...defaultHeaders,
              Cookie: Array.from(cookieJar).join("; "),
            },
            redirect: "manual",
          });
          harvestCookies(res);
          h2++;
        }
      } else {
        // No uuid and no download -> likely private or quota-exceeded
        if (/quota/i.test(text)) {
          return fail(
            "quota-exceeded",
            "Google Drive download quota exceeded. Try again later.",
          );
        }
        return fail(
          "private",
          'This file appears to be private. The owner must share it as "Anyone with the link".',
        );
      }
    }

    // Try to get the real filename from Content-Disposition
    let fileName = null;
    const disp = res.headers.get("content-disposition");
    if (disp) {
      const m = disp.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      if (m) fileName = decodeURIComponent(m[1].trim());
    }

    // Diagnostic: if the "file" response is HTML, resolution FAILED — say so
    const finalCt = (res.headers.get("content-type") || "").toLowerCase();
    console.log(
      `[GDrive] resolved id=${fileId} status=${res.status} content-type=${finalCt || "(none)"}`,
    );
    if (finalCt.includes("text/html")) {
      return fail(
        "unknown",
        "Google Drive returned an HTML page instead of the file. The link may be private, quota-limited, or the confirm token could not be extracted.",
      );
    }

    return {
      ok: true,
      url: dlUrl,
      fileName,
      cookie: Array.from(cookieJar).join("; "),
    };
  } catch (err) {
    return fail(
      "network",
      `Network error while contacting Google Drive: ${err.message}`,
    );
  }
}

// Native Google Drive download engine — bypasses aria2 entirely.
// Uses the cookie jar captured during resolution so Google never sees a
// CookieMismatch. Parallel range requests for speed, streamed to disk.
async function downloadGDriveFile(taskId, downloadUrl, cookie, fileName) {
  const t = tasks[taskId];
  if (!t) return;
  const destPath = path.join(appConfig.downloadDir, fileName);
  let fileHandle = null;
  let speedMeter = null;
  let downloadedBytes = 0; // hoisted: the completion sanity check below reads this outside the parallel/simple branches

  try {
    const reqHeaders = { ...defaultHeaders };
    if (cookie) reqHeaders.Cookie = cookie;

    // Extract the REAL Drive file id from the download URL (query "id=") —
    // the old code passed taskId ("gdrive-...") here, so when the interstitial
    // form omitted a hidden id field the rebuilt URL carried garbage.
    let gdriveFileId = null;
    try {
      gdriveFileId = new URL(downloadUrl).searchParams.get("id") || null;
    } catch {}

    // Guard against the virus-scan interstitial: if Google still answers with
    // an HTML page, parse its confirm form and rebuild the real download URL
    // instead of writing ~37KB of HTML to disk as the "file".
    async function resolveRealUrl(url) {
      for (let pass = 0; pass < 3; pass++) {
        const head = await fetch(url, {
          headers: { ...reqHeaders, Range: "bytes=0-0" },
          redirect: "follow",
        });
        const ctype = (head.headers.get("content-type") || "").toLowerCase();
        if (!ctype.includes("text/html")) {
          await head.body?.cancel?.();
          return url;
        }
        const html = await head.text();
        const next = buildGDriveConfirmUrl(url, gdriveFileId || taskId, html);
        if (!next || next === url)
          throw new Error(
            "Google Drive returned an HTML page instead of the file (confirm token missing — link may be private or quota-limited).",
          );
        url = next;
      }
      throw new Error(
        "Google Drive kept returning HTML confirmation pages after 3 attempts.",
      );
    }

    downloadUrl = await resolveRealUrl(downloadUrl);

    // Probe: get total size + confirm range support
    const probe = await fetch(downloadUrl, {
      headers: { ...reqHeaders, Range: "bytes=0-0" },
      redirect: "follow",
    });
    if (!probe.ok)
      throw new Error(
        `Google returned HTTP ${probe.status} (file may be private)`,
      );
    const cr = probe.headers.get("content-range"); // "bytes 0-0/4294967296"
    const total = cr ? Number(cr.split("/")[1]) : null;
    const acceptsRanges = total != null && !isNaN(total);
    await probe.body?.cancel?.();

    t.total = total;
    // GDrive engine runs its own parallel workers — reflect that immediately
    // instead of the hard-coded 1 the task was created with.
    if (acceptsRanges && total > 8 * 1024 * 1024) t.connections = 6;

    fileHandle = await fsp.open(destPath, "w");
    if (acceptsRanges && total > 8 * 1024 * 1024) {
      // ---- Parallel chunked download (8MB chunks, 6 workers) ----
      const CHUNK = 8 * 1024 * 1024;
      const chunkCount = Math.ceil(total / CHUNK);
      let nextChunk = 0;
      let activeWorkers = 0; // live connection count for the UI
      let lastBytes = 0;
      // Smoothed speed (EMA) — raw per-second deltas bounce to 0 whenever
      // workers pause between chunk requests, making the UI look broken.
      let emaSpeed = 0;
      let failed = false;

      speedMeter = setInterval(() => {
        const delta = downloadedBytes - lastBytes;
        lastBytes = downloadedBytes;
        emaSpeed = emaSpeed * 0.6 + delta * 0.4; // ~2.5s rolling window
        t.speed = Math.round(emaSpeed);
        t.connections = activeWorkers; // real parallel stream count
        t.downloaded = downloadedBytes;
        t.progress = Math.round((downloadedBytes / total) * 100);
        t.eta =
          emaSpeed > 0
            ? Math.round((total - downloadedBytes) / emaSpeed)
            : null;
        broadcastTasks();
      }, 1000);

      // Pre-allocate file so parallel writes don't race
      await fileHandle.truncate(total);

      async function worker() {
        while (nextChunk < chunkCount && !failed && t.state !== "cancelled") {
          if (t.state === "paused") {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          const idx = nextChunk++;
          const start = idx * CHUNK;
          const end = Math.min(start + CHUNK - 1, total - 1);

          for (let attempt = 0; attempt < 3 && !failed; attempt++) {
            let written = 0; // bytes streamed this attempt (for rollback)
            try {
              const res = await fetch(downloadUrl, {
                headers: { ...reqHeaders, Range: `bytes=${start}-${end}` },
                redirect: "follow",
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              activeWorkers++;
              // Interstitial guard: never write HTML chunks into the file
              const rct = (res.headers.get("content-type") || "").toLowerCase();
              if (rct.includes("text/html"))
                throw new Error(
                  "HTML interstitial on chunk request (session expired)",
                );

              // Stream the chunk straight to disk instead of buffering the
              // whole 8MB via arrayBuffer(). Buffering caused the classic
              // burst-then-zero speed pattern: fast fill -> idle while the
              // next request set up -> write -> repeat.
              const reader = res.body.getReader();
              let pos = start;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  await fileHandle.write(
                    Buffer.from(value),
                    0,
                    value.length,
                    pos,
                  );
                  pos += value.length;
                  written += value.length;
                  downloadedBytes += value.length;
                }
              } finally {
                activeWorkers--;
                await reader.cancel().catch(() => {});
              }
              break;
            } catch (err) {
              // Roll back partial progress when a chunk fails mid-stream and
              // gets retried from its start — otherwise downloadedBytes
              // double-counts and progress/ETA go haywire.
              downloadedBytes -= written;
              if (attempt === 2) {
                failed = true;
                console.error(`GDrive chunk ${idx} failed:`, err.message);
              } else
                await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
          }
        }
      }

      await Promise.all(Array.from({ length: 6 }, () => worker()));
      if (failed) throw new Error("One or more chunks failed after retries");
    } else {
      // ---- Simple streamed download (small files / no range support) ----
      const res = await fetch(downloadUrl, {
        headers: reqHeaders,
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`);
      t.total = Number(res.headers.get("content-length")) || null;

      let lastBytes = 0;
      speedMeter = setInterval(() => {
        t.speed = downloadedBytes - lastBytes;
        lastBytes = downloadedBytes;
        t.downloaded = downloadedBytes;
        if (t.total) t.progress = Math.round((downloadedBytes / t.total) * 100);
        t.eta =
          t.speed > 0 && t.total
            ? Math.round((t.total - downloadedBytes) / t.speed)
            : null;
        broadcastTasks();
      }, 1000);

      const reader = res.body.getReader();
      while (true) {
        if (t.state === "cancelled") {
          await reader.cancel();
          break;
        }
        if (t.state === "paused") {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        const { done, value } = await reader.read();
        if (done) break;
        await fileHandle.write(Buffer.from(value));
        downloadedBytes += value.length;
      }
    }

    clearInterval(speedMeter);
    await fileHandle.close();
    fileHandle = null;

    if (t.state === "cancelled") {
      await fsp.unlink(destPath).catch(() => {});
      delete tasks[taskId];
    } else if (
      t.total &&
      downloadedBytes < Math.min(1024 * 1024, t.total * 0.01)
    ) {
      // Sanity check: a "complete" 37KB result for a 4GB file means we saved
      // Google's HTML confirmation page. Fail loudly instead of lying.
      await fsp.unlink(destPath).catch(() => {});
      t.state = "error";
      t.error = `Downloaded ${downloadedBytes} bytes but the file is ${formatBytesSafe(t.total)}. Google served an HTML page instead of the file — try re-copying the share link.`;
    } else {
      t.state = "complete";
      t.progress = 100;
      t.speed = 0;
      t.eta = null;
    }
    broadcastTasks();
  } catch (error) {
    if (speedMeter) clearInterval(speedMeter);
    if (fileHandle) await fileHandle.close().catch(() => {});
    t.state = "error";
    t.error = error.message;
    t.speed = 0;
    broadcastTasks();
  }
}

// 1. Download Endpoint (Direct URLs, GDrive & Magnet Links)
app.post("/api/download", async (req, res) => {
  const {
    url,
    fileName,
    split = appConfig.defaultSplit,
    maxConnectionPerServer = appConfig.defaultSplit,
    headers = {},
    category = "General",
  } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  const rawUrl = String(url).trim();

  // Strict validation: rejects non-http(s) schemes, missing hosts, and
  // magnet links that don't carry a real info hash. The old regex accepted
  // any string starting with "http://" including "http://" with no host.
  const urlCheck = validateDownloadUrl(rawUrl);
  if (!urlCheck.ok) {
    return res.status(400).json({ error: urlCheck.error });
  }

  const isMagnet = rawUrl.startsWith("magnet:?");
  let resolvedUrl = rawUrl;
  let resolvedName = fileName;

  // Google Drive special handling — matches drive. AND docs.google.com links.
  // Drive files are downloaded by our OWN Node engine (not aria2) because
  // Google's CookieMismatch redirect breaks every aria2 header handoff.
  // Google Drive special handling — matches drive./docs.google.com AND the
  // direct drive.usercontent.google.com/download links copied from browsers.
  // CRITICAL: usercontent do NOT match "drive.google.com", so they used
  // to fall through to aria2, which saved Google's ~37KB HTML confirmation
  // page as the "file".
  if (
    !isMagnet &&
    /((drive|docs)\.google\.com|drive\.usercontent\.google\.com)/i.test(rawUrl)
  ) {
    // Forward any browser cookies the caller (extension) captured — required
    // for signed-in / restricted files and one-time usercontent links.
    const incomingCookie = headers?.cookie || headers?.Cookie || null;
    const gdrive = await resolveGoogleDriveUrl(rawUrl, incomingCookie);
    if (!gdrive?.ok) {
      // Structured error so the UI can distinguish private / auth-required / etc.
      return res.status(422).json({
        error: gdrive?.message || "Could not resolve this Google Drive link.",
        reason: gdrive?.reason || "unknown",
      });
    }
    const gdriveCookie = gdrive.cookie; // <-- Added: extract cookie from resolved URL
    const safeName = sanitizeFileName(
      fileName || gdrive.fileName || `gdrive_${Date.now()}.bin`,
    );
    const id = `gdrive-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    tasks[id] = {
      id,
      url: rawUrl,
      fileName: safeName,
      originalFileName: safeName,
      state: "downloading",
      progress: 0,
      downloaded: 0,
      total: null,
      split: 1,
      category: "General",
      backend: "GDrive Engine",
      isGDrive: true,
      speed: 0,
      connections: 1,
    };
    res.json({ id });
    broadcastTasks();
    downloadGDriveFile(id, gdrive.url, gdriveCookie, safeName);
    return;
  }

  if (isMagnet) {
    try {
      const parsedMag = new URL(rawUrl);
      const dn = parsedMag.searchParams.get("dn");
      if (dn) resolvedName = decodeURIComponent(dn);
    } catch {}
  }

  const safeName = sanitizeFileName(
    resolvedName ||
      (isMagnet
        ? "BitTorrent Magnet"
        : path.basename(new URL(rawUrl).pathname) || "downloaded.file"),
  );
  const id = `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const norm = normalizeHeaders(headers); // must exist before the Range probe below (was used before declaration -> silent TDZ ReferenceError)

  // Multi-connection capability probe: aria2 can only parallelize a download
  // when the server answers Range requests (Accept-Ranges). If it doesn't,
  // all 16 "connections" collapse into ONE stream and splitting cannot
  // multiply the speed — worth surfacing in the UI instead of guessing.
  let rangeSupported = null;
  try {
    const probe = await fetch(rawUrl, {
      method: "HEAD",
      headers: { "User-Agent": norm["User-Agent"], Accept: "*/*" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    const accepts = String(
      probe.headers.get("accept-ranges") || "",
    ).toLowerCase();
    rangeSupported = probe.ok && accepts.includes("bytes");
  } catch {
    rangeSupported = null;
  } // unknown — let aria2 try anyway

  tasks[id] = {
    id,
    url: resolvedUrl,
    fileName: safeName,
    originalFileName: safeName,
    state: "starting",
    progress: 0,
    downloaded: 0,
    total: null,
    split: Number(split),
    maxConnectionPerServer: Number(maxConnectionPerServer),
    category,
    isTorrent: isMagnet,
    backend: "aria2",
    rangeSupported,
    speed: 0,
    connections: 0,
  };

  // Anti-hotlink fix: many CDNs (vidssave, streamtape, googlevideo mirrors...)
  // answer plain aria2 requests with HTTP 403 unless the request carries a
  // plausible browser fingerprint. When the caller didn't supply one, derive
  // Referer/Origin from the download URL itself so the host sees its own site.
  try {
    const u = new URL(resolvedUrl);
    if (!norm["Referer"]) norm["Referer"] = `${u.protocol}//${u.host}/`;
    if (!norm["Origin"]) norm["Origin"] = `${u.protocol}//${u.host}`;
  } catch {}

  const headerArr = [];
  // Note: GDrive requests return earlier with their own cookie handling
  // (downloadGDriveFile), so no gdriveCookie is needed on this aria2 path.
  for (const [k, v] of Object.entries(norm)) {
    if (v == null || v === "" || k.toLowerCase() === "user-agent") continue;
    headerArr.push(`${k}: ${v}`);
  }

  // In server.js inside app.post('/api/download')
  // Update the opts payload sent to aria2:

  const opts = {
    dir: appConfig.downloadDir,
    // Collision policy fix: allow-overwrite=true + auto-file-renaming=false
    // (the old end state) meant a filename collision SILENTLY CLOBBERED an
    // existing file. New downloads now rename on collision instead; the
    // resume/retry path below still forces overwrite+no-renaming so a retry
    // reuses its own partial file.
    "allow-overwrite": "false",
    "auto-file-renaming": "true",
    continue: "true",
    "connect-timeout": "15",
    timeout: "30",
    "optimize-concurrent-downloads": "true", // Dynamically raises split as speed grows
    "conditional-get": "true", // Resume-friendly, avoids re-downloading unchanged data
    "http-accept-gzip": "true", // Compressed transfer where server supports it
    "bt-tracker": DEFAULT_BT_TRACKERS,
    "enable-dht": "true",
    "enable-peer-exchange": "true",
    "bt-enable-lpd": "true",
    "bt-max-peers": "150",
    // Torrent speed fix: hint the swarm speed so aria2 connects to more peers
    "bt-request-peer-speed-limit": "10M",
    "follow-torrent": "true",
    "bt-min-crypto-level": "plain",
    "bt-require-crypto": "false",
    "seed-time": "0",
    "user-agent": norm["User-Agent"],
  };

  if (headerArr.length > 0) opts.header = headerArr;

  if (!isMagnet) {
    opts.out = safeName;
    const effSplit = Math.min(16, Number(split) || 16);
    opts.split = String(effSplit);
    opts["max-connection-per-server"] = String(
      Math.min(16, Number(maxConnectionPerServer) || 16),
    );
    opts["min-split-size"] = "1M"; // Smaller chunks = better parallel utilization
    opts["piece-length"] = "1M"; // Match min-split-size for finer parallelism
    opts["socket-recv-buffer-size"] = "4M";
    opts["disk-cache"] = appConfig.diskCache;
    // NOTE: no stream-piece-selector override — aria2's default 'geom' gives best throughput
    opts["lowest-speed-limit"] = "0"; // Never auto-abort slow connections
    opts["max-tries"] = "8";
    opts["retry-wait"] = "1";
    // Speed fix: cap concurrent HTTP connections per host so a single slow host
    // doesn't starve other downloads sharing the same server
    opts["max-overall-download-limit"] = "0";
    // NOTE: duplicate "max-connection-per-server" assignment and the
    // contradictory "auto-file-renaming": "false" that used to live here were
    // removed — both are set once above / in the task-resume path.
  }

  // Torrent fix: BT downloads resume against an existing folder and FAIL with
  // errorCode=13 ("file exists, but a control file (*.aria2) does not exist")
  // when allow-overwrite is off. BT payload is content-addressed, so letting
  // aria2 overwrite/truncate here is safe — and matches the /api/torrent path.
  if (isMagnet) {
    opts["allow-overwrite"] = "true";
    opts["auto-file-renaming"] = "false";
  }

  const ariaResult = await aria2Request("aria2.addUri", [[resolvedUrl], opts]);
  if (ariaResult?.result) {
    tasks[id].aria2 = { gid: ariaResult.result };
    tasks[id].options = opts; // Exposed for the /ariang monitor page
    tasks[id].state = "managed-by-aria2";
  } else {
    tasks[id].state = "failed";
    tasks[id].error = ariaResult?.error?.message || "Failed to start in engine";
  }

  broadcastTasks();
  res.json({ id });
});

// 2. Local Torrent File Handler
app.post("/api/torrent", async (req, res) => {
  const { torrentBase64, fileName, category = "Torrents" } = req.body;
  if (!torrentBase64)
    return res.status(400).json({ error: "Torrent data required" });

  const id = `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const safeName = sanitizeFileName(fileName || "Torrent Package");

  tasks[id] = {
    id,
    url: "file.torrent",
    fileName: safeName,
    originalFileName: safeName,
    state: "starting",
    progress: 0,
    downloaded: 0,
    total: null,
    category,
    isTorrent: true,
    backend: "aria2",
    speed: 0,
    connections: 0,
  };

  // In server.js inside app.post('/api/download') and app.post('/api/torrent')
  const opts = {
    dir: appConfig.downloadDir,
    "bt-tracker": DEFAULT_BT_TRACKERS,
    "enable-dht": "true",
    "enable-peer-exchange": "true",
    "bt-enable-lpd": "true",
    "bt-max-peers": "150",
    // Speed fix: tell aria2 the whole swarm speed so it opens more connections.
    // With '0' (auto), aria2 throttles peer discovery and shows peers but barely
    // downloads from them on well-seeded torrents.
    "bt-request-peer-speed-limit": "10M",
    "bt-min-crypto-level": "plain",
    "bt-require-crypto": "false",
    "seed-time": "0",
    // Torrent-specific fixes:
    "bt-detach-seed-only": "true", // Don't count seeding torrents against download slots
    "follow-torrent": "true", // Follow magnet metadata -> real payload
    "allow-overwrite": "true",
    "auto-file-renaming": "true",
    "file-allocation": "none", // Start downloading immediately, no pre-alloc stall
    "max-connection-per-server": "16",
  };

  const ariaResult = await aria2Request("aria2.addTorrent", [
    torrentBase64,
    [],
    opts,
  ]);
  if (ariaResult?.result) {
    tasks[id].aria2 = { gid: ariaResult.result };
    tasks[id].state = "managed-by-aria2";
  } else {
    tasks[id].state = "failed";
    tasks[id].error = ariaResult?.error?.message || "Invalid .torrent file";
  }

  broadcastTasks();
  res.json({ id });
});

// 3. Task Action Controls (Pause / Resume / Cancel + Hard File Cleanup)
app.post("/api/task/:id/pause", async (req, res) => {
  const t = tasks[req.params.id];
  if (!t) return res.json({ ok: false });

  if (t.isHls || t.isGDrive) {
    // Native engines: workers check t.state each loop iteration
    t.state = "paused";
    t.speed = 0;
  } else if (t.aria2?.gid) {
    await aria2Request("aria2.pause", [t.aria2.gid]);
    t.state = "paused";
    t.speed = 0;
  }
  broadcastTasks();
  res.json({ ok: true });
});

// In server.js replace app.post('/api/task/:id/resume') with:
app.post("/api/task/:id/resume", async (req, res) => {
  const t = tasks[req.params.id];
  if (!t) return res.json({ ok: false });

  if (t.isHls || t.isGDrive) {
    // Native engines: workers check t.state each loop iteration
    t.state = "downloading";
  } else if (t.state === "error" || t.state === "failed") {
    // Re-queue aborted download with a fresh GID.
    // Retry fix: reuse the ORIGINAL options (Referer/Origin/cookies/UA) — the
    // previous version rebuilt bare opts here, so hotlink-protected hosts
    // rejected every retry with 403 even when the first attempt had worked.
    const safeName = t.fileName || "downloaded.file";
    const opts = {
      ...(t.options || {}),
      dir: appConfig.downloadDir,
      out: safeName,
      "allow-overwrite": "true",
      continue: "true",
      split: String(t.split || 16),
      "max-connection-per-server": String(t.maxConnectionPerServer || 16),
      "min-split-size": "1M",
      "socket-recv-buffer-size": "4M",
      "disk-cache": appConfig.diskCache,
      "lowest-speed-limit": "0",
      "max-tries": "8",
      "retry-wait": "1",
    };
    // Never resume into a renamed copy if the partial file still exists
    opts["auto-file-renaming"] = "false";

    const ariaResult = await aria2Request("aria2.addUri", [[t.url], opts]);
    if (ariaResult?.result) {
      t.aria2 = { gid: ariaResult.result };
      t.state = "managed-by-aria2";
      t.error = null;
    }
  } else if (t.aria2?.gid) {
    await aria2Request("aria2.unpause", [t.aria2.gid]);
    t.state = "downloading";
  }

  broadcastTasks();
  res.json({ ok: true });
});
app.post("/api/task/:id/cancel", async (req, res) => {
  const id = req.params.id;
  const t = tasks[id];
  if (!t) return res.json({ ok: true });

  const gid = t.aria2?.gid;
  if (gid) {
    await aria2Request("aria2.forceRemove", [gid]);
    await aria2Request("aria2.removeDownloadResult", [gid]);
  }

  // CRITICAL: signal native engines (HLS / GDrive) to stop BEFORE deleting
  // files — their workers poll t.state each loop iteration, so without this
  // they kept downloading in the background and raced the unlink below.
  if (t.isHls || t.isGDrive) {
    t.state = "cancelled";
    // Give the workers a tick to observe the state before removing the task
    await new Promise((r) => setTimeout(r, 500));
  }

  // Delete incomplete / partial files from disk
  const targetDir = appConfig.downloadDir;
  const base = t.fileName;
  try {
    const files = await fsp.readdir(targetDir);
    for (const f of files) {
      if (f === base || f.startsWith(base + ".") || f.startsWith(id)) {
        await fsp.unlink(path.join(targetDir, f)).catch(() => {});
      }
    }
  } catch {}

  // Remove completely from task list
  delete tasks[id];
  broadcastTasks();
  res.json({ ok: true });
});

// 4. WebSocket Broadcast
function broadcastTasks() {
  const data = JSON.stringify({
    type: "TASKS_UPDATE",
    tasks: Object.values(tasks),
  });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(data);
  });
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({ type: "TASKS_UPDATE", tasks: Object.values(tasks) }),
  );
});

// 5. Active Task Monitor Loop
setInterval(async () => {
  const activeTasks = Object.values(tasks).filter((t) => t.aria2?.gid);
  if (activeTasks.length === 0) return;

  // In server.js inside setInterval() polling loop:
  for (const t of activeTasks) {
    const resp = await aria2Request("aria2.tellStatus", [
      t.aria2.gid,
      [
        "status",
        "totalLength",
        "completedLength",
        "downloadSpeed",
        "connections",
        "bittorrent",
        "files",
        "numSeeders",
        "followedBy",
        "errorMessage",
        "errorCode",
      ],
    ]);
    if (!resp?.result) continue;
    const s = resp.result;

    if (s.followedBy && s.followedBy.length > 0) {
      t.aria2.gid = s.followedBy[0];
      continue;
    }

    t.state = s.status || t.state;
    t.total = Number(s.totalLength) || t.total;
    t.downloaded = Number(s.completedLength) || t.downloaded;
    t.progress = t.total ? Math.round((t.downloaded / t.total) * 100) : 0;
    t.speed =
      t.state === "complete" || t.state === "paused" || t.state === "error"
        ? 0
        : Number(s.downloadSpeed) || 0;
    t.connections =
      t.state === "complete" || t.state === "paused" || t.state === "error"
        ? 0
        : Number(s.connections) || Number(s.numSeeders) || 0;
    // Expose seeder count so the UI can show swarm health
    t.seeders = Number(s.numSeeders) || 0;
    // ETA in seconds (aria2 gives us downloadSpeed; compute remaining time)
    if (t.speed > 0 && t.total && t.downloaded < t.total) {
      t.eta = Math.round((t.total - t.downloaded) / t.speed);
    } else {
      t.eta = null;
    }

    // Store aria2 error message (translate cryptic codes into actionable text)
    if (s.errorMessage) {
      if (s.errorCode === "22" && /status=403/.test(s.errorMessage)) {
        t.error =
          "Access denied (403). The link may have expired or requires a Referer/Cookie from the source site. Re-capture the link and retry.";
      } else if (s.errorCode === "22" && /status=404/.test(s.errorMessage)) {
        t.error = "File not found (404). The link has expired on the server.";
      } else if (
        s.errorCode === "13" &&
        /control file|allow-overwrite/i.test(s.errorMessage)
      ) {
        t.error =
          "An existing file/folder with this name has no resume data (.aria2). Delete it from the downloads folder or cancel this task and re-add it to start fresh.";
      } else {
        t.error = s.errorMessage;
      }
    }

    if (s.bittorrent?.info?.name) {
      t.fileName = s.bittorrent.info.name;
      t.originalFileName = s.bittorrent.info.name;
      t.isTorrent = true;
    } else if (Array.isArray(s.files) && s.files[0]?.path) {
      const resolved = path.basename(s.files[0].path);
      if (resolved && resolved !== "download") t.fileName = resolved;
    }
  }

  broadcastTasks();
}, 400);

server.on("error", (err) => {
  // Crash fix: an EADDRINUSE used to be an unhandled 'error' event that took
  // down the whole app (white window, no logs). Fail loudly but stay alive —
  // the UI is served from this process, so killing it is strictly worse.
  if (err.code === "EADDRINUSE") {
    console.error(
      `[LSDM] FATAL: port ${port} is already in use (another LSDM instance or an unrelated app?). Free the port or set PORT=<other> and restart. The UI at http://127.0.0.1:${port} will NOT load.`,
    );
  } else {
    console.error("[LSDM] Server error:", err);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`LSDM Server running at http://127.0.0.1:${port}`);
  if (!process.env.ARIA2_SECRET) {
    console.warn(
      "[LSDM] ARIA2_SECRET is not set. This is fine when launched via the Electron main process (it sets the secret automatically), but if you are running `node server.js` directly, every aria2 RPC call will be rejected with an auth error. Start the aria2 daemon with --rpc-secret=<value> and export ARIA2_SECRET=<same-value> first.",
    );
  }
});
