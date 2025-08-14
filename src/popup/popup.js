// Enhanced popup.js with series-specific settings and language support
class PopupManager {
  constructor() {
    this.currentDomain = '';
    this.currentSeries = null;
    this.settings = {
      globalEnabled: true,
      domains: {},
      series: {}
    };
    this.languageManager = new LanguageManager();
    
    this.init();
  }

  async init() {
    // Initialize language first
    await this.languageManager.initialize();
    
    await this.loadSettings();
    await this.detectCurrentContext();
    this.setupEventListeners();
    this.updateUI();
    this.startPeriodicUpdates();
    
    // Apply initial translations
    this.applyTranslations();
  }

  async loadSettings() {
    try {
      console.log('🔍 Loading settings...');
      let loadedSettings = null;
      let loadMethod = '';
      
      // Method 1: Try sync storage first
      try {
        if (chrome.storage && chrome.storage.sync) {
          const result = await chrome.storage.sync.get(['skipperSettings']);
          if (result.skipperSettings) {
            loadedSettings = result.skipperSettings;
            loadMethod = 'Sync Storage ☁️';
            console.log('✅ Settings loaded from sync storage');
          }
        }
      } catch (syncError) {
        console.warn('⚠️ Sync storage failed:', syncError.message);
      }
      
      // Method 2: Try local storage if sync failed
      if (!loadedSettings) {
        try {
          if (chrome.storage && chrome.storage.local) {
            const result = await chrome.storage.local.get(['skipperSettings']);
            if (result.skipperSettings) {
              loadedSettings = result.skipperSettings;
              loadMethod = 'Local Storage 💾';
              console.log('✅ Settings loaded from local storage');
            }
          }
        } catch (localError) {
          console.warn('⚠️ Local storage failed:', localError.message);
        }
      }
      
      // Method 3: Try browser localStorage (for temporary extensions)
      if (!loadedSettings) {
        try {
          const storedSettings = localStorage.getItem('skipperSettings');
          if (storedSettings) {
            loadedSettings = JSON.parse(storedSettings);
            loadMethod = 'Browser Storage 🔄';
            console.log('✅ Settings loaded from localStorage (temporary extension mode)');
          }
        } catch (lsError) {
          console.warn('⚠️ localStorage failed:', lsError.message);
        }
      }
      
      // Method 4: Check in-memory storage
      if (!loadedSettings && window.skipperSettings) {
        loadedSettings = window.skipperSettings;
        loadMethod = 'Memory 🧠';
        console.log('✅ Settings loaded from memory');
      }
      
      if (loadedSettings) {
        // Validate and merge settings
        this.settings = {
          globalEnabled: loadedSettings.globalEnabled !== undefined ? loadedSettings.globalEnabled : true,
          domains: loadedSettings.domains || {},
          series: loadedSettings.series || {}
        };
        console.log(`✅ Settings loaded successfully from ${loadMethod}:`, this.settings);
        this.showStatus(`Einstellungen geladen (${loadMethod})`, 'success');
      } else {
        console.log('📝 No settings found, using defaults');
        this.showStatus('Standard-Einstellungen geladen', 'info');
        // Initialize with defaults and save
        await this.saveSettings();
      }
    } catch (error) {
      console.error('❌ Error loading settings:', error);
      this.showStatus('Fehler beim Laden der Einstellungen', 'error');
      
      // Use safe defaults
      this.settings = {
        globalEnabled: true,
        domains: {},
        series: {}
      };
    }
  }

