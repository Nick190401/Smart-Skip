/**
 * Button classifier — Gemini Nano first, rule-based fallback for when AI
 * isn't available. The rule set covers 12 languages so it works everywhere.
 *
 * Returned types: 'intro' | 'recap' | 'credits' | 'ads' | 'next' | 'none'
 */

class AIClassifier {
  constructor() {
    this._session = null;       // Gemini Nano session (lazy)
    this._initPromise = null;   // ongoing init to deduplicate calls
    this._cache = new Map();    // button fingerprint → type  (avoid re-asking AI)
  }

  async classify(button) {
    const fp = this._fingerprint(button);
    if (this._cache.has(fp)) return this._cache.get(fp);

    // Fast rule-based first pass
    const ruleResult = this._ruleClassify(button);
    if (ruleResult.type !== 'none' && ruleResult.confidence >= 0.85) {
      this._cache.set(fp, ruleResult);
      return ruleResult;
    }

    // rule result is ambiguous, ask Gemini Nano
    if (await this._isAIAvailable()) {
      try {
        const aiResult = await this._aiClassify(button);
        if (aiResult.type !== 'none') {
          const merged = aiResult.confidence >= ruleResult.confidence ? aiResult : ruleResult;
          this._cache.set(fp, merged);
          return merged;
        }
      } catch (_) { /* fall through */ }
    }

    this._cache.set(fp, ruleResult);
    return ruleResult;
  }

  /** Synchronous classify, used where latency matters more than accuracy */
  classifySync(button) {
    const fp = this._fingerprint(button);
    if (this._cache.has(fp)) return this._cache.get(fp);
    const result = this._ruleClassify(button);
    this._cache.set(fp, result);
    return result;
  }

  async aiStatus() {
    return ssAI.availabilityStatus();
  }

  clearCache() { this._cache.clear(); }

  // Delegates to shared AI utility — cached 30 s internally.
  async _isAIAvailable() {
    return ssAI.isAvailable();
  }

  async _getSession() {
    if (this._session) return this._session;
    if (this._initPromise) return this._initPromise;

    this._initPromise = ssAI.createSession({
      systemPrompt: `You are a streaming-player UI classifier.
Given the text content and HTML attributes of a button, decide what category it belongs to.

Categories (respond with EXACTLY one word):
  intro   – button skips an opening / intro / theme / opening credits
  recap   – button skips a previousy-on / recap / Wiederholung / summary
  credits – button skips end credits / outro / Abspann
  ads     – button skips an advertisement or commercial
  next    – button starts the next episode
  none    – anything else (do not click this)

Rules:
- Language can be any (German, English, Spanish, French, etc.)
- If unsure, answer: none
- Answer only the single word, lowercase, no punctuation.`
    }).then(s => { this._session = s; return s; })
      .catch(err => {
        this._initPromise = null;
        throw err;
      });

    return this._initPromise;
  }

  async _aiClassify(button) {
    const session = await this._getSession();
    const text     = (button.textContent || '').trim().slice(0, 120);
    const aria     = button.getAttribute('aria-label') || '';
    const cls      = (button.className || '').toString().slice(0, 80);
    const dataAttrs = this._dataAttrSummary(button).slice(0, 80);

    const prompt =
`Button text: "${text}"
aria-label: "${aria}"
classes: "${cls}"
data-attrs: "${dataAttrs}"

Category?`;

    try {
      const raw = (await session.prompt(prompt)).trim().toLowerCase().replace(/[^a-z]/g, '');
      const VALID = ['intro', 'recap', 'credits', 'ads', 'next', 'none'];
      const type  = VALID.includes(raw) ? raw : 'none';
      return { type, confidence: type === 'none' ? 0 : 0.82, source: 'ai' };
    } catch (e) {
      // Session crashed (context overflow, GPU reset, etc.) — destroy and retry once.
      if (this._session) { try { this._session.destroy(); } catch {} }
      this._session = null;
      this._initPromise = null;
      try {
        const fresh = await this._getSession();
        const raw = (await fresh.prompt(prompt)).trim().toLowerCase().replace(/[^a-z]/g, '');
        const VALID = ['intro', 'recap', 'credits', 'ads', 'next', 'none'];
        const type  = VALID.includes(raw) ? raw : 'none';
        return { type, confidence: type === 'none' ? 0 : 0.82, source: 'ai' };
      } catch {
        throw e; // both attempts failed — let classify() fall back to rules
      }
    }
  }

