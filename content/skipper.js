﻿/**
 * Smart Skip v2 — main controller
 *
 * Wires together the DOM observer, periodic scan loop and metadata
 * detection. Needs platforms.js, ai-classifier.js, dom-scanner.js,
 * learning-store.js and sync-service.js loaded first.
 */

// Returns false once the extension has been reloaded/unloaded.
// All interval callbacks and async chrome API paths check this first so that
// a stale content-script never throws "Extension context invalidated".
function _ssContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

// Domains where SmartSkip never makes sense (live-streaming, no VOD segments).
// These are permanently excluded — no LearningStore writes, no AI calls, no HUD.
const BLOCKED_DOMAINS = new Set([
  'www.twitch.tv',
  'twitch.tv',
  'm.twitch.tv',
  'clips.twitch.tv',
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

/**
 * How much each metadata source can be trusted, so a later detection pass can
 * only ever improve what we know about the series — never replace it with a
 * guess scraped off document.title.
 *
 *   4  the player's own DOM, or structured data the site publishes about itself
 *   3  Gemini Nano reading the page
 *   2  regex over the tab title
 *   1  the tab title with the platform suffix stripped off
 */
const SS_META_QUALITY = {
  netflix: 4, disneyplus: 4, prime: 4, crunchyroll: 4, paramount: 4,
  max: 4, appletv: 4, hulu: 4, viki: 4, structured: 4,
  'ai-scanner': 3, 'ai-title': 3,
  generic: 2, 'title-fallback': 2,
  'title-raw': 1,
};
const ssMetaQuality = (source) => SS_META_QUALITY[source] ?? 2;

class SmartSkipV2 {
  constructor() {
    this.platform     = resolvePlatform();   // from platforms.js
    this.enabled      = true;
    this.settings     = this._defaultSettings();
    this.currentSeries = null;

    // Observers & timers
    this._domObserver   = null;
    this._metaObserver  = null;
    this._titleObserver = null;
    this._scanDebounce  = null;
    this._metaDebounce  = null;
    this._metaRetry     = null;   // interval for retrying when meta not yet found
    this._metaSlowRetry  = null;   // low-frequency background polling after burst ends
    this._metaRetryCount = 0;
    this._lastClickAt   = 0;
    this._clickCooldown = 700; // ms — long enough for the DOM to settle after a click

    // Crossing one segment boundary is the best predictor that another is right
    // behind it: a recap runs straight into the opening on most series. While a
    // burst is active the scan budget drops from seconds to milliseconds.
    this._burstUntil   = 0;
    this._lastSkipType = null;
    // element → { ts, type, videoTime }. Replaces a blanket cooldown that also
    // blocked the *next* segment's button when the player reuses one node.
    this._recentClicks   = new Map();
    this._followUpTimers = new Set();

    // button texts confirmed by the AI on this domain (e.g. "Skip Intro")
    // filled from LearningStore on boot, updated when domScanner returns new results
    this._learnedTextPatterns = [];

    // Remote admin config (feature flags, domain rules, keywords, broadcasts)
    // Fetched once by SyncService at boot and cached for 6 hours.
    this._remoteConfig = null;

    // HUD
    this._hud           = null;
    this._hudHideTimer  = null;

    this._scanPending   = false;  // true while an AI scan is running
    this._lastScanAt    = 0;
  }

  async init() {
    // Hard-blocked domains: exit immediately before any storage access or observer setup.
    if (BLOCKED_DOMAINS.has(location.hostname)) return;

    // In sub-frames (all_frames: true) only run if a <video> is present.
    // Avoids wasted AI calls, observers and storage reads in ad/tracking iframes.
    if (window !== window.top && !document.querySelector('video')) return;

    try { await i18n.init(); } catch (_) {}

    try {
      await this._loadSettings();
    } catch (_) { /* use defaults */ }

    if (!this.enabled) return;

    // ── Remote admin config ──────────────────────────────────────────────────
    // Cached for 6 hours, so this is instant on almost every run. When the cache
    // has expired it needs the network — and start-up must not depend on that.
    // Wait briefly, then start anyway and apply the config if it still arrives.
    const configP = syncService.fetchRemoteConfig().catch(() => null);
    try {
      this._remoteConfig = await Promise.race([
        configP,
        new Promise(r => setTimeout(() => r(null), 1500)),
      ]);
    } catch (_) {}

    if (this._applyRemoteConfigGates()) return;

    // Config that arrived after we gave up waiting: honour it retroactively, so
    // maintenance mode and admin rules still take effect on an already-running page.
    if (!this._remoteConfig) {
      configP.then(cfg => {
        if (!cfg || this._remoteConfig) return;
        this._remoteConfig = cfg;
        if (this._applyRemoteConfigGates()) this.shutdown();
      });
    }

    this._setupMessageListener();
    this._setupDOMObserver();
    this._setupMetaObserver();
    this._ensureHUD();
    this._connectKeepAlive();

    this._scheduleScan(200);
    this._scheduleMeta(300);
    this._startMetaRetry();
    this._startPeriodicScan();

    // warm up learned patterns so the first scan on this domain isn't blind
    learningStore.getSelectors(location.hostname).then(learned => {
      if (learned?.skipTextPatterns?.length) {
        this._learnedTextPatterns = [...learned.skipTextPatterns];
      }
    });

    // Inject server-managed keywords from the admin panel (feature flag: keywords_sync)
    // These run alongside locally-learned patterns and are added once per page load.
    if (this._remoteConfig?.feature_flags?.keywords_sync !== false && this._remoteConfig?.keywords?.length) {
      for (const { keyword } of this._remoteConfig.keywords) {
        if (keyword && !this._learnedTextPatterns.includes(keyword)) {
          this._learnedTextPatterns.push(keyword);
        }
      }
    }

    // Watch for navigation (SPA support) and for the episode changing underneath
    // a URL that stays put.
    let lastHref = location.href;
    let lastDomain = location.hostname;
    ssMedia.resetChangeBaseline();
    const navCheck = this._navCheck = setInterval(() => {
      // Stop silently if the extension was reloaded while this tab is open.
      if (!_ssContextValid()) { clearInterval(navCheck); return; }
      if (location.href !== lastHref) {
        lastHref = location.href;
        this._resetForNewMedia('navigation');
        if (location.hostname !== lastDomain) {  // domain changed — drop stale patterns
          lastDomain = location.hostname;
          this._learnedTextPatterns = [];
          learningStore.getSelectors(location.hostname).then(learned => {
            if (learned?.skipTextPatterns?.length) {
              this._learnedTextPatterns = [...learned.skipTextPatterns];
            }
          });
        }
        return;
      }
      // Autoplay on Prime, Disney+ and Crunchyroll loads the next episode into
      // the same player without touching location.href. Everything keyed on the
      // episode — timing windows, the episode settings row, what the popup shows
      // — stayed pinned to the previous one for the rest of the session.
      if (ssMedia.pollChange()) this._resetForNewMedia('media-change');
    }, 1000);

    // update HUD badge once we know whether Gemini Nano is ready
    if (typeof aiClassifier !== 'undefined') {
      aiClassifier.aiStatus().then(status => {
        if (this._hud) this._updateHUDStatus(status);
      });
    }

    this._waitForVideo();
  }

  /**
   * Different content is playing — either the page navigated or the player
   * swapped the stream. Everything derived from the previous episode is now
   * wrong, so it all goes: cached classifications, discovered selectors, armed
   * timing windows and the detected series itself.
   */
  _resetForNewMedia(reason) {
    ssMedia.invalidate();
    ssMedia.resetChangeBaseline();
    if (typeof aiClassifier    !== 'undefined') aiClassifier.clearCache();
    if (typeof domScanner      !== 'undefined') domScanner.invalidate();
    if (typeof signalCollector !== 'undefined') signalCollector.disarm();
    if (typeof timingSkipper   !== 'undefined') timingSkipper.disarm();

    this.currentSeries   = null;
    this._metaRetryCount = 0;
    this._burstUntil     = 0;
    this._lastSkipType   = null;
    this._recentClicks.clear();
    for (const id of this._followUpTimers) clearTimeout(id);
    this._followUpTimers.clear();

    this._setupMetaObserver();
    this._scheduleMeta(400);
    this._startMetaRetry();
    this._startPeriodicScan();
    this._scheduleScan(600);
    console.info(`[SmartSkip] new media (${reason}) — re-detecting series`);
  }

  /**
   * Admin-controlled kill switches. Returns true when the extension must not run.
   * Split out of init() so a config that arrives after start-up can be applied
   * through exactly the same checks.
   */
  _applyRemoteConfigGates() {
    const cfg = this._remoteConfig;
    if (!cfg) return false;

    if (cfg.maintenance) {
      console.warn('[SmartSkip] Server maintenance mode active — scanning paused.');
      return true;
    }
    if (cfg.domain_disabled) return true;
    if (cfg.version_ok === false) {
      console.warn(
        `[SmartSkip] Version too old. Please update to v${cfg.min_ext_version || '?'} or newer.`
      );
      return true;
    }
    return false;
  }

  /** Tear down every timer, observer and listener this instance owns. */
  shutdown() {
    this.enabled = false;
    for (const t of ['_scanDebounce', '_metaDebounce', '_hudHideTimer']) {
      clearTimeout(this[t]); this[t] = null;
    }
    for (const t of ['_metaRetry', '_metaSlowRetry', '_periodicScanInterval', '_navCheck']) {
      clearInterval(this[t]); this[t] = null;
    }
    for (const o of ['_domObserver', '_metaObserver', '_titleObserver', '_videoObserver']) {
      try { this[o]?.disconnect(); } catch {}
      this[o] = null;
    }
    for (const id of this._followUpTimers) clearTimeout(id);
    this._followUpTimers.clear();
    this._recentClicks.clear();
    this._burstUntil = 0;
    try { timingSkipper.disarm(); }   catch {}
    try { signalCollector.disarm(); } catch {}
    try { this._hud?.remove(); } catch {}
    this._hud = null;
  }

  _setupDOMObserver() {
    this._domObserver = new MutationObserver((mutations) => {
      let needsScan = false;
      let needsMeta = false;

      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const tag = (node.tagName || '').toLowerCase();
            const cls = (node.className || '').toString().toLowerCase();
            const role = node.getAttribute?.('role') || '';
            const dataT = node.getAttribute?.('data-t') || '';
            const ariaLabel = (node.getAttribute?.('aria-label') || '').toLowerCase();

            // wide net — anything that might be a skip button
            if (tag === 'button' || role === 'button' || tag === 'a'
              || cls.includes('skip') || cls.includes('next') || cls.includes('intro')
              || cls.includes('recap') || cls.includes('overlay') || cls.includes('prompt')
              || cls.includes('action') || cls.includes('ctrl') || cls.includes('control')
              || dataT.includes('skip') || dataT.includes('next') || dataT.includes('prompt')
              || ariaLabel.includes('skip') || ariaLabel.includes('next')) {
              needsScan = true;
            }
            if (cls.includes('metadata') || cls.includes('title') || cls.includes('series')
              || cls.includes('episode') || tag === 'h1' || tag === 'h2' || tag === 'h3') {
              needsMeta = true;
            }
          }
        }
        // visibility change on a button (e.g. display:none → block)
        if (m.type === 'attributes' && m.target?.tagName) {
          const el = m.target;
          const tag = (el.tagName || '').toLowerCase();
          if (tag === 'button' || el.getAttribute?.('role') === 'button') {
            needsScan = true;
          }
        }
      }

      if (needsScan) this._scheduleScan(80);
      if (needsMeta) this._scheduleMeta(300);
    });

    this._domObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'aria-hidden', 'hidden'],
    });
  }

  _setupMetaObserver() {
    if (this._metaObserver) { this._metaObserver.disconnect(); this._metaObserver = null; }
    if (this._titleObserver) { this._titleObserver.disconnect(); this._titleObserver = null; }

    // <title> changes fast on SPAs
    const titleEl = document.querySelector('title');
    if (titleEl) {
      this._titleObserver = new MutationObserver(() => this._scheduleMeta(150));
      this._titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }

    // also watch known metadata containers; re-queried fresh each time
    const metaSelectors = [
      '.skin-metadata-manager-header', '.skin-metadata-manager-body', // Paramount+
      '[data-uia="video-title"]',                                      // Netflix
      '.atvwebplayersdk-title-text', '.atvwebplayersdk-subtitle-text', // Prime
      '[data-t="series-title"]', '[data-t="episode-title"]',           // Crunchyroll
      '.video-title', '.series-title', '.episode-title',
      '[data-testid="content-title"]', '[data-testid="content-subtitle"]',
      'h1', 'h2',
    ];

    const targets = metaSelectors.flatMap(s => [...document.querySelectorAll(s)]);
    if (targets.length) {
      this._metaObserver = new MutationObserver(() => this._scheduleMeta(200));
      const opts = { childList: true, subtree: true, characterData: true };
      targets.forEach(el => this._metaObserver.observe(el, opts));
    }
  }

  /** Title comes from a source better than a tab-title guess. */
  _metaTitleGood() {
    const m = this.currentSeries;
    return !!m?.title && ssMetaQuality(m.source) >= 3;
  }

  /** Title *and* episode known — nothing left for the retry ladder to find. */
  _metaSettled() {
    const m = this.currentSeries;
    return this._metaTitleGood() && !!m.episode && m.episode !== 'unknown';
  }

  /** Compare two series titles ignoring case, punctuation and spacing. */
  _normTitle(t) {
    return (t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // 1 s burst for up to 60 s, then falls back to slow background polling
  _startMetaRetry() {
    if (this._metaRetry) { clearInterval(this._metaRetry); this._metaRetry = null; }
    if (this._metaSlowRetry) { clearInterval(this._metaSlowRetry); this._metaSlowRetry = null; }
    this._metaRetryCount = 0;
    this._metaRetry = setInterval(() => {
      if (!_ssContextValid()) { clearInterval(this._metaRetry); this._metaRetry = null; return; }
      if (!this.platform.isWatchPage()) return;
      // A good title used to end the ladder on its own, which is why so many
      // series ran the whole episode with episode 'unknown': the code often
      // renders a few seconds after the show name. Keep looking for it — but
      // only briefly, since movies will never have one.
      if (this._metaSettled()
          || (this._metaTitleGood() && this._metaRetryCount > 15)) {
        clearInterval(this._metaRetry);
        this._metaRetry = null;
        if (!this._metaSettled()) this._startSlowMetaRetry();
        return;
      }
      this._metaRetryCount++;
      // after 60 s hand off to slower polling — some platforms load titles late
      if (this._metaRetryCount > 60) {
        clearInterval(this._metaRetry);
        this._metaRetry = null;
        this._startSlowMetaRetry();
        return;
      }
      this._setupMetaObserver();  // re-attach in case DOM changed
      this._updateMeta();
    }, 1000);
  }

  // every 8 s — picks up titles that load well after the initial burst
  _startSlowMetaRetry() {
    if (this._metaSlowRetry) return;
    // Capped at ~10 minutes. Each tick re-queries every h1/h2 in the document and
    // rebuilds the metadata observers; on a page whose title we will never parse
    // that ran for as long as the tab stayed open. A fresh SPA navigation restarts
    // the whole retry ladder anyway, so nothing is permanently given up.
    let ticks = 0;
    this._metaSlowRetry = setInterval(() => {
      const stop = () => { clearInterval(this._metaSlowRetry); this._metaSlowRetry = null; };
      if (!_ssContextValid()) return stop();
      // A page we still cannot name is worth the full ladder. One where only the
      // episode code is missing usually never had one (a film, a special), so
      // give it a couple of minutes rather than ten.
      if (++ticks > (this._metaTitleGood() ? 20 : 75)) return stop();
      if (this._metaSettled()) return stop();
      if (!this.platform.isWatchPage()) return;
      this._setupMetaObserver();
      this._updateMeta();
    }, 8000);
  }

  _scheduleScan(delay = 150) {
    clearTimeout(this._scanDebounce);
    this._scanDebounce = setTimeout(() => this._scan(), delay);
  }

  /**
   * Extra passes queued after a skip. They cannot go through _scheduleScan():
   * it holds exactly one pending timer, so three calls would collapse into the
   * last one — and the whole point is to look again several times while the
   * player swaps in the next segment's button.
   */
  _scheduleFollowUpScan(delay) {
    const id = setTimeout(() => {
      this._followUpTimers.delete(id);
      if (this.enabled) this._scan();
    }, delay);
    this._followUpTimers.add(id);
  }

  async _scan() {
    if (!this.enabled || this._scanPending) return;
    if (!this.platform.isWatchPage()) return;
    if (Date.now() - this._lastClickAt < this._clickCooldown) return;
    if (typeof aiClassifier === 'undefined') return;  // extension reloaded — globals gone

    // learned timing windows are advisory — we scan a bit less outside them,
    // but never skip a full scan cycle based on predictions alone
    const seriesKey = this.currentSeries ? this._seriesKey(this.currentSeries.title) : null;
    const epKey     = this.currentSeries
      ? this._episodeKey(this.currentSeries.title, this.currentSeries.episode)
      : null;
    let insidePredictedWindow = false;
    if (seriesKey) {
      const video = ssMedia.activeVideo();
      if (video && !isNaN(video.currentTime) && video.currentTime > 0) {
        const types = ['intro', 'recap', 'credits', 'ads', 'next'];
        const ctx   = { duration: video.duration };
        for (const t of types) {
          const w = (epKey && await learningStore.predictWindow(epKey, t, { ...ctx, tier: 'episode' }))
                 || await learningStore.predictWindow(seriesKey, t, { ...ctx, tier: 'series' });
          if (w && video.currentTime >= w.from && video.currentTime <= w.to) {
            insidePredictedWindow = true;
            break;
          }
        }
      }
    }

    // Scan budget. Every scan runs an AI classification pass, and the safety-net
    // interval alone asks for one every 2 s, plus whatever the DOM observer fires
    // on top. Unthrottled that is constant model load for hours of playback — and
    // the throttle used to apply only once a series had been detected, so the
    // pages that knew the least scanned the hardest.
    //
    // The flat 4 s budget was also what lost the intro after a recap: the button
    // for the following segment is on screen within a second of the jump, and
    // the next scan was still three seconds away. Right after a skip we spend
    // the budget freely — that is the one moment we know something is coming.
    const burst = Date.now() < this._burstUntil;
    const budget = burst ? 500 : (insidePredictedWindow ? 1200 : 4000);
    const sinceLast = this._lastScanAt ? Date.now() - this._lastScanAt : Infinity;
    if (sinceLast < budget) return;
    this._lastScanAt = Date.now();

    this._scanPending = true;

    // Check snooze — cached 10 s to avoid storage hammering; check AFTER setting
    // _scanPending so concurrent _scan() calls cannot both slip through
    if (!this._snoozeCacheTs || Date.now() - this._snoozeCacheTs > 10000) {
      try {
        const { ss2_snooze } = await chrome.storage.local.get('ss2_snooze');
        this._snoozeUntil   = ss2_snooze?.until ?? 0;
        this._snoozeCacheTs = Date.now();
      } catch {
        // Extension context invalidated — abort this scan cycle silently.
        this._scanPending = false;
        return;
      }
    }
    if (this._snoozeUntil > Date.now()) {
      this._scanPending = false;
      return;
    }

    try {
      const container = this.platform.getContainer();
      if (!container) return;

      const seriesSettings = this._currentSeriesSettings();

      const scanResult = (this._remoteConfig?.feature_flags?.ai_scan !== false)
        ? await domScanner.scan()
        : null; // AI scan disabled by admin feature flag

      // keep learned text patterns up to date for future cycles
      if (scanResult?.skipTextPatterns?.length) {
        this._learnedTextPatterns = [...new Set([
          ...this._learnedTextPatterns,
          ...scanResult.skipTextPatterns,
        ])];
      }

      // scanner found a title and we don't have one yet — grab it without waiting
      if (scanResult?.title && !this._metaTitleGood()) {
        this._updateMeta();
      }

      // Reveal hover-gated player controls (skip buttons hidden until mouse moves)
      // before collecting candidates. The 250 ms wait lets CSS transitions finish.
      this._nudgePlayerControls();
      await new Promise(resolve => setTimeout(resolve, 250));

      const candidates = this._collectCandidates(container);

      // Gather all clickable buttons from both sources into one list, then
      // classify them in a single AI prompt (faster + context-aware).
      const video = ssMedia.activeVideo();
      const batchContext = {
        videoTime: video && !isNaN(video.currentTime) ? video.currentTime : null,
        // Position alone says nothing without the total — "1200s in" is the end
        // of a 21-minute episode and the first third of a feature.
        duration:  video && Number.isFinite(video.duration) && video.duration > 0
                     ? video.duration : null,
        series:    this.currentSeries?.title   || null,
        episode:   this.currentSeries?.episode || null,
        // Only while the burst is live — an hour-old skip says nothing about
        // what is on screen now.
        justSkipped: burst ? this._lastSkipType : null,
      };
      const allButtons = [
        ...(scanResult?.skipButtons || []).filter(el => this._isClickable(el)),
        ...candidates.filter(el => this._isClickable(el)),
      ];
      if (!allButtons.length) {
        // Nothing was on screen, so nothing was classified and no model time was
        // spent. Charging the full budget for that turns a button that renders
        // 200 ms late into a button we look at four seconds late.
        this._lastScanAt = Date.now() - Math.max(0, budget - 800);
        return;
      }

      const batchResults = await aiClassifier.classifyBatch(allButtons, batchContext);
      for (let i = 0; i < allButtons.length; i++) {
        const result = batchResults[i];
        // Trusted domains get lower thresholds — admin has verified these pages are safe
        const trusted = this._remoteConfig?.domain_trusted === true;
        const threshold = i < (scanResult?.skipButtons?.length ?? 0)
          ? (trusted ? 0.40 : 0.50)
          : (trusted ? 0.45 : 0.55);
        if (!result || result.type === 'none' || result.confidence < threshold) continue;
        if (!this._typeAllowed(result.type, seriesSettings)) continue;
        if (!this._positionAllows(result.type, video)) continue;
        if (this._recentlyClicked(allButtons[i], result.type, video)) continue;
        this._click(allButtons[i], result);
        return;
      }
    } finally {
      this._scanPending = false;
    }
  }

  /**
   * Have we already acted on this exact button for this exact segment?
   *
   * The old guard was a global 1.2 s cooldown, which is both too weak (a button
   * that survives the click gets pressed again) and too strong (it blocks every
   * other button on the page). Players routinely keep one overlay node and
   * relabel it, so identity alone cannot decide: a second click is legitimate
   * when the segment type changed, or when the playhead has clearly moved on to
   * a new part of the episode.
   */
  _recentlyClicked(el, type, video) {
    const prev = this._recentClicks.get(el);
    if (!prev) return false;
    if (Date.now() - prev.ts > 8000) { this._recentClicks.delete(el); return false; }
    if (prev.type !== type) return false;               // relabelled — new segment
    const t = video && Number.isFinite(video.currentTime) ? video.currentTime : null;
    if (t !== null && prev.videoTime !== null && Math.abs(t - prev.videoTime) > 4) {
      return false;                                     // the skip landed us elsewhere
    }
    return true;
  }

  _collectCandidates(container) {
    const seen = new Set();
    const learnedHits    = [];
    const textHits       = [];
    const selectorHits   = [];

    // learned patterns from previous visits go first — highest confidence
    if (this._learnedTextPatterns.length) {
      const patterns = this._learnedTextPatterns.map(p => p.toLowerCase().trim());
      for (const el of document.querySelectorAll('button, [role="button"], [data-t], a')) {
        if (!this._isClickable(el)) continue;
        const txt = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().toLowerCase();
        if (patterns.some(p => txt === p || txt.includes(p))) {
          if (!seen.has(el)) { seen.add(el); learnedHits.push(el); }
        }
      }
    }

    // multilingual keyword scan — includes autoplay-countdown patterns
    // ("Continue watching", "Weiter", "Next Episode in 5", etc.)
    const SKIP_WORDS = /skip|überspringen|\bweiter\b|continue\s*(?:watching|playing)?|keep\s+watching|jetzt\s*(?:ansehen|weitersehen)|intro\s*(?:skip)?|(?:next|nächste)\s*(?:episode|folge)|next\s*ep\b|recap|credits|abspann|vorspann|wiederholung|zusammenfassung|pular|saltar|ignorer|hoppa/i;
    for (const el of document.querySelectorAll('button, [role="button"], [data-t], [aria-label]')) {
      if (!this._isClickable(el)) continue;
      const label = (el.getAttribute('aria-label') || '').trim();
      const text  = (el.textContent || '').trim();
      if (SKIP_WORDS.test(label) || SKIP_WORDS.test(text)) {
        if (!seen.has(el)) { seen.add(el); textHits.push(el); }
      }
    }

    // class-name guesses inside the player as a last resort
    for (const el of container.querySelectorAll(
      'button, [role="button"], [tabindex="0"][class*="skip"], [tabindex="0"][class*="next"], [class*="skip"], [class*="Skip"]'
    )) {
      if (!this._isClickable(el)) continue;
      if (!seen.has(el)) { seen.add(el); selectorHits.push(el); }
    }

    return [...learnedHits, ...textHits, ...selectorHits];
  }

  _scheduleMeta(delay = 250) {
    clearTimeout(this._metaDebounce);
    this._metaDebounce = setTimeout(() => this._updateMeta(), delay);
  }

  async _updateMeta() {
    if (!this.platform.isWatchPage()) return;

    // 1. platform adapter
    let meta = this.platform.extractMeta();

    // 1b. Structured page metadata (og:video:series, JSON-LD partOfSeries).
    // Independent of DOM structure, so it still answers while the player is
    // re-rendering and every adapter selector momentarily matches nothing.
    if (!meta?.title) {
      try {
        const s = this.platform.metaSeriesTitle?.();
        if (s && !this._isJunkTitle(s) && !this.platform._looksLikeEpisodeName?.(s)) {
          meta = { title: s.trim(), episode: meta?.episode || 'unknown', source: 'structured' };
        }
      } catch (_) {}
    }

    // 2. AI DOM scanner (result is cached, no re-prompt unless invalidated)
    if (!meta?.title || ssMetaQuality(meta.source) < 3) {
      try {
        const scanResult = await domScanner.scan();
        if (scanResult?.title) {
          // Strip embedded episode fragment from scanner title, e.g.
          // "Hell's Paradise Tagesanbruch und Stupor" → sanitize via _parseTitle
          const cleaned = this._parseTitle(scanResult.title);
          const titleToUse = cleaned?.title || scanResult.title;
          const looksLikeEpisode = /^(?:E|EP|Episode|Folge|Chapter)\s*\d+\b/i.test(titleToUse);
          if (!looksLikeEpisode && !this._isJunkTitle(titleToUse)) {
            meta = {
              title:   titleToUse,
              episode: cleaned?.episode !== 'unknown' ? cleaned?.episode
                       : scanResult.episode || meta?.episode || 'unknown',
              source:  'ai-scanner',
            };
          }
        }
      } catch (_) {}
    }

    // 3. document.title parse — try AI first, regex fallback
    if (!meta || !meta.title) {
      const raw = document.title?.trim();
      if (raw && raw.length > 1) {
        const aiParsed = await domScanner.parseTitle(raw);
        // Reject if the AI returned the platform name as the series title
        if (aiParsed && this._isJunkTitle(aiParsed.title)) {
          meta = this._parseTitle(raw);
        } else {
          meta = aiParsed || this._parseTitle(raw);
        }
      }
    }

    // 4. raw title — keeps the popup from showing blank, retry loop upgrades it later
    if (!meta || !meta.title) {
      const raw = document.title?.trim();
      if (raw && raw.length > 2) {
        // strip platform suffix but keep the rest as-is
        const stripped = raw
          .replace(/\s*[|\-\u2013\u2014]\s*(Netflix|Prime Video|Amazon|Disney\+?|Crunchyroll|Hulu|Max|HBO|Paramount\+?|Apple TV\+?|Viki).*$/i, '')
          .replace(/^(?:Watch|Schaue?\s+dir)\s+/i, '')
          .replace(/\s+an\s*$/i, '')
          .trim();
        if (stripped.length > 2 && !this._isJunkTitle(stripped)) {
          meta = { title: stripped, episode: 'unknown', source: 'title-raw' };
        }
      }
    }

    if (!meta || !meta.title) return;

    // 5. Episode code from structured data. Platforms that never print S/E on
    // screen still ship it in JSON-LD, and without a code every observation is
    // filed against the series bucket alone.
    if (!meta.episode || meta.episode === 'unknown') {
      try {
        const code = this.platform.metaEpisodeCode?.();
        if (code) meta = { ...meta, episode: code };
      } catch (_) {}
    }

    const prev = this.currentSeries;
    if (prev) {
      // Never downgrade. _updateMeta runs on every DOM mutation near the title,
      // and a player mid-re-render makes every adapter selector miss — the pass
      // then falls all the way through to document.title and used to overwrite
      // a confirmed series name with a stripped tab title. Re-detection after a
      // real episode change goes through _resetForNewMedia(), which clears
      // currentSeries first, so nothing here blocks it.
      if (ssMetaQuality(meta.source) < ssMetaQuality(prev.source)) {
        const sameShow = this._normTitle(prev.title) === this._normTitle(meta.title);
        const addsEpisode = sameShow
          && (!prev.episode || prev.episode === 'unknown')
          && meta.episode && meta.episode !== 'unknown';
        if (!addsEpisode) return;
        meta = { ...prev, episode: meta.episode };
      }
    }

    const prevTitle   = prev?.title;
    const prevEpisode = prev?.episode;

    this.currentSeries = meta;

    const key = this._seriesKey(meta.title);
    if (!this.settings.series[key]) {
      this.settings.series[key] = this._defaultSeriesSettings();
      this._saveSettings();
    }
    const epKey = this._episodeKey(meta.title, meta.episode);
    if (epKey && !this.settings.episodes?.[epKey]) {
      if (!this.settings.episodes) this.settings.episodes = {};
      this.settings.episodes[epKey] = {};  // empty = inherit from series
      this._saveSettings();
    }

    // Notify background
    if (meta.title !== prevTitle || meta.episode !== prevEpisode) {
      this._sendMessage({
        action: 'seriesDetected',
        series: meta,
        domain: location.hostname,
      });
      this._updateHUD();

      // Cloud-sync: fetch learned selectors and timing windows from server
      // Gated by the feature_cloud_sync admin flag.
      if (this._remoteConfig?.feature_flags?.cloud_sync !== false) {
        syncService.fetchSelectors(location.hostname);
        if (ssMetaQuality(meta.source) >= 3) {
          syncService.fetchTimings(this._seriesKey(meta.title));
          const epTimingKey = this._episodeKey(meta.title, meta.episode);
          if (epTimingKey) syncService.fetchTimings(epTimingKey);
        }
      }

      // arm timing-skipper whenever we have a confirmed series identity
      // Gated by the feature_timing admin flag.
      const tSeriesKey = this._seriesKey(meta.title);
      const tEpKey     = this._episodeKey(meta.title, meta.episode);
      if (this._remoteConfig?.feature_flags?.timing !== false) timingSkipper.arm({
        seriesKey: tSeriesKey,
        epKey:     tEpKey,
        settings:  this._currentSeriesSettings(),
        onNearEnd: () => {
          // Prefetch timing data for the next episode so auto-skip is instant
          // when autoplay starts without waiting for the 30-s refresh cycle.
          const nextKey = this._nextEpisodeKey(tEpKey);
          if (nextKey) {
            syncService.fetchTimings(nextKey).catch(() => {});
            console.info(`[SmartSkip] prefetching next episode: ${nextKey}`);
          }
          syncService.fetchTimings(tSeriesKey).catch(() => {});
        },
        onSkip: (win) => {
          win._undoTime = ssMedia.activeVideo()?.currentTime - 1;
          this._flashHUDTiming(win);
          this._sendMessage({
            action:     'buttonClicked',
            buttonType: win.type,
            confidence: win.confidence,
            aiSource:   `timing:${win.sources?.join(',')}`,
            series:     this.currentSeries,
            domain:     location.hostname,
          });
          // Feed the timing back into LearningStore only when the skip was
          // driven by live evidence from this episode. Recording a jump that a
          // series prior triggered would let that prior cite itself as proof and
          // grow stronger with every episode it got wrong.
          const vid = ssMedia.activeVideo();
          const t   = vid && win.local ? win.from + (win.to - win.from) / 2 : null;
          if (t !== null) {
            if (tEpKey)     learningStore.recordTiming(tEpKey,     win.type, t);
            if (tSeriesKey) learningStore.recordTiming(tSeriesKey, win.type, t);
            if (tEpKey)     syncService.recordTiming(tEpKey,     win.type, t);
            if (tSeriesKey) syncService.recordTiming(tSeriesKey, win.type, t);
          }
        },
        onHint: (win) => {
          this._showHUDHint(win);
        },
      });

      // arm signal-collector: discovers {from, to} windows from XHR/DOM/button lifecycle
      signalCollector.arm(tSeriesKey, tEpKey);
    }
  }

  // Tries to extract a series title and episode code.
  // Returns null when the whole title string looks like an episode name
  // (e.g. "E79 - ..." on Crunchyroll) so the retry loop keeps trying.
  _parseTitle(raw) {
    const episodeShape = /^(?:E|EP|Episode|Folge|Chapter)\s*\d+\b/i;

    // DE: "Schaue dir X Staffel N Folge M: Titel an …"
    let m = raw.match(
      /^Schaue?\s+dir\s+(.+?)\s+Staffel\s+(\d+)\s+Folge\s+(\d+)(?::\s*.+?)?\s+an\b/i
    );
    if (m) {
      return {
        title:   m[1].trim(),
        episode: `S${m[2].padStart(2,'0')}E${m[3].padStart(2,'0')}`,
        source:  'title-fallback',
      };
    }

    // EN: "Watch X Season N Episode M: Title on …"
    m = raw.match(
      /^Watch\s+(.+?)\s+Season\s+(\d+)\s+Episode\s+(\d+)(?::\s*.+?)?\s+on\b/i
    );
    if (m) {
      return {
        title:   m[1].trim(),
        episode: `S${m[2].padStart(2,'0')}E${m[3].padStart(2,'0')}`,
        source:  'title-fallback',
      };
    }

    // Generic SxxExx pattern: "Serie - S02E04 - Folgentitel | Plattform"
    m = raw.match(/^(.+?)\s*[-–—]\s*S(\d{1,2})E(\d{1,2})/i);
    if (m) {
      return {
        title:   m[1].trim(),
        episode: `S${m[2].padStart(2,'0')}E${m[3].padStart(2,'0')}`,
        source:  'title-fallback',
      };
    }

    // Crunchyroll / generic: "Series Title - E14 - Episode Name | Platform"
    // Also matches: "Series Title - E14: Episode Name", "Series Title E14 - Episode Name"
    m = raw.match(/^(.+?)\s*[-–—\s]\s*E(\d{1,3})\s*(?:[-–—:].+)?$/i);
    if (m && !episodeShape.test(m[1].trim())) {
      return {
        title:   m[1].trim(),
        episode: `E${m[2].padStart(2, '0')}`,
        source:  'title-fallback',
      };
    }

    // Strip platform suffix
    const cleaned = raw
      .replace(/\s*[|\-–—]\s*(Netflix|Prime Video|Amazon|Disney\+?|Crunchyroll|Hulu|Max|HBO|Paramount\+?|Apple TV\+?|Viki|Twitch|Vimeo|Dailymotion).*$/i, '')
      .replace(/^Schaue?\s+dir\s+/i, '')
      .replace(/^Watch\s+/i, '')
      .replace(/\s+an\s*$/i, '')
      .trim();

    if (episodeShape.test(cleaned) || /^E\d+\s*[-–—:]/i.test(cleaned)) {
      return null;
    }

    if (cleaned.length > 1 && !this._isJunkTitle(cleaned)) {
      return { title: cleaned, episode: 'unknown', source: 'title-fallback' };
    }
    return null;
  }

  // Filter out player names, loading states and other non-series strings.
  _isJunkTitle(str) {
    if (!str) return true;
    const s = str.trim().toLowerCase();
    const JUNK = new Set([
      // Generic non-titles
      'vilos',          // Crunchyroll video player
      'player',
      'video player',
      'loading',
      'loading…',
      'please wait',
      'home',
      'index',
      'untitled',
      'new tab',
      'watch',
      'stream',
      'livestream',
      'live',
      'video',
      'media',
      'error',
      'not found',
      '404',
      // Platform / brand names — never valid series titles
      'netflix',
      'disney+',
      'disney plus',
      'prime video',
      'amazon prime',
      'amazon',
      'crunchyroll',
      'hulu',
      'max',
      'hbo max',
      'hbo',
      'paramount+',
      'paramount plus',
      'apple tv+',
      'apple tv',
      'viki',
      'peacock',
      'peacocktv',
      'funimation',
      'joyn',
      'sky',
      'wow',
      'rtl+',
      'rtl plus',
      'prosieben',
      'zdf',
      'zdfmediathek',
      'ard',
      'ardmediathek',
      'vimeo',
      'dailymotion',
    ]);
    if (JUNK.has(s)) return true;

    // Shapes rather than names. Kept deliberately narrow: a pattern like
    // /^max\b/ would reject "Max Payne", so brand names stay in the exact-match
    // set above and only self-evidently non-series strings are matched here.
    return /^(?:video|media)\s*player$|^untitled\b|^\d+$|^watch\s+(?:tv\s+shows?|movies)\b|watch\s+tv\s+shows\s+online/i.test(s);
  }

  //  Click

  _click(el, result) {
    this._lastClickAt = Date.now();

    const selector  = this._selectorOf(el);
    const video     = ssMedia.activeVideo();
    const videoTime = video ? video.currentTime : null;

    // Read the segment start BEFORE clicking: the click makes the button vanish
    // or get relabelled, and SignalCollector retires the registry entry that
    // holds its appear time.
    const buttonFrom = signalCollector.getButtonAppearTime(el);

    // Keyed by element, so stale entries pin removed DOM nodes in memory for as
    // long as the tab lives. Prune on the way in.
    for (const [node, rec] of this._recentClicks) {
      if (Date.now() - rec.ts > 30_000 || !node.isConnected) this._recentClicks.delete(node);
    }
    this._recentClicks.set(el, { ts: Date.now(), type: result.type, videoTime });

    try { el.click(); } catch (_) {}

    // A recap ends where the intro begins. Scan hard for the next ~25 s, and
    // throw away every verdict that was only true because of where we were in
    // the episode — the overlay that said "Skip Recap" a moment ago is the same
    // node that says "Skip Intro" now.
    this._lastSkipType = result.type;
    this._burstUntil   = Date.now() + 25_000;
    try { aiClassifier.evictAmbiguous(); } catch (_) {}
    for (const delay of [900, 1600, 2600]) this._scheduleFollowUpScan(delay);
    setTimeout(() => { try { signalCollector.refreshButtons(); } catch (_) {} }, 600);

    // buttonFrom (captured above) is when the button appeared — i.e. when the
    // segment began, not when we clicked.
    const timingFrom = buttonFrom ?? videoTime;
    const seriesKey = this.currentSeries ? this._seriesKey(this.currentSeries.title) : null;
    // Episode key is more specific — record timing at both levels so predictions
    // benefit from episode-accurate data while also populating the series fallback.
    const epTimingKey = this.currentSeries
      ? this._episodeKey(this.currentSeries.title, this.currentSeries.episode)
      : null;

    // ─ Enriched training data captured at click time ──────────────────────────────
    // Normalized position: consistent across any episode length — lets the
    // server build expected-fraction ranges per segment type per platform.
    const videoDuration   = (video?.duration > 0 && isFinite(video.duration)) ? Math.round(video.duration) : null;
    const episodeFraction = (timingFrom !== null && videoDuration) ? Math.round(timingFrom / videoDuration * 1000) / 1000 : null;
    // Current subtitle text — what was the user reading when the button appeared.
    // Gold-standard for AI subtitle scan: the sentences just before/during an
    // intro tell Gemini Nano what "intro" looks like in this language/platform.
    const subtitleSample  = signalCollector.getButtonSubtitleSample(el) ?? this._getCurrentSubtitleText(video);
    // Button HTML fingerprint — sent separately to build a cross-platform
    // button pattern library that improves DOMScanner prompts over time.
    const buttonSignature = this._getButtonSignature(el);

    // Lokaler Feedback-Loop
    learningStore.recordClick({
      domain:     location.hostname,
      buttonType: result.type,
      selector,
      source:     result.source,
      success:    true,
    });

    // Video-Time lokal aufzeichnen
    // Use button-appear time (more accurate) if available, otherwise click time.
    if (timingFrom !== null) {
      if (epTimingKey) learningStore.recordTiming(epTimingKey, result.type, timingFrom);
      if (seriesKey)   learningStore.recordTiming(seriesKey,   result.type, timingFrom);
    }

    // Cloud-Sync (fire-and-forget)
    syncService.recordEvent({
      domain:          location.hostname,
      buttonType:      result.type,
      confidence:      result.confidence,
      aiSource:        result.source,
      videoTime,
      seriesTitle:     this.currentSeries?.title   ?? null,
      episodeInfo:     this.currentSeries?.episode ?? null,
      // enriched fields
      videoDuration,
      episodeFraction,
      subtitleSample,
      buttonText:      buttonSignature.text  ?? null,
      buttonAttrs:     buttonSignature.attrs ?? null,
    });
    // Send button fingerprint for cross-platform pattern learning (separate action
    // so the server can aggregate selectors independently of skip events).
    if (buttonSignature.text || Object.keys(buttonSignature.attrs ?? {}).length) {
      syncService.recordButtonSignature(location.hostname, result.type, buttonSignature);
    }
    if (videoTime !== null) {
      if (epTimingKey) syncService.recordTiming(epTimingKey, result.type, timingFrom ?? videoTime);
      if (seriesKey)   syncService.recordTiming(seriesKey,   result.type, timingFrom ?? videoTime);
    }

    this._sendMessage({
      action: 'buttonClicked',
      buttonType: result.type,
      confidence: result.confidence,
      aiSource: result.source,
      series: this.currentSeries,
      domain: location.hostname,
    });
    this._flashHUD(result.type, result);
    console.info(`[SmartSkip v2] ✅ ${result.type} (${result.source}, ${(result.confidence*100).toFixed(0)}%) @ ${videoTime?.toFixed(1)}s`);

    // let timing-skipper know so it can refresh its windows immediately
    timingSkipper.onButtonClick();

    // Post-click verification (2 s)
    // Detect whether the skip actually worked before recording feedback.
    // Criteria: button disappeared from DOM  OR  video time jumped >4 s.
    const _domain      = location.hostname;
    const _elRef       = new WeakRef(el);
    const _selCopy     = selector;
    const _type        = result.type;
    const _src         = result.source;
    const _t0          = videoTime;
    const _timingFrom  = timingFrom;    // best available segment start
    const _duration    = video?.duration ?? null;  // capture before possible navigation
    setTimeout(() => {
      const btn         = _elRef.deref();
      const vid         = ssMedia.activeVideo();
      const tNow        = vid ? vid.currentTime : null;
      const btnGone     = !btn || !document.contains(btn)
                          || getComputedStyle(btn).display === 'none'
                          || parseFloat(getComputedStyle(btn).opacity) < 0.05;
      // Credits/next-episode skips often navigate away — video element leaves DOM
      const videoGone   = _t0 !== null && !document.querySelector('video');
      const videoJumped = _t0 !== null && tNow !== null && (tNow - _t0) > 4;
      const success     = btnGone || videoJumped || videoGone;

      syncService.recordFeedback({ domain: _domain, buttonType: _type, selector: _selCopy, success, sources: _src });

      if (!success) {
        learningStore.removeSkipSelector(_domain, _selCopy);
        console.warn(`[SmartSkip v2] ❌ ${_type} failed verification — removing selector: ${_selCopy}`);
      } else {
        console.info(`[SmartSkip v2] ✔ ${_type} verified OK (btn=${btnGone}, jump=${videoJumped})`);

        // ── ground-truth window recording ───────────────────────────────────────────
        // Every confirmed skip carries the most precise {from, to} we can get:
        //   from = when the button appeared   = actual segment start
        //   to   = where the video landed     = actual segment end
        // This is the training signal that lets TimingSkipper auto-skip the
        // next episode of this series WITHOUT needing a visible button.
        if (videoJumped && _timingFrom !== null && tNow > _timingFrom && tNow - _timingFrom <= 900) {
          // Video jumped to post-skip position — tNow is the segment end.
          signalCollector.recordButtonWindow(_type, _timingFrom, tNow, 'button-click');
        } else if (videoGone && _timingFrom !== null && _duration !== null) {
          // Video navigated away (credits / next episode).
          // Best estimate: segment runs from button-appear to end-of-episode.
          const creditTo = Math.min(_duration - 2, _timingFrom + 600);
          if (creditTo > _timingFrom + 5) {
            signalCollector.recordButtonWindow(_type, _timingFrom, creditTo, 'button-click-nav');
          }
        }
      }
    }, 2000);
  }

  // build a stable CSS selector from an element for storage
  _selectorOf(el) {
    if (!el) return '';
    // data-* attributes survive React re-renders; prefer them over class names
    if (el.id) return `#${CSS.escape(el.id)}`;

    const dataT = el.getAttribute('data-t');
    if (dataT) return `[data-t="${dataT}"]`;

    const testid = el.getAttribute('data-testid');
    if (testid) return `[data-testid="${testid}"]`;

    const uia = el.getAttribute('data-uia');
    if (uia) return `[data-uia="${uia}"]`;

    const qa = el.getAttribute('data-qa');
    if (qa) return `[data-qa="${qa}"]`;

    const automation = el.getAttribute('data-automation-id');
    if (automation) return `[data-automation-id="${automation}"]`;

    // aria-label is stable as long as the site doesn't localise it per-page
    const aria = el.getAttribute('aria-label');
    if (aria) return `[aria-label="${aria.replace(/"/g, '\\"')}"]`;

    // Class names last — least stable but better than just tagName
    if (el.className) {
      const classes = [...el.classList].slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
      if (classes) return `${el.tagName.toLowerCase()}${classes}`;
    }
    return el.tagName.toLowerCase();
  }

  //  Helpers for enriched training data capture

  /**
   * Returns active subtitle/caption text at the current video position.
   * Falls back to the cue closest in time if no cue is active right now.
   */
  _getCurrentSubtitleText(video) {
    if (!video) return null;
    try {
      const t = video.currentTime;
      for (const track of video.textTracks) {
        if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
        if (track.mode === 'disabled') continue;
        const cues = track.cues ? [...track.cues] : [];
        const active = cues.filter(c => c.startTime <= t && c.endTime >= t);
        if (active.length) {
          return active.map(c => (c.text || '').replace(/<[^>]+>/g, '').trim()).join(' ').slice(0, 200) || null;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Returns a compact, serialisable fingerprint of a skip button element.
   * Captures the data needed to identify this button type on future visits
   * and to improve DOMScanner prompts via server-side aggregation.
   */
  _getButtonSignature(el) {
    if (!el) return { tag: '', text: '', classes: '', attrs: {} };
    const DATA_ATTRS = ['data-t', 'data-testid', 'data-uia', 'data-qa',
                        'data-automation-id', 'aria-label', 'type', 'role'];
    const attrs = {};
    for (const a of DATA_ATTRS) {
      const v = el.getAttribute(a);
      if (v) attrs[a] = v.slice(0, 100);
    }
    return {
      tag:     el.tagName.toLowerCase(),
      text:    (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      classes: [...(el.classList || [])].slice(0, 5).join(' '),
      attrs,
    };
  }

  //  Settings

  _defaultSettings()       { return ss2Defaults(); }

  _defaultSeriesSettings() { return ss2SeriesDefaults(); }

  _seriesKey(title) {
    return `${location.hostname}:${title}`;
  }

  _episodeKey(title, episode) {
    if (!episode || episode === 'unknown') return null;
    return `${location.hostname}:${title}:${episode}`;
  }

  // Infer the key for the next episode to prefetch timing data before autoplay.
  // Supports SxxExx and bare Eyyy formats. Returns null for unparseable keys.
  _nextEpisodeKey(epKey) {
    if (!epKey) return null;
    const m = epKey.match(/^(.+S\d{1,2}E)(\d{1,3})$/);
    if (m) {
      const next = String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
      return `${m[1]}${next}`;
    }
    const m2 = epKey.match(/^(.+E)(\d{2,3})$/);
    if (m2) {
      const next = String(parseInt(m2[2], 10) + 1).padStart(m2[2].length, '0');
      return `${m2[1]}${next}`;
    }
    return null;
  }

  _currentSeriesSettings() {
    // Priority: episode-specific override → series default → global defaults
    const epKey  = this.currentSeries
      ? this._episodeKey(this.currentSeries.title, this.currentSeries.episode)
      : null;
    const serKey = this.currentSeries
      ? this._seriesKey(this.currentSeries.title)
      : null;

    const epSettings  = epKey  ? this.settings.episodes?.[epKey]  : null;
    const serSettings = serKey ? this.settings.series?.[serKey]   : null;
    const base = serSettings || this._defaultSeriesSettings();

    // Episode override: only apply fields that were explicitly set
    return epSettings ? { ...base, ...epSettings } : base;
  }

  /**
   * Settings say *whether* an action is wanted, never *when*. Prime keeps its
   * next-episode button mounted all episode, so without this it fired the moment
   * it was classified.
   *
   * Only next/credits are gated. Intro, recap and ads buttons appear only while
   * their segment runs, so their presence is the evidence.
   */
  _positionAllows(type, video) {
    if (type !== 'next' && type !== 'credits') return true;

    const dur = video?.duration;
    const t   = video?.currentTime;
    if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(t)) {
      // Unknown length (live stream, manifest not parsed yet). Skipping credits
      // is harmless; jumping to a next episode we cannot locate the end of is not.
      return type !== 'next';
    }

    if (type === 'next') {
      if (video.ended) return true;
      return (dur - t) <= Math.max(90, dur * 0.08);
    }
    // credits
    return t >= dur * 0.6;
  }

  _typeAllowed(type, s) {
    switch (type) {
      case 'intro':   return s.skipIntro;
      case 'recap':   return s.skipRecap;
      case 'credits': return s.skipCredits;
      case 'ads':     return s.skipAds;
      case 'next':    return s.autoNext;
      default:        return false;
    }
  }

  async _loadSettings() {
    const data = await this._sendMessageAsync({ action: 'getSettings' });
    if (data?.settings) {
      this.settings = { ...this._defaultSettings(), ...data.settings };
      this.enabled  = this.settings.globalEnabled;

      const domainKey   = location.hostname;
      const domainCfg   = this.settings.domains?.[domainKey];
      if (domainCfg?.enabled === false) this.enabled = false;
    } else {
      // No local settings — try cloud restore (consent-gated inside SyncService)
      try {
        const cloud = await syncService.loadSettings();
        if (cloud) {
          this.settings = { ...this._defaultSettings(), ...cloud };
          this.enabled  = this.settings.globalEnabled;
          await this._sendMessageAsync({ action: 'saveSettings', settings: this.settings });
        }
      } catch (_) {}
    }
  }

  async _saveSettings() {
    try {
      await this._sendMessageAsync({ action: 'saveSettings', settings: this.settings });
      // Mirror to cloud (fire-and-forget, consent-gated inside SyncService)
      syncService.saveSettings(this.settings);
    } catch (_) {}
  }

  //  HUD

  _ensureHUD() {
    if (this._hud || !this.settings.hudEnabled) return;

    const hud = document.createElement('div');
    hud.id = 'smart-skip-hud-v2';
    hud.innerHTML = `
      <span class="ss-icon">⏭</span>
      <span class="ss-label">Smart Skip</span>
      <span class="ss-badge ss-badge--off">—</span>`;

    const style = document.createElement('style');
    style.textContent = `
      #smart-skip-hud-v2 {
        position: fixed;
        bottom: 72px;
        right: 20px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        background: rgba(13,13,13,0.82);
        border: 1px solid rgba(255,255,255,0.15);
        border-radius: 20px;
        color: #fff;
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        pointer-events: none;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity .25s, transform .25s;
        backdrop-filter: blur(8px);
      }
      #smart-skip-hud-v2.ss-visible {
        opacity: 1;
        transform: translateY(0);
      }
      .ss-badge {
        padding: 2px 7px;
        border-radius: 10px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .5px;
      }
      .ss-badge--ai   { background: #7c3aed; }
      .ss-badge--rule { background: #0284c7; }
      .ss-badge--off  { background: rgba(255,255,255,.15); color: #aaa; }
      .ss-badge--skip { background: #16a34a; animation: ss-pop .3s ease; }
      .ss-undo {
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .5px;
        background: rgba(255,255,255,.18);
        border: 1px solid rgba(255,255,255,.35);
        color: #fff;
        cursor: pointer;
        transition: background .15s;
      }
      .ss-undo:hover { background: rgba(255,255,255,.32); }
      #smart-skip-hud-v2.ss-interactive { pointer-events: auto; }
      @keyframes ss-pop {
        0%  { transform: scale(1); }
        50% { transform: scale(1.25); }
        100%{ transform: scale(1); }
      }`;
    document.head.appendChild(style);
    document.documentElement.appendChild(hud);
    this._hud = hud;
  }

  _updateHUD() {
    this._ensureHUD();
    if (!this._hud) return;

    const label = this._hud.querySelector('.ss-label');
    if (label && this.currentSeries?.title) {
      label.textContent = this.currentSeries.title;
    }
    this._showHUD(1800);
  }

  _updateHUDStatus(aiStatus) {
    this._ensureHUD();
    if (!this._hud) return;
    const badge = this._hud.querySelector('.ss-badge');
    if (!badge) return;
    if (aiStatus === 'readily') {
      badge.className = 'ss-badge ss-badge--ai';
      badge.textContent = i18n.t('aiReady');
    } else {
      badge.className = 'ss-badge ss-badge--rule';
      badge.textContent = i18n.t('aiRule');
    }
  }

  _flashHUD(type, result) {
    this._ensureHUD();
    if (!this._hud) return;
    const badge = this._hud.querySelector('.ss-badge');
    if (!badge) return;

    const icons = { intro: '⏭', recap: '⏭', credits: '⏭', ads: '⏭', next: '▶' };
    const names = {
      intro:   i18n.t('hudIntro'),
      recap:   i18n.t('hudRecap'),
      credits: i18n.t('hudCredits'),
      ads:     i18n.t('hudAds'),
      next:    i18n.t('hudNext'),
    };

    const icon       = icons[type]  || '⏭';
    const label      = names[type]  || type;
    const pct        = result ? Math.round((result.confidence ?? 0) * 100) : null;
    const src        = result?.source === 'ai' ? i18n.t('hudSourceAI') : i18n.t('hudSourceRule');
    const confidence = pct !== null ? ` ${pct}% (${src})` : '';

    badge.className   = 'ss-badge ss-badge--skip';
    badge.textContent = `${icon} ${label}${confidence}`;
    this._showHUD(2600);
    setTimeout(() => this._updateHUDStatus(''), 3000);
  }

  // shown after a timing-based auto-skip — includes a 5 s undo button
  _flashHUDTiming(win) {
    this._ensureHUD();
    if (!this._hud) return;

    const label = this._hud.querySelector('.ss-label');
    if (label) label.textContent = win.type;

    // swap badge for undo button
    this._hud.querySelector('.ss-badge, .ss-undo')?.remove();
    const undo = document.createElement('button');
    undo.className = 'ss-undo';
    undo.textContent = i18n.t('undo') || 'Undo';
    undo.addEventListener('click', () => {
      // Routed through TimingSkipper so the rewind is validated against where
      // the playhead actually is now — the button lives for 5 s and the user may
      // have seeked away — and so our own seek is not mistaken for user intent.
      // Undo is also the clearest possible "that was not an intro", so it
      // penalises the window and stops it firing on the following episodes.
      try { timingSkipper.undoSkip(win); } catch {}
      undo.remove();
      this._hud.classList.remove('ss-interactive');
      const b = document.createElement('span');
      b.className = 'ss-badge ss-badge--off';
      b.textContent = '—';
      this._hud.appendChild(b);
      clearTimeout(this._hudHideTimer);
      this._hudHideTimer = setTimeout(() => this._hud?.classList.remove('ss-visible'), 1500);
    });
    this._hud.appendChild(undo);
    this._hud.classList.add('ss-visible', 'ss-interactive');

    clearTimeout(this._hudHideTimer);
    this._hudHideTimer = setTimeout(() => {
      if (!this._hud) return;
      this._hud.classList.remove('ss-visible', 'ss-interactive');
      this._hud.querySelector('.ss-undo')?.remove();
      const b = document.createElement('span');
      b.className = 'ss-badge ss-badge--off';
      b.textContent = '—';
      this._hud.appendChild(b);
    }, 5000);
  }

  // shown when timing confidence is 0.50–0.64 — offers a one-time manual skip
  _showHUDHint(win) {
    this._ensureHUD();
    if (!this._hud) return;

    const label = this._hud.querySelector('.ss-label');
    if (label) label.textContent = `${win.type}?`;

    this._hud.querySelector('.ss-badge, .ss-undo')?.remove();
    const btn = document.createElement('button');
    btn.className = 'ss-undo';
    btn.style.background = 'rgba(180,83,9,.7)';
    btn.textContent = i18n.t('skip') || 'Skip';
    btn.addEventListener('click', () => {
      // The hint is on screen for 9 s. Let TimingSkipper decide whether the
      // window is still ahead of the playhead — otherwise the "skip" would
      // rewind the user to where the segment used to be.
      let done = false;
      try { done = timingSkipper.confirmSkip(win); } catch {}
      btn.remove();
      this._hud.classList.remove('ss-interactive');
      const b = document.createElement('span');
      b.className = done ? 'ss-badge ss-badge--skip' : 'ss-badge ss-badge--off';
      b.textContent = done ? 'skipped' : '—';
      this._hud.appendChild(b);
      clearTimeout(this._hudHideTimer);
      this._hudHideTimer = setTimeout(() => this._hud?.classList.remove('ss-visible'), 2500);
    });
    this._hud.appendChild(btn);
    this._hud.classList.add('ss-interactive');
    this._showHUD(9000);
  }

  _showHUD(hideAfter = 2000) {
    if (!this._hud) return;
    this._hud.classList.add('ss-visible');
    clearTimeout(this._hudHideTimer);
    this._hudHideTimer = setTimeout(() => {
      if (this._hud) this._hud.classList.remove('ss-visible', 'ss-interactive');
    }, hideAfter);
  }

  //  Utility helpers

  /**
   * Fires synthetic mouse events over the video element (and its parent wrapper)
   * to un-hide player controls that are only visible on hover. Many streaming
   * platforms fade their overlay buttons to opacity 0 or display:none while the
   * mouse is idle — this nudge triggers the same CSS hover states a real mouse
   * move would produce, so the skip button is visible when we scan for it.
   */
  _nudgePlayerControls() {
    const video = ssMedia.activeVideo();
    if (!video) return;
    const r = video.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const cx = r.left + r.width  / 2;
    const cy = r.top  + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    // Target both the video element and its direct parent — many players attach
    // hover listeners to a wrapper div rather than the <video> element itself.
    for (const target of [video.parentElement, video]) {
      if (!target) continue;
      target.dispatchEvent(new MouseEvent('mouseenter', opts));
      target.dispatchEvent(new MouseEvent('mousemove',  opts));
    }
  }

  _isClickable(el) {
    if (!el || el.disabled) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') < 0.1) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom < 0 || r.top > window.innerHeight) return false;

    // Must be an interactive element — reject layout containers like divs/sections
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const isInteractive = tag === 'button' || tag === 'a' || tag === 'input'
      || role === 'button' || role === 'link'
      || el.hasAttribute('tabindex') || el.hasAttribute('data-t')
      || el.hasAttribute('data-uia') || el.hasAttribute('data-testid');
    if (!isInteractive) return false;

    // Skip buttons must not be taller than a normal button.
    // Width is NOT capped — streaming platforms (Paramount+, Netflix, etc.) use
    // wide full-width banner buttons for "Skip Recap / Intro" overlays.
    if (r.height > 150) return false;

    // Skip buttons are never inside structural navigation / landmark wrappers.
    // NOTE: <footer> / role="contentinfo" are intentionally excluded — many streaming
    // players wrap their entire control bar in a <footer> element (Paramount+, Hulu…)
    // and the skip button lives inside it.
    if (el.closest(
      'nav, [role="navigation"], header, [role="banner"], ' +
      'aside, [role="complementary"]'
    )) return false;

    // When a video is present the skip button must be spatially near the player.
    // Use a generous bottom margin because many platforms pin their skip bar
    // BELOW the video element (Paramount+, Peacock…) — the bar's top can be
    // several hundred pixels beneath vr.bottom while still being a player control.
    const vid = ssMedia.activeVideo();
    if (vid) {
      const vr = vid.getBoundingClientRect();
      const hMargin = 200;   // left / right / above
      const vBelowMargin = Math.max(window.innerHeight * 0.4, 300); // generous downward margin
      if (r.right  < vr.left   - hMargin ||
          r.left   > vr.right  + hMargin ||
          r.bottom < vr.top    - hMargin ||
          r.top    > vr.bottom + vBelowMargin) {
        return false;
      }
    }

    return true;
  }

  /**
   * Periodic safety-net scan — runs every 2 s while a video is playing.
   * This catches skip buttons that appear without triggering the MutationObserver
   * (e.g. injected by React portals, CSS-transition reveals, timed API callbacks).
   * The scan itself is guarded by _scanPending and _clickCooldown so there's no
   * risk of double-clicking.
   */
  _startPeriodicScan() {
    if (this._periodicScanInterval) {
      clearInterval(this._periodicScanInterval);
    }
    this._periodicScanInterval = setInterval(() => {
      if (!_ssContextValid()) { clearInterval(this._periodicScanInterval); this._periodicScanInterval = null; return; }
      if (!this.enabled) return;
      const video = ssMedia.activeVideo();
      // Only fire while there is a playing (or recently paused) video
      if (!video || video.paused || video.ended) return;
      // If series is still missing while the video is playing, nudge meta detection
      if (!this._metaSettled()) this._scheduleMeta(200);
      this._scheduleScan(0); // immediate, no extra debounce delay
    }, 2000);
  }

  _stopPeriodicScan() {
    if (this._periodicScanInterval) {
      clearInterval(this._periodicScanInterval);
      this._periodicScanInterval = null;
    }
  }

  _waitForVideo() {
    if (document.querySelector('video')) {
      this._scheduleScan(300);
      this._scheduleMeta(300);
      return;
    }
    // Held on `this` so shutdown() can reach it: an un-disconnected subtree
    // observer on document.body keeps firing for the lifetime of a page that
    // never gets a player (a browse page the user leaves open for hours).
    this._videoObserver?.disconnect();
    this._videoObserver = new MutationObserver(() => {
      if (!document.querySelector('video')) return;
      this._videoObserver?.disconnect();
      this._videoObserver = null;
      this._scheduleScan(300);
      this._scheduleMeta(300);
    });
    if (document.body) {
      this._videoObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  _setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (msg.action === 'settingsUpdated') {
        const wasEnabled = this.enabled;
        this._loadSettings().then(() => {
          if (!this.enabled) {
            // User disabled the extension — stop all background activity
            this._stopPeriodicScan();
            if (this._hud) this._hud.classList.remove('ss-visible');
          } else if (!wasEnabled && this.enabled) {
            // User re-enabled — restart the periodic scan
            this._startPeriodicScan();
          }
        });
        return false;
      }

      if (msg.action === 'ping') {
        respond({ series: this.currentSeries, enabled: this.enabled });
        return false;
      }

      // Popup uses this on open: force a fresh meta pass and return the result directly.
      // More reliable than ping because it waits for the async AI scan to finish.
      if (msg.action === 'fetchSeries') {
        // If we already have a good series title, return it immediately —
        // no need to re-run the expensive AI scan just to open the popup.
        const alreadyGood = this._metaTitleGood();

        if (alreadyGood) {
          respond({ series: this.currentSeries, enabled: this.enabled });
          return false;
        }

        // Series is missing or stale — try a fresh pass only if a video
        // element exists (universal proxy for "player is open").
        const hasVideo = !!document.querySelector('video');
        if (!hasVideo) {
          respond({ series: this.currentSeries, enabled: this.enabled });
          return false;
        }

        let responded = false;
        const safeRespond = (val) => { if (!responded) { responded = true; respond(val); } };
        this._updateMeta()
          .then(() => safeRespond({ series: this.currentSeries, enabled: this.enabled }))
          .catch(() => safeRespond({ series: this.currentSeries, enabled: this.enabled }));
        // Safety net: always respond within 4 s even if _updateMeta hangs
        setTimeout(() => safeRespond({ series: this.currentSeries, enabled: this.enabled }), 4000);
        return true; // async
      }

      if (msg.action === 'snoozeUpdated') {
        // Invalidate our local snooze cache so the next scan re-reads storage
        this._snoozeCacheTs = 0;
        respond({ ok: true });
        return false;
      }

      if (msg.action === 'scanNow') {
        // Manual scan triggered from popup
        domScanner.invalidate();
        this._scheduleScan(0);
        respond({ ok: true });
        return false;
      }

      if (msg.action === 'getAIStatus') {
        // Note: popup now checks window.LanguageModel directly; this handler
        // is kept for backward compat but must always call respond().
        aiClassifier.aiStatus()
          .then(status => respond({ status }))
          .catch(() => respond({ status: 'unavailable' }));
        return true; // async
      }

      if (msg.action === 'deleteMyData') {
        // DSGVO Art. 17: delete all cloud data for this anonymous device.
        // syncService handles the API call and clears the local device-id.
        syncService.deleteMyData()
          .then(r => respond({ ok: true, deleted: r?.deleted ?? false }))
          .catch(e => respond({ ok: false, error: e.message }));
        return true; // async
      }

      return false;
    });
  }

  _connectKeepAlive() {
    // MV3 service workers get terminated after ~30 s of inactivity.
    // Holding a long-lived Port prevents that while this content script is alive.
    const connect = () => {
      if (!_ssContextValid()) return;
      try {
        const port = chrome.runtime.connect({ name: 'ss2-keepalive' });
        // SW was killed → port disconnects → reconnect so the next wake-up
        // gets a fresh port immediately (content script is still alive).
        port.onDisconnect.addListener(() => {
          if (_ssContextValid()) setTimeout(connect, 1000);
        });
      } catch (_) {}
    };
    connect();
  }

  _sendMessage(payload) {
    try { chrome.runtime.sendMessage(payload, () => chrome.runtime.lastError); } catch (_) {}
  }

  _sendMessageAsync(payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response);
        });
      } catch (_) { resolve(null); }
    });
  }
}

// Boot
(function boot() {
  // Avoid double-injection
  if (window.__smartSkipV2__) return;
  window.__smartSkipV2__ = new SmartSkipV2();
  window.__smartSkipV2__.init();

  // Global error handler: report uncaught errors from our content scripts
  window.addEventListener('error', (ev) => {
    // Only report errors from our own extension scripts
    if (!ev.filename?.includes(chrome.runtime?.id)) return;
    try {
      syncService.reportError({
        domain:  location.hostname,
        message: `${ev.message} (${ev.filename?.split('/').pop()}:${ev.lineno})`,
        url:     location.pathname,
      });
    } catch {}
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const msg = ev.reason?.message || String(ev.reason);
    // Ignore extension context invalidation — expected on update/reload
    if (msg.includes('Extension context invalidated')) return;
    try {
      syncService.reportError({
        domain:  location.hostname,
        message: `Unhandled rejection: ${msg.slice(0, 200)}`,
        url:     location.pathname,
      });
    } catch {}
  });
})();
