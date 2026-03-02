﻿/**
 * Platform adapters — detect() finds the right adapter for the current site,
 * extractMeta() reads the series/episode title from the DOM, getContainer()
 * scopes the button scan to the player area.
 */

// Base
class BasePlatform {
  get host() { return window.location.hostname; }
  get path() { return window.location.pathname; }
  get href() { return window.location.href; }

  detect()       { return false; }
  isWatchPage()  { return !!document.querySelector('video'); }
  extractMeta()  { return null; }
  getContainer() { return document.body; }

  /**
   * Read skip-timing data already embedded in the page by the platform itself.
   * Returns [{type, from, to}] or null. Override in platform subclasses.
   * Confidence is assigned by timing-skipper.js (defaults to 0.95 for native data).
   */
  extractTimings() { return null; }

  /** Helper: read text from first matching selector */
  text(...selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return null;
  }

  /** Helper: read content= from meta tag */
  meta(property) {
    return document.querySelector(`meta[property="${property}"], meta[name="${property}"]`)?.content?.trim() || null;
  }

  /** Helper: best series title from og:video:series, og:title, twitter:title, structured-data */
  metaSeriesTitle() {
    // 1. Explicit series tag (most reliable)
    const explicit = this.meta('og:video:series') || this.meta('video:series');
    if (explicit) return explicit.trim();

    // 2. JSON-LD structured data
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(el.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const s = item.partOfSeries?.name || item.seriesName ||
                    item.partOfSeason?.partOfSeries?.name || item['@type'] === 'TVSeries' && item.name;
          if (s && typeof s === 'string' && s.trim().length > 1) return s.trim();
        }
      } catch {}
    }
    return null;
  }

  /**
   * Returns true when a string looks like an episode/segment title rather than a series title.
   * Used as a guard to prevent episode text being stored as the series name.
   */
  _looksLikeEpisodeName(str) {
    if (!str) return false;
    return (
      // Starts with episode number: E79, EP79, Episode 79, Folge 79, #79
      /^(?:E|EP|Episode|Folge|Chapter|Kapitel|#)\s*\d+\b/i.test(str) ||
      // SxxExx anywhere at start
      /^S\d{1,2}E\d{1,2}/i.test(str) ||
      // "E79 -", "E79:", "Episode 79 -"
      /^E\d+\s*[-–—:]/i.test(str) ||
      // Contains season/episode info
      /Staffel\s+\d+.*Folge\s+\d+/i.test(str) ||
      /Season\s+\d+.*Episode\s+\d+/i.test(str)
    );
  }

  /** Helper: extract slug from URL and title-case it */
  slugToTitle(slug) {
    return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

// Netflix
class NetflixPlatform extends BasePlatform {
  detect() { return this.host.includes('netflix.com'); }

  isWatchPage() {
    return this.href.includes('/watch/') || !!document.querySelector('video');
  }

  extractMeta() {
    const title = this.text(
      '[data-uia="video-title"]  h4',
      '[data-uia="dp-series-title"]',
      'h1[class*="ltr-"]',
      '.title-title',
    ) || this.metaSeriesTitle();
    if (!title || this._looksLikeEpisodeName(title)) return null;

    let episode = null;
    const titleEl = document.querySelector('[data-uia="video-title"]');
    if (titleEl) {
      const spans = [...titleEl.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean);
      if (spans.length) episode = spans.join(' – ');
    }
    return { title, episode: episode || 'unknown', source: 'netflix' };
  }

  getContainer() {
    return document.querySelector('.watch-video') || document.body;
  }

  extractTimings() {
    // Netflix embeds skip markers into the player state under the "markers" key.
    // The exact shape has changed over time; we try several known paths.
    try {
      // Path 1: global player state (most common since 2023)
      const ctx = window.__NETFLIX_BROWSE_CONTEXT__
               || window.netflix?.appContext?.state?.playerApp;
      const markers = ctx?.getState?.()?.videoPlayer
        ?.getVideoPlayerBySessionId?.(
          ctx.getState?.()?.videoPlayer?.getActiveSessionId?.()
        )?.getSkipMarkers?.();
      if (markers?.length) return this._normalizeNetflixMarkers(markers);
    } catch (_) {}
    try {
      // Path 2: __PLAYER_STATE__ injected into page by the Netflix SPA
      const ps = JSON.parse(
        document.getElementById('__PLAYER_STATE__')?.textContent || 'null'
      );
      const markers = ps?.videoPlayer?.markers || ps?.markers;
      if (markers?.length) return this._normalizeNetflixMarkers(markers);
    } catch (_) {}
    return null;
  }

  _normalizeNetflixMarkers(markers) {
    const typeMap = { intro: 'intro', recap: 'recap', credit: 'credits', credits: 'credits', ad: 'ads' };
    return markers
      .filter(m => typeMap[m.type?.toLowerCase()])
      .map(m => ({
        type: typeMap[m.type.toLowerCase()],
        from: m.start ?? m.startPosition ?? 0,
        to:   m.end   ?? m.endPosition   ?? 0,
      }))
      .filter(m => m.to > m.from);
  }
}

// Disney+
class DisneyPlusPlatform extends BasePlatform {
  detect() { return this.host.includes('disneyplus.com') || this.host.includes('disney.com'); }

  isWatchPage() {
    return this.href.includes('/video/') || !!document.querySelector('video');
  }

  extractMeta() {
    const title = this.text(
      '[class*="title-field"]',
      '[data-testid="content-title"]',
      'h1[class*="title"]',
      '.title-field',
    ) || this.metaSeriesTitle() || this.meta('og:title');
    if (!title || this._looksLikeEpisodeName(title)) return null;
    const episode = this.text('[class*="subtitle"]', '[data-testid="content-subtitle"]') || 'unknown';
    return { title, episode, source: 'disneyplus' };
  }

  extractTimings() {
    try {
      const state = window.__PLAYER_STATE__
                 || window.__dcp_internal_player_state__
                 || window.bmxAccountState?.playerState
                 || window.bmxPlayerState;
      const markers = state?.playbackContext?.skipMarkers
                   || state?.playerControls?.skipMarkers
                   || state?.skipMarkers
                   || state?.markers;
      if (markers?.length) return this._normalizeMarkers(markers);
      return null;
    } catch { return null; }
  }

  _normalizeMarkers(markers) {
    const TYPE_MAP = {
      INTRO: 'intro', intro: 'intro', opening: 'intro', OPENING: 'intro',
      RECAP: 'recap', recap: 'recap', previously: 'recap',
      CREDIT: 'credits', CREDITS: 'credits', credits: 'credits',
      OUTRO: 'credits', outro: 'credits', ending: 'credits', ENDING: 'credits',
      AD: 'ads', ADS: 'ads', ads: 'ads',
    };
    return markers
      .map(m => ({
        type: TYPE_MAP[m.type] || TYPE_MAP[m.skipType] || TYPE_MAP[m.markerType] || null,
        from: +(m.startPosition ?? m.start ?? m.startTime ?? m.from ?? 0),
        to:   +(m.endPosition   ?? m.end   ?? m.endTime   ?? m.to   ?? 0),
      }))
      .filter(m => m.type && m.to > m.from && m.to - m.from < 1200);
  }
}

// Amazon Prime Video
class PrimeVideoPlatform extends BasePlatform {
  detect() {
    return this.host.includes('primevideo.com')
      || (this.host.includes('amazon.') && this.path.includes('/gp/video'));
  }

  isWatchPage() { return this.href.includes('/watch/') || !!document.querySelector('video'); }

  extractMeta() {
    const title =
      document.querySelector('.atvwebplayersdk-title-text')?.textContent?.trim()
      || document.querySelector('[data-automation-id="title"]')?.textContent?.trim()
      || this.metaSeriesTitle()
      || this.meta('og:title');
    if (!title || this._looksLikeEpisodeName(title)) return null;
    const episode =
      document.querySelector('.atvwebplayersdk-subtitle-text')?.textContent?.trim()
      || 'unknown';
    return { title, episode, source: 'prime' };
  }

  getContainer() { return document.body; }

  extractTimings() {
    try {
      // Prime Video exposes intro-skip info via nvpController or window globals
      const ctrl  = window.nvpController || window.pv_atv_controller;
      const state = ctrl?.playerState ?? ctrl?.state ?? null;
      if (state) {
        const intro = state.introSkipInfo ?? state.skipIntro ?? state.introMarker;
        if (intro) {
          const from = +(intro.startPosition ?? intro.start ?? 0);
          const to   = +(intro.endPosition   ?? intro.end   ?? 0);
          if (to > from) return [{ type: 'intro', from, to }];
        }
      }
      const raw = window.__INITIAL_STATE__;
      if (!raw) return null;
      const ep = raw?.playback ?? raw?.playerConfig ?? raw?.videoMeta;
      if (ep?.intro) {
        const i    = ep.intro;
        const from = +(i.start ?? i.startPosition ?? 0);
        const to   = +(i.end   ?? i.endPosition   ?? from + 90);
        if (to > from) return [{ type: 'intro', from, to }];
      }
      return null;
    } catch { return null; }
  }
}

// Crunchyroll
class CrunchyrollPlatform extends BasePlatform {
  detect() { return this.host.includes('crunchyroll.com'); }

  isWatchPage() {
    return this.href.includes('/watch/')
      || this.host.includes('static.crunchyroll.com')
      || !!document.querySelector('video');
  }

  extractMeta() {
    // 1. Explicit series DOM elements (most reliable, appear after player loads)
    let seriesTitle =
      // New player (2024+)
      this.text(
        '[data-t="series-title"]',
        'a[data-t="series-link"]',
        '.show-title-link',
        '.series-title',
        '[class*="SeriesTitle"]',
        '[class*="series-title"]',
        // Breadcrumb series link
        'nav a[href*="/series/"]',
        'a[href*="/series/"]',
      );

    // 2. og:video:series or JSON-LD (added by Crunchyroll on episode pages)
    if (!seriesTitle || this._looksLikeEpisodeName(seriesTitle)) {
      seriesTitle = this.metaSeriesTitle() || seriesTitle;
    }

    // 3. URL: /series/{slug}/  or  /watch/{id}/{episode-slug}
    if (!seriesTitle || this._looksLikeEpisodeName(seriesTitle)) {
      const seriesSlug = this.path.match(/\/series\/[A-Z0-9]+\/([^/]+)/)?.[1]
                      || this.path.match(/\/series\/([^/]+)/)?.[1];
      if (seriesSlug) seriesTitle = this.slugToTitle(seriesSlug);
    }

    // 4. og:title is usually episode title on Crunchyroll — use only if
    //      it doesn't look like an episode name AND nothing better was found ──
    if (!seriesTitle) {
      const ogTitle = this.meta('og:title');
      if (ogTitle && !this._looksLikeEpisodeName(ogTitle)) {
        seriesTitle = ogTitle.replace(/\s*[|]\s*Crunchyroll.*/i, '').trim();
      }
    }

    if (!seriesTitle) return null;
    if (this._looksLikeEpisodeName(seriesTitle)) return null;

    // Episode info
    let episode =
      this.text(
        '[data-t="episode-title"]',
        '[class*="EpisodeTitle"]',
        '[class*="episode-title"]',
        '.episode-title',
        'h1[class*="title"]',
      )
      || this.meta('og:title')?.replace(/\s*[|]\s*Crunchyroll.*/i, '').trim()
      || 'unknown';

    // Strip series title prefix from episode string if present
    if (episode && episode.toLowerCase().startsWith(seriesTitle.toLowerCase())) {
      episode = episode.substring(seriesTitle.length).replace(/^[\s\-–—|:]+/, '').trim();
    }

    // Parse SxxExx episode codes  (e.g. "S1 E3" or "Season 1 Episode 3")
    const epCode = this._extractEpisodeCode(episode);

    return { title: seriesTitle, episode: epCode || episode || 'unknown', source: 'crunchyroll' };
  }

  extractTimings() {
    // Crunchyroll injects intro/outro markers into __INITIAL_STATE__ for their
    // own skip buttons — read it before the React app removes it from the DOM.
    try {
      const raw = window.__INITIAL_STATE__
               || window.__APP_CONFIG__
               || JSON.parse(
                    document.querySelector('script#vilos-config')?.textContent
                    || document.querySelector('script[type="application/json"]')?.textContent
                    || 'null'
                  );
      const ep = raw?.episode || raw?.mediaPage?.episode;
      const markers = ep?.introEnd != null ? [{
        type: 'intro',
        from: ep.introStart ?? 0,
        to:   ep.introEnd,
      }] : null;
      const outroMarker = ep?.outroStart != null ? {
        type: 'credits',
        from: ep.outroStart,
        to:   ep.outroEnd ?? (ep.outroStart + 90),
      } : null;
      const results = [...(markers || []), ...(outroMarker ? [outroMarker] : [])]
        .filter(m => m.to > m.from);
      return results.length ? results : null;
    } catch (_) { return null; }
  }
  _extractEpisodeCode(str) {
    if (!str) return null;
    let m = str.match(/S(\d{1,2})\s*[E×x]\s*(\d{1,2})/i);
    if (m) return `S${m[1].padStart(2,'0')}E${m[2].padStart(2,'0')}`;
    m = str.match(/(?:Season|Staffel)\s*(\d+).*?(?:Episode|Folge)\s*(\d+)/i);
    if (m) return `S${m[1].padStart(2,'0')}E${m[2].padStart(2,'0')}`;
    // "E79" or "Episode 79" without season → use E00 as season
    m = str.match(/^(?:E|EP|Episode|Folge)\s*(\d+)/i);
    if (m) return `E${m[1].padStart(3,'0')}`;
    return null;
  }
}

// Paramount+
class ParamountPlatform extends BasePlatform {
  detect() { return this.host.includes('paramountplus.com'); }

  isWatchPage() {
    return this.href.includes('/shows/')
      || this.href.includes('/movies/')
      || this.href.includes('/video/')
      || !!document.querySelector('video');
  }

  extractMeta() {
    // 1) Primary: skin-metadata elements injected by Paramount player
    let title   = document.querySelector('.skin-metadata-manager-header')?.textContent?.trim() || null;
    let episode = null;

    const bodyText = document.querySelector('.skin-metadata-manager-body')?.textContent?.trim() || '';
    if (bodyText) {
      // "S2 F3 Tulsa King - Oklahoma gegen Manfredi"  (F = Folge / E = Episode)
      const m = bodyText.match(/^S(\d+)\s*[EFef](\d+)[^\w]*(.*)?$/);
      if (m) {
        let epTitle = (m[3] || '').trim();
        if (title && epTitle.toLowerCase().startsWith(title.toLowerCase())) {
          epTitle = epTitle.substring(title.length).replace(/^[\s\-–—|:]+/, '').trim();
        }
        episode = `S${m[1]}E${m[2]}${epTitle ? ' – ' + epTitle : ''}`;
      } else {
        episode = bodyText;
      }
    }

    // 2) If skin-metadata didn't deliver, parse document.title / og:title
    //    which Paramount always sets, even before the player loads.
    if (!title) {
      const candidates = [
        document.title?.trim(),
        this.meta('og:title'),
      ].filter(Boolean);

      for (const raw of candidates) {
        const parsed = this._parseParamountTitle(raw);
        if (parsed) {
          title   = parsed.title;
          episode = episode || parsed.episode;
          break;
        }
      }
    }

    // 3) Last resort: URL slug
    if (!title) {
      title = this.slugToTitle(this.path.match(/\/shows\/([^\/]+)/)?.[1] || '') || null;
    }

    return title ? { title, episode: episode || 'unknown', source: 'paramount' } : null;
  }

  /**
   * Parse Paramount+ page titles in DE and EN:
   *   DE: "Schaue dir Tulsa King Staffel 2 Folge 4: Helden und Schurken an - Paramount+…"
   *   EN: "Watch Tulsa King Season 2 Episode 4: Heroes and Villains on Paramount+…"
   *   Generic: "Tulsa King | Paramount+"
   */
  _parseParamountTitle(raw) {
    // DE pattern
    let m = raw.match(
      /^Schaue?\s+dir\s+(.+?)\s+Staffel\s+(\d+)\s+Folge\s+(\d+)(?::\s*(.+?))?\s+an\b/i
    );
    if (m) {
      const epLabel = `S${m[2].padStart(2,'0')}E${m[3].padStart(2,'0')}${m[4] ? ' – ' + m[4].trim() : ''}`;
      return { title: m[1].trim(), episode: epLabel };
    }
    // EN pattern
    m = raw.match(
      /^Watch\s+(.+?)\s+Season\s+(\d+)\s+Episode\s+(\d+)(?::\s*(.+?))?\s+on\b/i
    );
    if (m) {
      const epLabel = `S${m[2].padStart(2,'0')}E${m[3].padStart(2,'0')}${m[4] ? ' – ' + m[4].trim() : ''}`;
      return { title: m[1].trim(), episode: epLabel };
    }
    // Generic SxxExx
    m = raw.match(/^(.+?)\s*[-–—]\s*S(\d{1,2})E(\d{1,2})/i);
    if (m) {
      return { title: m[1].trim(), episode: `S${m[2].padStart(2,'0')}E${m[3].padStart(2,'0')}` };
    }
    // Movie / series without episode: strip "- Paramount+…" suffix
    const cleaned = raw.replace(/\s*[-–—|]\s*Paramount\+.*$/i, '').trim();
    if (cleaned.length > 1 && cleaned !== raw) {
      return { title: cleaned, episode: null };
    }
    return null;
  }

  getContainer() { return document.body; }
}

// HBO Max / Max
class MaxPlatform extends BasePlatform {
  detect() { return this.host.includes('max.com') || this.host.includes('hbomax.com'); }

  isWatchPage() { return this.href.includes('/video/') || !!document.querySelector('video'); }

  extractMeta() {
    const title = this.text(
      '[class*="series-title"]',
      '[data-testid="title"]',
      'h1'
    ) || this.meta('og:title');
    if (!title) return null;
    const episode = this.text('[class*="episode-title"]', '[data-testid="subtitle"]') || 'unknown';
    return { title, episode, source: 'max' };
  }
}

// Apple TV+
class AppleTVPlatform extends BasePlatform {
  detect() { return this.host.includes('apple.com') || this.host.includes('tv.apple.com'); }
  isWatchPage() { return !!document.querySelector('video'); }

  extractMeta() {
    const title = this.text('.product-header__title', 'h1') || this.meta('og:title');
    if (!title) return null;
    const episode = this.text('.episode-title', '.subtitle') || 'unknown';
    return { title, episode, source: 'appletv' };
  }
}

// Hulu
class HuluPlatform extends BasePlatform {
  detect() { return this.host.includes('hulu.com'); }
  isWatchPage() { return this.href.includes('/watch/') || !!document.querySelector('video'); }

  extractMeta() {
    const title = this.text('[class*="TitleCard"]', '[class*="show-title"]', 'h1') || this.meta('og:title');
    if (!title) return null;
    const episode = this.text('[class*="episode-title"]', '[class*="EpisodeTitle"]') || 'unknown';
    return { title, episode, source: 'hulu' };
  }
}

// Viki
class VikiPlatform extends BasePlatform {
  detect() { return this.host.includes('viki.com'); }
  isWatchPage() { return this.href.includes('/videos/') || !!document.querySelector('video'); }

  extractMeta() {
    const ogTitle = this.meta('og:title');
    if (ogTitle) {
      const parts = ogTitle.split(/[-–]/);
      const title = parts[0]?.trim();
      const episode = parts.slice(1).join('-').trim() || 'unknown';
      return title ? { title, episode, source: 'viki' } : null;
    }
    const title = this.text('h1', '.title') || document.title.split('-')[0].trim();
    return title ? { title, episode: 'unknown', source: 'viki' } : null;
  }
}

// Generic fallback (YouTube, Twitch, Vimeo, any other video page)
class GenericPlatform extends BasePlatform {
  detect() { return true; } // Always matches as final fallback

  isWatchPage() {
    if (!document.querySelector('video')) return false;
    const skip = ['/browse', '/search', '/home', '/profile', '/settings'];
    return !skip.some(p => this.path.startsWith(p));
  }

  extractMeta() {
    const title =
      this.meta('og:title')
      || this.text('h1')
      || document.title?.split(/[-–|]/)[0]?.trim();
    if (!title || title.length < 2) return null;
    return { title, episode: 'unknown', source: 'generic' };
  }

  getContainer() {
    const video = document.querySelector('video');
    if (!video) return document.body;
    // Walk up to find a meaningful wrapper
    let node = video.parentElement;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      const cls = (node.className || '').toString().toLowerCase();
      if (cls.includes('player') || cls.includes('video-player') || cls.includes('watch')) {
        return node;
      }
      node = node.parentElement;
    }
    return video.closest('.player, .video-player, #player') || video.parentElement || document.body;
  }
}

// Registry — resolves the right adapter for the current page
const PLATFORM_REGISTRY = [
  new NetflixPlatform(),
  new DisneyPlusPlatform(),
  new PrimeVideoPlatform(),
  new CrunchyrollPlatform(),
  new ParamountPlatform(),
  new MaxPlatform(),
  new AppleTVPlatform(),
  new HuluPlatform(),
  new VikiPlatform(),
  new GenericPlatform(),
];

function resolvePlatform() {
  return PLATFORM_REGISTRY.find(p => p.detect()) || PLATFORM_REGISTRY[PLATFORM_REGISTRY.length - 1];
}
