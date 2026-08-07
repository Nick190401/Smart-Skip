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
   *
   * Observations are bucketed *per episode* rather than averaged into one blurred
   * range. Averaging across episodes was the root cause of phantom skips: an intro
   * at 62 s in episode 1 and at 95 s in episode 3 collapsed into a single 78 s
   * window that matched neither, while `count` — and therefore confidence — kept
   * climbing. predictWindow() now derives the series prior from the median across
   * *distinct* episodes and can see how far they actually disagree.
   *
   * @param {number} [initialCount=1]  Pass server-reported count when
   *   storing a window received from fetchTimings so that confidence
   *   reflects how many devices contributed, not just 1.
   * @param {object} [meta]            { epKey, duration, server }
   *   epKey    — episode this observation came from; observations without one
   *              cannot prove episode diversity and are pooled under '_unknown'.
   *   duration — video.duration at observation time, used to reject a prior
   *              whose episode had a very different length.
   */
  async recordTimingWindow(seriesKey, type, from, to, initialCount = 1, meta = {}) {
    await this._ensureLoaded();
    if (!this._data.windows[seriesKey])       this._data.windows[seriesKey] = {};
    if (!this._data.windows[seriesKey][type]) this._data.windows[seriesKey][type] = [];

    from = Math.round(from);
    to   = Math.round(to);
    if (!(to > from)) return;

    const list  = this._data.windows[seriesKey][type];
    const epId  = meta.server ? '_server' : (meta.epKey || '_unknown');
    const dur   = Number.isFinite(meta.duration) && meta.duration > 0 ? Math.round(meta.duration) : null;

    // check if this window merges with an existing one (within 20 s tolerance)
    let entry = list.find(w => Math.abs(w.from - from) <= 20 && Math.abs(w.to - to) <= 20);
    if (!entry) {
      entry = { from, to, count: 0, eps: {}, rejects: 0, ts: Date.now() };
      list.push(entry);
      if (list.length > 20) list.shift(); // keep last 20 unique windows
    }
    if (!entry.eps) entry.eps = {};       // migrate v1 entries written before this change

    const ep = entry.eps[epId] || { from, to, dur, n: 0, ts: 0 };
    // Within one episode, refine toward the newest observation. Across episodes
    // nothing is averaged — each episode keeps its own bounds.
    ep.from = Math.round((ep.from * ep.n + from) / (ep.n + 1));
    ep.to   = Math.round((ep.to   * ep.n + to)   / (ep.n + 1));
    ep.n    = epId === '_server' ? Math.max(ep.n + 1, initialCount) : ep.n + 1;
    if (dur) ep.dur = dur;
    ep.ts   = Date.now();
    entry.eps[epId] = ep;

    entry.count = Math.max((entry.count || 0) + 1, initialCount);
    entry.ts    = Date.now();
    this._recomputeWindowBounds(entry);
    this._scheduleSave();
  }

  /** Median from/to across the distinct episodes that observed this window. */
  _recomputeWindowBounds(entry) {
    const eps = Object.values(entry.eps || {});
    if (!eps.length) return;
    const med = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      return Math.round(s[Math.floor(s.length / 2)]);
    };
    entry.from = med(eps.map(e => e.from));
    entry.to   = med(eps.map(e => e.to));
  }

  /** Stats used by predictWindow to decide how much a window can be trusted. */
  _windowStats(entry) {
    const eps    = Object.values(entry.eps || {});
    // '_unknown' and '_server' pool many sources under one id — they prove no
    // episode diversity, so they count as a single episode each.
    const nEps   = eps.length || 1;
    const froms  = eps.map(e => e.from);
    const spread = froms.length > 1 ? Math.max(...froms) - Math.min(...froms) : 0;
    const durs   = eps.map(e => e.dur).filter(d => Number.isFinite(d) && d > 0);
    const medDur = durs.length
      ? [...durs].sort((a, b) => a - b)[Math.floor(durs.length / 2)]
      : null;
    return { nEps, spread, medDur, rejects: entry.rejects || 0 };
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

  /**
   * Hard rejection: the user undid the skip or seeked back into the window.
   * A rejection is far stronger evidence than a sighting — one wrong jump in
   * episode 5 must outweigh three passive sightings in episodes 1-3, otherwise
   * a bad series prior can never be unlearned.
   *
   * Each rejection halves the window's confidence; two rejections delete it.
   */
  async rejectTimingWindow(key, type, from, to, epKey = null) {
    await this._ensureLoaded();
    const list = this._data.windows?.[key]?.[type];
    if (!list) return;
    const idx = list.findIndex(w => Math.abs(w.from - from) <= 25 && Math.abs(w.to - to) <= 25);
    if (idx === -1) return;
    const entry = list[idx];
    entry.rejects = (entry.rejects || 0) + 1;
    // Drop this episode's contribution — it demonstrably does not hold here.
    if (epKey && entry.eps?.[epKey]) {
      delete entry.eps[epKey];
      this._recomputeWindowBounds(entry);
    }
    if (entry.rejects >= 2 || !Object.keys(entry.eps || {}).length) list.splice(idx, 1);
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
   * Returns { from, to, confidence, source, tier, nEps, spread, stable } or null.
   *
   * Priority:
   *   1. Exact windows from signal-collector (windows bucket) — highest confidence
   *   2. Server window from crowdsourced API (timings._server)
   *   3. Cluster of local point-in-time observations (timings._local / array)
   *
   * Everything returned here is *memory*, never live evidence. Series-tier
   * predictions are therefore hard-capped at PRIOR_CAP, which sits below the
   * caller's auto-skip threshold: a series prior can raise suspicion and drive a
   * manual hint, but it can never fire a jump on its own. Only an episode-tier
   * prediction (same episode, seen before) or live corroboration in the page
   * gets past that line.
   *
   * @param {string} key                 series or episode key
   * @param {string} buttonType
   * @param {object} [ctx]
   *   tier     — 'series' (default) or 'episode'
   *   duration — current video.duration, used to reject priors recorded on
   *              episodes of a very different length
   */
  async predictWindow(key, buttonType, ctx = {}) {
    await this._ensureLoaded();

    const tier     = ctx.tier === 'episode' ? 'episode' : 'series';
    const duration = Number.isFinite(ctx.duration) && ctx.duration > 0 ? ctx.duration : null;

    // Series memory alone must stay below the auto-skip threshold (0.65).
    const PRIOR_CAP = 0.60;

    // Applies agreement / spread / duration / rejection penalties and clamps
    // to the tier cap.
    const finish = (from, to, base, source, stats) => {
      let conf   = base;
      let stable = true;

      // Episodes that disagree by more than 25 s describe different segments,
      // not one segment seen repeatedly — exactly the "episode 5 is not episode
      // 1-3" case. Such a prior may hint but must not drive a jump.
      if (stats.nEps > 1 && stats.spread > 25) { conf *= 0.6; stable = false; }

      // Disagreement larger than the ±20 s merge tolerance does not show up as
      // spread at all — it produces a second window entry instead. So also weigh
      // how many of the episodes we know about actually back the winning window.
      // A series whose intro sits at 62 s in three episodes and at 150 s in two
      // others is not a series with a reliable intro position.
      if (stats.agreement != null && stats.agreement < 0.6) {
        conf *= 0.5 + stats.agreement / 2; // 0.5 agreement → ×0.75, 0.25 → ×0.625
        stable = false;
      }

      // A prior learned on 24-minute episodes says nothing about a 48-minute
      // double episode or a recap special.
      if (duration && stats.medDur && Math.abs(duration - stats.medDur) / stats.medDur > 0.15) {
        conf *= 0.5;
        stable = false;
      }

      // Each past rejection halves the trust.
      if (stats.rejects) conf *= Math.pow(0.5, stats.rejects);

      if (tier === 'series') conf = Math.min(conf, PRIOR_CAP);
      if (conf < 0.25) return null;

      return {
        from, to,
        confidence: +conf.toFixed(3),
        source, tier,
        nEps:      stats.nEps,
        spread:    stats.spread,
        agreement: stats.agreement ?? null,
        stable,
      };
    };

    // 1. exact windows (from signal-collector: XHR/DOM/button-lifecycle)
    const winList = this._data.windows?.[key]?.[buttonType];
    if (winList?.length) {
      // Prefer the window backed by the most *distinct episodes*, not the one
      // with the highest raw count — replaying one episode five times used to
      // inflate count to 5 and buy 0.93 confidence for a single sighting.
      const scored = winList
        .map(w => ({ w, stats: this._windowStats(w) }))
        .sort((a, b) => (b.stats.nEps - a.stats.nEps) || ((b.w.count || 0) - (a.w.count || 0)));
      const { w: best, stats } = scored[0];

      // Share of all episodes that have ever reported this segment type and
      // back the winning window rather than a competing one.
      const allEps = new Set();
      for (const w of winList) for (const id of Object.keys(w.eps || {})) allEps.add(id);
      stats.agreement = allEps.size > 1 ? stats.nEps / allEps.size : null;

      const base = tier === 'episode'
        // Same episode seen before: observations really are repeat sightings.
        ? (best.count >= 3 ? 0.90 : best.count >= 2 ? 0.82 : 0.70)
        // Series prior: only episode diversity counts.
        : (stats.nEps >= 5 ? 0.60 : stats.nEps >= 3 ? 0.55 : stats.nEps >= 2 ? 0.45 : 0.35);

      const out = finish(best.from, best.to, base, 'window', stats);
      if (out) return out;
      // fall through to the weaker buckets rather than returning nothing
    }

    const bucket = this._data.timings[key]?.[buttonType];
    if (!bucket) return null;

    // server window — aggregated across devices, but still series-wide memory
    if (bucket._server && bucket._server.samples >= 3) {
      const s = bucket._server;
      const base = s.samples >= 10 ? 0.92
                 : s.samples >= 5  ? 0.85
                 : 0.75;
      const out = finish(s.from, s.to, base, 'server', { nEps: 1, spread: 0, medDur: null, rejects: 0 });
      if (out) return out;
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

    const base = cluster.length >= 8 ? 0.88
               : cluster.length >= 5 ? 0.80
               : cluster.length >= 3 ? 0.72
               : 0.60;

    return finish(
      Math.max(0, mid - pad),
      mid + pad + 10,
      base,
      'local',
      { nEps: 1, spread: max - min, medDur: null, rejects: 0 },
    );
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
