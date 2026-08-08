/**
 * Which <video> is the episode, and is an episode actually playing?
 *
 * Every other module used to call `document.querySelector('video')`, which
 * returns the FIRST video in DOM order. On Netflix, Prime and Disney+ that is
 * regularly a muted billboard preview, a trailer rail or an ad slot — not the
 * player. Everything downstream then reads the wrong currentTime/duration:
 * timing windows are recorded against a 40-second trailer, `_positionAllows`
 * decides a next-episode button is fair game, and the series never gets
 * detected because the page was never really a watch page.
 *
 * This module picks the video the user is watching and answers two questions
 * the rest of the extension keeps asking:
 *   - is a real long-form player active right now?      isPlayerActive()
 *   - did we switch to a different episode?             pollChange()
 *
 * Plain global (no ESM — content scripts are classic scripts). Must load
 * before platforms.js.
 */

const ssMedia = (() => {
  const CACHE_MS = 700;   // activeVideo() runs inside timeupdate handlers

  let _cached   = null;
  let _cachedAt = 0;
  let _lastId   = null;

  const rectOf = (v) => { try { return v.getBoundingClientRect(); } catch { return null; } };

  /**
   * Higher is more likely to be the main player. Area dominates, because the
   * player is the biggest thing on a watch page — the multipliers only break
   * ties between similarly sized elements.
   */
  function _score(v) {
    const r = rectOf(v);
    const area = r ? Math.max(0, r.width) * Math.max(0, r.height) : 0;
    const d = v.duration;
    const hasDur = Number.isFinite(d) && d > 0;

    // Off-screen or zero-sized: only a playing element is worth anything, and
    // then only barely — a fullscreen player always outscores it.
    if (area <= 0) return (!v.paused && v.readyState >= 2) ? 1 : 0;

    let s = area;
    if (hasDur && d >= 300)      s *= 4;     // long-form: the episode
    else if (hasDur && d < 90)   s *= 0.15;  // teaser / bumper / ad
    if (!v.paused)               s *= 2;
    if (v.readyState >= 2)       s *= 1.5;
    if (v.muted && v.paused)     s *= 0.5;   // idle autoplay preview
    return s;
  }

  /** The <video> the user is actually watching, or null. Cached for 700 ms. */
  function activeVideo() {
    if (_cached && _cached.isConnected && Date.now() - _cachedAt < CACHE_MS) return _cached;

    const vids = document.querySelectorAll('video');
    if (!vids.length) { _cached = null; _cachedAt = Date.now(); return null; }

    let best = null, bestScore = -1;
    for (const v of vids) {
      const s = _score(v);
      if (s > bestScore) { bestScore = s; best = v; }
    }
    // All candidates scored 0 (nothing loaded yet): keep the first one so
    // callers that only need "is there a player at all" still work.
    _cached   = best || vids[0];
    _cachedAt = Date.now();
    return _cached;
  }

  /** Force the next activeVideo() to re-evaluate — call after a navigation. */
  function invalidate() { _cached = null; _cachedAt = 0; }

  /**
   * 'none' | 'short' | 'feature' | 'unknown'
   * 'unknown' means the manifest has not been parsed yet — callers must treat
   * it as "possibly an episode", never as a reason to stop.
   */
  function kind() {
    const v = activeVideo();
    if (!v) return 'none';
    const d = v.duration;
    if (!Number.isFinite(d) || d <= 0) return 'unknown';
    return d >= 300 ? 'feature' : 'short';
  }

  /**
   * True when a real player is on screen with content long enough to have
   * segments. This is the gate that keeps browse-page billboard previews from
   * being treated as an episode.
   */
  function isPlayerActive() {
    const v = activeVideo();
    if (!v) return false;

    const fs = !!document.fullscreenElement;
    const d  = v.duration;
    const hasDur = Number.isFinite(d) && d > 0;

    // Muted + short is what an autoplaying preview looks like everywhere.
    // A muted *episode* (user muted it) is long, so it never matches.
    if (v.muted && !fs && hasDur && d < 300) return false;

    if (fs) return true;

    // Some players paint to a canvas and keep the <video> element at zero size,
    // which would fail every geometric test below. Long-form content that is
    // actually decoding frames is a player however it happens to be rendered.
    if (hasDur && d >= 300 && !v.paused && v.readyState >= 2) return true;

    const r = rectOf(v);
    if (!r) return false;
    // Player-sized: either a decent absolute width or a real share of the
    // viewport. Rails of thumbnails and picture-in-picture chips fail both.
    const minW = Math.min(480, Math.max(280, window.innerWidth * 0.4));
    return r.width >= minW && r.height >= 160;
  }

  /** Identity of the media currently loaded — changes when the episode changes. */
  function mediaId() {
    const v = activeVideo();
    if (!v) return null;
    const src = v.currentSrc || v.src || '';
    const d   = Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : 0;
    return `${src}#${d}`;
  }

  /**
   * True exactly once per episode change. Autoplay on Prime, Disney+ and
   * Crunchyroll swaps the media without touching location.href, so the SPA
   * URL watcher never fires and every key stays pinned to the previous episode.
   */
  function pollChange() {
    const id = mediaId();
    if (id === null) return false;              // no player — nothing to compare
    if (_lastId === null) { _lastId = id; return false; }
    if (id === _lastId) return false;

    const [prevSrc, prevDur] = _lastId.split('#');
    const [nextSrc, nextDur] = id.split('#');
    _lastId = id;

    // Same stream, duration merely became known or got refined by the manifest.
    if (prevSrc === nextSrc) {
      const a = +prevDur, b = +nextDur;
      if (a === 0 || b === 0 || Math.abs(a - b) < 5) return false;
    }
    return true;
  }

  /** Adopt the current media as the baseline without reporting a change. */
  function resetChangeBaseline() { _lastId = mediaId(); }

  return { activeVideo, invalidate, kind, isPlayerActive, mediaId, pollChange, resetChangeBaseline };
})();
