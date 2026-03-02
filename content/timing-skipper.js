/**
 * Timing-based auto-skip — jumps video.currentTime to the end of an intro,
 * recap or credits segment when the playhead enters a known skip window,
 * even when there is no visible skip button on the page.
 *
 * Detection tiers (best → weakest):
 *   0. Platform-native  — reads timing data already embedded in the page
 *   1. <track> / VTT    — chapter/subtitle cues ("Intro", "[♪ THEME ♪]", "Main Content")
 *   2. MediaSession     — navigator.mediaSession.metadata.chapterInfos (Chrome 128+)
 *   3. Community        — clustered server timings merged from all users
 *   4. Local            — clustered per-user observations from LearningStore
 *   5. AI subtitle      — Gemini Nano analyzes subtitle cues (cold-start only)
 *
 * Multiple sources for the same segment type are merged: independent signals
 * that agree multiply their confidence. Disagreeing clusters are resolved by
 * picking the dominant group (most members within ±20 s tolerance).
 *
 * Needs: learning-store.js, sync-service.js loaded first.
 */

class TimingSkipper {
  constructor() {
    this._video         = null;
    this._windows       = [];        // [{ type, from, to, confidence, sources, count }]
    this._armed         = false;
    this._skippedTypes  = new Set(); // types auto-skipped this episode — don't repeat
    this._hintedTypes   = new Set(); // types for which a hint was already shown
    this._lastUserSeek  = 0;
    this._tickHandler   = null;
    this._seekHandler   = null;
    this._settings      = null;
    this._seriesKey     = null;
    this._epKey         = null;
    this._onSkip             = null;  // callback (window) — fires on auto-jump
    this._onHint             = null;  // callback (window) — fires on weak signal
    this._windowRefreshTimer = null;  // periodic re-load of timing windows
    this._trackListener      = null;  // addtrack listener for late-loading subtitles
  }

  /**
   * Arm for the current episode. Call after meta changes.
   *   onSkip(win)  — called when confidence ≥ 0.65 and we're about to jump
   *   onHint(win)  — called when 0.50 ≤ confidence < 0.65 (show manual-skip UI)
   */
  async arm({ seriesKey, epKey, settings, onSkip, onHint }) {
    this.disarm();
    this._seriesKey = seriesKey;
    this._epKey     = epKey;
    this._settings  = settings;
    this._onSkip    = onSkip  || (() => {});
    this._onHint    = onHint  || (() => {});
    this._skippedTypes.clear();
    this._hintedTypes.clear();

    const video = document.querySelector('video');
    if (!video) return;
    this._video = video;

    // Proactively pull community timings from the cloud before loading local data.
    // This ensures first-time viewers benefit from data that other users contributed.
    try {
      if (seriesKey) await syncService.fetchTimings(seriesKey);
      if (epKey)     await syncService.fetchTimings(epKey);
    } catch (_) { /* offline or no consent — proceed with local data */ }

    await this._loadWindows();

    this._armed = true;
    this._attachListeners();
    this._startWindowRefresh();
    this._listenForNewTracks();

    // Check immediately — video may already be inside a known window
    // (e.g. arm() called mid-episode or after a SPA navigation).
    this._tick();

    // Schedule AI subtitle scans with back-off — .vtt subtitle files load
    // asynchronously; an immediate scan often finds nothing. Retry at 10 s and 30 s.
    if (!this._windows.length) {
      this._doAISubtitleScan();
      setTimeout(() => { if (this._armed && !this._windows.length) this._doAISubtitleScan(); }, 10_000);
      setTimeout(() => { if (this._armed && !this._windows.length) this._doAISubtitleScan(); }, 30_000);
    }
  }

  disarm() {
    this._armed = false;
    this._detachListeners();
    if (this._windowRefreshTimer) { clearInterval(this._windowRefreshTimer); this._windowRefreshTimer = null; }
    if (this._trackListener && this._video) {
      try { this._video.textTracks.removeEventListener('addtrack', this._trackListener); } catch {}
      this._trackListener = null;
    }
    this._windows     = [];
    this._video       = null;
    this._seriesKey   = null;
    this._epKey       = null;
    this._skippedTypes.clear();
    this._hintedTypes.clear();
  }

  // called externally after a button-click so we can refresh windows immediately
  async onButtonClick() {
    if (!this._armed) return;
    await this._loadWindows();
    this._tick();
  }

