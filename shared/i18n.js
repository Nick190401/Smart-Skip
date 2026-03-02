/**
 * i18n — EN and DE are built-in, everything else gets translated once
 * by Gemini Nano and cached in chrome.storage.local for 30 days.
 * Falls back to English if AI isn't available.
 *
 * Usage:  await i18n.init();  then  i18n.t('saveBtn')
 */

// English base strings (source of truth)
const I18N_EN = {
  // Header
  loading:               'Loading…',
  aiReady:               'Gemini AI',
  aiDownloading:         'AI (DL)',
  aiRule:                'Smart',

  // Series card
  sectionCurrentSeries:  'Current Series',
  seriesLabel:           'Series',
  noSeriesDetected:      'None detected',
  lastSkipped:           '⏭ Last skipped:',

  // Section headings
  sectionGlobal:         'Global',
  sectionSeriesDefault:  'Series — Default',
  seriesHeadingPrefix:   'Series',
  sectionEpisodeOverride:'Episode — Override',
  episodeHeadingPrefix:  'Episode',
  episodeOverrideReset:  'Reset',
  episodeInheritNote:    'All values inherited from series — override here:',
  episodeOverrideActive: 'Episode override active (blue = differs from series):',
  episodeOnly:           'this episode only',

  // Global toggles
  toggleEnabled:         'Extension active',
  toggleEnabledDesc:     'Enable/disable Smart Skip globally',
  toggleHUD:             'Show HUD',
  toggleHUDDesc:         'Small overlay in the player',
  toggleBadge:           'Skip badge',
  toggleBadgeDesc:       'Show today\'s skip count on the extension icon',
  toggleCloudSync:       'Cloud Sync',
  toggleCloudSyncDesc:   'Share anonymous data to improve detection for everyone',
  toggleDomainEnabled:   'Active on this site',
  toggleDomainEnabledDesc:'Disable Smart Skip for this domain only',

  // Skip toggles
  toggleSkipIntro:       'Skip intro',
  toggleSkipIntroDesc:   'Opening / title sequence',
  toggleSkipRecap:       'Skip recap',
  toggleSkipRecapDesc:   'Previously on…',
  toggleSkipCredits:     'Skip credits',
  toggleSkipCreditsDesc: 'Credits / outro',
  toggleSkipAds:         'Skip ads',
  toggleSkipAdsDesc:     'Skip-Ad buttons',
  toggleAutoNext:        'Auto next episode',
  toggleAutoNextDesc:    'Auto-Next episode',

  // Episode toggles (short labels)
  epLabelIntro:          'Intro',
  epLabelRecap:          'Recap',
  epLabelCredits:        'Credits',
  epLabelAds:            'Ads',
  epLabelNext:           'Next',

  // Buttons
  saveBtn:               'Save settings',
  toastSaved:            'Saved ✓',
  deleteMyData:          'Delete cloud data',
  deleteMyDataDesc:      'Remove selectors, timings & statistics',
  deleteMyDataBtn:       'Delete',
  deleteMyDataTitle:     'Delete cloud data?',
  deleteMyDataConfirm:   'All your anonymous cloud data (selectors, timings, statistics) will be permanently deleted.',
  deleteMyDataConfirmBtn:'Delete permanently',
  deleteMyDataDone:      'Cloud data deleted.',
  deleteMyDataError:     'Deletion failed. Are you online?',
  cancel:                'Cancel',

  // Insights
  insightsTitle:         'Insights',
  insightsLoading:       'loading…',
  insightsEmpty:         'No AI data for this domain yet.',
  insightsSelectors:     'Detected Selectors',
  insightsFeedback:      'Click Feedback',
  insightsTimings:       'Timing Windows',
  insightsClearBtn:      'Reset domain',
  insightsRefreshBtn:    '↻ Refresh',
  insightsDataPoints:    'data points',

  // HUD button types
  hudIntro:              'Intro',
  hudRecap:              'Recap',
  hudCredits:            'Credits',
  hudAds:                'Ad',
  hudNext:               'Next',

  // Popup stats
  statTotalLabel:        'Skipped',
  justNow:               'just now',

  // Consent banner
  consentTitle:          'Privacy & Data Sharing',
  consentBody:           'Smart Skip can share anonymous usage data to help improve skip detection for all users. No personal data is ever collected.',
  consentPoint1:         'Anonymous device ID (no name, no email, no IP stored)',
  consentPoint2:         'Which skip buttons were detected and clicked',
  consentPoint3:         'Video timestamps (when does the intro start?)',
  consentNote:           'You can change this at any time in the extension settings.',
  consentYes:            '✓ Yes, help improve',
  consentNo:             'No, local only',

  // Popup dynamic strings
  updateRequired:        'Update required',
  updateMinVersion:      'Minimum version: v{min} — your version: v{cur}',
  agoMinutes:            '{n} min ago',
  agoHours:              '{n} hrs ago',
  domainCacheCleared:    'Domain cache cleared',
  scanStarted:           'Scan started…',
  noPlayerFound:         'No active player found',
  snoozedForMin:         'Paused for {n} min',
  snoozedForHour:        'Paused for 1 hr',
  snoozeCancelled:       'Snooze cancelled',
  snoozeRemainingMin:    'Paused for {n} min remaining',
  snoozeRemainingHour:   'Paused for {n} hrs remaining',
  snoozeLabel:           'Pause',
  snoozeDescText:        'Briefly disable auto-skip',
  noActiveTab:           'No active tab detected.',
  unsupportedBlocked:    'Smart Skip is not active on this platform. Global settings and statistics remain available.',
  unsupportedUnknown:    'No streaming content detected on this page. Smart Skip activates when you open a supported platform — e.g. Netflix, Disney+, Prime Video or Crunchyroll.',
  domainNotSupported:    '{domain} — not supported',
  copy:                  'Copy',
  copied:                '✔ Copied',
  statTodayLabel:        'Today',
  scanNowBtn:            'Now',
  broadcastMore:         'Learn\u00A0more',
  broadcastDismiss:      'Close',

  // Status dot
  statusAiActive:        'AI active',
  statusRules:           'Rules',
  statusInactive:        'Inactive',
  tooltipAiReady:        'Gemini Nano active ✓ — AI-powered detection running',
  tooltipAiPending:      'Gemini Nano downloading… Rule-based detection active until ready.',
  tooltipAiOff:          'AI unavailable — Rule-based mode active.\nEnable Gemini Nano:\n① chrome://flags/#optimization-guide-on-device-model → Enabled BypassPerfRequirement\n② chrome://flags/#prompt-api-for-gemini-nano-multimodal-input → Enabled\n③ Restart browser',
  tooltipInactive:       'Smart Skip is not active on this page.',

  // HUD source labels
  hudSourceAI:           'AI',
  hudSourceRule:         'Rule',

  // AI translation notice
  aiTranslationHint:     'Do not translate: Smart Skip, HUD, Intro, Recap, Credits, CSS selectors, S01E01.',
};