  async saveSettings() {
    try {
      // Validate settings structure before saving
      if (!this.settings || typeof this.settings !== 'object') {
        throw new Error('Invalid settings structure');
      }
      
      // Ensure required properties exist
      const validSettings = {
        globalEnabled: this.settings.globalEnabled || false,
        domains: this.settings.domains || {},
        series: this.settings.series || {}
      };
      
      console.log('💾 Attempting to save settings:', validSettings);
      this.showStatus('Speichere...', 'info');
      
      let saveSuccess = false;
      let saveMethod = '';
      
      // Method 1: Try chrome.storage.sync first
      try {
        if (chrome.storage && chrome.storage.sync) {
          await chrome.storage.sync.set({ skipperSettings: validSettings });
          saveSuccess = true;
          saveMethod = 'Sync Storage ☁️';
          console.log('✅ Settings saved to sync storage');
        } else {
          throw new Error('Sync storage not available');
        }
      } catch (syncError) {
        console.warn('⚠️ Sync storage failed:', syncError.message);
        
        // Method 2: Try chrome.storage.local
        try {
          if (chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ skipperSettings: validSettings });
            saveSuccess = true;
            saveMethod = 'Local Storage 💾';
            console.log('✅ Settings saved to local storage');
          } else {
            throw new Error('Local storage not available');
          }
        } catch (localError) {
          console.warn('⚠️ Local storage failed:', localError.message);
        }
      }
      
      // Method 3: Fallback to browser localStorage (for temporary extensions)
      if (!saveSuccess) {
        try {
          const settingsString = JSON.stringify(validSettings);
          localStorage.setItem('skipperSettings', settingsString);
          localStorage.setItem('skipperSettingsTimestamp', Date.now().toString());
          saveSuccess = true;
          saveMethod = 'Browser Storage 🔄';
          console.log('✅ Settings saved to localStorage (temporary extension mode)');
        } catch (lsError) {
          console.error('❌ localStorage failed:', lsError.message);
        }
      }
      
      // Method 4: Last resort - in-memory storage
      if (!saveSuccess) {
        window.skipperSettings = validSettings;
        saveSuccess = true;
        saveMethod = 'Memory 🧠 (Session nur)';
        console.log('⚠️ Settings saved to memory only (will be lost on page refresh)');
      }
      
