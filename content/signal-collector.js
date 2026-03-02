/**
 * Collects skip-timing signals from multiple sources and writes complete
 * {from, to} windows into LearningStore — no AI, no user interaction needed.
 *
 * Sources:
 *   A. Fetch/XHR responses  — intercepts the platform's own API calls in page
 *      context via an injected <script> and listens for postMessage replies.
 *      Gives exact {from, to} directly from the platform's own data.
 *
 *   B. Chapter/marker DOM   — reads timestamps from progress-bar marker elements
 *      and <track kind="chapters"> cues. Two adjacent markers give a full window.
 *
 *   C. window-state scan    — searches window.* globals for timing-shaped objects
 *      (introStart/introEnd, skipMarkers[], chapter arrays, etc.)
 *
 *   D. Button lifecycle     — MutationObserver records video.currentTime when a
 *      skip button *appears* (= from) and *disappears* (= to). More precise than
 *      recording the click time, which always lags by 1-5 s.
 *
 * Everything found is fed into learningStore.recordTimingWindow() and also
 * submitted to the cloud via syncService so all users benefit.
 *
 * Needs: learning-store.js, sync-service.js loaded first.
 */

class SignalCollector {
  constructor() {
    this._seriesKey    = null;
    this._epKey        = null;
    this._armed        = false;

    // button lifecycle tracking
    this._skipButtonRegistry = new Map(); // element → { type, appearedAt }
    this._buttonObserver     = null;

    // dedup: don't record the same window twice in one session
    this._recordedWindows = new Set();

    // XHR/fetch bridge
    this._messageHandler = null;
    this._injected       = false;

    // chapter DOM polling
    this._chapterPollTimer = null;

    // AI XHR fallback — lazy session, dedup by URL
    this._aiSession      = null;
    this._aiSessionP     = null;
    this._aiParsedUrls   = new Set();
  }

  arm(seriesKey, epKey) {
    this.disarm();
    this._seriesKey = seriesKey;
    this._epKey     = epKey;
    this._armed     = true;
    this._recordedWindows.clear();

    this._injectPageScript();
    this._startMessageBridge();
    this._startChapterPoll();
    this._startWindowScan();
    this._startButtonObserver();
    this._scanInlineScripts();
  }

  disarm() {
    this._armed     = false;
    this._seriesKey = null;
    this._epKey     = null;

    if (this._buttonObserver)  { this._buttonObserver.disconnect(); this._buttonObserver  = null; }
    if (this._messageHandler)  { window.removeEventListener('message', this._messageHandler); this._messageHandler = null; }
    if (this._chapterPollTimer){ clearInterval(this._chapterPollTimer); this._chapterPollTimer = null; }

    this._skipButtonRegistry.clear();
    this._recordedWindows.clear();

    // Destroy + reset AI XHR fallback state so next arm() starts fresh
    if (this._aiSession) { try { this._aiSession.destroy(); } catch {} }
    this._aiSession    = null;
    this._aiSessionP   = null;
    this._aiParsedUrls.clear();
  }

  // ── A. Fetch / XHR interceptor (page-context bridge) ─────────────────────

  _injectPageScript() {
    if (this._injected) return;
    this._injected = true;
    try {
      // Load the interceptor from a standalone extension file instead of using
      // script.textContent — inline scripts are blocked by strict CSP on sites
      // like Paramount+, Max, Hulu, etc. Extension-origin src URLs are allowed.
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/page-interceptor.js');
      // Remove after execution so DevTools isn't cluttered
      script.addEventListener('load',  () => script.remove(), { once: true });
      script.addEventListener('error', () => script.remove(), { once: true });
      document.documentElement.prepend(script);
    } catch (_) {}
  }

  _startMessageBridge() {
    this._messageHandler = (ev) => {
      if (!ev.data?.__ss2_net__ || !this._armed) return;
      this._processNetworkData(ev.data.data, ev.data.url || '');
    };
    window.addEventListener('message', this._messageHandler);
  }

