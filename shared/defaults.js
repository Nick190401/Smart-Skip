/**
 * Settings shape, shared by background, popup and content scripts.
 *
 * These lived in three places and had already drifted apart — popup was missing
 * verboseLogging, the content script was missing badgeEnabled — so a toggle
 * could render from a shape that did not match what the background persisted.
 *
 * Plain globals rather than modules: content scripts cannot use ESM declaratively.
 */

const SS2_DEFAULTS = Object.freeze({
  globalEnabled:  true,
  hudEnabled:     true,
  badgeEnabled:   true,
  verboseLogging: false,
  domains:        {},   // hostname → { enabled }
  series:         {},   // "host:Title" → series settings
  episodes:       {},   // "host:Title:S01E01" → sparse overrides
});

const SS2_SERIES_DEFAULTS = Object.freeze({
  skipIntro: true, skipRecap: true, skipCredits: true, skipAds: true, autoNext: false,
});

// Frozen above, so hand out copies. Nested objects are shared by reference on
// purpose: callers replace them wholesale, never mutate in place.
const ss2Defaults       = () => ({ ...SS2_DEFAULTS, domains: {}, series: {}, episodes: {} });
const ss2SeriesDefaults = () => ({ ...SS2_SERIES_DEFAULTS });