// German built-in
const I18N_DE = {
  loading:               'Lädt…',
  aiReady:               'Gemini AI',
  aiDownloading:         'AI (DL)',
  aiRule:                'Smart',

  sectionCurrentSeries:  'Aktuelle Serie',
  seriesLabel:           'Serie',
  noSeriesDetected:      'Keine erkannt',
  lastSkipped:           '⏭ Zuletzt übersprungen:',

  sectionGlobal:         'Global',
  sectionSeriesDefault:  'Serie — Standard',
  seriesHeadingPrefix:   'Serie',
  sectionEpisodeOverride:'Folge — Override',
  episodeHeadingPrefix:  'Folge',
  episodeOverrideReset:  'Reset',
  episodeInheritNote:    'Alle Werte von Serie geerbt — hier überschreiben:',
  episodeOverrideActive: 'Folgen-Override aktiv (blaue Felder weichen von Serie ab):',
  episodeOnly:           'nur diese Folge',

  toggleEnabled:         'Extension aktiv',
  toggleEnabledDesc:     'Smart Skip global ein-/ausschalten',
  toggleHUD:             'HUD anzeigen',
  toggleHUDDesc:         'Kleines Overlay im Player',
  toggleBadge:           'Skip-Badge',
  toggleBadgeDesc:       'Heutige Skips am Extension-Icon anzeigen',
  toggleCloudSync:       'Cloud-Sync',
  toggleCloudSyncDesc:   'Anonym zur besseren Erkennung für alle beitragen',
  toggleDomainEnabled:   'Auf dieser Seite aktiv',
  toggleDomainEnabledDesc:'Smart Skip nur für diese Domain deaktivieren',

  toggleSkipIntro:       'Intro überspringen',
  toggleSkipIntroDesc:   'Vorspann / Opening',
  toggleSkipRecap:       'Wiederholung überspringen',
  toggleSkipRecapDesc:   'Previously on / Recap',
  toggleSkipCredits:     'Abspann überspringen',
  toggleSkipCreditsDesc: 'Credits / Outro',
  toggleSkipAds:         'Werbung überspringen',
  toggleSkipAdsDesc:     'Skip-Ad Buttons',
  toggleAutoNext:        'Nächste Folge automatisch',
  toggleAutoNextDesc:    'Auto-Next Episode',

  epLabelIntro:          'Intro',
  epLabelRecap:          'Wiederholung',
  epLabelCredits:        'Abspann',
  epLabelAds:            'Werbung',
  epLabelNext:           'Weiter',

  saveBtn:               'Einstellungen speichern',
  toastSaved:            'Gespeichert ✓',
  deleteMyData:          'Cloud-Daten löschen',
  deleteMyDataDesc:      'Selektoren, Timings & Statistiken entfernen',
  deleteMyDataBtn:       'Löschen',
  deleteMyDataTitle:     'Cloud-Daten löschen?',
  deleteMyDataConfirm:   'Alle anonymen Cloud-Daten (Selektoren, Timings, Statistiken) werden unwiderruflich gelöscht.',
  deleteMyDataConfirmBtn:'Unwiderruflich löschen',
  deleteMyDataDone:      'Cloud-Daten gelöscht.',
  deleteMyDataError:     'Löschen fehlgeschlagen. Bist du online?',
  cancel:                'Abbrechen',

  insightsTitle:         'Erkenntnisse',
  insightsLoading:       'lädt…',
  insightsEmpty:         'Noch keine KI-Daten für diese Domain.',
  insightsSelectors:     'Erkannte Selektoren',
  insightsFeedback:      'Klick-Feedback',
  insightsTimings:       'Timing-Fenster',
  insightsClearBtn:      'Domain zurücksetzen',
  insightsRefreshBtn:    '↻ Aktualisieren',
  insightsDataPoints:    'Punkte',

  hudIntro:              'Intro',
  hudRecap:              'Recap',
  hudCredits:            'Credits',
  hudAds:                'Werbung',
  hudNext:               'Weiter',

  // Popup stats
  statTotalLabel:        'Übersprungen',
  justNow:               'gerade eben',

  // Consent banner
  consentTitle:          'Datenschutz & Datenfreigabe',
  consentBody:           'Smart Skip kann anonyme Nutzungsdaten teilen, um die Erkennung für alle Nutzer zu verbessern. Es werden keine persönlichen Daten erhoben.',
  consentPoint1:         'Anonyme Geräte-ID (kein Name, keine E-Mail, keine IP-Speicherung)',
  consentPoint2:         'Welche Skip-Schaltflächen erkannt und geklickt wurden',
  consentPoint3:         'Zeitpunkte im Video (wann beginnt der Intro?)',
  consentNote:           'Jederzeit in den Einstellungen änderbar.',
  consentYes:            '✓ Ja, helfen',
  consentNo:             'Nein, nur lokal',

  // Popup dynamic strings
  updateRequired:        'Update erforderlich',
  updateMinVersion:      'Mindestversion: v{min} — deine Version: v{cur}',
  agoMinutes:            'vor {n} Min',
  agoHours:              'vor {n} Std',
  domainCacheCleared:    'Domain-Cache gelöscht',
  scanStarted:           'Scan gestartet…',
  noPlayerFound:         'Kein aktiver Player gefunden',
  snoozedForMin:         'Pausiert für {n} Min',
  snoozedForHour:        'Pausiert für 1 Std',
  snoozeCancelled:       'Snooze aufgehoben',
  snoozeRemainingMin:    'Pausiert noch {n} Min',
  snoozeRemainingHour:   'Pausiert noch {n} Std',
  snoozeLabel:           'Pausieren',
  snoozeDescText:        'Auto-Skip kurz deaktivieren',
  noActiveTab:           'Kein aktiver Tab erkannt.',
  unsupportedBlocked:    'Smart Skip ist auf dieser Plattform nicht aktiv. Die globalen Einstellungen und Statistiken sind weiterhin verfügbar.',
  unsupportedUnknown:    'Auf dieser Seite wurde kein Streaming-Inhalt erkannt. Smart Skip wird aktiv, sobald du eine unterstützte Plattform öffnest — z.\u00A0B. Netflix, Disney+, Prime Video oder Crunchyroll.',
  domainNotSupported:    '{domain} — nicht unterstützt',
  copy:                  'Kopieren',
  copied:                '✔ Kopiert',
  statTodayLabel:        'Heute',
  scanNowBtn:            'Jetzt',
  broadcastMore:         'Mehr\u00A0erfahren',
  broadcastDismiss:      'Schließen',

  // Status dot
  statusAiActive:        'KI aktiv',
  statusRules:           'Regeln',
  statusInactive:        'Inaktiv',
  tooltipAiReady:        'Gemini Nano aktiv ✓ — KI-gestützte Erkennung läuft',
  tooltipAiPending:      'Gemini Nano wird heruntergeladen… Regelbasierte Erkennung aktiv bis es fertig ist.',
  tooltipAiOff:          'KI nicht verfügbar — Regelbasierter Modus aktiv.\nGemini Nano aktivieren:\n① chrome://flags/#optimization-guide-on-device-model → Enabled BypassPerfRequirement\n② chrome://flags/#prompt-api-for-gemini-nano-multimodal-input → Enabled\n③ Browser neu starten',
  tooltipInactive:       'Smart Skip ist auf dieser Seite nicht aktiv.',

  // HUD source labels
  hudSourceAI:           'KI',
  hudSourceRule:         'Regel',
};

