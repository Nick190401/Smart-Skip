class LanguageManager {
  constructor() {
    this.currentLanguage = null;
    this.translations = {
      de: {
        extensionName: "Smart Skip",
        
        popupTitle: "Smart Skip",
        currentSeries: "Aktuelle Serie",
        noSeriesDetected: "Keine Serie erkannt",
        unsupportedSite: "Diese Website wird nicht unterstützt",
        unsupportedSiteTitle: "Nicht unterstützte Website",
        unsupportedSiteDesc: "Diese Extension funktioniert nur auf:",
        unsupportedSiteHint: "Gehe zu einer Streaming-Website, um die Extension zu nutzen",
  supportedPlatforms: "Netflix, Disney+, Prime Video, Crunchyroll, Hulu, Apple TV+, HBO Max📺 und weiteren Streaming-Plattformen",
        
        settingsTitle: "Einstellungen",
        globalSettings: "Globale Einstellungen",
        extensionEnabled: "Extension aktiviert",
        domainEnabled: "Für diese Website",
        domainEnabledDesc: "Spezielle Einstellung für aktuelle Website",
        
        skipOptions: "Skip-Optionen",
        skipIntro: "Intro überspringen",
        skipRecap: "Zusammenfassung überspringen",
        skipCredits: "Abspann überspringen", 
        skipAds: "Werbung überspringen",
        autoNext: "Nächste Folge automatisch",
        
        seriesSettings: "Serien-Einstellungen",
        seriesSettingsDesc: "Einstellungen werden automatisch für jede erkannte Serie gespeichert",
        
        languageSettings: "Sprache",
        languageSettingsDesc: "Interface-Sprache wählen",
        languageAuto: "Automatisch (Browser-Sprache)",
        languageGerman: "Deutsch",
        languageEnglish: "English",
        
        saveSettings: "Einstellungen speichern",
        reloadButton: "Neuladen",
        
        settingsSaved: "Einstellungen gespeichert",
        settingsSavedTemp: "Temporär gespeichert",
        saveFailed: "Speichern fehlgeschlagen",
        
        browsing: "durchsuchen",
        playing: "läuft",
        unknown: "unbekannt",
        
        platformSupported: "Diese Plattform wird unterstützt",
        platformNotSupported: "Diese Plattform wird nicht unterstützt",
        
        tooltipIntro: "Überspringe automatisch Intro-Sequenzen",
        tooltipRecap: "Überspringe 'Bisher geschah...' Zusammenfassungen",
        tooltipCredits: "Überspringe Abspann und Credits",
        tooltipAds: "Überspringe Werbeanzeigen (immer aktiv)",
        tooltipAutoNext: "Gehe automatisch zur nächsten Folge"
      },
      
      en: {
        extensionName: "Smart Skip",
        
        popupTitle: "Smart Skip",
        currentSeries: "Current Series",
        noSeriesDetected: "No series detected",
        unsupportedSite: "This website is not supported",
        unsupportedSiteTitle: "Unsupported Website",
        unsupportedSiteDesc: "This extension only works on:",
        unsupportedSiteHint: "Go to a streaming website to use the extension",
  supportedPlatforms: "Netflix, Disney+, Prime Video, Crunchyroll, Hulu, Apple TV+, HBO Max📺 and other streaming platforms",
        
        settingsTitle: "Settings",
        globalSettings: "Global Settings",
        extensionEnabled: "Extension enabled",
        domainEnabled: "For this website",
        domainEnabledDesc: "Special setting for current website",
        
        skipOptions: "Skip Options",
        skipIntro: "Skip Intro",
        skipRecap: "Skip Recap", 
        skipCredits: "Skip Credits",
        skipAds: "Skip Ads",
        autoNext: "Auto Next Episode",
        
        seriesSettings: "Series Settings",
        seriesSettingsDesc: "Settings are automatically saved for each detected series",
        
        languageSettings: "Language",
        languageSettingsDesc: "Choose interface language",
        languageAuto: "Auto (Browser Language)",
        languageGerman: "Deutsch",
        languageEnglish: "English",
        
        saveSettings: "Save Settings",
        reloadButton: "Reload",
        
        settingsSaved: "Settings saved",
        settingsSavedTemp: "Saved temporarily",
        saveFailed: "Save failed",
        
        browsing: "browsing",
        playing: "playing",
        unknown: "unknown",
        
        platformSupported: "This platform is supported",
        platformNotSupported: "This platform is not supported",
        
        tooltipIntro: "Automatically skip intro sequences",
        tooltipRecap: "Skip 'previously on...' summaries",
        tooltipCredits: "Skip end credits and closing sequences",
        tooltipAds: "Skip advertisements (always active)",
        tooltipAutoNext: "Automatically advance to next episode"
      }
    };
  }
  detectBrowserLanguage() {
    const browserLang = navigator.language || navigator.userLanguage || 'en';
    const langCode = browserLang.toLowerCase().split('-')[0];
    return this.translations[langCode] ? langCode : 'en';
  }
  
  async loadLanguagePreference() {
    try {
      let languageSettings = null;
      
      try {
        if (chrome.storage && chrome.storage.sync) {
          const result = await chrome.storage.sync.get(['smartSkipLanguage']);
          if (result.smartSkipLanguage) {
            languageSettings = result.smartSkipLanguage;
          }
        }
      } catch (syncError) {
        // Silent fail
      }
      
      if (!languageSettings) {
        try {
          if (chrome.storage && chrome.storage.local) {
            const result = await chrome.storage.local.get(['smartSkipLanguage']);
            if (result.smartSkipLanguage) {
              languageSettings = result.smartSkipLanguage;
            }
          }
        } catch (localError) {
          // Silent fail
        }
      }
      
      if (languageSettings && languageSettings.language) {
        this.currentLanguage = languageSettings.language;
      } else {
        this.currentLanguage = 'auto';
      }
    } catch (error) {
      this.currentLanguage = 'auto';
    }
  }
  
  async saveLanguagePreference(language) {
    try {
      const languageSettings = { language: language };
      
      try {
        await chrome.storage.sync.set({ smartSkipLanguage: languageSettings });
      } catch (syncError) {
        await chrome.storage.local.set({ smartSkipLanguage: languageSettings });
      }
      
      this.currentLanguage = language;
    } catch (error) {
      // Silent fail
    }
  }
  
  getEffectiveLanguage() {
    if (this.currentLanguage === 'auto') {
      return this.detectBrowserLanguage();
    }
    return this.currentLanguage || 'en';
  }
  
  t(key) {
    const effectiveLang = this.getEffectiveLanguage();
    const translation = this.translations[effectiveLang]?.[key];
    
    if (!translation) {
      const fallback = this.translations['en']?.[key];
      if (!fallback) {
        return key;
      }
      return fallback;
    }
    
    return translation;
  }
  
  async initialize() {
    await this.loadLanguagePreference();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LanguageManager;
} else {
  window.LanguageManager = LanguageManager;
}
