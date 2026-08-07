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
 * Evidence model
 * --------------
 * Sources split into two classes, and the distinction decides whether we may
 * jump the playhead:
 *
 *   LOCAL  — observed in *this* playback: platform timing data, text-track cues,
 *            live cuechange, MediaSession chapters, signal-collector findings.
 *            Proves something is happening right now.
 *   PRIOR  — remembered from other episodes of the same series, or crowd data.
 *            Predicts, but proves nothing about the episode on screen.
 *
 * A prior on its own can only raise a manual hint. To actually jump, it must be
 * corroborated live (a visible skip button, an active matching cue, the platform
 * itself) — otherwise episode 5 gets its intro cut out at the timestamp that
 * happened to work for episodes 1-3.
 *
 * Needs: learning-store.js, sync-service.js loaded first.
 */

// Sources that constitute live evidence from the episode currently playing.
const SS_LOCAL_SOURCE_RE = /^(platform|track:|cuechange:|mediasession|ai-subtitle|signal:)/;

const SS_FIRE_THRESHOLD   = 0.65; // jump the playhead at or above this
const SS_HINT_THRESHOLD   = 0.50; // offer a manual skip button at or above this
const SS_CORROB_BOOST     = 0.30; // added when a prior is confirmed live in the page

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
    this._onNearEnd          = null;  // callback () — fires once at 85% playtime for prefetch
    this._windowRefreshTimer = null;  // periodic re-load of timing windows
    this._trackListener      = null;  // addtrack listener for late-loading subtitles
    this._cueChangeHandlers  = new Map(); // TextTrack → handler fn, for cleanup
    this._cueStartTimes      = {};    // type → currentTime when cue went active
    this._prefetchDone       = false; // fires onNearEnd only once per arm
    this._rejectedTypes      = new Set(); // types the user undid this episode — never re-fire
    this._pendingVerify      = null;  // { win, target, until } — watched for seek-back
    this._localTypes         = new Set(); // types with live evidence this episode
    this._skipBtnSelectors   = { byType: {}, all: [], patterns: [] }; // refreshed with windows
    this._persisted          = new Set(); // dedup key → already written this episode
    this._seekedHandler      = null;
    this._selfSeekAt         = 0;     // timestamp of a seek we performed ourselves
    this._selfSeekTarget     = null;  // where that seek was aimed
    this._armedAt            = 0;     // player start-up seeks are not user intent
    this._generation         = 0;     // bumped per arm(); invalidates in-flight loads
    this._userPlaced         = new Map(); // type → window the user parked inside
  }

  /** True when a window carries at least one live source from this playback. */
  _isLocalSource(source) {
    return !!source && SS_LOCAL_SOURCE_RE.test(source);
  }

  /**
   * Arm for the current episode. Call after meta changes.
   *   onSkip(win)  — called when confidence ≥ 0.65 and we're about to jump
   *   onHint(win)  — called when 0.50 ≤ confidence < 0.65 (show manual-skip UI)
   */
  async arm({ seriesKey, epKey, settings, onSkip, onHint, onNearEnd }) {
    this.disarm();
    // Any _loadWindows() still in flight belongs to the previous episode. It
    // must not finish into this one: on autoplay the next episode arms while the
    // old load is mid-await, and its windows and local-evidence flags would be
    // adopted as if they described the episode now playing.
    const gen = ++this._generation;
    this._seriesKey  = seriesKey;
    this._epKey      = epKey;
    this._settings   = settings;
    this._onSkip     = onSkip    || (() => {});
    this._onHint     = onHint    || (() => {});
    this._onNearEnd  = onNearEnd || null;
    this._skippedTypes.clear();
    this._hintedTypes.clear();
    this._rejectedTypes.clear();
    this._localTypes.clear();
    this._persisted.clear();
    this._userPlaced.clear();
    this._pendingVerify  = null;
    this._selfSeekAt     = 0;
    this._selfSeekTarget = null;
    this._armedAt        = Date.now();

    const video = document.querySelector('video');
    if (!video) return;
    this._video = video;

    // Proactively pull community timings from the cloud before loading local data,
    // so first-time viewers benefit from what other users contributed.
    //
    // Capped: arming must not wait on the network. A slow or unreachable server
    // used to delay it for as long as the request took, and the segments worth
    // skipping are in the first minute — by the time arming finished the intro
    // was over. If the fetch lands late, the 30-s window refresh picks it up.
    const cloud = Promise.allSettled([
      seriesKey ? syncService.fetchTimings(seriesKey) : null,
      epKey     ? syncService.fetchTimings(epKey)     : null,
    ]);
    await Promise.race([cloud, new Promise(r => setTimeout(r, 2000))]);
    if (gen !== this._generation) return; // re-armed while we waited

    await this._loadWindows(gen);
    if (gen !== this._generation) return;
    // Fold in whatever arrived after we stopped waiting.
    cloud.then(() => {
      if (this._armed && gen === this._generation) this._loadWindows(gen).catch(() => {});
    });

    this._armed = true;
    this._attachListeners();
    this._startWindowRefresh();
    this._listenForNewTracks();
    this._startCueChangeListeners();

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
    // Invalidate anything still in flight so it cannot write into a later arm().
    this._generation++;
    this._detachListeners();
    if (this._windowRefreshTimer) { clearInterval(this._windowRefreshTimer); this._windowRefreshTimer = null; }
    if (this._trackListener && this._video) {
      try { this._video.textTracks.removeEventListener('addtrack', this._trackListener); } catch {}
      this._trackListener = null;
    }
    // Clean up all cuechange listeners
    for (const [track, handler] of this._cueChangeHandlers) {
      try { track.removeEventListener('cuechange', handler); } catch {}
    }
    this._cueChangeHandlers.clear();
    this._cueStartTimes  = {};
    this._prefetchDone   = false;
    this._windows     = [];
    this._video       = null;
    this._seriesKey   = null;
    this._epKey       = null;
    this._onNearEnd   = null;
    this._pendingVerify = null;
    this._skippedTypes.clear();
    this._hintedTypes.clear();
    this._rejectedTypes.clear();
    this._localTypes.clear();
    this._persisted.clear();
    this._userPlaced.clear();
  }

  /**
   * Register a window observed live in this playback (SignalCollector: XHR data,
   * chapter DOM, button lifecycle). Unlike windows that come back out of the
   * store, these count as evidence for the episode on screen and may fire a jump.
   */
  addLocalWindow(type, from, to, source = 'signal:unknown') {
    if (!this._armed) return;
    from = Math.round(from);
    to   = Math.round(to);
    if (!(to > from) || to - from > 1200) return;
    this._localTypes.add(type);

    const src      = source.startsWith('signal:') ? source : `signal:${source}`;
    const existing = this._windows.find(w => w.type === type && Math.abs(w.from - from) <= 20);
    if (existing) {
      existing.from       = Math.min(existing.from, from);
      existing.to         = Math.max(existing.to,   to);
      existing.confidence = Math.max(existing.confidence, 0.85);
      existing.local      = true;
      existing.sources    = [...new Set([...(existing.sources || []), src])];
    } else {
      this._windows.push({ type, from, to, confidence: 0.85, sources: [src], count: 1, local: true });
    }
    if (!this._tickHandler) this._attachListeners();
    this._tick();
    this._writeTimingStatus();
  }

  /**
   * Perform a skip the user confirmed through the HUD hint button.
   *
   * The hint stays on screen for several seconds, so by the time it is clicked
   * the playhead may have moved well past the window — assigning `win.to` blindly
   * would then yank the user backwards. Validate before moving.
   *
   * @returns {boolean} whether the jump was performed
   */
  confirmSkip(win) {
    const video = this._video || document.querySelector('video');
    if (!video || !win) return false;
    const t = video.currentTime;
    if (t >= win.to - 1) return false;   // already past it — nothing to skip
    if (t < win.from - 30) return false; // user moved far away — stale hint
    this._skippedTypes.add(win.type);
    this._seekTo(video, win.to);
    return true;
  }

  /**
   * Undo a skip we just performed, and record that it was unwanted.
   * Refuses when the user has since moved elsewhere — rewinding them to a
   * position from a minute ago is worse than doing nothing.
   *
   * @returns {boolean} whether the rewind was performed
   */
  undoSkip(win) {
    const video = this._video || document.querySelector('video');
    if (!video || win?._undoTime == null) return false;
    const stillWhereWeLanded = Math.abs(video.currentTime - win.to) <= 30;
    if (stillWhereWeLanded) this._seekTo(video, win._undoTime);
    this.rejectWindow(win);
    return stillWhereWeLanded;
  }

  /**
   * Hard rejection from the user (HUD undo, or a seek back into the window).
   * Removes the window for the rest of this episode and penalises it in the
   * store so the same phantom skip does not come back next episode.
   */
  rejectWindow(win) {
    if (!win) return;
    this._rejectedTypes.add(win.type);
    this._skippedTypes.add(win.type);
    this._windows = this._windows.filter(w => w !== win && w.type !== win.type);
    this._recordFeedback(win, false);
    this._writeTimingStatus();
    console.info(`[SmartSkip timing] ✗ rejected ${win.type} ${win.from}→${win.to}s — window penalised`);
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

  /**
   * @param {number} [gen] arm() generation this load belongs to. Results are
   *   discarded if the skipper was re-armed meanwhile — see arm().
   */
  async _loadWindows(gen = this._generation) {
    const results = await Promise.allSettled([
      this._fromPlatform(),
      Promise.resolve(this._fromTracks()),
      Promise.resolve(this._fromMediaSession()),
      this._fromCommunity(),
    ]);
    if (gen !== this._generation) return; // belongs to a previous episode

    const raw = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.length) raw.push(...r.value);
    }
    for (const w of raw) {
      if (w.local === undefined) w.local = this._isLocalSource(w.source);
      if (w.local && w.type !== '__content_start') this._localTypes.add(w.type);
    }

    // Carry over windows that SignalCollector pushed in live this episode —
    // they are not in the store yet and must not be dropped by a refresh.
    // Re-added as one entry: splitting them per source would make a single
    // observation look like several agreeing ones and inflate its confidence.
    for (const w of this._windows) {
      if (w.local && (w.sources || []).some(s => String(s).startsWith('signal:'))) {
        raw.push({ type: w.type, from: w.from, to: w.to, confidence: w.confidence, sources: w.sources, local: true });
      }
    }

    this._windows = this._mergeWindows(raw);
    await this._refreshSkipSelectors();
    if (gen !== this._generation) return;
    this._writeTimingStatus();

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
        this._persist(w.type, from, to, w.source);
      }
    }
  }

  /**
   * Write a window to the local store and the cloud, attributed to the episode
   * it was observed in. The epKey is what lets predictWindow() tell "three
   * different episodes agree" apart from "one episode watched three times".
   */
  _persist(type, from, to, source) {
    if (!this._seriesKey) return;
    // _loadWindows re-runs every 30 s and would otherwise re-submit the same
    // track cues over and over, inflating the observation count of a window
    // that was really only seen once.
    const dedup = `${type}:${from}:${to}:${source}`;
    if (this._persisted.has(dedup)) return;
    this._persisted.add(dedup);

    const meta = { epKey: this._epKey || null, duration: this._video?.duration };
    learningStore.recordTimingWindow(this._seriesKey, type, from, to, 1, meta);
    if (this._epKey) learningStore.recordTimingWindow(this._epKey, type, from, to, 1, meta);
    syncService.recordTimingWindow(this._seriesKey, type, from, to, source);
    if (this._epKey) syncService.recordTimingWindow(this._epKey, type, from, to, source);
  }

  /**
   * Refresh the selectors that have historically pointed at a real skip button
   * on this domain. Cached because the corroboration check runs inside a
   * `timeupdate` handler and therefore has to be synchronous.
   */
  async _refreshSkipSelectors() {
    try {
      const byType  = (await learningStore.getAllFeedbackSelectors(location.hostname)) || {};
      const learned = await learningStore.getSelectors(location.hostname);
      this._skipBtnSelectors = {
        byType,
        all:      [...new Set([...Object.values(byType), ...(learned?.skipSelectors || [])])].filter(Boolean),
        patterns: (learned?.skipTextPatterns || []).map(p => String(p).toLowerCase().trim()).filter(Boolean),
      };
    } catch { /* keep the previous list */ }
  }

  // Tier 0 — platform.extractTimings() reads timing data already on the page
  async _fromPlatform() {
    try {
      const platform = window.__smartSkipV2__?.platform;
      if (typeof platform?.extractTimings !== 'function') return [];
      const raw = platform.extractTimings();
      if (!raw?.length) return [];
      return raw.map(w => ({ ...w, source: 'platform', confidence: w.confidence ?? 0.95, local: true }));
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
          results.push({ type, from: cue.startTime, to: cue.startTime, confidence: 1, source: 'track:content_start', local: true });
          continue;
        }

        results.push({
          type,
          from:       cue.startTime,
          to:         cue.endTime,
          confidence: track.kind === 'chapters' ? 0.90 : 0.78,
          source:     `track:${track.kind}`,
          local:      true,
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
        results.push({ type, from, to, confidence: 0.88, source: 'mediasession', local: true });
      }
      return results;
    } catch (_) { return []; }
  }

  // Tier 3+4 — LearningStore predictWindow (returns cluster-based windows
  // from both local observations and server-merged community data).
  //
  // This is *memory*, not evidence: everything returned here is flagged
  // local:false so _tick() knows it needs live corroboration before jumping.
  // The episode key is the exception — a previous playback of the very same
  // episode is specific enough to act on by itself.
  async _fromCommunity() {
    const results = [];
    const duration = this._video?.duration;
    const keys = [
      this._epKey     ? { key: this._epKey,     tier: 'episode' } : null,
      this._seriesKey ? { key: this._seriesKey, tier: 'series'  } : null,
    ].filter(Boolean);

    for (const { key, tier } of keys) {
      for (const type of ['intro', 'recap', 'credits', 'ads']) {
        const w = await learningStore.predictWindow(key, type, { tier, duration });
        if (!w) continue;
        results.push({
          type,
          from:       w.from,
          to:         w.to,
          confidence: w.confidence,
          source:     `${w.source || 'memory'}:${tier}`,
          local:      false,
          tier,
          nEps:       w.nEps,
          spread:     w.spread,
          stable:     w.stable,
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
        aiWindows.push({ type, from: range.from, to: range.to, confidence: 0.62, source: 'ai-subtitle', local: true });
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
          this._localTypes.add(w.type);
          this._persist(w.type, Math.round(w.from), Math.round(w.to), 'ai-subtitle');
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
    // (already-merged windows carry `sources`, fresh ones carry `source` —
    // normalise so a re-merge does not drop the provenance we decide on)
    const byType = {};
    for (const w of real) {
      if (!w.source && Array.isArray(w.sources) && w.sources.length) w.source = w.sources[0];
      (byType[w.type] = byType[w.type] || []).push(w);
    }

    const merged = [];
    for (const [type, windows] of Object.entries(byType)) {
      // Live evidence supersedes memory outright. A prior may fill a gap where
      // this episode reports nothing, but it must never sit in the same pool and
      // outvote a live source: when the remembered intro (62-152 s) and this
      // episode's chapter track (88-178 s) are more than the cluster tolerance
      // apart, the tie-break used to hand the win to the prior and we cut the
      // wrong range — early enough to clip the intro, late enough to eat a scene.
      const live  = windows.filter(w => w.local);
      const local = live.length > 0;
      const pool  = local ? live : windows;

      const cluster = this._dominantCluster(pool, 20);
      if (!cluster.length) continue;

      // Independent live sources that agree multiply their uncertainty away.
      // Priors deliberately do NOT take part in that: the series bucket and the
      // episode bucket are fed from the same observations, so treating them as
      // two independent votes let two views of one memory reach 0.88 and fire a
      // jump with no evidence at all. Memory is worth no more than its single
      // strongest entry.
      const combined = local && cluster.length > 1
        ? 1 - cluster.reduce((p, w) => p * (1 - w.confidence), 1)
        : Math.max(...cluster.map(w => w.confidence));

      merged.push({
        type,
        from:       Math.min(...cluster.map(w => w.from)),
        to:         Math.max(...cluster.map(w => w.to)),
        confidence: Math.min(0.97, combined),
        sources:    [...new Set(cluster.flatMap(w => w.sources || [w.source]).filter(Boolean))],
        count:      cluster.length,
        local,
        tier:       local ? 'live' : (cluster.find(w => w.tier === 'episode') ? 'episode' : 'series'),
      });
    }

    return merged;
  }

  // returns the group of windows (sorted by from-time) where the most members
  // lie within toleranceSec of each other. Equally sized groups are decided by
  // total confidence rather than by whichever starts earliest — an arbitrary
  // tie-break here silently picks which range gets cut out of the episode.
  _dominantCluster(windows, toleranceSec) {
    if (!windows.length) return [];
    const sorted = [...windows].sort((a, b) => a.from - b.from);
    const weight = (g) => g.reduce((s, w) => s + (w.confidence || 0), 0);
    let best = [sorted[0]];
    for (let i = 0; i < sorted.length; i++) {
      const group = sorted.filter(w => Math.abs(w.from - sorted[i].from) <= toleranceSec);
      if (group.length > best.length
          || (group.length === best.length && weight(group) > weight(best))) {
        best = group;
      }
    }
    return best;
  }

  // --- listener ---

  _attachListeners() {
    const video = this._video;
    if (!video) return;
    this._tickHandler = () => this._tick();
    // `seeking` starts the cooldown as early as possible (it also fires
    // repeatedly while the user drags the scrubber); `seeked` is where the
    // final landing position is known and can be acted on.
    this._seekHandler   = () => { if (!this._isSelfSeek()) this._lastUserSeek = Date.now(); };
    this._seekedHandler = () => this._onSeeked();
    video.addEventListener('timeupdate', this._tickHandler);
    video.addEventListener('seeking',    this._seekHandler);
    video.addEventListener('seeked',     this._seekedHandler);
  }

  _detachListeners() {
    if (this._video) {
      if (this._tickHandler)   this._video.removeEventListener('timeupdate', this._tickHandler);
      if (this._seekHandler)   this._video.removeEventListener('seeking',    this._seekHandler);
      if (this._seekedHandler) this._video.removeEventListener('seeked',     this._seekedHandler);
    }
    this._tickHandler   = null;
    this._seekHandler   = null;
    this._seekedHandler = null;
  }

  /**
   * Was the seek currently being reported one we caused ourselves?
   * Buffering makes players emit extra seek events after a jump, so the time
   * window is generous — but the landing position has to match, otherwise a
   * genuine correction right after a bad skip would be swallowed.
   */
  _isSelfSeek() {
    if (Date.now() - this._selfSeekAt > 3000) return false;
    if (this._selfSeekTarget == null) return true;
    const v = this._video;
    return !v || Math.abs(v.currentTime - this._selfSeekTarget) < 1.5;
  }

  /** Move the playhead, marking the seek as ours so it is not read as user intent. */
  _seekTo(video, seconds) {
    this._selfSeekAt     = Date.now();
    this._selfSeekTarget = seconds;
    video.currentTime    = seconds;
  }

  /**
   * The user finished a seek. Two consequences:
   *   - landing back inside something we cut away is a rejection
   *   - landing inside a known window means they chose that position on
   *     purpose, so we must not drag them out of it
   */
  _onSeeked() {
    const video = this._video;
    if (!video || this._isSelfSeek()) return;
    this._lastUserSeek = Date.now();
    this._checkSeekBack();

    // Players seek on their own while starting up — restoring a "continue
    // watching" position, settling after the manifest loads. That is not the
    // user choosing a spot, so it must not suppress the first skip.
    if (Date.now() - this._armedAt < 4000) return;

    const t = video.currentTime;
    for (const win of this._windows) {
      if (t >= win.from - 2 && t <= win.to) {
        this._userPlaced.set(win.type, { from: win.from, to: win.to });
      }
    }
  }

  // Periodically re-load timing windows for the first 5 min after arming.
  // Picks up data discovered by SignalCollector while the episode plays.
  _startWindowRefresh() {
    let ticks = 0;
    const gen = this._generation;
    this._windowRefreshTimer = setInterval(async () => {
      if (!this._armed || gen !== this._generation) return;
      if (++ticks >= 10) { clearInterval(this._windowRefreshTimer); this._windowRefreshTimer = null; return; }
      await this._loadWindows(gen);
      if (gen !== this._generation) return;
      if (!this._tickHandler && this._windows.length) this._attachListeners();
    }, 30_000);
  }

  // ── Real-time cuechange tracking ─────────────────────────────────────────
  //
  // Attaches `cuechange` to every text track on the video element.  When a
  // cue whose text matches a skip-type keyword becomes *active*, we record
  // `from = currentTime`.  When it goes *inactive* we close the window and
  // persist it immediately — no button click needed, no polling delay.
  // This is the highest-precision source for tracks that actually label their
  // cues (Netflix, Apple TV+, many anime platforms).
  _startCueChangeListeners() {
    const video = this._video;
    if (!video) return;
    for (const track of video.textTracks) this._attachCueChangeOnTrack(track);
  }

  _attachCueChangeOnTrack(track) {
    if (this._cueChangeHandlers.has(track)) return;
    const handler = () => {
      if (!this._armed || !this._video) return;
      const t        = this._video.currentTime;
      const active   = track.activeCues ? [...track.activeCues] : [];
      const activeTypes = new Set();

      for (const cue of active) {
        const text = (cue.text || '').replace(/<[^>]+>/g, '').trim();
        const type = this._cueTextToType(text);
        if (!type || type === '__content_start') continue;
        activeTypes.add(type);
        if (!(type in this._cueStartTimes)) {
          this._cueStartTimes[type] = t; // cue just became active
        }
      }

      // Detect cues that just went inactive
      for (const type of Object.keys(this._cueStartTimes)) {
        if (!activeTypes.has(type)) {
          const from = this._cueStartTimes[type];
          delete this._cueStartTimes[type];
          const to = t;
          if (to - from >= 3 && to - from <= 600) {
            this._onCueWindow(type, from, to, track.kind);
          }
        }
      }
    };
    this._cueChangeHandlers.set(track, handler);
    try { track.addEventListener('cuechange', handler); } catch {}
  }

  _onCueWindow(type, from, to, trackKind) {
    const conf = trackKind === 'chapters' ? 0.94 : 0.84;
    this._localTypes.add(type); // this episode really has such a segment
    // Merge into live windows immediately so _tick() can act this cycle
    const existing = this._windows.find(w => w.type === type);
    if (existing && Math.abs(existing.from - from) <= 20) {
      // A live cue overrides a remembered range instead of widening it.
      existing.from       = existing.local ? Math.min(existing.from, Math.round(from)) : Math.round(from);
      existing.to         = existing.local ? Math.max(existing.to,   Math.round(to))   : Math.round(to);
      existing.confidence = Math.max(existing.confidence, conf);
      existing.local      = true;
      existing.sources    = [...new Set([...(existing.sources || []), `cuechange:${trackKind}`])];
    } else if (!existing) {
      this._windows.push({ type, from: Math.round(from), to: Math.round(to), confidence: conf, sources: [`cuechange:${trackKind}`], count: 1, local: true });
    }
    if (!this._tickHandler) this._attachListeners();
    this._tick();
    // Persist so next episode benefits without a repeated cue scan
    this._persist(type, Math.round(from), Math.round(to), `cuechange:${trackKind}`);
    console.info(`[SmartSkip timing] cuechange captured ${type} ${from.toFixed(0)}\u2192${to.toFixed(0)}s src=cuechange:${trackKind}`);
    this._writeTimingStatus();
  }

  // Write current windows summary to storage so the popup can display them.
  _writeTimingStatus() {
    if (!this._seriesKey) return;
    try {
      const summary = this._windows
        .filter(w => w.confidence >= 0.35)
        .map(w => ({
          type:       w.type,
          from:       Math.round(w.from),
          to:         Math.round(w.to),
          confidence: +(w.confidence.toFixed(2)),
          count:      w.count ?? 1,
          // 'live'    — confirmed in this episode, will auto-skip
          // 'episode' — remembered from this episode, will auto-skip
          // 'series'  — remembered from other episodes, needs live confirmation
          tier:       w.tier || (w.local ? 'live' : 'series'),
        }));
      chrome.storage.local.set({ ss2_timing_status: { seriesKey: this._seriesKey, windows: summary, ts: Date.now() } });
    } catch {}
  }

  // Listen for new TextTrack additions — subtitle .vtt files are fetched
  // asynchronously and their cues are the best source for cold-start platforms
  // that have no visible skip buttons.
  _listenForNewTracks() {
    const video = this._video;
    if (!video) return;
    this._trackListener = (event) => {
      if (!this._armed) return;
      // Hook cuechange on the new track immediately — don't wait for 1.5 s
      if (event?.track) this._attachCueChangeOnTrack(event.track);
      // Brief delay so cues are actually populated before we do a one-shot read
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
            this._localTypes.add(w.type);
            this._persist(w.type, from, to, w.source || 'track');
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

    // Near-end prefetch — fire once at 85% through the episode so the next
    // episode's timing data is ready in LearningStore before autoplay starts.
    if (!this._prefetchDone && video.duration > 0 && t / video.duration > 0.85) {
      this._prefetchDone = true;
      if (this._onNearEnd) try { this._onNearEnd(); } catch {}
    }
    // Release a user-chosen position once the playhead has left it, so the
    // suppression below lasts exactly as long as they stay where they put it.
    for (const [type, p] of this._userPlaced) {
      if (t < p.from - 2 || t > p.to + 2) this._userPlaced.delete(type);
    }

    for (const win of this._windows) {
      if (this._skippedTypes.has(win.type))  continue;
      if (this._rejectedTypes.has(win.type)) continue;
      if (!this._typeAllowed(win.type)) continue;
      if (t < win.from || t > win.to) continue;

      // A remembered window that cannot physically be this segment in this
      // episode (credits in minute 3, an intro past the halfway mark) is dropped
      // outright rather than merely downgraded.
      if (!win.local && !this._plausible(win, video)) continue;

      // The user scrubbed to this spot themselves. Whatever we think is playing
      // here, they chose to be here — offer the skip, never take it for them.
      const placed  = this._userPlaced.get(win.type);
      const userOwns = !!placed && t >= placed.from - 2 && t <= placed.to;

      const effective = this._effectiveConfidence(win);

      if (effective >= SS_FIRE_THRESHOLD && !userOwns) {
        this._execute(video, win);
      } else if (effective >= SS_HINT_THRESHOLD) {
        this._hint(win);
      }
      break; // one action per tick
    }
  }

  /**
   * Confidence actually used for the fire/hint decision.
   *
   * Live windows keep their own confidence. A prior only reaches the auto-skip
   * threshold if something in the page confirms it right now — that corroboration
   * requirement is what stops episode 5 being cut at episode 1-3's timestamps.
   */
  _effectiveConfidence(win) {
    if (win.local) return win.confidence;
    const ev = this._corroborate(win);
    win._corroboratedBy = ev.reason;
    return ev.ok ? Math.min(0.97, win.confidence + SS_CORROB_BOOST) : win.confidence;
  }

  /**
   * Live confirmation that the remembered segment is really on screen.
   * Synchronous — runs inside the `timeupdate` handler.
   * @returns {{ok: boolean, reason: string}}
   */
  _corroborate(win) {
    // 1. The platform itself says so (chapter/marker data for this episode).
    try {
      const platform = window.__smartSkipV2__?.platform;
      if (typeof platform?.extractTimings === 'function') {
        const now = this._video?.currentTime ?? 0;
        for (const w of (platform.extractTimings() || [])) {
          if (w?.type === win.type && now >= w.from - 2 && now <= w.to + 2) {
            return { ok: true, reason: 'platform' };
          }
        }
      }
    } catch { /* platform data unavailable */ }

    // 2. A text-track cue matching this type is active right now.
    if (this._activeCueMatches(win.type)) return { ok: true, reason: 'cue' };

    // 3. The platform is showing a skip button for this segment.
    if (this._visibleSkipButton(win.type)) return { ok: true, reason: 'button' };

    // 4. Something already proved this segment type exists in this episode.
    if (this._localTypes.has(win.type)) return { ok: true, reason: 'local-signal' };

    return { ok: false, reason: 'none' };
  }

  /** Is a cue whose text maps to `type` currently active on any text track? */
  _activeCueMatches(type) {
    const video = this._video;
    if (!video) return false;
    try {
      for (const track of video.textTracks) {
        if (!track.activeCues) continue;
        for (const cue of track.activeCues) {
          const text = (cue.text || '').replace(/<[^>]+>/g, '').trim();
          if (this._cueTextToType(text) === type) return true;
        }
      }
    } catch { /* cross-origin track */ }
    return false;
  }

  /** Is a visible, clickable skip button for `type` present in the DOM? */
  _visibleSkipButton(type) {
    const TYPE_WORDS = {
      intro:   /skip.*intro|intro.*(?:skip|überspringen)|vorspann|opening|オープニング/i,
      recap:   /skip.*recap|recap.*(?:skip|überspringen)|previously|zusammenfassung|wiederholung/i,
      credits: /skip.*credits|credits.*(?:skip|überspringen)|abspann|outro|ending/i,
      ads:     /skip.*ad\b|werbung.*überspringen|anzeige/i,
    };
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && parseFloat(st.opacity || '1') > 0.1;
    };

    try {
      // Selector learned specifically for this button type on this domain.
      const known = this._skipBtnSelectors.byType?.[type];
      if (known && isVisible(document.querySelector(known))) return true;

      // Any element whose label matches this segment type.
      const re = TYPE_WORDS[type];
      if (re) {
        for (const el of document.querySelectorAll('button, [role="button"], [data-t], [aria-label]')) {
          const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.trim();
          if (label.length > 80) continue;      // paragraphs are not buttons
          if (re.test(label) && isVisible(el)) return true;
        }
      }

      // Text patterns the DOM scanner previously confirmed on this domain.
      if (this._skipBtnSelectors.patterns?.length) {
        for (const sel of this._skipBtnSelectors.all) {
          const el = document.querySelector(sel);
          if (!isVisible(el)) continue;
          const txt = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.toLowerCase();
          if (re && re.test(txt)) return true;
        }
      }
    } catch { /* malformed learned selector */ }
    return false;
  }

  /**
   * Sanity check for a remembered window against the episode actually playing.
   * Rejects windows that are geometrically impossible for their type — the
   * cheapest defence against a series prior bleeding into an episode that is
   * structured differently (no cold open, different length, no credits scene).
   */
  _plausible(win, video) {
    const dur = video?.duration;
    if (!Number.isFinite(dur) || dur <= 0) return true; // unknown length — don't guess

    switch (win.type) {
      case 'intro':
        // Intros live in the front third; a 40-minute mark is not an intro.
        return win.to <= Math.max(600, dur * 0.35);
      case 'recap':
        return win.to <= Math.max(420, dur * 0.25);
      case 'credits':
        // Credits belong to the tail. Mid-episode "credits" are a mislabel.
        return win.from >= dur * 0.60;
      default:
        return true;
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
    // Never move the playhead backwards. A window whose end already lies behind
    // the current position is stale — acting on it would rewind the user.
    if (!(win.to > video.currentTime + 1)) return;

    this._skippedTypes.add(win.type);
    const fromTime     = video.currentTime;
    const origDuration = Math.round(video.duration || 0);
    this._seekTo(video, win.to);

    this._onSkip(win);
    const how = win.local ? 'live' : `prior+${win._corroboratedBy}`;
    console.info(`[SmartSkip timing] ⏭ ${win.type} ${win.from.toFixed(0)}→${win.to.toFixed(0)}s conf=${win.confidence.toFixed(2)} via=${how} src=[${win.sources}]`);

    // Watch for the user seeking back into what we cut. Any backward seek that
    // lands inside the window within the next 60 s is a rejection — the old
    // 20 s / 5 s rule almost never triggered, so bad windows were effectively
    // permanent once learned.
    this._pendingVerify = { win, target: win.to, until: Date.now() + 60_000 };

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
      if (isNewEpisode(vid)) { this._pendingVerify = null; return; } // episode boundary
      const jumped = Math.abs(vid.currentTime - win.to) < 8;
      // Only a *live-evidence* skip counts as a positive training sample.
      // Confirming a prior with its own successful jump was a feedback loop:
      // the blind skip proved itself right and the phantom window grew stronger
      // with every episode it ruined.
      if (jumped && !win.local) return;
      this._recordFeedback(win, jumped);
    }, 3000);
  }

  _hint(win) {
    if (this._hintedTypes.has(win.type)) return;
    this._hintedTypes.add(win.type);
    this._onHint(win);
  }

  /**
   * The user seeked. If they went back into a segment we just cut away, that is
   * an explicit "this was wrong" — treat it as a hard rejection of the window.
   */
  _checkSeekBack() {
    const pv = this._pendingVerify;
    if (!pv || !this._video) return;
    if (Date.now() > pv.until) { this._pendingVerify = null; return; }

    const t = this._video.currentTime;
    // Landed back inside (or just before) the window we skipped over.
    if (t < pv.target - 3 && t >= pv.win.from - 15) {
      this._pendingVerify = null;
      this.rejectWindow(pv.win);
    }
  }

  _recordFeedback(win, success) {
    if (!success) {
      const meta = { epKey: this._epKey || null };
      // A rejection is worth more than the sightings that produced the window:
      // rejectTimingWindow drops this episode's contribution and halves the
      // remaining trust, so two bad jumps delete the prior instead of leaving it
      // to out-vote the user forever.
      if (this._seriesKey) learningStore.rejectTimingWindow(this._seriesKey, win.type, win.from, win.to, meta.epKey);
      if (this._epKey)     learningStore.rejectTimingWindow(this._epKey,     win.type, win.from, win.to, meta.epKey);

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
