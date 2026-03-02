/**
 * Sends a trimmed DOM snapshot to Gemini Nano and asks it to identify
 * CSS selectors for series metadata and skip buttons on this site.
 * Results are cached per domain (LearningStore + in-memory TTL) so the
 * AI prompt fires once per site, not on every scan cycle.
 */

class DOMScanner {
  constructor() {
    this._selectorCache = new Map();
    this._cacheTTL  = 10 * 60 * 1000;
    this._session   = null;
    this._initP     = null;
    this._scanning  = false;
    this._scanPromise = null;
  }

  // Public API

  async scan() {
    const domain = location.hostname;

    // LearningStore has data from a previous session — try that first
    const learned = await learningStore.getSelectors(domain);
    if (learned) {
      const result = this._applySelectors(learned);
      if (result.skipButtons.length > 0 || result.title) return result;
      // selectors no longer match anything, prune the dead ones
      for (const sel of learned.skipSelectors || []) {
        if (![...document.querySelectorAll(sel)].some(el => this._isVisible(el))) {
          await learningStore.removeSkipSelector(domain, sel);
        }
      }
    }

    const cached = this._getCached();
    if (cached) return this._applySelectors(cached);

    if (this._scanning) {
      if (this._scanPromise) return this._scanPromise;
      return null;
    }
    this._scanning = true;
    this._scanPromise = (async () => {
      try {
        const discovered = await this._aiDiscover();
        if (discovered) {
          this._setCached(discovered);
          await learningStore.saveSelectors(domain, discovered);
          return this._applySelectors(discovered);
        }
        return null;
      } finally {
        this._scanning = false;
        this._scanPromise = null;
      }
    })();
    return this._scanPromise;
  }

  invalidate() {
    this._selectorCache.delete(location.hostname);  // in-memory only, LearningStore keeps its data
  }

  async _aiDiscover() {
    const session = await this._getSession();
    if (!session) return null;

    const snapshot = this._buildSnapshot();
    if (!snapshot) return null;

    const prompt = `
You are analyzing the HTML of a streaming video page (site: ${location.hostname}).
Your job: find selectors or text patterns for:
  1. The SERIES TITLE — the SHOW name (e.g. "One Piece", "Breaking Bad"), NOT an episode title
  2. The EPISODE INFO — season/episode code or episode title (e.g. "S2E3", "E79")
  3. Any visible SKIP / NEXT buttons — buttons to skip intro, recap, credits, or go to next episode

HTML snapshot (trimmed, key attributes kept):
\`\`\`html
${snapshot}
\`\`\`

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "seriesSelector": "CSS selector for the SERIES TITLE element (not episode title), or null",
  "episodeSelector": "CSS selector for the episode info element, or null",
  "skipSelectors": ["CSS selector for skip/next button"],
  "skipTextPatterns": ["exact button text 1", "exact button text 2"],
  "notes": "brief reasoning (max 30 words)"
}

Critical rules:
- skipSelectors: prefer data-attribute selectors like [data-t="skip-intro"] — they survive React re-renders
- skipTextPatterns: list the EXACT visible text of skip/next buttons you see (e.g. "Skip Intro", "Intro \u00FCberspringen", "Weiter", "\u00DCberspringen", "Skip Recap", "Next Episode")
- For series title: NEVER use a selector that points to an episode name like "E79 - Title" — only the show name
- Crunchyroll skip buttons often have text "Skip Intro", "Skip Recap", "\u00DCberspringen" or data-t attributes
- If nothing found, use null / empty array
- Return ONLY the JSON object`;

    try {
      const raw = await session.prompt(prompt);
      const json = this._parseJSON(raw);
      if (!json) return null;

      return {
        seriesSelector:   typeof json.seriesSelector  === 'string' ? json.seriesSelector  : null,
        episodeSelector:  typeof json.episodeSelector === 'string' ? json.episodeSelector : null,
        skipSelectors:    Array.isArray(json.skipSelectors)    ? json.skipSelectors.filter(s => typeof s === 'string')    : [],
        skipTextPatterns: Array.isArray(json.skipTextPatterns) ? json.skipTextPatterns.filter(s => typeof s === 'string') : [],
      };
    } catch (e) {
      // session crashed — destroy and reset so next call gets a fresh one
      if (this._session) { try { this._session.destroy(); } catch {} }
      this._session = null;
      this._initP   = null;
      console.warn('[DOMScanner] AI discovery failed (session reset):', e.message);
      try { syncService.reportError({ domain: location.hostname, message: `DOMScanner AI failed: ${e.message?.slice(0, 150)}` }); } catch {}
      return null;
    }
  }