  _processNetworkData(data, url) {
    const windows = this._extractWindowsFromObject(data, 0);
    if (windows.length) {
      for (const w of windows) this._record(w.type, w.from, w.to, 'xhr');
      return;
    }
    // Heuristic missed — try AI on responses that look like they could have timing data
    this._aiParseNetworkData(data, url);
  }

  async _aiParseNetworkData(data, url) {
    if (!this._armed) return;
    // Deduplicate by URL — one AI call per endpoint per session
    const urlKey = url.replace(/[?#].*/, '').slice(-120);
    if (this._aiParsedUrls.has(urlKey)) return;
    // Quick sanity: only attempt on responses that mention time-related words
    const str = JSON.stringify(data);
    if (str.length < 40 || str.length > 25000) return;
    if (!/(time|skip|intro|chapter|marker|cue|segment|credit|recap)/i.test(str)) return;
    this._aiParsedUrls.add(urlKey);

    try {
      if (!this._aiSession) {
        if (this._aiSessionP) { this._aiSession = await this._aiSessionP; }
        else {
          if (!(await ssAI.isAvailable())) return;
          this._aiSessionP = ssAI.createSession({
            systemPrompt: 'You are a streaming API timing data extractor. Always respond with valid JSON only.',
          });
          this._aiSession = await this._aiSessionP;
        }
      }
      const prompt =
        `Streaming platform API response. Find timing windows for intro, recap, credits, or ads.\n` +
        `JSON data: ${str.slice(0, 4000)}\n` +
        `Respond ONLY with a JSON array. Each item: {"type":"intro|recap|credits|ads","from":N,"to":N}\n` +
        `If nothing found: []`;
      const raw = await this._aiSession.prompt(prompt);
      const match = raw.match(/\[[\s\S]*?\]/);
      if (!match) return;
      const parsed = JSON.parse(match[0]);
      const VALID = ['intro','recap','credits','ads'];
      for (const w of parsed) {
        if (!VALID.includes(w.type)) continue;
        const from = +w.from, to = +w.to;
        if (isNaN(from) || isNaN(to) || to - from < 1 || to - from > 1200) continue;
        this._record(w.type, from, to, 'ai-xhr');
      }
    } catch { /* session error — discard */ }
  }

  // Recursively search an object for timing-shaped structures.
  // Depth-limited to 8 levels to avoid infinite recursion on circular refs.
  _extractWindowsFromObject(obj, depth) {
    if (depth > 8 || !obj || typeof obj !== 'object') return [];
    const results = [];

    // Pattern 1: {introStart, introEnd} / {recapStart, recapEnd} / etc.
    const typeAliases = {
      intro:   ['intro', 'opening', 'op', 'theme', 'open', 'openingTheme', 'opStart', 'introSequence', 'introVideo'],
      recap:   ['recap', 'previously', 'cold_open', 'coldOpen', 'teaser', 'preShow', 'pre_show', 'coldOpening'],
      credits: ['credits', 'credit', 'outro', 'ending', 'ed', 'outroStart', 'endCard', 'end_card', 'creditRoll', 'endCredits', 'closingCredits'],
      ads:     ['ad', 'ads', 'advertisement', 'commercial', 'break', 'adBreak', 'ad_break', 'adPod', 'midroll'],
    };
    for (const [type, aliases] of Object.entries(typeAliases)) {
      for (const alias of aliases) {
        const start = obj[`${alias}Start`] ?? obj[`${alias}_start`] ?? obj[`start_${alias}`];
        const end   = obj[`${alias}End`]   ?? obj[`${alias}_end`]   ?? obj[`end_${alias}`];
        if (start != null && end != null && +end > +start) {
          results.push({ type, from: +start, to: +end });
        }
      }
    }

    // Pattern 2: array of marker/chapter/segment objects
    const arrayKeys = ['markers', 'chapters', 'segments', 'cuepoints', 'skipMarkers',
                       'introMarkers', 'timecodes', 'bookmarks', 'tracks'];
    for (const k of arrayKeys) {
      if (Array.isArray(obj[k])) {
        for (const item of obj[k]) {
          const w = this._extractWindowFromMarker(item);
          if (w) results.push(w);
        }
        // chapter list: each chapter's end = next chapter's start
        if (k === 'chapters' && obj[k].length > 1) {
          const chapters = obj[k];
          for (let i = 0; i < chapters.length - 1; i++) {
            const type = this._labelToType(chapters[i].title || chapters[i].name || chapters[i].label || '');
            if (!type) continue;
            const from = +(chapters[i].startTime   ?? chapters[i].start ?? chapters[i].position ?? 0);
            const to   = +(chapters[i+1].startTime ?? chapters[i+1].start ?? chapters[i+1].position ?? from + 120);
            if (to > from) results.push({ type, from, to });
          }
        }
      }
    }

    // Pattern 3: {skipTo: N} — platform tells client "jump to N seconds"
    if (obj.skipTo != null && obj.type) {
      const type = this._labelToType(obj.type);
      if (type && obj.skipTo > 0) {
        const from = obj.start ?? obj.from ?? Math.max(0, obj.skipTo - 90);
        results.push({ type, from: +from, to: +obj.skipTo });
      }
    }

    // Pattern 4: {skipFrom/skipStart + skipTo/skipEnd} with optional type field
    {
      const from = obj.skipFrom  ?? obj.skipStart  ?? obj.skip_from  ?? obj.skip_start  ?? null;
      const to   = obj.skipTo    ?? obj.skipEnd    ?? obj.skip_to    ?? obj.skip_end    ?? null;
      if (from != null && to != null && +to > +from) {
        const type = this._labelToType(obj.type || obj.kind || obj.skipType || obj.segment || 'intro');
        if (type) results.push({ type, from: +from, to: +to });
      }
    }

    // Pattern 5: openingStart/openingEnd — common in anime streaming APIs (Crunchyroll, HiDive, etc.)
    if (obj.openingStart != null && obj.openingEnd != null && +obj.openingEnd > +obj.openingStart)
      results.push({ type: 'intro',   from: +obj.openingStart, to: +obj.openingEnd });
    if (obj.endingStart  != null && obj.endingEnd  != null && +obj.endingEnd  > +obj.endingStart)
      results.push({ type: 'credits', from: +obj.endingStart,  to: +obj.endingEnd  });
    if (obj.recapStart   != null && obj.recapEnd   != null && +obj.recapEnd   > +obj.recapStart)
      results.push({ type: 'recap',   from: +obj.recapStart,   to: +obj.recapEnd   });

    // recurse into nested objects (but not arrays we already handled)
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        results.push(...this._extractWindowsFromObject(val, depth + 1));
      }
    }

    return results;
  }

