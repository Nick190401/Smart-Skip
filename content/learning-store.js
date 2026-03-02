/**
 * Speichert alles, was die Extension zwischen Browser-Neustarts lernt:
 * CSS-Selektoren pro Domain, Klick-Feedback und Zeitstempel pro Serie/Folge.
 *
 * Alles in chrome.storage.local unter "ss2_learn".
 */

class LearningStore {
  constructor() {
    this._data = null;    // loaded lazily
    this._dirty = false;  // pending save
    this._saveTimer = null;
  }

  //  Init

  async load() {
    try {
      const raw = (await chrome.storage.local.get('ss2_learn'))?.ss2_learn;
      this._data = raw || this._empty();
      // Migrate: ensure all top-level keys exist (data saved by older versions
      // may be missing 'windows' or future keys — fill gaps without losing data).
      const empty = this._empty();
      for (const key of Object.keys(empty)) {
        if (this._data[key] === undefined) this._data[key] = empty[key];
      }
    } catch {
      this._data = this._empty();
    }
    return this._data;
  }

  _empty() {
    return {
      selectors: {},    // domain → { seriesSelector, episodeSelector, skipSelectors[], quality, ts }
      feedback:  {},    // domain:buttonType → { selector, hits, misses, lastSeen }
      timings:   {},    // seriesKey  → { intro: [sec,...], recap: [sec,...], credits: [sec,...] }
      windows:   {},    // seriesKey  → { intro: [{from, to, count, ts}], ... }  (exact windows from signal-collector)
    };
  }

  async _ensureLoaded() {
    if (!this._data) await this.load();
  }

  //  1. Selector Memory

  /** Persist selectors discovered by AI DOM scanner */
  async saveSelectors(domain, { seriesSelector, episodeSelector, skipSelectors, skipTextPatterns }) {
    await this._ensureLoaded();
    const existing = this._data.selectors[domain];
    this._data.selectors[domain] = {
      seriesSelector:  seriesSelector  ?? existing?.seriesSelector  ?? null,
      episodeSelector: episodeSelector ?? existing?.episodeSelector ?? null,
      // Merge: union of old + new skip selectors, deduplicated
      skipSelectors: [...new Set([
        ...(existing?.skipSelectors || []),
        ...(skipSelectors || []),
      ])],
      // Merge text patterns too (e.g. "Skip Intro", "Überspringen")
      skipTextPatterns: [...new Set([
        ...(existing?.skipTextPatterns || []),
        ...(skipTextPatterns || []),
      ])],
      quality: (existing?.quality || 0) + 1,  // quality score increases each time confirmed
      ts: Date.now(),
    };
    this._scheduleSave();
  }

  /** Get persisted selectors for a domain (null if none / too old) */
  async getSelectors(domain, maxAgeMs = 7 * 24 * 60 * 60 * 1000) { // 7 days default TTL
    await this._ensureLoaded();
    const entry = this._data.selectors[domain];
    if (!entry) return null;
    if (Date.now() - entry.ts > maxAgeMs) return null;
    return entry;
  }

  /** Mark a skip selector as confirmed (quality++) */
  async confirmSelector(domain, selector) {
    await this._ensureLoaded();
    const entry = this._data.selectors[domain];
    if (!entry) return;
    entry.quality = (entry.quality || 0) + 1;
    entry.ts = Date.now();
    this._scheduleSave();
  }

  /** Remove a bad selector (called when a selector no longer finds anything) */
  async removeSkipSelector(domain, selector) {
    await this._ensureLoaded();
    const entry = this._data.selectors[domain];
    if (!entry?.skipSelectors) return;
    entry.skipSelectors = entry.skipSelectors.filter(s => s !== selector);
    this._scheduleSave();
  }

  //  2. Feedback Loop

  /**
   * Record a click event on a skip button.
   * source: 'ai' | 'manual' | 'rule'
   * success: true = button was visible and clickable, false = stale/wrong
   */
  async recordClick({ domain, buttonType, selector, source, success = true }) {
    await this._ensureLoaded();
    const key = `${domain}:${buttonType}`;
    const existing = this._data.feedback[key] || { selector: null, hits: 0, misses: 0, lastSeen: null, sources: {} };

    if (success) {
      existing.hits++;
      existing.selector  = selector || existing.selector;
      existing.lastSeen  = Date.now();
      existing.sources[source] = (existing.sources[source] || 0) + 1;
    } else {
      existing.misses++;
    }

    this._data.feedback[key] = existing;
    this._scheduleSave();
  }

  /** Get highest-confidence known selector for a button type on a domain */
  async getBestSelector(domain, buttonType) {
    await this._ensureLoaded();
    const key = `${domain}:${buttonType}`;
    const entry = this._data.feedback[key];
    if (!entry || !entry.selector || entry.hits < 2) return null;
    // Only trust if hit rate is decent
    const total = entry.hits + entry.misses;
    if (total > 0 && entry.hits / total < 0.5) return null;
    return entry.selector;
  }