// Language name map for AI prompt
const LANG_NAMES = {
  af:'Afrikaans', ar:'Arabic', bg:'Bulgarian', bn:'Bengali', ca:'Catalan',
  cs:'Czech', cy:'Welsh', da:'Danish', el:'Greek', es:'Spanish',
  et:'Estonian', fa:'Persian', fi:'Finnish', fr:'French', ga:'Irish',
  gl:'Galician', gu:'Gujarati', he:'Hebrew', hi:'Hindi', hr:'Croatian',
  hu:'Hungarian', hy:'Armenian', id:'Indonesian', is:'Icelandic',
  it:'Italian', ja:'Japanese', ka:'Georgian', kn:'Kannada', ko:'Korean',
  lt:'Lithuanian', lv:'Latvian', mk:'Macedonian', ml:'Malayalam',
  mr:'Marathi', ms:'Malay', mt:'Maltese', nl:'Dutch', no:'Norwegian',
  pa:'Punjabi', pl:'Polish', pt:'Portuguese', ro:'Romanian',
  ru:'Russian', sk:'Slovak', sl:'Slovenian', sq:'Albanian',
  sr:'Serbian', sv:'Swedish', sw:'Swahili', ta:'Tamil', te:'Telugu',
  th:'Thai', tl:'Filipino', tr:'Turkish', uk:'Ukrainian', ur:'Urdu',
  vi:'Vietnamese', zh:'Chinese', zu:'Zulu',
};