  _extractWindowFromMarker(item) {
    if (!item || typeof item !== 'object') return null;
    const label = item.type || item.kind || item.title || item.name || item.label || item.markerType || '';
    const type  = this._labelToType(label);
    if (!type) return null;

    const from = +(item.startTime ?? item.start ?? item.from  ?? item.begin    ?? item.position ?? -1);
    const to   = +(item.endTime   ?? item.end   ?? item.to    ?? item.duration ?? -1);
    if (from < 0 || to <= from) return null;
    // duration-style: to is actually duration in seconds
    const realTo = to > from ? to : from + to;
    if (realTo - from > 1200 || realTo - from < 1) return null; // sanity: 1-1200 s

    return { type, from, to: realTo };
  }

  _labelToType(label) {
    if (!label) return null;
    const l = label.toLowerCase().replace(/[_\-\s]/g, '');
    if (/intro|opening|^op$|theme|beginning|openingtheme|opstart|introsequence|introstart|vorspann|オープニング|오프닝/.test(l)) return 'intro';
    if (/recap|previously|coldopen|teaser|preshow/.test(l))                                                                   return 'recap';
    if (/credit|outro|ending|^ed$|endcard|creditroll|endcredits|closingcredit|abspann|エンディング|엔딩/.test(l))               return 'credits';
    if (/^ads?$|advertisement|commercial|adbreak|adpod|midroll|werbung/.test(l))                                             return 'ads';
    return null;
  }

