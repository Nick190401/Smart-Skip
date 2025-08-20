// Language Manager for Smart Skip Extension
class LanguageManager {
  constructor() {
    this.currentLanguage = null;
    this.translations = {
      de: {
        // Extension Name
        extensionName: "Smart Skip",
        
        // Popup Header
        popupTitle: "Smart Skip",
        currentSeries: "Aktuelle Serie",
        noSeriesDetected: "Keine Serie erkannt",
        unsupportedSite: "Diese Website wird nicht unterstützt",
        unsupportedSiteTitle: "Nicht unterstützte Website",
        unsupportedSiteDesc: "Diese Extension funktioniert nur auf:",
        unsupportedSiteHint: "Gehe zu einer Streaming-Website, um die Extension zu nutzen",
        supportedPlatforms: "Netflix, Disney+, Prime Video, YouTube<br>🎭 Crunchyroll, Hulu, Apple TV+, HBO Max<br>📺 und weiteren Streaming-Plattformen",
        
        // Settings
        settingsTitle: "Einstellungen",
        globalSettings: "Globale Einstellungen",
        extensionEnabled: "Extension aktiviert",
        domainEnabled: "Für diese Website",
        domainEnabledDesc: "Spezielle Einstellung für aktuelle Website",
        
        // Skip Options
        skipOptions: "Skip-Optionen",
        skipIntro: "Intro überspringen",
        skipRecap: "Zusammenfassung überspringen",
        skipCredits: "Abspann überspringen", 
        skipAds: "Werbung überspringen",
        autoNext: "Nächste Folge automatisch",
        
        // Series Settings
        seriesSettings: "Serien-Einstellungen",
        seriesSettingsDesc: "Einstellungen werden automatisch für jede erkannte Serie gespeichert",
        
        // Language Settings
        languageSettings: "Sprache",
        languageSettingsDesc: "Interface-Sprache wählen",
        languageAuto: "Automatisch (Browser-Sprache)",
        languageGerman: "Deutsch",
        languageEnglish: "English",
        
        // Buttons
        saveSettings: "Einstellungen speichern",
        reloadButton: "Neuladen",
        
        // Status Messages
        settingsSaved: "Einstellungen gespeichert",
        settingsSavedTemp: "Temporär gespeichert",
        saveFailed: "Speichern fehlgeschlagen",
        
        // Episode States
        browsing: "durchsuchen",
        playing: "läuft",
        unknown: "unbekannt",
        
        // Platform Messages
        platformSupported: "Diese Plattform wird unterstützt",
        platformNotSupported: "Diese Plattform wird nicht unterstützt",
        
        // Tooltips
        tooltipIntro: "Überspringe automatisch Intro-Sequenzen",
        tooltipRecap: "Überspringe 'Bisher geschah...' Zusammenfassungen",
        tooltipCredits: "Überspringe Abspann und Credits",
        tooltipAds: "Überspringe Werbeanzeigen (immer aktiv)",
        tooltipAutoNext: "Gehe automatisch zur nächsten Folge"
      },
      
      en: {
        // Extension Name
        extensionName: "Smart Skip",
        
        // Popup Header
        popupTitle: "Smart Skip",
        currentSeries: "Current Series",
        noSeriesDetected: "No series detected",
        unsupportedSite: "This website is not supported",
        unsupportedSiteTitle: "Unsupported Website",
        unsupportedSiteDesc: "This extension only works on:",
        unsupportedSiteHint: "Go to a streaming website to use the extension",
        supportedPlatforms: "Netflix, Disney+, Prime Video, YouTube<br>🎭 Crunchyroll, Hulu, Apple TV+, HBO Max<br>📺 and other streaming platforms",
        
        // Settings
        settingsTitle: "Settings",
        globalSettings: "Global Settings",
        extensionEnabled: "Extension enabled",
        domainEnabled: "For this website",
        domainEnabledDesc: "Special setting for current website",
        
        // Skip Options
        skipOptions: "Skip Options",
        skipIntro: "Skip Intro",
        skipRecap: "Skip Recap", 
        skipCredits: "Skip Credits",
        skipAds: "Skip Ads",
        autoNext: "Auto Next Episode",
        
        // Series Settings
        seriesSettings: "Series Settings",
        seriesSettingsDesc: "Settings are automatically saved for each detected series",
        
        // Language Settings
        languageSettings: "Language",
        languageSettingsDesc: "Choose interface language",
        languageAuto: "Auto (Browser Language)",
        languageGerman: "Deutsch",
        languageEnglish: "English",
        
        // Buttons
        saveSettings: "Save Settings",
        reloadButton: "Reload",
        
        // Status Messages
        settingsSaved: "Settings saved",
        settingsSavedTemp: "Saved temporarily",
        saveFailed: "Save failed",
        
        // Episode States
        browsing: "browsing",
        playing: "playing",
        unknown: "unknown",
        
        // Platform Messages
        platformSupported: "This platform is supported",
        platformNotSupported: "This platform is not supported",
        
        // Tooltips
        tooltipIntro: "Automatically skip intro sequences",
        tooltipRecap: "Skip 'previously on...' summaries",
        tooltipCredits: "Skip end credits and closing sequences",
        tooltipAds: "Skip advertisements (always active)",
        tooltipAutoNext: "Automatically advance to next episode"
      }
    };
  }
  