  _ruleClassify(button) {
    const text  = this._buttonText(button);
    const attrs = this._dataAttrSummary(button);
    const cls   = (button.className || '').toString().toLowerCase();
    const combined = `${text} ${attrs} ${cls}`;

    const check = (patterns) => patterns.test(combined);

    if (button.getAttribute('data-uia') === 'next-episode-seamless-button')
      return { type: 'next', confidence: 1, source: 'rule' };
    if (button.getAttribute('data-uia') === 'watch-credits-seamless-button')
      return { type: 'none', confidence: 1, source: 'rule' }; // "Watch Credits" — never skip
    if (button.getAttribute('data-uia')?.includes('skip-intro'))
      return { type: 'intro', confidence: 1, source: 'rule' };
    if (button.getAttribute('data-uia')?.includes('skip-recap'))
      return { type: 'recap', confidence: 1, source: 'rule' };

    // Amazon
    if (cls.includes('atvwebplayersdk-skipelement'))
      return { type: 'intro', confidence: 0.95, source: 'rule' };

    // keyword patterns: EN / DE / ES / FR / PT / IT / NL / PL / RU / JA / KO / ZH
    if (check(/wiederholung|recap|previously|zusammenfassung|rückblick|resumen|résumé|resumo|riepilogo|samenvatting|podsumowanie|要約|요약|回顾/i))
      return { type: 'recap', confidence: 0.92, source: 'rule' };

    if (check(/intro|opening|vorspann|abertura|générique|apertura|オープニング|오프닝|片头/i))
      return { type: 'intro', confidence: 0.92, source: 'rule' };

    if (check(/credits|abspann|outro|ending|créditos|crédits|crediti|aftiteling|титры|クレジット|크레딧|片尾/i))
      return { type: 'credits', confidence: 0.88, source: 'rule' };

    // Ads: require BOTH an ad-related word AND a skip-intent word.
    // Matching "ad" alone is too broad — Twitch and other platforms have
    // ad-feedback / ad-info elements near the player that aren't skip buttons.
    const hasAdWord   = /\bad\b|advertisement|werbung|anzeige|anuncio|publicité|pubblicit|advertentie|reklama|реклама|広告|광고|广告/i.test(combined);
    const hasSkipIntent = /skip|überspringen|pular|saltar|passer|salta|overslaan|pomiń|пропустить|スキップ|건너뛰기|跳过/i.test(combined);
    if (hasAdWord && hasSkipIntent)
      return { type: 'ads', confidence: 0.88, source: 'rule' };

    // "Skip" / "überspringen" alone → unknown-skip, boost confidence by context
    const hasSkipWord = /skip|überspringen|pular|saltar|passer|salta|overslaan|pomiń|пропустить|スキップ|건너뛰기|跳过/i.test(combined);
    if (hasSkipWord) {
      if (/next|weiter|nächste/i.test(combined)) return { type: 'next',    confidence: 0.75, source: 'rule' };
      if (/end|close|schließen/i.test(combined)) return { type: 'credits', confidence: 0.65, source: 'rule' };
      return { type: 'intro', confidence: 0.60, source: 'rule' };  // most common
    }

    if (check(/next episode|nächste folge|nächste episode|siguiente episodio|prochain épisode/i))
      return { type: 'next', confidence: 0.90, source: 'rule' };

    return { type: 'none', confidence: 0, source: 'rule' };
  }

  _buttonText(el) {
    return [
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ].join(' ').toLowerCase().trim();
  }