  // ── B. Chapter / marker DOM ───────────────────────────────────────────────

  _startChapterPoll() {
    // Also run progress-bar segment analysis once after playback has started
    // (DOMContentLoaded may have already fired, so we poll briefly).
    setTimeout(() => { if (this._armed) this._readProgressBarSegments(); }, 4000);
    setTimeout(() => { if (this._armed) this._readProgressBarSegments(); }, 20_000);
    // Poll every 3 s for the first 2 min — chapter markers often appear later
    let ticks = 0;
    this._chapterPollTimer = setInterval(() => {
      if (!this._armed) return;
      ticks++;
      this._readChapterMarkers();
      this._readTrackCues();
      if (ticks > 40) {   // after 2 min check every 30 s
        clearInterval(this._chapterPollTimer);
        this._chapterPollTimer = setInterval(() => {
          if (this._armed) { this._readChapterMarkers(); this._readTrackCues(); }
        }, 30_000);
      }
    }, 3000);
  }

  _readChapterMarkers() {
    const video = document.querySelector('video');
    if (!video?.duration) return;
    const dur = video.duration;

    // Generic: elements with [data-time], [data-position-seconds], [data-start-time]
    // or position expressed as left: X% inside a timeline/scrubber container
    const candidates = [
      ...document.querySelectorAll('[data-time], [data-position-seconds], [data-start-time], [data-timecode]'),
      // elements with left:% style inside a scrubber/timeline
      ...document.querySelectorAll('[class*="chapter"], [class*="marker"], [class*="cue-point"], [class*="segment"]'),
    ];

    const points = [];
    for (const el of candidates) {
      let sec = parseFloat(
        el.dataset.time ?? el.dataset.positionSeconds ?? el.dataset.startTime ?? el.dataset.timecode ?? NaN
      );
      if (isNaN(sec)) {
        // try to derive from left: X% + video duration
        const style = el.getAttribute('style') || '';
        const m = style.match(/left:\s*([\d.]+)%/);
        if (m) sec = (parseFloat(m[1]) / 100) * dur;
      }
      if (!isNaN(sec) && sec >= 0 && sec < dur) {
        const label = this._labelToType(
          el.dataset.chapterName || el.dataset.label || el.title ||
          el.getAttribute('aria-label') || el.textContent?.trim() || ''
        );
        points.push({ sec, type: label, el });
      }
    }

    if (points.length < 2) return;
    points.sort((a, b) => a.sec - b.sec);

    for (let i = 0; i < points.length; i++) {
      if (!points[i].type) continue;
      const from = points[i].sec;
      const to   = points[i + 1]?.sec ?? Math.min(from + 120, dur);
      if (to > from) this._record(points[i].type, from, to, 'chapter-dom');
    }
  }

  _readTrackCues() {
    const video = document.querySelector('video');
    if (!video) return;
    for (const track of video.textTracks) {
      if (track.kind !== 'chapters' && track.kind !== 'metadata') continue;
      const prev = track.mode;
      if (track.mode === 'disabled') track.mode = 'hidden';
      const cues = track.cues ? [...track.cues] : [];
      track.mode = prev;

      for (let i = 0; i < cues.length; i++) {
        const type = this._labelToType(cues[i].text?.replace(/<[^>]+>/g, '') || '');
        if (!type) continue;
        const from = cues[i].startTime;
        const to   = cues[i].endTime > cues[i].startTime
          ? cues[i].endTime
          : (cues[i + 1]?.startTime ?? from + 120);
        if (to > from) this._record(type, from, to, 'track-cue');
      }
    }
  }

