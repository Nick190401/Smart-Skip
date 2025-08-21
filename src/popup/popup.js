// Enhanced popup.js with series-specific settings and language support
class PopupManager {
  constructor() {
    this.currentDomain = '';
    this.currentSeries = null;
    this.lastKnownUnsupportedState = null; // Track unsupported state to prevent flicker
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
    
    // Apply initial translations after everything is set up
    this.applyTranslations();
  }

  async loadSettings() {
    try {
      let loadedSettings = null;
      let loadMethod = '';
      
      // Method 1: Try sync storage first
      try {
        if (chrome.storage && chrome.storage.sync) {
          const result = await chrome.storage.sync.get(['skipperSettings']);
          if (result.skipperSettings) {
            loadedSettings = result.skipperSettings;
            loadMethod = 'Sync Storage ☁️';
          }
        }
      } catch (syncError) {
        // Sync storage failed, try local storage
      }
      
      // Method 2: Try local storage if sync failed
      if (!loadedSettings) {
        try {
          if (chrome.storage && chrome.storage.local) {
            const result = await chrome.storage.local.get(['skipperSettings']);
            if (result.skipperSettings) {
              loadedSettings = result.skipperSettings;
              loadMethod = 'Local Storage 💾';
            }
          }
        } catch (localError) {
          // Local storage failed, try localStorage
        }
      }
      
      // Method 3: Try browser localStorage (for temporary extensions)
      if (!loadedSettings) {
        try {
          const storedSettings = localStorage.getItem('skipperSettings');
          if (storedSettings) {
            loadedSettings = JSON.parse(storedSettings);
            loadMethod = 'Browser Storage 🔄';
          }
        } catch (lsError) {
          // localStorage failed
        }
      }
      
      // Method 4: Check in-memory storage
      if (!loadedSettings && window.skipperSettings) {
        loadedSettings = window.skipperSettings;
        loadMethod = 'Memory 🧠';
      }
      
      if (loadedSettings) {
        // Validate and merge settings
        this.settings = {
          globalEnabled: loadedSettings.globalEnabled !== undefined ? loadedSettings.globalEnabled : true,
          domains: loadedSettings.domains || {},
          series: loadedSettings.series || {}
        };
        // Settings loaded successfully - no need to show status
      } else {
        // Initialize with defaults and save
        await this.saveSettings();
      }
    } catch (error) {
      this.showStatus('Einstellungen konnten nicht geladen werden', 'error');
      
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
      
      let saveSuccess = false;
      let saveMethod = '';
      
      // Method 1: Try chrome.storage.sync first
      try {
        if (chrome.storage && chrome.storage.sync) {
          await chrome.storage.sync.set({ skipperSettings: validSettings });
          saveSuccess = true;
          saveMethod = 'Sync Storage ☁️';
        } else {
          throw new Error('Sync storage not available');
        }
      } catch (syncError) {
        
        // Method 2: Try chrome.storage.local
        try {
          if (chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ skipperSettings: validSettings });
            saveSuccess = true;
            saveMethod = 'Local Storage 💾';
          } else {
            throw new Error('Local storage not available');
          }
        } catch (localError) {
          // Local storage failed
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
        } catch (lsError) {
          // localStorage failed
        }
      }
      
      // Method 4: Last resort - in-memory storage
      if (!saveSuccess) {
        window.skipperSettings = validSettings;
        saveSuccess = true;
        saveMethod = 'Memory 🧠 (Session nur)';
      }
      
