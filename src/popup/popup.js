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

  // Helper: resolve first existing element by id list
  resolveElementByIds(...ids) {
    for (const id of ids) {
      if (!id) continue;
      let el = null;
      if (id.startsWith('.')) {
        el = document.querySelector(id);
      } else if (id.startsWith('#')) {
        el = document.getElementById(id.slice(1));
      } else {
        el = document.getElementById(id);
      }
      if (el) return el;
    }
    return null;
  }

  elementForSetting(setting) {
    // try native id first, then prefixed 'current' variant
    const camel = setting.charAt(0).toUpperCase() + setting.slice(1);
    return this.resolveElementByIds(setting, `current${camel}`);
  }

  elementForSeriesName() {
    return this.resolveElementByIds('seriesName', 'currentSeriesTitle');
  }

  elementForSeriesEpisode() {
    return this.resolveElementByIds('seriesEpisode', 'currentSeriesInfo');
  }

  elementForSeriesSection() {
    return this.resolveElementByIds('.series-section', '#currentSeriesSection');
  }

  elementForReloadButton() {
    return this.resolveElementByIds('reloadButton', 'reloadBtn');
  }

  elementForStatus() {
    return this.resolveElementByIds('status', 'statusMessage');
  }

  // Toggle helpers: works with input[type=checkbox] or div-based toggles
  setToggleState(el, state) {
    if (!el) return;
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      el.checked = !!state;
    } else {
      if (state) el.classList.add('active'); else el.classList.remove('active');
    }
  }

  getToggleState(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT' && el.type === 'checkbox') return !!el.checked;
    return el.classList ? el.classList.contains('active') : false;
  }

  addToggleListener(el, callback) {
    if (!el) return;
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      el.addEventListener('change', (e) => callback(!!e.target.checked));
    } else {
      el.addEventListener('click', () => {
        const newState = !this.getToggleState(el);
        this.setToggleState(el, newState);
        callback(newState);
      });
    }
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
    const globalToggleEl = this.resolveElementByIds('globalEnabled', 'globalToggle');
    this.addToggleListener(globalToggleEl, (checked) => {
      this.settings.globalEnabled = checked;
      this.saveSettings();
      this.updateUI();
    });

    const domainToggleEl = this.resolveElementByIds('domainEnabled', 'domainToggle');
    this.addToggleListener(domainToggleEl, (checked) => {
      if (!this.settings.domains[this.currentDomain]) this.settings.domains[this.currentDomain] = {};
      this.settings.domains[this.currentDomain].enabled = checked;
      this.saveSettings();
      this.updateUI();
    });

    const skipSettings = ['skipIntro', 'skipRecap', 'skipCredits', 'skipAds', 'autoNext'];
    skipSettings.forEach(setting => {
      const checkbox = this.elementForSetting(setting);
      if (checkbox) {
        checkbox.addEventListener('change', (e) => {
          this.updateSeriesSetting(setting, !!e.target.checked);
        });
      }
    });

    const reloadButton = this.elementForReloadButton();
    if (reloadButton) {
      reloadButton.addEventListener('click', async () => {
        try {
          // Try to reload the active tab to get a fresh page state, then re-detect context
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.id) {
            try {
              chrome.tabs.reload(tab.id, () => {
                // After reload, re-evaluate context in popup
                setTimeout(() => {
                  this.detectCurrentContext().then(() => {
                    this.updateUI();
                    this.showStatus('Seite neu geladen', 'success');
                  });
                }, 500);
              });
              return;
            } catch (reloadErr) {
              // fallback to re-detect without full reload
            }
          }

          // If reload not possible, at least re-run detection
          await this.detectCurrentSeries();
          this.updateUI();
          this.showStatus('Neu geladen', 'success');
        } catch (e) {
          this.showStatus('Neuladen fehlgeschlagen', 'error');
        }
      });
    }
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
    if (mainContent) mainContent.style.display = 'none';
    if (unsupportedContent) unsupportedContent.style.display = 'block';
    try { document.body.classList.add('compact-mode'); } catch (e) {}

    // wire the unsupported reload button if present
    const reloadUnsupported = document.getElementById('reloadBtnUnsupported');
    if (reloadUnsupported && !reloadUnsupported.dataset.bound) {
      reloadUnsupported.addEventListener('click', () => {
        // try re-detecting context
        this.detectCurrentContext().then(() => {
          this.updateUI();
          this.showStatus('Neu geladen', 'success');
        });
      });
      reloadUnsupported.dataset.bound = 'true';
    }
  }

  showSupportedSite() {
    const mainContent = document.querySelector('.main-content');
    const unsupportedContent = document.querySelector('.unsupported-content');
    if (mainContent) mainContent.style.display = 'block';
    if (unsupportedContent) unsupportedContent.style.display = 'none';
    try { document.body.classList.remove('compact-mode'); } catch (e) {}
  }

  updateSettingsUI() {
    const globalCheckbox = this.resolveElementByIds('globalEnabled', 'globalToggle');
    const domainCheckbox = this.resolveElementByIds('domainEnabled', 'domainToggle');

    if (globalCheckbox) this.setToggleState(globalCheckbox, this.settings.globalEnabled);

    if (domainCheckbox) {
      const domainSetting = this.settings.domains[this.currentDomain]?.enabled;
      if (domainSetting !== undefined) {
        this.setToggleState(domainCheckbox, domainSetting);
        if (domainCheckbox.tagName === 'INPUT') domainCheckbox.indeterminate = false;
      } else {
        this.setToggleState(domainCheckbox, this.settings.globalEnabled);
        if (domainCheckbox.tagName === 'INPUT') domainCheckbox.indeterminate = true;
      }
    }
  }

  updateSeriesUI() {
    const seriesNameElement = this.elementForSeriesName();
    const seriesEpisodeElement = this.elementForSeriesEpisode();
    const seriesSection = this.elementForSeriesSection();

    if (this.currentSeries) {
      if (seriesNameElement) seriesNameElement.textContent = this.currentSeries.title;
      if (seriesEpisodeElement) seriesEpisodeElement.textContent = this.currentSeries.episode || 'Unbekannt';
      if (seriesSection) seriesSection.style.display = 'block';

      this.updateSeriesSettings();
    } else {
      if (seriesSection) seriesSection.style.display = 'none';
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
      const checkbox = this.elementForSetting(setting);
      if (checkbox) {
        if (checkbox.tagName === 'INPUT' && checkbox.type === 'checkbox') {
          checkbox.checked = !!seriesSettings[setting];
        } else {
          this.setToggleState(checkbox, !!seriesSettings[setting]);
        }
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
    const statusElement = this.elementForStatus();
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