  // ── E. Inline JSON <script> tags ──────────────────────────────────────────
  //
  // Many platforms (Next.js, Nuxt, Crunchyroll v2, HIDIVE, Funimation, etc.)
  // embed the full app/episode state as JSON inside <script> tags that are
  // part of the SSR HTML response.  The XHR/fetch interceptor never sees these
  // because they are never fetched separately.
  _scanInlineScripts() {
    const selectors = [
      '#__NEXT_DATA__',                       // Next.js universal embed
      '#__NUXT_DATA__',                       // Nuxt 3
      '#__NUXT__',                            // Nuxt 2
      'script[type="application/json"]',
      'script[type="application/ld+json"]',   // schema.org VideoObject / TVEpisode
      'script[id*="data"]',
      'script[id*="state"]',
      'script[id*="config"]',
      'script[id*="episode"]',
      'script[id*="player"]',
    ];
    const seen = new Set();
    for (const sel of selectors) {
      for (const tag of document.querySelectorAll(sel)) {
        if (seen.has(tag)) continue;
        seen.add(tag);
        try {
          const text = tag.textContent?.trim();
          if (!text || text.length < 20 || text.length > 500_000) continue;
          const data = JSON.parse(text);
          for (const w of this._extractWindowsFromObject(data, 0)) {
            this._record(w.type, w.from, w.to, 'inline-script');
          }
        } catch {}
      }
    }
  }

  // ── F. Progress-bar visual segment analysis ───────────────────────────────
  //
  // Streaming platforms place small marker/segment divs inside the seek-bar
  // with a `left: X%` style that corresponds to a chapter boundary position.
  // Even without any label, the *first* boundary in the first 5 min is almost
  // always the intro end, and the *last* boundary near the end is credits.
  _readProgressBarSegments() {
    const video = document.querySelector('video');
    if (!video?.duration || video.duration < 480) return;
    const dur = video.duration;

    const containers = [...document.querySelectorAll(
      '[class*="progress-bar"], [class*="progressBar"], [class*="ProgressBar"], '
      + '[class*="SeekBar"], [class*="seekbar"], [class*="Seekbar"], '
      + '[class*="timeline"], [class*="TimeLine"], '
      + '[class*="scrubber"], [class*="Scrubber"]'
    )];

    for (const container of containers) {
      if (container.getBoundingClientRect().width < 100) continue;

      const points = [];
      for (const child of container.querySelectorAll('*')) {
        const style = child.getAttribute('style') || '';
        const m = style.match(/left:\s*([\d.]+)%/);
        if (!m) continue;
        const pct = parseFloat(m[1]) / 100;
        if (pct <= 0 || pct >= 1) continue;
        const sec = pct * dur;
        const labelRaw = child.dataset.chapterName || child.dataset.label
          || child.getAttribute('aria-label') || child.title || '';
        points.push({ sec, type: this._labelToType(labelRaw) });
      }
      if (!points.length) continue;
      points.sort((a, b) => a.sec - b.sec);

      // Named boundaries — record each as a window to its successor
      let namedAny = false;
      for (let i = 0; i < points.length; i++) {
        if (!points[i].type) continue;
        namedAny = true;
        const to = points[i + 1]?.sec ?? Math.min(points[i].sec + 180, dur);
        if (to > points[i].sec) this._record(points[i].type, points[i].sec, to, 'progress-segment');
      }

      // Unlabeled fallback heuristic — only when nothing had a label
      if (!namedAny) {
        const first = points[0];
        if (first.sec > 30 && first.sec < 300) {
          // First boundary in the first 5 min → very likely the intro/OP end.
          // Don't start from 0 — that would trigger an immediate skip the moment
          // playback begins.  Use a conservative from = boundary - 120s (min 5s).
          const introFrom = Math.max(5, first.sec - 120);
          this._record('intro', introFrom, first.sec, 'progress-heuristic');
        }
        const last = points[points.length - 1];
        if (last.sec > dur * 0.78) {
          // Last boundary deep into the episode → very likely credits start
          this._record('credits', last.sec, Math.min(last.sec + 300, dur - 3), 'progress-heuristic');
        }
      }
    }
  }

