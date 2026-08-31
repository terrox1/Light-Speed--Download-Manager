// extension/content.js
let widgetContainer = null;

function sanitizeName(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function getBestPageTitle() {
  const heading = document.querySelector('h1, h2, .title, [class*="video-title"]')?.innerText?.trim();
  if (heading && heading.length > 3) return sanitizeName(heading.slice(0, 70));
  const docTitle = document.title.replace(/[-|].*$/, '').trim();
  return sanitizeName(docTitle.slice(0, 70)) || 'Video_Stream';
}

function createFloatingWidget(mediaList) {
  if (!mediaList || mediaList.length === 0) return;

  if (!widgetContainer) {
    widgetContainer = document.createElement('div');
    widgetContainer.id = 'lsdm-sniffer-widget';
    document.body.appendChild(widgetContainer);
  }

  // Flicker fix: only rebuild the card contents when the media set actually
  // changed. Repeated LSDM_MEDIA_DETECTED messages with identical data no
  // longer wipe and redraw the widget (which killed in-flight button states).
  const signature = JSON.stringify(mediaList.map(m => [m.rawUrl, m.qualities?.map(q => q.url)]));
  if (widgetContainer.dataset.signature === signature && widgetContainer.style.display !== 'none') {
    return;
  }
  widgetContainer.dataset.signature = signature;

  const baseTitle = getBestPageTitle();

  let cardsHtml = '';
  mediaList.forEach((media, mIdx) => {
    const itemTitle = media.detectedName || `${baseTitle}_${mIdx + 1}`;

    media.qualities.forEach((q) => {
      const ext = media.isHls ? 'mp4' : (media.rawUrl.match(/\.(mp4|webm|mkv|mov)/i)?.[1] || 'mp4');
      const targetFilename = `${itemTitle}_${q.resolution || q.quality}.${ext}`.replace(/\s+/g, '_');

      cardsHtml += `
        <div class="lsdm-media-row">
          <div class="lsdm-row-info">
            <div class="lsdm-media-title" title="${targetFilename}">
              ${itemTitle}
            </div>
            <div class="lsdm-media-meta">
              <span class="lsdm-badge-quality">${q.quality}</span>
              <span class="lsdm-meta-size">${q.sizeFormatted}</span>
              <span class="lsdm-meta-type">${media.isHls ? 'HLS Stream' : 'Direct MP4'}</span>
            </div>
          </div>
          <div class="lsdm-btn-group">
            <button class="lsdm-btn-copy" data-url="${q.url}" title="Copy Media Link">📋</button>
            <button class="lsdm-btn-download" data-url="${q.url}" data-hls="${media.isHls}" data-filename="${targetFilename}">
              Download
            </button>
          </div>
        </div>
      `;
    });
  });

  widgetContainer.innerHTML = `
    <div class="lsdm-widget-card">
      <div class="lsdm-widget-header">
        <div class="lsdm-header-title">
          <span class="lsdm-pulse">⚡</span>
          <strong>Detected Media (${mediaList.length})</strong>
        </div>
        <button id="lsdm-widget-close" title="Close">&times;</button>
      </div>
      <div class="lsdm-widget-body">
        ${cardsHtml}
      </div>
    </div>
  `;

  document.getElementById('lsdm-widget-close').onclick = () => {
    // Remove from DOM entirely instead of just hiding — avoids leaving stale
    // listeners/nodes around and lets a fresh detection rebuild cleanly
    widgetContainer?.remove();
    widgetContainer = null;
  };

  // Copy Link Handler
  widgetContainer.querySelectorAll('.lsdm-btn-copy').forEach(btn => {
    btn.onclick = () => {
      navigator.clipboard.writeText(btn.dataset.url).then(() => {
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      });
    };
  });

  // Download Handler
  widgetContainer.querySelectorAll('.lsdm-btn-download').forEach(btn => {
    btn.onclick = () => {
      const url = btn.dataset.url;
      const isHls = btn.dataset.hls === 'true';
      const fileName = btn.dataset.filename;

      chrome.runtime.sendMessage({
        type: 'START_MEDIA_DOWNLOAD',
        url,
        isHls,
        fileName,
        referer: window.location.href
      });

      btn.textContent = 'Sent!';
      btn.style.background = '#6bffb0';
      btn.style.color = '#000';
      setTimeout(() => {
        btn.textContent = 'Download';
        btn.style.background = '';
        btn.style.color = '';
      }, 2000);
    };
  });

  widgetContainer.style.display = 'block';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LSDM_MEDIA_DETECTED') {
    createFloatingWidget(msg.media);
  }
});

chrome.runtime.sendMessage({ type: 'GET_TAB_MEDIA' }, (res) => {
  if (res?.media) createFloatingWidget(res.media);
});

// Cleanup: remove the widget when the page is being unloaded or restored
// from the back/forward cache, so no detached nodes linger across restores.
window.addEventListener('pagehide', () => {
  widgetContainer?.remove();
  widgetContainer = null;
});