  /**
   * Ask Gemini Nano to split a raw page title into series + episode.
   * Returns { title, episode, source:'ai-title' } or null.
   * Results are cached per raw string for 5 min to avoid re-prompting on
   * every meta-retry tick.
   */
  async parseTitle(raw) {
    if (!raw) return null;

    // In-memory cache keyed by raw string
    if (!this._titleCache) this._titleCache = new Map();
    const cached = this._titleCache.get(raw);
    if (cached) return cached;

    const session = await this._getSession();
    if (!session) return null;

    const prompt =
      `You are a metadata parser for a streaming video page.\n` +
      `The raw browser tab title is: "${raw}"\n` +
      `Extract the SERIES NAME, EPISODE CODE, and EPISODE TITLE from it.\n` +
      `Rules:\n` +
      `- seriesTitle: the SHOW name only (e.g. "Hell's Paradise", "One Piece") — never include episode numbers or episode names\n` +
      `- episode: the episode code only (e.g. "E14", "S02E04") — null if not present\n` +
      `- episodeName: the episode title/name only (e.g. "Tagesanbruch und Stupor") — null if not present\n` +
      `- Ignore platform names like Crunchyroll, Netflix, Disney+, etc.\n` +
      `Respond ONLY with JSON, no markdown:\n` +
      `{"seriesTitle": "...", "episode": "..." or null, "episodeName": "..." or null}`;

    try {
      const raw_resp = await session.prompt(prompt);
      const json = this._parseJSON(raw_resp);
      if (!json?.seriesTitle) return null;
      const result = {
        title:       json.seriesTitle.trim(),
        episode:     typeof json.episode     === 'string' ? json.episode.trim()     : 'unknown',
        episodeName: typeof json.episodeName === 'string' ? json.episodeName.trim() : null,
        source:  'ai-title',
      };
      // Cache for 5 min
      this._titleCache.set(raw, result);
      setTimeout(() => this._titleCache?.delete(raw), 5 * 60 * 1000);
      return result;
    } catch {
      return null;
    }
  }