      // Show result to user
      if (saveSuccess) {
        // Only show success message for user-initiated saves, not automatic ones
        if (saveMethod.includes('Browser Storage') || saveMethod.includes('Memory')) {
          this.showStatus('⚠️ Temporäre Speicherung', 'warning');
        }
        // For normal chrome storage, don't show any message as it's expected behavior
        
        // Notify content script about settings change
        this.notifyContentScript();
      } else {
        this.showStatus('❌ Speichern fehlgeschlagen', 'error');
      }
      
    } catch (error) {
      // Only show critical errors to user
      if (error.message.includes('Critical') || error.message.includes('structure')) {
        this.showStatus('❌ Speicherfehler', 'error');
      }
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
        // Only update if state changed to prevent flicker
        if (this.lastKnownUnsupportedState !== this.currentDomain) {
          this.lastKnownUnsupportedState = this.currentDomain;
          
          // Enable compact mode
          document.body.classList.add('compact-mode');
          
          // Show "not supported" message and hide most UI
          document.getElementById('currentDomainName').textContent = this.currentDomain;
          
          // Hide series-specific sections
          document.getElementById('currentSeriesSection').classList.add('hidden');
          
          // Hide domain-specific toggle (makes no sense on unsupported sites)
          document.querySelector('.global-settings .setting-item:nth-of-type(2)').classList.add('hidden');
          
          // Show permanent warning message with translation - only set once
          this.showPermanentUnsupportedMessage();
        }
        // Always return early for unsupported sites to prevent any further updates
        return;
      }
      
      // Reset unsupported state if we're now on a supported site
      if (this.lastKnownUnsupportedState !== null) {
        this.lastKnownUnsupportedState = null;
        // Show series section again
        document.getElementById('currentSeriesSection').classList.remove('hidden');
        document.querySelector('.global-settings .setting-item:nth-of-type(2)').classList.remove('hidden');
        
        // Reset permanent status message
        const statusEl = document.getElementById('statusMessage');
        if (statusEl) {
          statusEl.removeAttribute('data-permanent');
          statusEl.classList.add('hidden');
        }
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
        // Content script not ready yet
      }

    } catch (error) {
      // Error detecting context
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
        this.showStatus('Einstellung konnte nicht gespeichert werden', 'error');
        
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
          this.showStatus('Serie-Einstellung konnte nicht gespeichert werden', 'error');
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
      // Content script not available
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
      this.showStatus('Seite konnte nicht neu geladen werden', 'error');
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
    // Only update if we're on a supported platform to prevent flicker on unsupported sites
    setInterval(() => {
      // Skip updates if we're on an unsupported site
      if (this.lastKnownUnsupportedState !== null) {
        return; // Don't update anything on unsupported sites
      }
      this.detectCurrentContext();
    }, 10000);
  }

  showStatus(message, type) {
    const statusEl = document.getElementById('statusMessage');
    
    // Don't override permanent messages (like unsupported site warnings)
    if (statusEl.getAttribute('data-permanent') === 'true') {
      return;
    }
    
    // Translate common status messages
    const translatedMessage = this.translateStatusMessage(message);
    
    statusEl.textContent = translatedMessage;
    statusEl.className = `status ${type}`;
    statusEl.classList.remove('hidden');
    
    setTimeout(() => {
      // Only hide if it's not permanent
      if (statusEl.getAttribute('data-permanent') !== 'true') {
        statusEl.classList.add('hidden');
      }
    }, 3000);
  }
  
  translateStatusMessage(message) {
    // Common status message translations
    const statusTranslations = {
      'Settings saved': this.languageManager.t('settingsSaved'),
      'Einstellungen gespeichert': this.languageManager.t('settingsSaved'),
      'Save failed': this.languageManager.t('saveFailed'),
      'Speichern fehlgeschlagen': this.languageManager.t('saveFailed'),
      'wird nicht unterstützt': this.languageManager.t('unsupportedSite'),
      'not supported': this.languageManager.t('unsupportedSite')
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
    // Make sure languageManager is ready
    if (!this.languageManager) {
      return;
    }
    
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
  
  showPermanentUnsupportedMessage() {
    const statusEl = document.getElementById('statusMessage');
    if (statusEl && this.languageManager) {
      // Clear previous content
      statusEl.textContent = '';

      // Create container div
      const container = document.createElement('div');
      container.style.textAlign = 'center';

      // Strong title
      const strong = document.createElement('strong');
      strong.textContent = `❌ ${this.languageManager.t('unsupportedSiteTitle')}`;
      container.appendChild(strong);
      container.appendChild(document.createElement('br'));

      // First small (desc + supported platforms)
      const small1 = document.createElement('small');
      small1.style.opacity = '0.8';
      small1.style.marginTop = '8px';
      small1.style.display = 'block';
      small1.appendChild(document.createTextNode(this.languageManager.t('unsupportedSiteDesc')));
      small1.appendChild(document.createElement('br'));
      small1.appendChild(document.createTextNode(`📺 ${this.languageManager.t('supportedPlatforms')}`));
      container.appendChild(small1);

      // Second small (hint)
      const small2 = document.createElement('small');
      small2.style.opacity = '0.6';
      small2.style.marginTop = '8px';
      small2.style.display = 'block';
      small2.appendChild(document.createTextNode(this.languageManager.t('unsupportedSiteHint')));
      container.appendChild(small2);

      statusEl.appendChild(container);
      statusEl.className = 'status error';
      statusEl.classList.remove('hidden');
      // Mark as permanent - no timeout to hide the message
      statusEl.setAttribute('data-permanent', 'true');
    }
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupManager();
});