  // Called by SignalCollector after recording a new window — triggers an immediate
  // window refresh so auto-skip fires without waiting for the 30-s interval.
  async notifyNewWindow() {
    if (!this._armed) return;
    await this._loadWindows();
    if (!this._tickHandler && this._windows.length) this._attachListeners();
    this._tick();
  }

  // --- loading ---

  async _loadWindows() {
    const results = await Promise.allSettled([
      this._fromPlatform(),
      Promise.resolve(this._fromTracks()),
      Promise.resolve(this._fromMediaSession()),
      this._fromCommunity(),
    ]);

    const raw = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.length) raw.push(...r.value);
    }

    this._windows = this._mergeWindows(raw);

    // Persist windows discovered from authoritative sources (platform API,
    // subtitle tracks, MediaSession) back to LearningStore and the cloud.
    // These tiers run inside TimingSkipper and bypass SignalCollector, so
    // without this step the data is lost when the episode ends.
    // Community (tier 3/4) and local-prediction windows come *from* the store,
    // so feeding them back would be circular — skip those.
    const PERSIST_SOURCES = new Set(['platform', 'track:chapters', 'track:subtitles',
      'track:metadata', 'track:captions', 'track:content_start', 'mediasession']);
    if (this._seriesKey) {
      for (const w of raw) {
        if (!PERSIST_SOURCES.has(w.source)) continue;
        if (w.type === '__content_start') continue;
        const from = Math.round(w.from);
        const to   = Math.round(w.to);
        if (to <= from || to - from > 1200) continue;
        learningStore.recordTimingWindow(this._seriesKey, w.type, from, to);
        if (this._epKey) learningStore.recordTimingWindow(this._epKey, w.type, from, to);
        syncService.recordTimingWindow(this._seriesKey, w.type, from, to, w.source);
        if (this._epKey) syncService.recordTimingWindow(this._epKey, w.type, from, to, w.source);
      }
    }
  }

  // Tier 0 — platform.extractTimings() reads timing data already on the page
  async _fromPlatform() {
    try {
      const platform = window.__smartSkipV2__?.platform;
      if (typeof platform?.extractTimings !== 'function') return [];
      const raw = platform.extractTimings();
      if (!raw?.length) return [];
      return raw.map(w => ({ ...w, source: 'platform', confidence: w.confidence ?? 0.95 }));
    } catch (_) { return []; }
  }

  // Tier 1 — <track kind="chapters|subtitles"> cue text
  _fromTracks() {
    const video = this._video;
    if (!video) return [];
    const results = [];

    for (const track of video.textTracks) {
      const prev = track.mode;
      if (track.mode === 'disabled') track.mode = 'hidden'; // need this to access cues
      const cues = track.cues ? [...track.cues] : [];
      track.mode = prev;

      for (const cue of cues) {
        const text = (cue.text || '').replace(/<[^>]+>/g, '').trim();
        const type = this._cueTextToType(text);
        if (!type) continue;

        if (type === '__content_start') {
          // not a skip window itself — used to cap open intro/recap windows
          results.push({ type, from: cue.startTime, to: cue.startTime, confidence: 1, source: 'track:content_start' });
          continue;
        }

        results.push({
          type,
          from:       cue.startTime,
          to:         cue.endTime,
          confidence: track.kind === 'chapters' ? 0.90 : 0.78,
          source:     `track:${track.kind}`,
        });
      }
    }
    return results;
  }

  _cueTextToType(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    if (/\bintro\b|opening|^op$|\btheme\b|vorspann|inizio|apertura|オープニング|오프닝/.test(t))           return 'intro';
    if (/recap|previously|zuvor|wiederholung|zusammenfassung|riassunto|résumé|이전에/.test(t))            return 'recap';
    if (/credits?|abspann|ending|^ed$|outro|générique|sigle|créditos|エンディング|엔딩/.test(t))          return 'credits';
    if (/\bad\b|advertisement|werbung|commercial|publicité/.test(t))                                    return 'ads';
    if (/[♪♫]|\[music]|\[theme]|\[instrumental]/.test(t))                                              return 'intro';
    if (/^main content$|^episode\b|cold.?open|teaser/.test(t))                                         return '__content_start';
    return null;
  }

  // Tier 2 — MediaSession chapterInfos (Chrome 128+)
  _fromMediaSession() {
    try {
      const chapters = navigator.mediaSession?.metadata?.chapterInfos;
      if (!chapters?.length) return [];
      const results = [];
      for (let i = 0; i < chapters.length; i++) {
        const ch   = chapters[i];
        const next = chapters[i + 1];
        const type = this._cueTextToType(ch.title || '');
        if (!type || type === '__content_start') continue;
        const from = ch.startTime ?? 0;
        const to   = next?.startTime ?? (from + 120);
        results.push({ type, from, to, confidence: 0.88, source: 'mediasession' });
      }
      return results;
    } catch (_) { return []; }
  }

  // Tier 3+4 — LearningStore predictWindow (returns cluster-based windows
  // from both local observations and server-merged community data)
  async _fromCommunity() {
    const results = [];
    const keys = [this._epKey, this._seriesKey].filter(Boolean);
    for (const key of keys) {
      for (const type of ['intro', 'recap', 'credits', 'ads']) {
        const w = await learningStore.predictWindow(key, type);
        if (!w) continue;
        results.push({
          type,
          from:       w.from,
          to:         w.to,
          confidence: w.confidence,
          source:     w.source || (key === this._epKey ? 'local-ep' : 'local-series'),
        });
      }
    }
    return results;
  }

  // Tier 5 — Gemini Nano semantic analysis of subtitle cues (cold-start only)
  async _doAISubtitleScan() {
    const video = this._video;
    if (!video) return;

    // gather subtitle/caption/metadata cues from the first 5 minutes —
    // metadata tracks often carry timing data on platforms without VTT subtitles
    const cues = [];
    for (const track of video.textTracks) {
      if (track.kind !== 'subtitles' && track.kind !== 'captions' && track.kind !== 'metadata') continue;
      const prev = track.mode;
      if (track.mode === 'disabled') track.mode = 'hidden';
      if (track.cues) {
        for (const c of track.cues) {
          if (c.startTime <= 300) {
            cues.push({ t: Math.round(c.startTime), text: c.text.replace(/<[^>]+>/g, '').trim() });
          }
        }
      }
      track.mode = prev;
    }
    if (cues.length < 3) return; // not enough cues — subtitle VTT may not have loaded yet

    try {
      if (!(await ssAI.isAvailable())) return;
      const session = await ssAI.createSession({ temperature: 0, topK: 1 });
      const sample  = cues.slice(0, 50).map(c => `[${c.t}s] ${c.text}`).join('\n');
      const reply   = await session.prompt(
        `You are analyzing subtitle cues from a streaming video episode. ` +
        `Identify the time range (in seconds) of: the intro/opening theme, ` +
        `any recap ("Previously on..."), and end credits. ` +
        `Reply with JSON only, no prose: ` +
        `{"intro":{"from":N,"to":N},"recap":{"from":N,"to":N},"credits":{"from":N,"to":N}} ` +
        `Set a key to null if that segment is not present.\n\n${sample}`
      );
      session.destroy();

      const json = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] || 'null');
      if (!json) return;

      const aiWindows = [];
      for (const [type, range] of Object.entries(json)) {
        if (!range || range.from == null || range.to == null) continue;
        if (range.to <= range.from || range.to - range.from > 600) continue; // sanity check
        aiWindows.push({ type, from: range.from, to: range.to, confidence: 0.62, source: 'ai-subtitle' });
      }
      if (!aiWindows.length) return;

      this._windows = this._mergeWindows([...this._windows, ...aiWindows]);
      if (this._windows.length && !this._armed) {
        this._armed = true;
        this._attachListeners();
      }

      // Persist AI-discovered windows so future episodes on the same series
      // benefit immediately without a repeated AI subtitle scan.
      if (this._seriesKey) {
        for (const w of aiWindows) {
          const from = Math.round(w.from), to = Math.round(w.to);
          learningStore.recordTimingWindow(this._seriesKey, w.type, from, to);
          if (this._epKey) learningStore.recordTimingWindow(this._epKey, w.type, from, to);
          syncService.recordTimingWindow(this._seriesKey, w.type, from, to, 'ai-subtitle');
          if (this._epKey) syncService.recordTimingWindow(this._epKey, w.type, from, to, 'ai-subtitle');
        }
        console.info(`[SmartSkip timing] AI subtitle scan persisted ${aiWindows.length} window(s)`);
      }
    } catch (_) {}
  }

  // --- window merging ---

  _mergeWindows(raw) {
    if (!raw.length) return [];

    // cap open intro/recap windows at the nearest "content start" marker
    const contentStarts = raw.filter(w => w.type === '__content_start').map(w => w.from);
    const real          = raw.filter(w => w.type !== '__content_start');
    for (const w of real) {
      if (w.type === 'intro' || w.type === 'recap') {
        for (const cs of contentStarts) {
          if (cs > w.from && cs < w.to) w.to = cs;
        }
      }
    }

    // group by type, then find dominant cluster per type
    const byType = {};
    for (const w of real) {
      (byType[w.type] = byType[w.type] || []).push(w);
    }

    const merged = [];
    for (const [type, windows] of Object.entries(byType)) {
      const cluster = this._dominantCluster(windows, 20);
      if (!cluster.length) continue;

      // independent sources that agree multiply their uncertainty away
      const combined = cluster.length > 1
        ? 1 - cluster.reduce((p, w) => p * (1 - w.confidence), 1)
        : cluster[0].confidence;

      merged.push({
        type,
        from:       Math.min(...cluster.map(w => w.from)),
        to:         Math.max(...cluster.map(w => w.to)),
        confidence: Math.min(0.97, combined),
        sources:    [...new Set(cluster.map(w => w.source))],
        count:      cluster.length,
      });
    }

    return merged;
  }

  // returns the group of windows (sorted by from-time) where the most members
  // lie within toleranceSec of each other
  _dominantCluster(windows, toleranceSec) {
    if (!windows.length) return [];
    const sorted = [...windows].sort((a, b) => a.from - b.from);
    let best = [sorted[0]];
    for (let i = 0; i < sorted.length; i++) {
      const group = sorted.filter(w => Math.abs(w.from - sorted[i].from) <= toleranceSec);
      if (group.length > best.length) best = group;
    }
    return best;
  }

  // --- listener ---

  _attachListeners() {
    const video = this._video;
    if (!video) return;
    this._tickHandler = () => this._tick();
    this._seekHandler = () => { this._lastUserSeek = Date.now(); };
    video.addEventListener('timeupdate', this._tickHandler);
    video.addEventListener('seeking',    this._seekHandler);
  }

  _detachListeners() {
    if (this._video) {
      if (this._tickHandler) this._video.removeEventListener('timeupdate', this._tickHandler);
      if (this._seekHandler) this._video.removeEventListener('seeking',    this._seekHandler);
    }
    this._tickHandler = null;
    this._seekHandler = null;
  }

  // Periodically re-load timing windows for the first 5 min after arming.
  // Picks up data discovered by SignalCollector while the episode plays.
  _startWindowRefresh() {
    let ticks = 0;
    this._windowRefreshTimer = setInterval(async () => {
      if (!this._armed) return;
      if (++ticks >= 10) { clearInterval(this._windowRefreshTimer); this._windowRefreshTimer = null; return; }
      await this._loadWindows();
      if (!this._tickHandler && this._windows.length) this._attachListeners();
    }, 30_000);
  }

  // Listen for new TextTrack additions — subtitle .vtt files are fetched
  // asynchronously and their cues are the best source for cold-start platforms
  // that have no visible skip buttons.
  _listenForNewTracks() {
    const video = this._video;
    if (!video) return;
    this._trackListener = () => {
      if (!this._armed) return;
      // Brief delay so cues are actually populated before we read them
      setTimeout(() => {
        if (!this._armed) return;
        const fresh = this._fromTracks();
        if (!fresh.length) return;
        this._windows = this._mergeWindows([...this._windows, ...fresh]);
        if (!this._tickHandler) this._attachListeners();
        this._tick();
        // Persist newly loaded track cues — they appear after page load and
        // would otherwise only be used in-session.
        if (this._seriesKey) {
          for (const w of fresh) {
            if (w.type === '__content_start') continue;
            const from = Math.round(w.from), to = Math.round(w.to);
            if (to <= from || to - from > 1200) continue;
            learningStore.recordTimingWindow(this._seriesKey, w.type, from, to);
            if (this._epKey) learningStore.recordTimingWindow(this._epKey, w.type, from, to);
            syncService.recordTimingWindow(this._seriesKey, w.type, from, to, w.source || 'track');
            if (this._epKey) syncService.recordTimingWindow(this._epKey, w.type, from, to, w.source || 'track');
          }
        }
      }, 1500);
    };
    try { video.textTracks.addEventListener('addtrack', this._trackListener); } catch (_) {}
  }

  // --- tick ---

  _tick() {
    const video = this._video;
    if (!video || video.paused || !this._armed) return;

    // don't act within 15 s of a manual seek — user is navigating intentionally
    if (Date.now() - this._lastUserSeek < 15_000) return;

    // videos shorter than 8 minutes are probably trailers/clips, not series episodes
    if (video.duration && video.duration < 480) return;

    const t = video.currentTime;
    for (const win of this._windows) {
      if (this._skippedTypes.has(win.type)) continue;
      if (!this._typeAllowed(win.type)) continue;
      if (t < win.from || t > win.to) continue;

      if (win.confidence >= 0.65) {
        this._execute(video, win);
      } else {
        this._hint(win);
      }
      break; // one action per tick
    }
  }

  _typeAllowed(type) {
    if (!this._settings) return true;
    switch (type) {
      case 'intro':   return this._settings.skipIntro   !== false;
      case 'recap':   return this._settings.skipRecap   !== false;
      case 'credits': return this._settings.skipCredits !== false;
      case 'ads':     return this._settings.skipAds     !== false;
      default: return false;
    }
  }

  _execute(video, win) {
    this._skippedTypes.add(win.type);
    const fromTime     = video.currentTime;
    const origDuration = Math.round(video.duration || 0);
    video.currentTime  = win.to;

    this._onSkip(win);
    console.info(`[SmartSkip timing] ⏭ ${win.type} ${win.from.toFixed(0)}→${win.to.toFixed(0)}s conf=${win.confidence.toFixed(2)} src=[${win.sources}]`);

    // Returns true when the video element belongs to a *different* episode than
    // the one we just skipped — autoplay loaded the next episode mid-check.
    // In that case all feedback would be false positives, so we skip it entirely.
    const isNewEpisode = (vid) => {
      if (!vid) return true;
      // duration changed by more than 60 s → different content
      const newDur = Math.round(vid.duration || 0);
      if (origDuration > 0 && newDur > 0 && Math.abs(newDur - origDuration) > 60) return true;
      // currentTime reset to near-zero while our target was deep in the episode
      if (vid.currentTime < 15 && win.to > 60) return true;
      return false;
    };

    // verify the jump actually moved the video
    setTimeout(() => {
      const vid = document.querySelector('video');
      if (isNewEpisode(vid)) return; // episode boundary — don't record feedback
      const jumped = Math.abs(vid.currentTime - win.to) < 8;
      this._recordFeedback(win, jumped);

      // if the user seeks back within 20 s → record as failure
      const t0 = vid.currentTime;
      setTimeout(() => {
        const vidNow = document.querySelector('video');
        if (!vidNow || isNewEpisode(vidNow)) return;
        if (vidNow.currentTime < t0 - 5) {
          this._recordFeedback(win, false);
        }
      }, 20_000);
    }, 3000);
  }

  _hint(win) {
    if (this._hintedTypes.has(win.type)) return;
    this._hintedTypes.add(win.type);
    this._onHint(win);
  }

  _recordFeedback(win, success) {
    if (!success) {
      // Downgrade the exact window in the windows-bucket (high-quality signal-collector
      // data).  Without this, a bad window from XHR/DOM/button-lifecycle would never
      // be touched by the timings-bucket poison below, and would re-fire every episode.
      if (this._seriesKey) learningStore.downgradeTimingWindow(this._seriesKey, win.type, win.from, win.to);
      if (this._epKey)     learningStore.downgradeTimingWindow(this._epKey,     win.type, win.from, win.to);

      // Also poison the timings-bucket cluster for point-in-time observations.
      const poison = (win.from + win.to) / 2 + 999;
      if (this._seriesKey) learningStore.recordTiming(this._seriesKey, win.type, poison);
      if (this._epKey)     learningStore.recordTiming(this._epKey,     win.type, poison);
    }
    syncService.recordFeedback({
      domain:     location.hostname,
      buttonType: win.type,
      selector:   `timing:${win.sources?.join(',')}`,
      success,
    });
  }
}

const timingSkipper = new TimingSkipper();