  _applySelectors({ seriesSelector, episodeSelector, skipSelectors, skipTextPatterns }) {
    let title   = null;
    let episode = null;
    const skipButtons = [];
    const seen = new Set();

    if (seriesSelector) {
      try { title = document.querySelector(seriesSelector)?.textContent?.trim() || null; } catch {}
    }
    if (episodeSelector) {
      try { episode = document.querySelector(episodeSelector)?.textContent?.trim() || null; } catch {}
    }

    for (const sel of (skipSelectors || [])) {
      try {
        const els = [...document.querySelectorAll(sel)]
          .filter(el => this._isVisible(el) && this._isSkipButtonPlausible(el));
        for (const el of els) { if (!seen.has(el)) { seen.add(el); skipButtons.push(el); } }
      } catch {}
    }

    // text patterns find buttons in React portals and other out-of-tree overlays
    if (skipTextPatterns?.length) {
      const patterns = skipTextPatterns.map(p => p.toLowerCase().trim());
      const interactive = document.querySelectorAll('button, [role="button"], [data-t], a');
      for (const el of interactive) {
        if (!this._isVisible(el)) continue;
        const elText = (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
        if (patterns.some(p => elText === p || elText.includes(p))) {
          if (!seen.has(el)) { seen.add(el); skipButtons.push(el); }
        }
      }
    }

    return { title, episode, skipButtons };
  }

  _buildSnapshot() {
    try {
      // Candidate roots: try many known player containers across platforms,
      // then fall back to full body.  Crunchyroll uses #velocity-player or
      // a top-level app wrapper; overlays (skip buttons) are often direct
      // children of <body> outside any player div.
      const playerRoot = document.querySelector(
        '#velocity-player, [data-t="player"], .video-player-wrapper, '
        + '.watch-video, #player, [class*="player-container"], '
        + '[data-uia="player-container"], [class*="VideoPlayer"], '
        + '[class*="vilos"], [id*="player"]'
      );

      // Also grab any fixed/absolute overlay elements — skip buttons often live here
      const overlayEls = [...document.querySelectorAll(
        '[class*="skip"], [class*="Skip"], [data-t*="skip"], '
        + '[aria-label*="Skip" i], [aria-label*="skip" i], '
        + '[class*="overlay"], [class*="Overlay"]'
      )].filter(el => {
        if (!el.textContent?.trim() && !el.getAttribute('aria-label')) return false;
        const s = getComputedStyle(el);
        const isPositioned = s.position === 'fixed' || s.position === 'absolute' || el.closest('[class*="skip" i]');
        if (!isPositioned) return false;
        // Only include overlay elements that are spatially near a video element.
        // This prevents sidebar/nav overlays (e.g. Twitch #side-nav) from polluting
        // the snapshot and misleading the AI into treating them as skip buttons.
        const vid = document.querySelector('video');
        if (vid) {
          const vr = vid.getBoundingClientRect();
          const er = el.getBoundingClientRect();
          const margin = 150;
          if (er.right  < vr.left   - margin ||
              er.left   > vr.right  + margin ||
              er.bottom < vr.top    - margin ||
              er.top    > vr.bottom + margin) return false;
        }
        return true;
      });

      // Build a combined root: player area + overlay snippets
      const root = playerRoot || document.body;

      // overlays (skip buttons) often live outside the player div, directly on <body>
      let overlayHtml = '';
      for (const ov of overlayEls.slice(0, 8)) {
        try { overlayHtml += ov.outerHTML + '\n'; } catch {}
      }

      const clone = root.cloneNode(true);

      // Remove noise
      for (const tag of ['script', 'style', 'svg', 'canvas', 'img', 'video', 'audio', 'noscript', 'iframe', 'link', 'object']) {
        clone.querySelectorAll(tag).forEach(el => el.remove());
      }

      clone.querySelectorAll('[aria-hidden="true"], [hidden]').forEach(el => el.remove());

      const KEEP_ATTRS = new Set(['class', 'id', 'data-uia', 'data-testid', 'data-t', 'data-qa',
        'data-automation-id', 'role', 'aria-label', 'type', 'tabindex', 'aria-hidden']);
      clone.querySelectorAll('*').forEach(el => {
        for (const attr of [...el.attributes]) {
          if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
        }
      });

      this._pruneEmptyNodes(clone);

      // Trim to max ~5000 chars (overlays prepended, rest from player)
      let html = clone.innerHTML || clone.outerHTML || '';
      html = html.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><').trim();

      if (overlayHtml) {
        const cleanOverlay = overlayHtml.replace(/\s{2,}/g, ' ').replace(/>\s+</g, '><').trim();
        html = '<!-- overlays -->\n' + cleanOverlay + '\n<!-- player -->\n' + html;
      }
      // Prepend structured-data context from <head> so the AI can use
      // LD+JSON VideoObject / TVEpisode data and OG meta tags to understand
      // the episode and show name even without visible DOM text.
      const metaContext = this._buildMetaContext();
      if (metaContext) html = '<!-- meta-context --\n' + metaContext + '\n<!-- /meta-context -->\n' + html;

      if (html.length > 5500) {
        html = html.slice(0, 5500) + '\n<!-- truncated -->';
      }

      return html || null;
    } catch (e) {
      return null;
    }
  }

  // Collect LD+JSON and OpenGraph meta tags from <head> into a compact
  // plain-text snippet that is prepended to the HTML snapshot.  This gives
  // the AI a reliable series/episode anchor independent of DOM structure.
  _buildMetaContext() {
    const parts = [];
    try {
      // OG / standard meta tags
      for (const m of document.querySelectorAll('meta[property], meta[name]')) {
        const key = m.getAttribute('property') || m.getAttribute('name') || '';
        const val = (m.getAttribute('content') || '').trim();
        if (!val) continue;
        if (/og:title|og:type|og:video|twitter:title|description|keywords/i.test(key)) {
          parts.push(`<meta ${key}="${val.slice(0, 120)}">`);
        }
      }
      // LD+JSON — grab just the first two (one TVEpisode + one BreadcrumbList is enough)
      let ldCount = 0;
      for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
        if (ldCount >= 2) break;
        const text = tag.textContent?.trim();
        if (text && text.length < 2000) { parts.push(text); ldCount++; }
      }
    } catch {}
    return parts.length ? parts.join('\n') : '';
  }