  /** Get all known button-type selectors for a domain */
  async getAllFeedbackSelectors(domain) {
    await this._ensureLoaded();
    const result = {};
    for (const [key, entry] of Object.entries(this._data.feedback)) {
      if (!key.startsWith(domain + ':')) continue;
      const buttonType = key.slice(domain.length + 1);
      if (entry.selector && entry.hits >= 2) {
        result[buttonType] = entry.selector;
      }
    }
    return result;  // e.g. { intro: '.skip-intro-btn', recap: '.skip-recap-btn' }
  }

  //  3. Video-Time Patterns

  /**
   * Record an exact skip window {from, to} discovered by signal-collector.
   * Windows from multiple independent sessions are merged — overlapping ones
   * are kept as separate entries so predictWindow() can pick the dominant cluster.
   */
  /**
   * @param {number} [initialCount=1]  Pass server-reported count when
   *   storing a window received from fetchTimings so that confidence
   *   reflects how many devices contributed, not just 1.
   */
  async recordTimingWindow(seriesKey, type, from, to, initialCount = 1) {
    await this._ensureLoaded();
    if (!this._data.windows[seriesKey])       this._data.windows[seriesKey] = {};
    if (!this._data.windows[seriesKey][type]) this._data.windows[seriesKey][type] = [];

    const list = this._data.windows[seriesKey][type];
    // check if this window merges with an existing one (within 20 s tolerance)
    const existing = list.find(w => Math.abs(w.from - from) <= 20 && Math.abs(w.to - to) <= 20);
    if (existing) {
      // refine bounds toward the new values; take the higher count
      // (server count already aggregates many devices, don't double-add)
      const newCount = Math.max(existing.count + 1, initialCount);
      existing.from  = Math.round((existing.from * existing.count + from * initialCount) / (existing.count + initialCount));
      existing.to    = Math.round((existing.to   * existing.count + to   * initialCount) / (existing.count + initialCount));
      existing.count = newCount;
      existing.ts    = Date.now();
    } else {
      list.push({ from, to, count: initialCount, ts: Date.now() });
      if (list.length > 20) list.shift(); // keep last 20 unique windows
    }
    this._scheduleSave();
  }

  /**
   * Downgrade a window that produced a bad skip (user sought back / jump failed).
   * Reduces its count by 2; removes it once count reaches 0.
   * This is the windows-bucket counterpart to the timings-bucket poison in recordTiming.
   */
  async downgradeTimingWindow(seriesKey, type, from, to) {
    await this._ensureLoaded();
    const list = this._data.windows?.[seriesKey]?.[type];
    if (!list) return;
    const idx = list.findIndex(w => Math.abs(w.from - from) <= 20 && Math.abs(w.to - to) <= 20);
    if (idx === -1) return;
    list[idx].count = Math.max(0, (list[idx].count ?? 1) - 2);
    if (list[idx].count === 0) list.splice(idx, 1);
    this._scheduleSave();
  }

  async recordTiming(seriesKey, buttonType, videoSeconds) {
    await this._ensureLoaded();
    if (!this._data.timings[seriesKey]) this._data.timings[seriesKey] = {};
    const bucket = this._data.timings[seriesKey];

    // bucket[buttonType] can be an array (local only) or
    // { _local: [], _server: {...} } if server data was merged in
    const existing = bucket[buttonType];
    if (!existing) {
      bucket[buttonType] = [Math.round(videoSeconds)];
    } else if (Array.isArray(existing)) {
      existing.push(Math.round(videoSeconds));
      if (existing.length > 10) existing.shift();
    } else {
      // Object form with _local / _server
      if (!existing._local) existing._local = [];
      existing._local.push(Math.round(videoSeconds));
      if (existing._local.length > 10) existing._local.shift();
    }

    this._scheduleSave();
  }