  _dataAttrSummary(el) {
    return ['data-uia', 'data-testid', 'data-qa', 'data-automation-id']
      .map(a => el.getAttribute(a) || '').filter(Boolean).join(' ').toLowerCase();
  }

  /** Stable fingerprint for caching — avoids re-classifying the same button */
  _fingerprint(el) {
    return [
      el.tagName,
      el.className?.toString().slice(0, 60) || '',
      (el.textContent || '').trim().slice(0, 80),
      el.getAttribute('aria-label') || '',
      el.getAttribute('data-uia') || '',
      el.getAttribute('data-testid') || '',
    ].join('|');
  }

  /**
   * Classify a batch of buttons in a SINGLE AI prompt, with video context.
   * Much faster and more accurate than calling classify() once per button.
   * context = { videoTime: number|null, series: string|null, episode: string|null }
   * Returns an array of results in the same order as `buttons`.
   */
  async classifyBatch(buttons, context = {}) {
    if (!buttons.length) return [];

    const results = new Array(buttons.length).fill(null);

    // Fill from cache and run rule classifier for all
    const needsAI = [];
    for (let i = 0; i < buttons.length; i++) {
      const fp = this._fingerprint(buttons[i]);
      if (this._cache.has(fp)) {
        results[i] = this._cache.get(fp);
      } else {
        const rule = this._ruleClassify(buttons[i]);
        results[i] = rule;
        if (rule.confidence < 0.85) needsAI.push(i);
      }
    }

    if (!needsAI.length || !(await this._isAIAvailable())) {
      for (let i = 0; i < buttons.length; i++) {
        if (!this._cache.has(this._fingerprint(buttons[i]))) {
          this._cache.set(this._fingerprint(buttons[i]), results[i]);
        }
      }
      return results;
    }

    // Build one prompt with all ambiguous buttons + full context
    const timeCtx  = context.videoTime != null ? `${Math.round(context.videoTime)}s into the episode` : 'unknown timestamp';
    const mediaCtx = context.series
      ? `Series: "${context.series}"${context.episode ? `, episode ${context.episode}` : ''}`
      : 'streaming video';

    const buttonLines = needsAI.map((i, idx) => {
      const btn  = buttons[i];
      const text = (btn.textContent || '').trim().slice(0, 60);
      const aria = (btn.getAttribute('aria-label') || '').slice(0, 60);
      const data = this._dataAttrSummary(btn).slice(0, 60);
      return `${idx}: text="${text}" aria="${aria}" data="${data}"`;
    }).join('\n');

    const prompt =
`Streaming player. ${mediaCtx}. Video position: ${timeCtx}.
Classify each UI button. For each output exactly one line: INDEX:CATEGORY:CONFIDENCE(0-100)
Categories: intro recap credits ads next none
${buttonLines}`;

    try {
      const session = await this._getSession();
      if (!session) throw new Error('no session');
      const raw = await session.prompt(prompt);
      for (const line of raw.trim().split('\n')) {
        const m = line.match(/(\d+):([a-z]+):(\d+)/);
        if (!m) continue;
        const localIdx  = parseInt(m[1]);
        const origIdx   = needsAI[localIdx];
        if (origIdx == null) continue;
        const VALID = ['intro','recap','credits','ads','next','none'];
        const type  = VALID.includes(m[2]) ? m[2] : 'none';
        const conf  = Math.min(1, parseInt(m[3]) / 100);
        const aiRes = { type, confidence: conf, source: 'ai-batch' };
        // Keep whichever is more confident
        results[origIdx] = conf >= (results[origIdx]?.confidence ?? 0) ? aiRes : results[origIdx];
        this._cache.set(this._fingerprint(buttons[origIdx]), results[origIdx]);
      }
    } catch {
      // batch failed — no-op, rule results already in array
    }

    // Cache any that weren't covered by AI response
    for (let i = 0; i < buttons.length; i++) {
      if (!this._cache.has(this._fingerprint(buttons[i]))) {
        this._cache.set(this._fingerprint(buttons[i]), results[i]);
      }
    }
    return results;
  }
}

const aiClassifier = new AIClassifier();
