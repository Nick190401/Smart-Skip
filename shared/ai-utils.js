/**
 * Shared AI utility — single source of truth for Gemini Nano availability
 * checks and session creation. Other modules (ai-classifier, dom-scanner,
 * signal-collector, timing-skipper, i18n) delegate to this instead of each
 * duplicating the Chrome 138+ / <138 API dance.
 *
 * Usage:
 *   if (await ssAI.isAvailable()) { ... }
 *   const session = await ssAI.createSession({ systemPrompt, temperature, topK, outputLang });
 *   // ...use session.prompt()...
 *   session.destroy();
 */

const ssAI = (() => {
  let _available  = null;   // null = unchecked, true/false after probe
  let _checkedAt  = 0;      // timestamp of last probe
  const _AI_OPTS  = {
    expectedInputs:  [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };

  /**
   * Returns the raw LanguageModel API reference, or null.
   * Chrome 138+: window.LanguageModel
   * Chrome <138:  window.ai.languageModel
   */
  function _api() {
    return window.LanguageModel || window.ai?.languageModel || null;
  }

  /**
   * Check if Gemini Nano is available for inference right now.
   * Result is cached for 30 s so callers don't hammer the API.
   * Returns false while the model is still downloading.
   */
  async function isAvailable() {
    const now = Date.now();
    if (_available !== null && now - _checkedAt < 30_000) return _available;
    try {
      const api = _api();
      if (!api) {
        if (_available !== false) {
          console.info(
            '[SmartSkip] Gemini Nano not available.\n'
            + '  → chrome://flags/#optimization-guide-on-device-model → Enabled BypassPerfRequirement\n'
            + '  → chrome://flags/#prompt-api-for-gemini-nano-multimodal-input → Enabled\n'
            + '  Then restart the browser and reload the page.'
          );
        }
        _available = false;
        _checkedAt = now;
        return false;
      }

      let status;
      if (window.LanguageModel) {
        status = await window.LanguageModel.availability(_AI_OPTS);
      } else {
        ({ available: status } = await api.capabilities());
      }

      _available = status !== 'unavailable' && status !== 'no';
      const pending = status === 'downloadable' || status === 'downloading' || status === 'after-download';
      if (pending) _available = false; // re-check later once downloaded
      _checkedAt = now;

      if (_available) {
        console.info(`[SmartSkip] Gemini Nano available (${status}) ✔`);
      }
    } catch {
      _available = false;
      _checkedAt = now;
    }
    return _available;
  }

  /**
   * Return the raw availability status string without caching logic.
   * Used by popup and content script to display AI badge / dot.
   */
  async function availabilityStatus() {
    try {
      if (window.LanguageModel) return await window.LanguageModel.availability(_AI_OPTS);
      if (window.ai?.languageModel) {
        const { available } = await window.ai.languageModel.capabilities();
        return available;
      }
    } catch { /* fall through */ }
    return 'unavailable';
  }

  /**
   * Create a new LanguageModel session.
   * @param {object} opts
   * @param {string} opts.systemPrompt
   * @param {number} [opts.temperature]  defaults to undefined (API default)
   * @param {number} [opts.topK]         defaults to undefined
   * @param {string} [opts.outputLang]   ISO 639-1 code (default 'en')
   * @returns {Promise<object>} session with .prompt() and .destroy()
   */
  async function createSession({ systemPrompt, temperature, topK, outputLang } = {}) {
    const api = _api();
    if (!api) throw new Error('AI API unavailable');
    const lang = outputLang || 'en';
    const opts = {
      expectedInputs:  [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: [lang] }],
      ...(systemPrompt != null && { systemPrompt }),
      ...(temperature  != null && { temperature }),
      ...(topK         != null && { topK }),
    };
    return api.create(opts);
  }

  /**
   * Force reset the availability cache.
   * Useful after a failed session creation to allow immediate re-check.
   */
  function resetCache() {
    _available = null;
    _checkedAt = 0;
  }

  return { isAvailable, availabilityStatus, createSession, resetCache };
})();