  /**
   * Predict the skip window for a series/episode.
   * Returns { from, to, confidence, source } or null if insufficient data.
   *
   * Priority:
   *   1. Exact windows from signal-collector (windows bucket) — highest confidence
   *   2. Server window from crowdsourced API (timings._server)
   *   3. Cluster of local point-in-time observations (timings._local / array)
   */
  async predictWindow(seriesKey, buttonType) {
    await this._ensureLoaded();

    // 1. exact windows (from signal-collector: XHR/DOM/button-lifecycle)
    const winList = this._data.windows?.[seriesKey]?.[buttonType];
    if (winList?.length) {
      // dominant cluster: find window with most confirmed observations
      const best = winList.reduce((a, b) => (b.count > a.count ? b : a));
      const conf = best.count >= 5 ? 0.93
                 : best.count >= 3 ? 0.87
                 : best.count >= 2 ? 0.80
                 : 0.72; // single observed window — still pretty reliable
      return { from: best.from, to: best.to, confidence: conf, source: 'window' };
    }

    const bucket = this._data.timings[seriesKey]?.[buttonType];
    if (!bucket) return null;

    // server window — pre-computed from many devices, highest trust
    if (bucket._server && bucket._server.samples >= 3) {
      const s = bucket._server;
      const conf = s.samples >= 10 ? 0.92
                 : s.samples >= 5  ? 0.85
                 : s.samples >= 3  ? 0.75
                 : 0.60;
      return { from: s.from, to: s.to, confidence: conf, source: 'server' };
    }

    // local observations — need at least 2
    const times = Array.isArray(bucket) ? bucket
                : (bucket._local || []);
    if (times.length < 2) return null;

    // cluster: find the group of timestamps within 30 s of each other
    // that has the most members — outliers are discarded
    const sorted  = [...times].sort((a, b) => a - b);
    let cluster    = [sorted[0]];
    for (let i = 0; i < sorted.length; i++) {
      const group = sorted.filter(t => Math.abs(t - sorted[i]) <= 30);
      if (group.length > cluster.length) cluster = group;
    }
    if (cluster.length < 2) return null;

    const min  = cluster[0];
    const max  = cluster[cluster.length - 1];
    const mid  = cluster[Math.floor(cluster.length / 2)];
    const pad  = Math.max(8, (max - min) * 0.4);

    const conf = cluster.length >= 8 ? 0.88
               : cluster.length >= 5 ? 0.80
               : cluster.length >= 3 ? 0.72
               : 0.60;

    return {
      from:       Math.max(0, mid - pad),
      to:         mid + pad + 10,
      confidence: conf,
      source:     'local',
    };
  }

  /**
   * Store a server-provided timing window (from crowdsourced API).
   * These are used in preference over local observations.
   */
  async setServerTimingWindow(seriesKey, buttonType, window) {
    await this._ensureLoaded();
    if (!this._data.timings[seriesKey]) this._data.timings[seriesKey] = {};
    const bucket = this._data.timings[seriesKey];
    if (!bucket[buttonType]) bucket[buttonType] = [];
    // Merge: keep local array, store server sub-object
    if (Array.isArray(bucket[buttonType])) {
      // bucket is array — convert to object form
      this._data.timings[seriesKey][buttonType] = {
        _local:  bucket[buttonType],
        _server: { from: window.from, to: window.to, avg: window.avg, samples: window.samples },
      };
    } else {
      bucket[buttonType]._server = { from: window.from, to: window.to, avg: window.avg, samples: window.samples };
    }
    this._scheduleSave();
  }

  /** Get all timing data for a series (for popup display) */
  async getTimings(seriesKey) {
    await this._ensureLoaded();
    return this._data.timings[seriesKey] || {};
  }

  //  Introspection (for popup)

  async getSummary(domain, seriesKey) {
    await this._ensureLoaded();
    const selectors = this._data.selectors[domain] || null;
    const feedback  = Object.entries(this._data.feedback)
      .filter(([k]) => k.startsWith(domain + ':'))
      .map(([k, v]) => ({ type: k.slice(domain.length + 1), ...v }));
    const timings   = seriesKey ? (this._data.timings[seriesKey] || {}) : {};
    return { selectors, feedback, timings };
  }

  async clearDomain(domain) {
    await this._ensureLoaded();
    delete this._data.selectors[domain];
    for (const key of Object.keys(this._data.feedback)) {
      if (key.startsWith(domain + ':')) delete this._data.feedback[key];
    }
    this._scheduleSave();
  }

  //  Persistence

  _scheduleSave() {
    this._dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._flush(), 1500);
  }

  async _flush() {
    if (!this._dirty || !this._data) return;
    // Extension context may have been invalidated after a reload/update.
    // chrome.runtime.id becomes undefined in that case — bail out silently
    // rather than spamming the console with uncatchable errors.
    if (!chrome.runtime?.id) {
      this._dirty = false;
      clearTimeout(this._saveTimer);
      return;
    }
    try {
      await chrome.storage.local.set({ ss2_learn: this._data });
      this._dirty = false;
    } catch (e) {
      // If the context was invalidated between the check above and the await,
      // treat it as a clean exit rather than a recoverable warning.
      if (e.message?.includes('Extension context invalidated')) {
        this._dirty = false;
        return;
      }
      console.warn('[LearningStore] save failed:', e.message);
      try { syncService.reportError({ domain: location.hostname, message: `LearningStore save failed: ${e.message?.slice(0, 150)}` }); } catch {}
    }
  }

  /** Force immediate flush (e.g. before page unload) */
  async flush() { await this._flush(); }
}

// Flush pending writes before the page unloads (SPA navigations, tab close)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (learningStore._dirty && learningStore._data && chrome.runtime?.id) {
      // Use synchronous-ish storage write via sendBeacon-style flush
      // chrome.storage.local.set is async but initiated before unload completes
      try { chrome.storage.local.set({ ss2_learn: learningStore._data }); } catch {}
      learningStore._dirty = false;
    }
  });
  // Also flush on visibilitychange (covers mobile and some desktop navigations)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') learningStore.flush();
  });
}

// Singleton
const learningStore = new LearningStore();
