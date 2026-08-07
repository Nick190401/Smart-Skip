﻿/**
 * Fetches selectors and timing windows from the server and submits
 * anonymised learning data back. Stays inactive until the user
 * consents — every method checks this._ready before the first request.
 *
 * Must be loaded after: learning-store.js
 */

// SYNC_API_BASE and SYNC_API_KEY must match the values in server/config.php.
// Set them in content/config.js (which is skip-worktree'd in git — never committed).
const SYNC_API_BASE = window.SS2_CONFIG?.apiBase || 'https://smartskipv2.kernelminds.de/api.php';
const SYNC_API_KEY  = window.SS2_CONFIG?.apiKey  || '';
const SYNC_VERSION  = chrome.runtime.getManifest().version;

const SELECTOR_CACHE_MINUTES = 60;   // how long to keep fetched selectors before re-requesting
const TIMING_CACHE_MINUTES   = 120;  // same for timing windows

// Every network call is capped. Nothing the server provides is worth stalling
// playback for — all of it has a local fallback.
const SYNC_TIMEOUT_MS   = 6000;  // regular API calls
const CONFIG_TIMEOUT_MS = 3500;  // start-up config: blocks first scan, keep it short


class SyncService {
  constructor() {
    this._deviceId   = null;
    this._ready      = false;      // true nach registerDevice
    this._queue      = [];         // ausstehende fire-and-forget Requests
    this._queueTimer = null;
    this._selectorCache = {};      // domain → { data, fetchedAt }
    this._timingCache   = {};      // seriesKey → { data, fetchedAt }
    this._remoteConfigCache    = null;
    this._remoteConfigFetchedAt = 0;
    this._init();
  }

  // --- init ---