class I18nService {
  constructor() {
    this._lang    = 'en';
    this._strings = null;
    this._promise = null;
  }

  /**
   * Must be awaited before calling t().
   * Safe to call multiple times — resolves immediately after first call.
   */
  init() {
    if (!this._promise) this._promise = this._load();
    return this._promise;
  }

  /** Translate a key. Falls back to English if key missing. */
  t(key) {
    const s = this._strings || I18N_EN;
    return s[key] ?? I18N_EN[key] ?? key;
  }

  /** Current ISO 639-1 language code (e.g. "de", "fr") */
  get lang() { return this._lang; }

  // Internal

  async _load() {
    const full = (navigator.language || 'en').toLowerCase();
    const lang = full.split('-')[0];
    this._lang = lang;

    // Built-in languages — no AI needed
    if (lang === 'en') { this._strings = { ...I18N_EN }; return; }
    if (lang === 'de') { this._strings = { ...I18N_DE }; return; }

    // Check persistent cache
    try {
      const cacheKey = `ss2_i18n_${lang}`;
      const stored   = await chrome.storage.local.get(cacheKey);
      if (stored[cacheKey] && Object.keys(stored[cacheKey]).length > 10) {
        this._strings = { ...I18N_EN, ...stored[cacheKey] };
        // Refresh cache in background if older than 30 days
        const meta = await chrome.storage.local.get(`${cacheKey}_ts`);
        const age  = Date.now() - (meta[`${cacheKey}_ts`] || 0);
        if (age > 30 * 86400_000) this._translateAndCache(lang, cacheKey);
        return;
      }
    } catch (_) {}

    // Try AI translation
    const translated = await this._translateWithAI(lang);
    if (translated) {
      this._strings = { ...I18N_EN, ...translated };
      try {
        const cacheKey = `ss2_i18n_${lang}`;
        await chrome.storage.local.set({
          [cacheKey]:        translated,
          [`${cacheKey}_ts`]: Date.now(),
        });
      } catch (_) {}
      return;
    }

    // Ultimate fallback: English
    this._strings = { ...I18N_EN };
  }

