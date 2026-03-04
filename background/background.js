/**
 * Smart Skip v2 — Background Service Worker (MV3)
 */

// Shared credentials — git-ignored local file, never committed.
// Clone setup: git update-index --skip-worktree content/config.js
// then fill in apiBase + apiKey.
try { importScripts('../content/config.js'); } catch (_) {
  // Fallback so the extension doesn't crash before config.js is set up.
  self.SS2_CONFIG = { apiBase: '', apiKey: '' };
}

const VERSION = '2.0.0';

const DEFAULTS = {
  globalEnabled: true,
  hudEnabled: true,
  badgeEnabled: true,
  verboseLogging: false,
  domains: {},
  series: {},
  episodes: {},
};

// ── Install / Update ─────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const cfg = await loadSettings();
  if (!cfg) {
    await saveSettings(DEFAULTS);
  } else {
    // Migrate: fill any keys added in v2 that may be missing
    let changed = false;
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (cfg[k] === undefined) { cfg[k] = v; changed = true; }
    }
    if (changed) await saveSettings(cfg);
  }
});

// Restore badge count on SW restart (e.g. after browser restart)
chrome.runtime.onStartup.addListener(async () => {
  const { ss2_stats, ss2 } = await chrome.storage.local.get(['ss2_stats', 'ss2']);
  const cfg = ss2 || DEFAULTS;
  if (ss2_stats?.daily && cfg.badgeEnabled !== false) {
    const today = new Date().toLocaleDateString('sv');
    _updateBadge(ss2_stats.daily[today] || 0);
  } else {
    _updateBadge(0);
  }

  // ── Startup pruning: remove stale data to keep storage lean ──
  try {
    // 1. Prune daily stats older than 30 days
    if (ss2_stats?.daily) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const cutoffStr = cutoff.toLocaleDateString('sv');
      let pruned = false;
      for (const d of Object.keys(ss2_stats.daily)) {
        if (d < cutoffStr) { delete ss2_stats.daily[d]; pruned = true; }
      }
      if (pruned) await chrome.storage.local.set({ ss2_stats });
    }

    // 2. Prune series not seen in the last 90 days
    if (cfg?.series) {
      const cutoff90 = Date.now() - 90 * 86400_000;
      let pruned = false;
      for (const [key, val] of Object.entries(cfg.series)) {
        const last = val.lastSeen ? new Date(val.lastSeen).getTime() : 0;
        if (last && last < cutoff90) { delete cfg.series[key]; pruned = true; }
      }
      if (pruned) await saveSettings(cfg);
    }

    // 3. Prune stale per-tab series caches (tabs that no longer exist)
    const allKeys = Object.keys(await chrome.storage.local.get(null));
    const tabKeys = allKeys.filter(k => k.startsWith('ss2_series_'));
    if (tabKeys.length > 0) {
      const openTabs = new Set((await chrome.tabs.query({})).map(t => t.id));
      const stale = tabKeys.filter(k => !openTabs.has(parseInt(k.replace('ss2_series_', ''), 10)));
      if (stale.length) await chrome.storage.local.remove(stale);
    }
  } catch (_) { /* pruning is best-effort */ }
});

// ── MV3 Keep-alive — content scripts hold a long-lived port to prevent SW termination ──
const _connectedPorts = new Set();
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ss2-keepalive') return;
  _connectedPorts.add(port);
  port.onDisconnect.addListener(() => _connectedPorts.delete(port));
});

// ── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    try {
      switch (msg.action) {

        case 'getSettings':
          respond({ settings: await loadSettings() });
          break;

        case 'saveSettings':
          await saveSettings(msg.settings);
          // Broadcast change to all streaming tabs so content scripts reload
          broadcastToStreamingTabs({ action: 'settingsUpdated' });
          respond({ ok: true });
          break;

        case 'seriesDetected':
          await handleSeriesDetected(msg);
          // Cache per tab so popup can retrieve reliably regardless of which frame detected the series
          if (sender.tab?.id) {
            chrome.storage.local.set({
              [`ss2_series_${sender.tab.id}`]: { series: msg.series, domain: msg.domain, ts: Date.now() }
            });
          }
          // Forward to popup if open
          chrome.runtime.sendMessage({ action: 'seriesDetected', series: msg.series, domain: msg.domain })
            .catch(() => {});
          respond({ ok: true });
          break;

        case 'buttonClicked':
          await handleButtonClicked(msg);
          respond({ ok: true });
          break;

        case 'resetSeries':
          await resetSeries(msg.seriesKey);
          respond({ ok: true });
          break;

        case 'getAIStatus':
          // Content script already checked AI; this just echoes for popup display
          respond({ status: msg.status || 'unknown' });
          break;

        case 'snooze': {
          // Store snooze expiry so content scripts check it each scan
          const { minutes } = msg;
          if (!minutes || minutes <= 0) {
            await chrome.storage.local.remove('ss2_snooze');
          } else {
            const until = Date.now() + minutes * 60 * 1000;
            await chrome.storage.local.set({ ss2_snooze: { until } });
          }
          broadcastToStreamingTabs({ action: 'snoozeUpdated' });
          respond({ ok: true });
          break;
        }

        case 'deleteMyData': {
          // DSGVO Art. 17 — delete all cloud data for this device.
          // Handled here in the SW so it works even when no content script is loaded
          // (e.g. popup opened on a non-streaming page).
          const { ss2_device_id } = await chrome.storage.local.get('ss2_device_id');
          if (!ss2_device_id) {
            // No device ID — nothing stored on the server.
            await chrome.storage.local.remove('ss2_device_id');
            respond({ ok: true, deleted: true });
            break;
          }
          const API_BASE = SS2_CONFIG?.apiBase || '';
          const API_KEY  = SS2_CONFIG?.apiKey  || '';
          try {
            const res = await fetch(API_BASE, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', 'X-SS2-Key': API_KEY },
              body:    JSON.stringify({ action: 'deleteMyData', device_id: ss2_device_id }),
            });
            const json = await res.json();
            if (json?.deleted) {
              await chrome.storage.local.remove('ss2_device_id');
            }
            respond({ ok: true, deleted: !!json?.deleted });
          } catch (e) {
            respond({ ok: false, error: e.message });
          }
          break;
        }

        default:
          respond({ error: 'unknown action' });
      }
    } catch (e) {
      respond({ error: e.message });
    }
  })();
  return true; // async response
});

// ── Handlers ─────────────────────────────────────────────────────────────────
async function handleSeriesDetected({ series, domain }) {
  const cfg = await loadSettings();
  const key = `${domain}:${series.title}`;

  if (!cfg.series[key]) {
    cfg.series[key] = {
      skipIntro: true,
      skipRecap: true,
      skipCredits: true,
      skipAds: true,
      autoNext: false,
      firstSeen: new Date().toISOString(),
    };
  }
  cfg.series[key].lastSeen  = new Date().toISOString();
  cfg.series[key].lastEpisode = series.episode || null;

  await saveSettings(cfg);
}