  _pruneEmptyNodes(root) {
    const INTERACTIVE = new Set(['button', 'a', 'input', 'select']);
    const walk = (node) => {
      if (node.nodeType !== 1) return;
      [...node.children].forEach(walk);
      const tag  = (node.tagName || '').toLowerCase();
      const text = (node.textContent || '').trim();
      const hasInteresting = node.getAttribute('aria-label') || node.getAttribute('data-uia')
        || node.getAttribute('data-testid') || node.getAttribute('data-t');
      if (!INTERACTIVE.has(tag) && !text && !hasInteresting && !node.children.length) {
        node.remove();
      }
    };
    walk(root);
  }

  async _getSession() {
    if (this._session) return this._session;
    if (this._initP)   return this._initP;
    try {
      if (!(await ssAI.isAvailable())) return null;

      this._initP = ssAI.createSession({
        systemPrompt: 'You are a precise HTML analysis assistant. Always respond with valid JSON only.',
      }).then(s => { this._session = s; this._initP = null; return s; })
        .catch(err => {
          this._initP = null;
          ssAI.resetCache(); // force re-check next time
          throw err;
        });
      return this._initP;
    } catch {
      return null;
    }
  }

  _getCached() {
    const entry = this._selectorCache.get(location.hostname);
    if (!entry) return null;
    if (Date.now() - entry.ts > this._cacheTTL) { this._selectorCache.delete(location.hostname); return null; }
    return entry;
  }

  _setCached(data) {
    this._selectorCache.set(location.hostname, { ...data, ts: Date.now() });
  }

  _parseJSON(raw) {
    try {
      const clean = raw.replace(/```json?|```/g, '').trim();
      return JSON.parse(clean);
    } catch {
      // Try to extract JSON object from freeform text
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { return JSON.parse(m[0]); } catch {}
      return null;
    }
  }

  _isVisible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.1) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
  }

  /**
   * Sanity-gate for selector-discovered skip button candidates.
   * Structural landmark elements (nav, sidebar, header …) and elements far
   * from the video player are never valid skip buttons.
   */
  _isSkipButtonPlausible(el) {
    // Must be an interactive element — not a layout container
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const isInteractive = tag === 'button' || tag === 'a'
      || role === 'button' || role === 'link'
      || el.hasAttribute('tabindex') || el.hasAttribute('data-t');
    if (!isInteractive) return false;

    // Skip buttons are compact — reject anything the size of a content section
    const r = el.getBoundingClientRect();
    if (r.width > 500 || r.height > 150) return false;

    if (el.closest(
      'nav, [role="navigation"], header, [role="banner"], ' +
      'aside, [role="complementary"], footer, [role="contentinfo"]'
    )) return false;

    const vid = document.querySelector('video');
    if (vid) {
      const vr = vid.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const margin = 150;
      if (er.right  < vr.left   - margin ||
          er.left   > vr.right  + margin ||
          er.bottom < vr.top    - margin ||
          er.top    > vr.bottom + margin) return false;
    }
    return true;
  }
}

// Singletons
const domScanner = new DOMScanner();