  async _translateWithAI(lang) {
    try {
      if (!(await ssAI.isAvailable())) return null;

      const langName = LANG_NAMES[lang] || lang.toUpperCase();

      // Build source object: exclude internal-only keys
      const source = { ...I18N_EN };
      delete source.aiTranslationHint;

      const prompt =
        `Translate the following JSON UI strings for a streaming video extension into ${langName}.\n` +
        `Rules:\n` +
        `- Return ONLY a valid JSON object with the SAME keys\n` +
        `- Keep these words exactly as-is: Smart Skip, HUD, Intro, Recap, Credits, AI, Gemini, S01E01\n` +
        `- Keep translations short and natural for a browser extension UI\n` +
        `- Do NOT add explanations or markdown\n\n` +
        JSON.stringify(source);

      const session = await ssAI.createSession({
        outputLang: lang,
        temperature: 0.2,
        topK: 10,
      });
      const response = await session.prompt(prompt);
      session.destroy();

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      // Validate: must have at least 80% of expected keys
      const expected = Object.keys(I18N_EN).length;
      const got      = Object.keys(parsed).length;
      if (got < expected * 0.8) return null;

      return parsed;
    } catch (_) {
      return null;
    }
  }

  // Background refresh after cache expiry
  _translateAndCache(lang, cacheKey) {
    this._translateWithAI(lang).then(translated => {
      if (translated) {
        chrome.storage.local.set({
          [cacheKey]:        translated,
          [`${cacheKey}_ts`]: Date.now(),
        });
      }
    }).catch(() => {});
  }
}

// Singleton
const i18n = new I18nService();