  // Auto-detect browser language
  detectBrowserLanguage() {
    const browserLang = navigator.language || navigator.userLanguage || 'en';
    const langCode = browserLang.toLowerCase().split('-')[0];
    return this.translations[langCode] ? langCode : 'en';
  }
  
  // Load language preference from storage
  async loadLanguagePreference() {
    try {
      let languageSettings = null;
      
      // Try sync storage first
      try {
        if (chrome.storage && chrome.storage.sync) {
          const result = await chrome.storage.sync.get(['smartSkipLanguage']);
          if (result.smartSkipLanguage) {
            languageSettings = result.smartSkipLanguage;
          }
        }
      } catch (syncError) {
        // Sync storage failed - try other methods
      }
      
      // Try local storage if sync failed
      if (!languageSettings) {
        try {
          if (chrome.storage && chrome.storage.local) {
            const result = await chrome.storage.local.get(['smartSkipLanguage']);
            if (result.smartSkipLanguage) {
              languageSettings = result.smartSkipLanguage;
            }
          }
        } catch (localError) {
          // Local storage failed
        }
      }
      
      if (languageSettings && languageSettings.language) {
        this.currentLanguage = languageSettings.language;
      } else {
        // Auto-detect if no preference saved
        this.currentLanguage = 'auto';
      }
    } catch (error) {
      this.currentLanguage = 'auto';
    }
  }
  
  // Save language preference
  async saveLanguagePreference(language) {
    try {
      const languageSettings = { language: language };
      
      // Try sync storage first
      try {
        await chrome.storage.sync.set({ smartSkipLanguage: languageSettings });
      } catch (syncError) {
        await chrome.storage.local.set({ smartSkipLanguage: languageSettings });
      }
      
      this.currentLanguage = language;
    } catch (error) {
      // Error saving language preference - silently fail
    }
  }
  
  // Get effective language (resolve 'auto' to actual language)
  getEffectiveLanguage() {
    if (this.currentLanguage === 'auto') {
      return this.detectBrowserLanguage();
    }
    return this.currentLanguage || 'en';
  }
  
  // Get translation for a key
  t(key) {
    const effectiveLang = this.getEffectiveLanguage();
    const translation = this.translations[effectiveLang]?.[key];
    
    if (!translation) {
      // Fallback to English if translation not found
      const fallback = this.translations['en']?.[key];
      if (!fallback) {
        return key; // Return key as fallback
      }
      return fallback;
    }
    
    return translation;
  }
  
  // Initialize language system
  async initialize() {
    await this.loadLanguagePreference();
    // Language initialization complete
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LanguageManager;
} else {
  window.LanguageManager = LanguageManager;
}