      // Show result to user
      if (saveSuccess) {
        this.showStatus(`✅ Gespeichert (${saveMethod})`, 'success');
        
        // Add explanation for temporary extension limitations
        if (saveMethod.includes('Browser Storage') || saveMethod.includes('Memory')) {
          const statusEl = document.querySelector('.status');
          if (statusEl && !statusEl.querySelector('.temp-extension-info')) {
            const info = document.createElement('div');
            info.className = 'temp-extension-info';
            info.innerHTML = `
              <small style="color: #666; display: block; margin-top: 5px;">
                💡 <strong>Temporäre Extension:</strong> Einstellungen gehen beim Browser-Neustart verloren.<br>
                Für persistente Speicherung Extension permanent installieren.
              </small>
            `;
            statusEl.appendChild(info);
          }
        }
        
        // Notify content script about settings change
        this.notifyContentScript();
      } else {
        this.showStatus('❌ Speichern komplett fehlgeschlagen', 'error');
      }
      
    } catch (error) {
      console.error('❌ Critical error in saveSettings:', error);
      this.showStatus(`❌ Kritischer Fehler: ${error.message}`, 'error');
    }
  }

  async detectCurrentContext() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      const url = new URL(tab.url);
      this.currentDomain = url.hostname;
      
      // Check if current domain is a supported streaming platform
      const supportedDomains = [
        // Netflix (all country domains)
        'netflix.',
        
        // Disney+ (all country domains)
        'disneyplus.',
        'disney.',
        
        // Amazon Prime Video (all country domains)
        'amazon.',
        'primevideo.',
        
        // YouTube (all country domains)
        'youtube.',
        'youtu.be',
        
        // Crunchyroll (all country domains)
        'crunchyroll.',
        
        // US-specific services
        'hulu.com',
        'peacocktv.com',
        'paramountplus.com',
        'funimation.com',
        
        // Apple TV+ (all country domains)
        'apple.com',
        'tv.apple.com',
        
        // HBO Max / Max (all country domains)
        'hbomax.',
        'max.com',
        'hbo.',
        
        // European services
        'wakanim.',
        'sky.',
        'joyn.',
        'rtl.',
        'prosieben.',
        'zdf.',
        'ard.',
        'mediathek.',
        
        // Additional streaming services
        'twitch.tv',
        'vimeo.com',
        'dailymotion.com'
      ];
      
      const isSupportedPlatform = supportedDomains.some(domain => {
        // For domains ending with a dot (like 'netflix.'), check if our domain starts with it
        if (domain.endsWith('.')) {
          return this.currentDomain.startsWith(domain) || this.currentDomain.includes('.' + domain.slice(0, -1) + '.');
        } else {
          // For complete domains (like 'hulu.com'), use exact match or subdomain match
          return this.currentDomain === domain || this.currentDomain.endsWith('.' + domain);
        }
      });
      
      if (!isSupportedPlatform) {
        // Enable compact mode
        document.body.classList.add('compact-mode');
        
        // Show "not supported" message and hide most UI
        document.getElementById('currentDomainName').textContent = this.currentDomain;
        
        // Hide series-specific sections
        document.getElementById('currentSeriesSection').classList.add('hidden');
        
        // Hide domain-specific toggle (makes no sense on unsupported sites)
        document.querySelector('.global-settings .setting-item:nth-of-type(2)').classList.add('hidden');
        
        // Show compact warning message
        this.showStatus(`❌ ${this.currentDomain} wird nicht unterstützt`, 'error');
        
        // Show supported platforms info in status
        const statusEl = document.querySelector('.status');
        if (statusEl && !statusEl.querySelector('.supported-platforms')) {
          setTimeout(() => {
            statusEl.innerHTML = `
              <div style="text-align: center;">
                <strong>❌ Nicht unterstützte Website</strong><br>
                <small style="opacity: 0.8; margin-top: 8px; display: block;">
                  Diese Extension funktioniert nur auf:<br>
                  🎬 Netflix, Disney+, Prime Video, YouTube<br>
                  🎭 Crunchyroll, Hulu, Apple TV+, HBO Max<br>
                  📺 und weiteren Streaming-Plattformen
                </small>
                <small style="opacity: 0.6; margin-top: 8px; display: block;">
                  Gehe zu einer Streaming-Website, um die Extension zu nutzen
                </small>
              </div>
            `;
            statusEl.className = 'status error';
          }, 100);
        }
        return;
      }
      
      // Remove compact mode if we're on a supported platform
      document.body.classList.remove('compact-mode');
      
      // Update domain name in UI
      document.getElementById('currentDomainName').textContent = this.currentDomain;

      // Request series detection from content script
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { 
          action: 'detectSeries' 
        });
        
        if (response && response.series) {
          this.currentSeries = response.series;
          this.updateCurrentSeriesUI();
        }
      } catch (error) {
        console.log('Content script not ready yet:', error);
      }

    } catch (error) {
      console.error('Error detecting context:', error);
    }
  }

  updateCurrentSeriesUI() {
    const section = document.getElementById('currentSeriesSection');
    const titleEl = document.getElementById('currentSeriesTitle');
    const infoEl = document.getElementById('currentSeriesInfo');

    if (this.currentSeries) {
      titleEl.textContent = this.currentSeries.title;
      infoEl.textContent = `${this.currentDomain} • Episode ${this.currentSeries.episode || 'unbekannt'}`;
      
      // Load series-specific settings
      const seriesKey = `${this.currentDomain}:${this.currentSeries.title}`;
      const seriesSettings = this.settings.series[seriesKey] || {
        skipIntro: true,
        skipRecap: true,
        skipCredits: true,
        skipAds: true,
        autoNext: false
      };

      // Update checkboxes
      document.getElementById('currentSkipIntro').checked = seriesSettings.skipIntro;
      document.getElementById('currentSkipRecap').checked = seriesSettings.skipRecap;
      document.getElementById('currentSkipCredits').checked = seriesSettings.skipCredits;
      document.getElementById('currentSkipAds').checked = seriesSettings.skipAds;
      document.getElementById('currentAutoNext').checked = seriesSettings.autoNext;

      section.classList.remove('hidden');
    } else {
      section.classList.add('hidden');
    }
  }

  setupEventListeners() {
    // Global toggles
    this.setupToggle('globalToggle', 'globalEnabled');
    this.setupToggle('domainToggle', () => {
      if (!this.settings.domains[this.currentDomain]) {
        this.settings.domains[this.currentDomain] = {};
      }
      // Default to enabled if not explicitly set
      return this.settings.domains[this.currentDomain].enabled !== false;
    }, (value) => {
      if (!this.settings.domains[this.currentDomain]) {
        this.settings.domains[this.currentDomain] = {};
      }
      this.settings.domains[this.currentDomain].enabled = value;
    });

    // Current series checkboxes
    this.setupSeriesCheckbox('currentSkipIntro', 'skipIntro');
    this.setupSeriesCheckbox('currentSkipRecap', 'skipRecap');
    this.setupSeriesCheckbox('currentSkipCredits', 'skipCredits');
    this.setupSeriesCheckbox('currentSkipAds', 'skipAds');
    this.setupSeriesCheckbox('currentAutoNext', 'autoNext');

    // Buttons
    document.getElementById('reloadBtn').addEventListener('click', () => this.reloadTab());
    
    // Language selector
    const languageSelect = document.getElementById('languageSelect');
    languageSelect.value = this.languageManager.currentLanguage;
    languageSelect.addEventListener('change', async (event) => {
      const newLanguage = event.target.value;
      await this.languageManager.saveLanguagePreference(newLanguage);
      this.applyTranslations();
    });
  }

  setupToggle(toggleId, getter, setter) {
    const toggle = document.getElementById(toggleId);
    const getValue = typeof getter === 'string' ? () => this.settings[getter] : getter;
    const setValue = typeof setter === 'function' ? setter : (value) => { this.settings[getter] = value; };

    // Set initial state
    if (getValue()) {
      toggle.classList.add('active');
    }

    toggle.addEventListener('click', async () => {
      const newValue = !getValue();
      
      try {
        setValue(newValue);
        
        if (newValue) {
          toggle.classList.add('active');
        } else {
          toggle.classList.remove('active');
        }
        
        await this.saveSettings();
        await this.sendUpdateToContentScript();
      } catch (error) {
        console.error('Error updating toggle:', error);
        this.showStatus('Fehler beim Speichern der Einstellung', 'error');
        
        // Revert toggle state
        if (newValue) {
          toggle.classList.remove('active');
        } else {
          toggle.classList.add('active');
        }
        setValue(!newValue);
      }
    });
  }

  setupSeriesCheckbox(checkboxId, setting) {
    const checkbox = document.getElementById(checkboxId);
    
    checkbox.addEventListener('change', async () => {
      if (this.currentSeries) {
        const seriesKey = `${this.currentDomain}:${this.currentSeries.title}`;
        
        if (!this.settings.series[seriesKey]) {
          this.settings.series[seriesKey] = {};
        }
        
        this.settings.series[seriesKey][setting] = checkbox.checked;
        
        try {
          await this.saveSettings();
          await this.sendUpdateToContentScript();
        } catch (error) {
          console.error('Error updating series setting:', error);
          this.showStatus('Fehler beim Speichern der Serie-Einstellung', 'error');
          // Revert checkbox state
          checkbox.checked = !checkbox.checked;
        }
      }
    });
  }

  async sendUpdateToContentScript() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { 
          action: 'updateSettings',
          settings: this.settings 
        });
      }
    } catch (error) {
      console.log('Content script not available:', error);
    }
  }



  async reloadTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.reload(tab.id);
        window.close();
      }
    } catch (error) {
      this.showStatus('Fehler beim Neuladen', 'error');
    }
  }

  updateUI() {
    // Update global toggles
    const globalToggle = document.getElementById('globalToggle');
    const domainToggle = document.getElementById('domainToggle');

    if (this.settings.globalEnabled) {
      globalToggle.classList.add('active');
    }

    // Default to enabled if not explicitly set to false
    const domainEnabled = !this.settings.domains[this.currentDomain] || 
                         this.settings.domains[this.currentDomain].enabled !== false;
    if (domainEnabled) {
      domainToggle.classList.add('active');
    }
    
    // Update language selector
    const languageSelect = document.getElementById('languageSelect');
    if (languageSelect && this.languageManager) {
      languageSelect.value = this.languageManager.currentLanguage;
    }

    this.updateCurrentSeriesUI();
    
    // Apply translations
    if (this.languageManager) {
      this.applyTranslations();
    }
  }

  startPeriodicUpdates() {
    // Update series detection every 5 seconds
    setInterval(() => {
      this.detectCurrentContext();
    }, 5000);
  }

  showStatus(message, type) {
    const statusEl = document.getElementById('statusMessage');
    
    // Translate common status messages
    const translatedMessage = this.translateStatusMessage(message);
    
    statusEl.textContent = translatedMessage;
    statusEl.className = `status ${type}`;
    statusEl.classList.remove('hidden');
    
    // Log for debugging
    console.log(`[PopupManager] Status: ${translatedMessage} (${type})`);
    
    setTimeout(() => {
      statusEl.classList.add('hidden');
    }, 3000);
  }
  
  translateStatusMessage(message) {
    // Common status message translations
    const statusTranslations = {
      'Settings saved': this.languageManager.t('settingsSaved'),
      'Einstellungen gespeichert': this.languageManager.t('settingsSaved'),
      'Save failed': this.languageManager.t('saveFailed'),
      'Speichern fehlgeschlagen': this.languageManager.t('saveFailed')
    };
    
    // Check if we have a translation for this message
    for (const [key, translation] of Object.entries(statusTranslations)) {
      if (message.includes(key)) {
        return message.replace(key, translation);
      }
    }
    
    return message; // Return original if no translation found
  }
  

  
  async notifyContentScript() {
    try {
      // Get current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        // Send message to content script about settings update
        chrome.tabs.sendMessage(tab.id, {
          action: 'updateSettings',
          settings: this.settings
        }).catch(error => {
          // Silent fail - normal if not on supported site
        });
      }
    } catch (error) {
      // Silent fail - error notifying content script
    }
  }
  
  applyTranslations() {
    // Get all elements with data-i18n attribute
    const elements = document.querySelectorAll('[data-i18n]');
    
    elements.forEach(element => {
      const key = element.getAttribute('data-i18n');
      const translation = this.languageManager.t(key);
      
      if (element.tagName === 'OPTION') {
        element.textContent = translation;
      } else {
        element.textContent = translation;
      }
    });
    
    // Update dynamic content
    this.updateTranslatedContent();
  }
  
  updateTranslatedContent() {
    // Update series section header
    const seriesSectionTitle = document.querySelector('.series-section h3');
    if (seriesSectionTitle) {
      seriesSectionTitle.textContent = this.languageManager.t('currentSeries');
    }
    
    // Update domain-specific toggle label dynamically
    const domainToggleLabel = document.querySelector('[data-i18n="domainEnabled"]');
    if (domainToggleLabel && this.currentDomain) {
      // For some domains, show a user-friendly name
      const friendlyDomainNames = {
        'netflix.com': 'Netflix',
        'netflix.de': 'Netflix',
        'netflix.fr': 'Netflix',
        'disneyplus.com': 'Disney+',
        'disneyplus.de': 'Disney+',
        'amazon.com': 'Amazon Prime',
        'amazon.de': 'Amazon Prime',
        'primevideo.com': 'Prime Video',
        'primevideo.de': 'Prime Video',
        'youtube.com': 'YouTube',
        'youtube.de': 'YouTube',
        'crunchyroll.com': 'Crunchyroll',
        'apple.com': 'Apple TV+',
        'tv.apple.com': 'Apple TV+'
      };
      
      const displayName = friendlyDomainNames[this.currentDomain] || this.currentDomain;
      domainToggleLabel.textContent = `${this.languageManager.t('domainEnabled')} (${displayName})`;
    }
    
    // Update current series display
    if (this.currentSeries) {
      const seriesTitle = document.getElementById('currentSeriesTitle');
      const episodeInfo = document.getElementById('currentSeriesEpisode');
      
      if (seriesTitle && episodeInfo) {
        const episodeText = this.languageManager.t(this.currentSeries.episode || 'unknown');
        episodeInfo.textContent = `${this.languageManager.t('episode')}: ${episodeText}`;
      }
    } else {
      // No series detected message
      const noSeriesMsg = document.querySelector('.no-series-message');
      if (noSeriesMsg) {
        noSeriesMsg.textContent = this.languageManager.t('noSeriesDetected');
      }
    }
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupManager();
});