async function handleButtonClicked({ buttonType, confidence, aiSource, series, domain }) {
  const cfg = await loadSettings();
  const key = `${domain}:${series?.title || '_unknown'}`;
  if (cfg.series[key]) {
    cfg.series[key].totalClicks = (cfg.series[key].totalClicks || 0) + 1;
    cfg.series[key].lastClickType = buttonType;
  }
  // Save per-click stats in local storage (no sync quota concern)
  const now = Date.now();
  await chrome.storage.local.set({
    lastClick: { buttonType, confidence, aiSource, domain, ts: now },
  });
  // Increment global + daily skip counter
  const { ss2_stats } = await chrome.storage.local.get('ss2_stats');
  const stats = ss2_stats || { totalSkipped: 0, byType: {}, daily: {} };
  stats.totalSkipped = (stats.totalSkipped || 0) + 1;
  stats.byType[buttonType] = (stats.byType[buttonType] || 0) + 1;
  // Daily counter — keyed by YYYY-MM-DD in local time
  const today = new Date().toLocaleDateString('sv'); // 'sv' gives YYYY-MM-DD
  if (!stats.daily) stats.daily = {};
  stats.daily[today] = (stats.daily[today] || 0) + 1;
  // Prune old daily entries (keep last 30 days)
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toLocaleDateString('sv');
  for (const d of Object.keys(stats.daily)) { if (d < cutoffStr) delete stats.daily[d]; }
  await chrome.storage.local.set({ ss2_stats: stats });

  // Update badge only when the user has it enabled
  if (cfg.badgeEnabled !== false) {
    _updateBadge(stats.daily[today]);
  } else {
    _updateBadge(0); // clear badge
  }
}

function _updateBadge(count) {
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#4f8ef7' });
}

async function resetSeries(seriesKey) {
  const cfg = await loadSettings();
  if (cfg.series[seriesKey]) {
    cfg.series[seriesKey] = {
      skipIntro: true, skipRecap: true, skipCredits: true, skipAds: true, autoNext: false
    };
    await saveSettings(cfg);
  }
}

// ── Storage helpers ───────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const sync  = (await chrome.storage.sync.get('ss2'))?.ss2;
    const local = (await chrome.storage.local.get('ss2'))?.ss2;
    const raw   = sync || local;
    return raw ? { ...DEFAULTS, ...raw } : null;
  } catch { return null; }
}

async function saveSettings(settings) {
  const clean = { ...DEFAULTS, ...settings };
  try {
    await chrome.storage.sync.set({ ss2: clean });
  } catch {
    // Sync quota exceeded — remove the now-stale sync entry so that loadSettings
    // does not silently return old sync data instead of the fresh local copy.
    try { await chrome.storage.sync.remove('ss2'); } catch {}
  }
  // Always mirror to local storage. This ensures the popup's Phase 1 pre-render
  // always reads the latest settings without waiting for the async background fetch.
  await chrome.storage.local.set({ ss2: clean });
}

// ── Cleanup per-tab series cache when tab closes or navigates away ──────────
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove(`ss2_series_${tabId}`);
});

// SPA or full navigation — the old series is no longer valid.
// Clear the cache so the next popup open falls back to fetchSeries
// instead of showing stale data from the previous URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    chrome.storage.local.remove(`ss2_series_${tabId}`);
  }
});

// ── Broadcast to streaming tabs ───────────────────────────────────────────────
async function broadcastToStreamingTabs(msg) {
  // Only send to tabs whose URL is a known streaming site —
  // avoids Chrome logging "message channel closed" errors for tabs
  // that have no content script (e.g. the extension website itself).
  const manifest   = chrome.runtime.getManifest();
  const rawPatterns = manifest.content_scripts?.[0]?.matches ?? [];

  // Convert manifest glob patterns to plain hostnames for fast matching
  //   "*://*.netflix.com/*" → "netflix.com"
  const hostnames = new Set(
    rawPatterns.map(p => p.replace(/^\*:\/\/\*\./, '').replace(/\/\*$/, '').toLowerCase())
  );

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    try {
      const host = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, '');
      // Exact match OR suffix match (e.g. "play.amazon.de" → ends with "amazon.de")
      const matches = hostnames.has(host) || [...hostnames].some(h => host.endsWith('.' + h) || host === h);
      if (!matches) continue;
      // Fire-and-forget per tab — don't await so one slow tab can't block others
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    } catch { /* invalid URL or missing content script */ }
  }
}

// ── Keyboard shortcut: Alt+S → trigger scan on active tab ────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'manual-skip') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'scanNow' });
  } catch { /* content script not available on this tab */ }
});