  // ── C. window-state scan ─────────────────────────────────────────────────

  _startWindowScan() {
    // run immediately and again after 5 s (some SPAs populate state lazily)
    this._scanWindowState();
    setTimeout(() => { if (this._armed) this._scanWindowState(); }, 5000);
    setTimeout(() => { if (this._armed) this._scanWindowState(); }, 15_000);
  }

  _scanWindowState() {
    // Known global keys where platforms store player state
    const candidates = [
      window.__INITIAL_STATE__,
      window.__STORE__?.getState?.(),
      window.__REDUX_STORE__?.getState?.(),
      window.__APP_CONFIG__,
      window.__APP_STATE__,
      window.__PLAYER_STATE__,
      window.__PLAYER_DATA__,
      window.__PLAYER__,
      window.__VIDEO_DATA__,
      window.__EPISODE_DATA__,
      window.__NEXT_DATA__?.props?.pageProps,
      window.__NUXT__?.data,
      window.__NUXT__?.payload,
      window.__NETFLIX_BROWSE_CONTEXT__,
      window.__DATA__,
      window._sharedData,
      window.App?.store?.getState?.(),
      window.playerConfig,
      window.videoData,
    ].filter(Boolean);

    for (const obj of candidates) {
      for (const w of this._extractWindowsFromObject(obj, 0)) {
        this._record(w.type, w.from, w.to, 'window-state');
      }
    }

    // Also try shallow scan of window for objects that look like player state
    try {
      for (const key of Object.keys(window)) {
        if (key.startsWith('__') || key.length < 3) continue;
        const val = window[key];
        if (!val || typeof val !== 'object') continue;
        // only look at objects that have timing-like keys directly on them
        if ('introStart' in val || 'introEnd' in val || 'skipMarkers' in val
            || 'chapters' in val || 'markers' in val || 'cuepoints' in val) {
          for (const w of this._extractWindowsFromObject(val, 0)) {
            this._record(w.type, w.from, w.to, 'window-state');
          }
        }
      }
    } catch (_) {}
  }

  // ── D. Button lifecycle observer ─────────────────────────────────────────

  _startButtonObserver() {
    const SKIP_WORDS = /skip|überspringen|intro|recap|credits|abspann|vorspann|pular|saltar/i;

    const getType = (el) => {
      const text = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      if (/intro|vorspann|opening/.test(text)) return 'intro';
      if (/recap|previously|wiederholung/.test(text)) return 'recap';
      if (/credits|abspann|outro/.test(text)) return 'credits';
      if (/\bad\b|werbung/.test(text)) return 'ads';
      if (SKIP_WORDS.test(text)) return 'intro'; // most common default
      return null;
    };

    const looksLikeSkipButton = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const tag   = el.tagName?.toLowerCase();
      const role  = el.getAttribute?.('role') || '';
      if (tag !== 'button' && role !== 'button' && tag !== 'a') return false;
      const text  = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      return SKIP_WORDS.test(text);
    };

    const onAppear = (el) => {
      const type = getType(el);
      if (!type) return;
      const video = document.querySelector('video');
      if (!video || video.paused || video.currentTime < 1) return;
      // Also capture the active subtitle text at this moment — it is the most
      // accurate context for what the intro/credits segment looks like textually.
      const subtitleAtAppear = this._captureSubtitleText(video);
      this._skipButtonRegistry.set(el, { type, appearedAt: video.currentTime, subtitleAtAppear });
    };

