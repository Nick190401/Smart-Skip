class PopupManager {
  constructor() {
    this.currentDomain = '';
    this.currentSeries = null;
    this.lastKnownUnsupportedState = null;
    this.settings = {
      globalEnabled: true,
      domains: {},
      series: {}
    };
    this.languageManager = new LanguageManager();
    
    this.init();
  }

  async init() {
    await this.languageManager.initialize();
    
    await this.loadSettings();
    await this.detectCurrentContext();
    this.setupEventListeners();
    this.updateUI();
    this.startPeriodicUpdates();
    
    this.applyTranslations();
  }

  async loadSettings() {
    try {
      let loadedSettings = null;
      let loadMethod = '';
      
      try {
        if (chrome.storage && chrome.storage.sync) {
          const result = await chrome.storage.sync.get(['skipperSettings']);
          if (result.skipperSettings) {
            loadedSettings = result.skipperSettings;
            loadMethod = 'Sync Storage ☁️';
          }
        }
      } catch (syncError) {
        // Silent fail
      }
      
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
          // Silent fail
        }
      }
      
      if (!loadedSettings) {
        try {
          const storedSettings = localStorage.getItem('skipperSettings');
          if (storedSettings) {
            loadedSettings = JSON.parse(storedSettings);
            loadMethod = 'Browser Storage 🔄';
          }
        } catch (lsError) {
          // Silent fail
        }
      }
      
      if (!loadedSettings && window.skipperSettings) {
        loadedSettings = window.skipperSettings;
        loadMethod = 'Memory 🧠';
      }
      
      if (loadedSettings) {
        this.settings = {
          globalEnabled: loadedSettings.globalEnabled !== undefined ? loadedSettings.globalEnabled : true,
          domains: loadedSettings.domains || {},
          series: loadedSettings.series || {}
        };
      } else {
        await this.saveSettings();
      }
    } catch (error) {
      this.showStatus('Einstellungen konnten nicht geladen werden', 'error');
      
      this.settings = {
        globalEnabled: true,
        domains: {},
        series: {}
      };
    }
  }

  async saveSettings() {
    try {
      if (!this.settings || typeof this.settings !== 'object') {
        return;
      }
      
      const validSettings = {
        globalEnabled: this.settings.globalEnabled !== undefined ? this.settings.globalEnabled : true,
        domains: this.settings.domains || {},
        series: this.settings.series || {}
      };
      
      let saveMethod = '';
      let savedSuccessfully = false;
      
      try {
        await chrome.storage.sync.set({ skipperSettings: validSettings });
        saveMethod = 'Sync ☁️';
        savedSuccessfully = true;
      } catch (syncError) {
        try {
          await chrome.storage.local.set({ skipperSettings: validSettings });
          saveMethod = 'Local 💾';
          savedSuccessfully = true;
        } catch (localError) {
          // Silent fail
        }
      }
      
      if (!savedSuccessfully) {
        try {
          localStorage.setItem('skipperSettings', JSON.stringify(validSettings));
          saveMethod = 'Browser 🔄';
          savedSuccessfully = true;
        } catch (lsError) {
          // Silent fail
        }
      }
      
      if (!savedSuccessfully) {
        window.skipperSettings = validSettings;
        saveMethod = 'Memory 🧠';
        savedSuccessfully = true;
      }
      
      if (savedSuccessfully) {
        if (saveMethod.includes('Browser') || saveMethod.includes('Memory')) {
          this.showStatus('Temporär gespeichert', 'warning');
        }
        
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'updateSettings',
              settings: validSettings
            });
          }
        } catch (messageError) {
          // Silent fail
        }
      }
    } catch (error) {
      this.showStatus('Speichern fehlgeschlagen', 'error');
    }
  }

  async detectCurrentContext() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        this.handleUnsupportedSite();
        return;
      }

      this.currentDomain = new URL(tab.url).hostname;
      
      const supportedDomains = [
        'netflix.',
        'disneyplus.',
        'disney.',
        'amazon.',
        'primevideo.',
        'youtube.',
        'youtu.be',
        'crunchyroll.',
        'hulu.com',
        'peacocktv.com',
        'paramountplus.com',
        'funimation.com',
        'apple.com',
        'tv.apple.com',
        'hbomax.',
        'max.com',
        'hbo.',
        'wakanim.',
        'sky.',
        'joyn.',
        'rtl.',
        'prosieben.',
        'zdf.',
        'ard.',
        'mediathek.',
        'twitch.tv',
        'vimeo.com',
        'dailymotion.com'
      ];

      const isSupported = supportedDomains.some(domain => {
        if (domain.endsWith('.')) {
          return this.currentDomain.startsWith(domain) || 
                 this.currentDomain.includes('.' + domain.slice(0, -1) + '.');
        } else {
          return this.currentDomain === domain || 
                 this.currentDomain.endsWith('.' + domain);
        }
      });

      if (!isSupported) {
        this.handleUnsupportedSite();
        return;
      }

      this.lastKnownUnsupportedState = false;
      await this.detectCurrentSeries();
    } catch (error) {
      this.handleUnsupportedSite();
    }
  }

  async detectCurrentSeries() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'detectSeries' });
      
      if (response && response.series) {
        this.currentSeries = response.series;
      } else {
        this.currentSeries = null;
      }
    } catch (error) {
      this.currentSeries = null;
    }
  }

  handleUnsupportedSite() {
    if (this.lastKnownUnsupportedState !== true) {
      this.lastKnownUnsupportedState = true;
      this.currentSeries = null;
      this.updateUI();
    }
  }

  setupEventListeners() {
    document.getElementById('globalEnabled').addEventListener('change', (e) => {
      this.settings.globalEnabled = e.target.checked;
      this.saveSettings();
      this.updateUI();
    });

    document.getElementById('domainEnabled').addEventListener('change', (e) => {
      if (!this.settings.domains[this.currentDomain]) {
        this.settings.domains[this.currentDomain] = {};
      }
      this.settings.domains[this.currentDomain].enabled = e.target.checked;
      this.saveSettings();
      this.updateUI();
    });

    const skipSettings = ['skipIntro', 'skipRecap', 'skipCredits', 'skipAds', 'autoNext'];
    
    skipSettings.forEach(setting => {
      const checkbox = document.getElementById(setting);
      if (checkbox) {
        checkbox.addEventListener('change', (e) => {
          this.updateSeriesSetting(setting, e.target.checked);
        });
      }
    });

    document.getElementById('reloadButton').addEventListener('click', () => {
      this.detectCurrentSeries().then(() => {
        this.updateUI();
        this.showStatus('Neu geladen', 'success');
      });
    });
  }

  updateSeriesSetting(setting, value) {
    if (!this.currentSeries) return;

    const seriesKey = `${this.currentDomain}:${this.currentSeries.title}`;
    
    if (!this.settings.series[seriesKey]) {
      this.settings.series[seriesKey] = {
        skipIntro: true,
        skipRecap: true,
        skipCredits: true,
        skipAds: true,
        autoNext: false
      };
    }

    this.settings.series[seriesKey][setting] = value;
    this.saveSettings();
  }

  updateUI() {
    if (this.lastKnownUnsupportedState === true) {
      this.showUnsupportedSite();
      return;
    }

    this.showSupportedSite();
    this.updateSettingsUI();
    this.updateSeriesUI();
  }

  showUnsupportedSite() {
    const mainContent = document.querySelector('.main-content');
    const unsupportedContent = document.querySelector('.unsupported-content');
    
    mainContent.style.display = 'none';
    unsupportedContent.style.display = 'block';
  }

  showSupportedSite() {
    const mainContent = document.querySelector('.main-content');
    const unsupportedContent = document.querySelector('.unsupported-content');
    
    mainContent.style.display = 'block';
    unsupportedContent.style.display = 'none';
  }

  updateSettingsUI() {
    const globalCheckbox = document.getElementById('globalEnabled');
    const domainCheckbox = document.getElementById('domainEnabled');
    
    globalCheckbox.checked = this.settings.globalEnabled;
    
    const domainSetting = this.settings.domains[this.currentDomain]?.enabled;
    if (domainSetting !== undefined) {
      domainCheckbox.checked = domainSetting;
      domainCheckbox.indeterminate = false;
    } else {
      domainCheckbox.checked = this.settings.globalEnabled;
      domainCheckbox.indeterminate = true;
    }
  }

  updateSeriesUI() {
    const seriesNameElement = document.getElementById('seriesName');
    const seriesEpisodeElement = document.getElementById('seriesEpisode');
    const seriesSection = document.querySelector('.series-section');
    
    if (this.currentSeries) {
      seriesNameElement.textContent = this.currentSeries.title;
      seriesEpisodeElement.textContent = this.currentSeries.episode || 'Unbekannt';
      seriesSection.style.display = 'block';
      
      this.updateSeriesSettings();
    } else {
      seriesSection.style.display = 'none';
    }
  }

  updateSeriesSettings() {
    if (!this.currentSeries) return;

    const seriesKey = `${this.currentDomain}:${this.currentSeries.title}`;
    const seriesSettings = this.settings.series[seriesKey] || {
      skipIntro: true,
      skipRecap: true,
      skipCredits: true,
      skipAds: true,
      autoNext: false
    };

    ['skipIntro', 'skipRecap', 'skipCredits', 'skipAds', 'autoNext'].forEach(setting => {
      const checkbox = document.getElementById(setting);
      if (checkbox) {
        checkbox.checked = seriesSettings[setting];
      }
    });
  }

  startPeriodicUpdates() {
    setInterval(() => {
      this.detectCurrentSeries().then(() => {
        this.updateSeriesUI();
      });
    }, 5000);
  }

  applyTranslations() {
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(element => {
      const key = element.getAttribute('data-i18n');
      const translation = this.languageManager.t(key);
      
      if (element.tagName === 'INPUT' && element.type === 'checkbox') {
        // For checkboxes, update the associated label
        const label = document.querySelector(`label[for="${element.id}"]`);
        if (label) {
          label.textContent = translation;
        }
      } else {
        element.textContent = translation;
      }
    });
  }

  showStatus(message, type = 'info') {
    const statusElement = document.getElementById('status');
    if (!statusElement) return;
    
    statusElement.textContent = message;
    statusElement.className = `status ${type}`;
    statusElement.style.display = 'block';
    
    setTimeout(() => {
      statusElement.style.display = 'none';
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.popupManager = new PopupManager();
});