  async _init() {
    // fetch remote config at startup — public endpoint, no PII, no consent needed
    this.fetchRemoteConfig().catch(() => {});

    // only activate after the user opts in
    const { ss2_consent } = await chrome.storage.local.get('ss2_consent');
    if (ss2_consent?.sync === true) {
      this._deviceId = await this._getOrCreateDeviceId();
      await this._registerDevice();
      this._ready = true;
      this._flushQueue();
    }

    // also react when the user flips the toggle while the tab is open
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ss2_consent) return;
      const newVal = changes.ss2_consent.newValue;
      if (newVal?.sync === true && !this._ready) {
        this.enable();
      } else if (newVal?.sync === false && this._ready) {
        this.disable();
      }
    });
  }

  async _getOrCreateDeviceId() {
    const stored = await chrome.storage.local.get('ss2_device_id');
    if (stored.ss2_device_id) return stored.ss2_device_id;

    // Neue UUID erzeugen (basierend auf crypto API)
    const id = ([1e7]+-1e3+-4e3+-8e3+-1e11)
      .replace(/[018]/g, c =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
      );
    await chrome.storage.local.set({ ss2_device_id: id });
    return id;
  }

  async _registerDevice() {
    try {
      await this._post({
        action:     'registerDevice',
        device_id:  this._deviceId,
        version:    SYNC_VERSION,
        user_agent: navigator.userAgent.slice(0, 128),
      });
    } catch (_) { /* offline — kein Problem */ }
  }

  /**
   * Called from the popup when the user grants consent or re-enables Cloud-Sync.
   * Safe to call multiple times.
   */
  async enable() {
    if (this._ready) return;
    this._deviceId = await this._getOrCreateDeviceId();
    await this._registerDevice();
    this._ready = true;
    this._flushQueue();
  }

  /**
   * Called from the popup when the user revokes consent or disables Cloud-Sync.
   * Discards any queued (unsent) data.
   */
  disable() {
    this._ready = false;
    this._queue = [];
    clearTimeout(this._queueTimer);
    this._queueTimer = null;
  }

  // --- public ---

  /**
   * Fetch crowd-sourced selectors for a domain.
   * Automatically merges the result into the local learningStore.
   * @returns {Promise<object|null>}
   */
  async fetchSelectors(domain) {
    if (!this._ready) return null;
    const cached = this._selectorCache[domain];
    if (cached && (Date.now() - cached.fetchedAt) < SELECTOR_CACHE_MINUTES * 60_000) {
      return cached.data;
    }
    try {
      const res = await this._post({ action: 'fetchSelectors', domain });
      if (res?.found && res.selectors) {
        this._selectorCache[domain] = { data: res.selectors, fetchedAt: Date.now() };

        // Merge into local learningStore (prefer server quality when higher)
        const local = await learningStore.getSelectors(domain);
        if (!local || res.selectors.quality > (local.quality || 0)) {
          learningStore.saveSelectors(domain, {
            seriesSelector:  res.selectors.series_selector,
            episodeSelector: res.selectors.episode_selector,
            skipSelectors:   res.selectors.skip_selectors?.map(s => s.selector || s) ?? [],
            quality:         res.selectors.quality,
            source:          'crowdsourced',
          });
        }
        return res.selectors;
      }
    } catch (_) { /* offline */ }
    return null;
  }

  /** Returns true when the admin has set block_telemetry for the current domain — no data leaves. */
  _isTelemetryBlocked() {
    return this.getRemoteConfig()?.block_telemetry === true;
  }

  /**
   * Submit local selectors to the server (crowdsourcing contribution).
   * Fire-and-forget.
   */
  submitSelectors(domain, selectors) {
    if (this._isTelemetryBlocked()) return;
    this._enqueue({
      action:           'submitSelectors',
      device_id:        this._deviceId,
      domain,
      series_selector:  selectors.seriesSelector  ?? null,
      episode_selector: selectors.episodeSelector ?? null,
      skip_selectors:   selectors.skipSelectors   ?? [],
      quality:          selectors.quality          ?? 0.5,
    });
    // Re-fetch after 15 s so the client immediately gets the merged server result
    setTimeout(() => this.fetchSelectors(domain), 15_000);
  }

  /**
   * Skip-Event protokollieren (Statistiken).
   * Fire-and-forget — blockiert die UI nicht.
   */
  recordEvent(data) {
    if (this._isTelemetryBlocked()) return;
    // { domain, buttonType, confidence, aiSource, videoTime, seriesTitle, episodeInfo,
    //   videoDuration, episodeFraction, subtitleSample, buttonText, buttonAttrs }
    this._enqueue({
      action:           'recordEvent',
      device_id:        this._deviceId,
      domain:           data.domain,
      button_type:      data.buttonType,
      confidence:       data.confidence      ?? null,
      ai_source:        (() => { const s = data.aiSource ?? ''; return (s === 'ai-batch' || s === 'ai') ? 'ai' : (s === 'rule' ? 'rule' : ''); })(),
      video_time:       data.videoTime       ?? null,
      series_title:     data.seriesTitle     ?? null,
      episode_info:     data.episodeInfo     ?? null,
      // ─ enriched training signals ─────────────────────────────────
      video_duration:   data.videoDuration   ?? null, // episode length (s)
      episode_fraction: data.episodeFraction ?? null, // position as 0.0–1.0
      subtitle_sample:  data.subtitleSample  ?? null, // active subtitle text at click
      button_text:      data.buttonText      ?? null, // visible button text
      button_attrs:     data.buttonAttrs ? JSON.stringify(data.buttonAttrs).slice(0, 500) : null,
      version:          SYNC_VERSION,
    });
  }

  /**
   * Submit selector feedback (did the click succeed?).
   * Fire-and-forget.
   */
  recordFeedback(data) {
    if (this._isTelemetryBlocked()) return;
    // { domain, buttonType, selector, success, sources }
    this._enqueue({
      action:      'recordFeedback',
      device_id:   this._deviceId,
      domain:      data.domain,
      button_type: data.buttonType,
      selector:    data.selector,
      success:     data.success ?? true,
      sources:     data.sources ?? '',
    });
  }

  /**
   * Button fingerprint for cross-platform pattern training: the server feeds
   * these back as text patterns, so new platforms work without hard-coded
   * selectors. Fire-and-forget.
   * @param {object} sig { tag, text, classes, attrs }
   */
  recordButtonSignature(domain, type, sig) {
    if (this._isTelemetryBlocked()) return;
    this._enqueue({
      action:    'submitButtonSignature',
      device_id: this._deviceId,
      domain,
      type,
      tag:       sig.tag     ?? '',
      text:      sig.text    ?? '',
      classes:   sig.classes ?? '',
      attrs:     sig.attrs   ?? {},
    });
  }

  /**
   * Timing-Datenpunkt einreichen.
   * Fire-and-forget.
   */
  recordTiming(seriesKey, eventType, videoTime) {
    if (this._isTelemetryBlocked()) return;
    this._enqueue({
      action:     'recordTiming',
      device_id:  this._deviceId,
      series_key: seriesKey,
      event_type: eventType,
      video_time: videoTime,
    });
  }

  /**
   * Exact timing window {from, to} einreichen (von signal-collector gesammelt).
   * Fire-and-forget. Server merged mehrere Submissions in ein crowdsourced window.
   * source: detection origin (e.g. 'xhr', 'platform', 'track', 'mediasession',
   *   'ai-subtitle', 'progress-segment', 'inline-script') — lets the server
   *   weight high-confidence sources (platform, xhr) over heuristic ones.
   */
  recordTimingWindow(seriesKey, eventType, from, to, source = '') {
    if (this._isTelemetryBlocked()) return;
    this._enqueue({
      action:     'recordTimingWindow',
      device_id:  this._deviceId,
      series_key: seriesKey,
      event_type: eventType,
      from,
      to,
      source,
    });
  }

  /**
   * Fetch crowd-sourced timing windows for a series.
   * Merges results into the local learningStore.
   * @returns {Promise<object>} Keyed by type: {avg, from, to, samples}
   */
  async fetchTimings(seriesKey) {
    if (!this._ready) return {};
    const cached = this._timingCache[seriesKey];
    if (cached && (Date.now() - cached.fetchedAt) < TIMING_CACHE_MINUTES * 60_000) {
      return cached.data;
    }
    try {
      const res = await this._post({ action: 'fetchTimings', series_key: seriesKey });
      if (res?.windows) {
        this._timingCache[seriesKey] = { data: res.windows, fetchedAt: Date.now() };

        // Merge into local learningStore
        for (const [type, w] of Object.entries(res.windows)) {
          if (w.samples >= 3) {
            // Enough statistical data points — replace local cluster with server values
            learningStore.setServerTimingWindow(seriesKey, type, w);
          }
          // Exact {from, to} windows from the timing_windows table:
          // stored with the server-side count as initialCount so that
          // predictWindow() immediately gets high confidence when many
          // devices have reported the same window.
          if (Array.isArray(w.exact)) {
            for (const ew of w.exact) {
              // Use device count if available, otherwise fall back to raw count.
              // Capped: a high device count means many people watched *some*
              // episode of the series, not that this window holds for the one
              // playing now. It is stored under the '_server' pseudo-episode so
              // it counts as a single opinion and stays prior-tier.
              const weight = Math.min(ew.devices ?? ew.count ?? 1, 5);
              learningStore.recordTimingWindow(seriesKey, type, ew.from, ew.to, weight, { server: true });
            }
          }
        }
        return res.windows;
      }
    } catch (_) { /* offline */ }
    return {};
  }

  /**
   * Save settings to the cloud.
   */
  async saveSettings(settings) {
    if (!this._ready) return;
    try {
      await this._post({
        action:    'saveSettings',
        device_id: this._deviceId,
        settings,
      });
    } catch (_) { /* offline */ }
  }

  /**
   * Load settings from the cloud.
   * @returns {Promise<object|null>} settings object or null if not found
   */
  async loadSettings() {
    if (!this._deviceId) return null;
    try {
      const res = await this._post({
        action:    'loadSettings',
        device_id: this._deviceId,
      });
      if (res?.found) return res.settings;
    } catch (_) { /* offline */ }
    return null;
  }

  /**
   * GDPR Art. 17 — delete all data stored on the server for this device.
   * Afterwards removes the local device ID so that the next opt-in
   * creates a completely fresh anonymous device.
   */
  async deleteMyData() {
    if (!this._deviceId) {
      // No device ID yet — nothing stored on the server
      await chrome.storage.local.remove('ss2_device_id');
      return { deleted: true };
    }
    try {
      const res = await this._post({
        action:    'deleteMyData',
        device_id: this._deviceId,
      });
      if (res?.deleted) {
        // Forget the local ID — the next opt-in will receive a fresh UUID
        this._deviceId = null;
        this._ready    = false;
        this._queue    = [];
        await chrome.storage.local.remove('ss2_device_id');
      }
      return res;
    } catch (e) {
      throw e;
    }
  }

  /**
   * Fehlerbericht einschicken.
   * Fire-and-forget.
   */
  reportError(data) {
    if (this._isTelemetryBlocked()) return;
    // { domain, message, url }
    this._enqueue({
      action:    'reportError',
      device_id: this._deviceId ?? undefined,
      domain:    data.domain   ?? '',
      message:   data.message  ?? '',
      url:       data.url      ?? location.pathname,
      version:   SYNC_VERSION,
    });
  }

  // --- remote config ---

  /**
   * Fetches the remote admin config (feature flags, broadcasts, keywords,
   * domain rules, version gate) from the public api.php getConfig endpoint.
   * Caches the result in chrome.storage.local for 6 hours.
   * Safe to call without consent — the endpoint returns no PII.
   */
  async fetchRemoteConfig() {
    const TTL = 6 * 60 * 60 * 1000; // 6 h

    // Return in-memory cache if still fresh
    if (this._remoteConfigCache && (Date.now() - this._remoteConfigFetchedAt) < TTL) {
      return this._remoteConfigCache;
    }

    // Try persistent cache from storage first (survives SW restarts)
    let stale = null;
    try {
      const { ss2_remote_config } = await chrome.storage.local.get('ss2_remote_config');
      if (ss2_remote_config?.data) {
        if ((Date.now() - (ss2_remote_config.fetchedAt || 0)) < TTL) {
          this._remoteConfigCache     = ss2_remote_config.data;
          this._remoteConfigFetchedAt = ss2_remote_config.fetchedAt;
          return this._remoteConfigCache;
        }
        // Expired, but still better than nothing if the server is unreachable.
        stale = ss2_remote_config.data;
      }
    } catch (_) {}

    // Fetch fresh from server. Start-up awaits this, so it gets the short
    // timeout — a stale or missing config only costs feature flags, whereas a
    // hanging request costs the user every skip on the page.
    try {
      const data = await this._fetchJSON(
        { action: 'getConfig', version: SYNC_VERSION }, CONFIG_TIMEOUT_MS);
      if (data.ok) {
        this._remoteConfigCache    = data;
        this._remoteConfigFetchedAt = Date.now();
        await chrome.storage.local.set({
          ss2_remote_config: { data, fetchedAt: this._remoteConfigFetchedAt },
        });
        return data;
      }
    } catch (_) { /* offline — fall back to stale cache */ }

    // Server unreachable: an expired config still describes the feature flags
    // and domain rules better than no config at all, so prefer it over null.
    return this._remoteConfigCache || stale;
  }

  /** Returns the last successfully fetched remote config (synchronous). */
  getRemoteConfig() {
    return this._remoteConfigCache;
  }

  // --- internal ---

  /** Enqueue a request payload and flush as a batched request shortly after. */
  _enqueue(payload) {
    if (!this._ready) return; // silently discard — no consent
    this._queue.push(payload);
    if (!this._queueTimer) {
      // Batch multiple calls that arrive within ~800 ms into a single request
      this._queueTimer = setTimeout(() => this._flushQueue(), 800);
    }
  }

  async _flushQueue() {
    clearTimeout(this._queueTimer);
    this._queueTimer = null;
    if (!this._ready && this._queue.length) {
      // noch nicht registriert, kurz re-versuchen
      this._queueTimer = setTimeout(() => this._flushQueue(), 2000);
      return;
    }
    const items = [...this._queue];
    this._queue = [];
    for (const payload of items) {
      try {
        await this._post(payload);
      } catch (_) {} // verwerfen
    }
  }

  /**
   * Timeout is not optional: a host that accepts the connection but never
   * answers would leave start-up and arming pending for the life of the page.
   * Every caller treats a rejection as "offline, carry on".
   */
  async _post(payload, timeoutMs = SYNC_TIMEOUT_MS) {
    const data = await this._fetchJSON(payload, timeoutMs);
    if (!data.ok) throw new Error(data.error || 'API error');
    return data;
  }

  async _fetchJSON(payload, timeoutMs = SYNC_TIMEOUT_MS) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(SYNC_API_BASE, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SS2-Key':    SYNC_API_KEY,
        },
        body:   JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

// Singleton
const syncService = new SyncService();