    const onDisappear = (el) => {
      const entry = this._skipButtonRegistry.get(el);
      if (!entry) return;
      this._skipButtonRegistry.delete(el);
      const video = document.querySelector('video');
      if (!video) return;
      const { type, appearedAt: from } = entry;
      // Defer the currentTime read by ~400 ms so that a seek triggered by the
      // button click has time to execute.  Reading synchronously would capture
      // the pre-seek position, giving a useless {from ≈ to} window.
      setTimeout(() => {
        const vid = document.querySelector('video');
        const to  = vid ? vid.currentTime : video.currentTime;
        // only record if window is plausible (5 s–1200 s)
        if (to - from >= 5 && to - from <= 1200) {
          this._record(type, from, to, 'button-lifecycle');
        }
      }, 400);
    };

    this._buttonObserver = new MutationObserver((mutations) => {
      if (!this._armed) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (looksLikeSkipButton(node)) onAppear(node);
          // also check subtree
          if (node.nodeType === 1) {
            for (const child of node.querySelectorAll('button, [role="button"], a')) {
              if (looksLikeSkipButton(child)) onAppear(child);
            }
          }
        }
        for (const node of m.removedNodes) {
          if (this._skipButtonRegistry.has(node)) onDisappear(node);
        }
        // attribute changes: element became hidden
        if (m.type === 'attributes' && this._skipButtonRegistry.has(m.target)) {
          const el = m.target;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' ||
              parseFloat(style.opacity) < 0.05) {
            onDisappear(el);
          }
        }
      }
    });

    this._buttonObserver.observe(document.body, {
      childList:       true,
      subtree:         true,
      attributes:      true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
    });
  }

  // called from skipper._click() so we can use button-appear time as `from`
  // instead of the (always-late) click time
  getButtonAppearTime(el) {
    return this._skipButtonRegistry.get(el)?.appearedAt ?? null;
  }

  /**
   * Returns the subtitle text that was active when the button first appeared.
   * Used by skipper._click() to include context in the cloud training payload.
   */
  getButtonSubtitleSample(el) {
    return this._skipButtonRegistry.get(el)?.subtitleAtAppear ?? null;
  }

  /**
   * Reads currently active subtitle/caption cue text from the video element.
   * Shared between onAppear (registry) and external callers.
   */
  _captureSubtitleText(video) {
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
   * Record a verified skip window derived from an actual button click.
   * Called after post-click verification confirms the skip worked.
   * These are the highest-quality training samples — exact {from, to} with
   * confirmed human/automatic intent.
   *
   * @param {string} type     'intro' | 'recap' | 'credits' | 'ads'
   * @param {number} from     video.currentTime when the button appeared (= segment start)
   * @param {number} to       video.currentTime after the skip landed (= segment end)
   * @param {string} [source] 'button-click' | 'button-click-nav'
   */
  recordButtonWindow(type, from, to, source = 'button-click') {
    if (!this._armed || !this._seriesKey) return;
    this._record(type, from, to, source);
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  _record(type, from, to, source) {
    if (!this._armed || !this._seriesKey) return;
    if (from == null || to == null || isNaN(from) || isNaN(to)) return;
    from = Math.round(from);
    to   = Math.round(to);
    if (to <= from || to - from > 1200 || from < 0) return;

    // dedup: same type + same from/to (±5 s) within this session
    const dedupKey = `${type}:${Math.round(from/5)}:${Math.round(to/5)}`;
    if (this._recordedWindows.has(dedupKey)) return;
    this._recordedWindows.add(dedupKey);

    learningStore.recordTimingWindow(this._seriesKey, type, from, to);
    if (this._epKey) learningStore.recordTimingWindow(this._epKey, type, from, to);

    syncService.recordTimingWindow(this._seriesKey, type, from, to, source);
    if (this._epKey) syncService.recordTimingWindow(this._epKey, type, from, to, source);

    console.info(`[SmartSkip signal] ${type} ${from}→${to}s (${source})`);
    // Notify TimingSkipper immediately so it can auto-skip without waiting
    // for the 30-s periodic window-refresh interval.
    timingSkipper?.notifyNewWindow?.().catch?.(() => {});
  }
}

const signalCollector = new SignalCollector();
