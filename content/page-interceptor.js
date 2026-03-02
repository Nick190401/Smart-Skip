/**
 * Smart Skip v2 — Page-context XHR/Fetch interceptor
 *
 * This file is injected into the PAGE context (not the extension sandbox) via
 * script.src = chrome.runtime.getURL('content/page-interceptor.js')
 * so that it can monkey-patch window.fetch and XMLHttpRequest before they
 * are used by the streaming platform.
 *
 * Using a standalone file (rather than script.textContent) is required because
 * sites like Paramount+, Max, Hulu etc. set a strict Content-Security-Policy
 * that blocks inline scripts — but extension-origin script src URLs are allowed.
 *
 * Communication back to the content script:
 *   window.postMessage({ __ss2_net__: true, data: <object>, url: <string> }, '*')
 */

(function () {
  if (window.__ss2_intercepted__) return;
  window.__ss2_intercepted__ = true;

  function tryPost(text, url) {
    try {
      const d = JSON.parse(text);
      if (d && typeof d === 'object') {
        window.postMessage({ __ss2_net__: true, data: d, url: url }, '*');
      }
    } catch (_) {}
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const _origFetch = window.fetch.bind(window);
  window.fetch = function (...args) {
    return _origFetch(...args).then(res => {
      const clone = res.clone();
      const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      clone.text()
           .then(t => tryPost(t, reqUrl))
           .catch(() => {});
      return res;
    });
  };

  // ── XMLHttpRequest ─────────────────────────────────────────────────────────
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ss2_url__ = url;
    return _XHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      if (this.responseType === '' || this.responseType === 'text') {
        tryPost(this.responseText, this.__ss2_url__ || '');
      }
    });
    return _XHRSend.apply(this, args);
  };

  // ── WebSocket ────────────────────────────────────────────────────────────
  // Disney+, Peacock and other platforms push timing/chapter data via WS.
  const _origWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new _origWS(...args);
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        tryPost(ev.data, typeof args[0] === 'string' ? args[0] : '');
      }
    });
    return ws;
  };
  try {
    window.WebSocket.prototype  = _origWS.prototype;
    window.WebSocket.CONNECTING = _origWS.CONNECTING;
    window.WebSocket.OPEN       = _origWS.OPEN;
    window.WebSocket.CLOSING    = _origWS.CLOSING;
    window.WebSocket.CLOSED     = _origWS.CLOSED;
  } catch (_) {}

  // ── Inline JSON scripts ──────────────────────────────────────────────────
  // Next.js / Nuxt / plain SSR pages embed full app state as <script> JSON
  // that already exists in the DOM before any XHR fires — the interceptors
  // above would never see it. Scan now and re-scan after DOMContentLoaded
  // in case the page builds them dynamically.
  function scanInitialScripts() {
    try {
      const sel = '#__NEXT_DATA__, #__NUXT_DATA__, #__NUXT__, '
        + 'script[type="application/json"], script[type="application/ld+json"]';
      document.querySelectorAll(sel).forEach(tag => {
        const text = tag.textContent?.trim();
        if (text && text.length > 10) tryPost(text, location.href);
      });
    } catch (_) {}
  }
  scanInitialScripts();
  if (document.readyState !== 'complete') {
    window.addEventListener('DOMContentLoaded', scanInitialScripts, { once: true });
  }
})();
