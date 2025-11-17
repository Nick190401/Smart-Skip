/**
 * PopupManager
 * - Loads/saves settings with multi-layer fallbacks
 * - Detects current tab domain and series (if available)
 * - Updates a glass-style popup UI and wires controls
 * - Communicates with content scripts/background in a fail-safe way
 */
class PopupManager {
  constructor() {
    this.currentDomain = '';
    this.currentSeries = null;
    // UI-selected series title; falls back to last-known when detection is empty
    this.uiSeriesTitle = null;
    this.lastKnownUnsupportedState = null;
    this.settings = {
      globalEnabled: true,
      globalHudEnabled: true,
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
    this.bindRealtimeListeners();
    // First detection immediately to populate UI
    await this.detectCurrentSeries();
    await this.trySetBlurredBackground();
    this.bindFocusVisibilityHandlers();
    this.setupEventListeners();
    this.updateUI();
    this.startPeriodicUpdates();
    
    this.applyTranslations();
  }

  // Safely send a message to the active tab's content script
  async sendMessageToActiveTabSafe(message) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return null;
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      // No content script on this tab or receiver missing; ignore to avoid uncaught rejection
      return null;
    }
  }

  // Re-run detection when popup regains focus or becomes visible
  bindFocusVisibilityHandlers() {
    const refresh = async () => {
      try {
        await this.detectCurrentContext();
        await this.detectCurrentSeries();
        this.updateUI();
      } catch (e) {}
    };
    try {
      window.addEventListener('focus', refresh);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refresh();
      });
    } catch (e) {}
  }

  // Listen for real-time series updates broadcasted by background/content
  bindRealtimeListeners() {
    try {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request && request.action === 'seriesDetected') {
          // Only update if message matches current domain context
          if (request.domain && this.currentDomain && request.domain !== this.currentDomain) return;
          this.currentSeries = request.series || null;
          if (this.currentSeries && this.currentSeries.title) {
            this.uiSeriesTitle = this.currentSeries.title;
          }
          this.lastKnownUnsupportedState = false;
          this.updateUI();
        }
      });
    } catch (e) {
      // ignore
    }
  }

  // Try to capture the visible tab and use it as blurred background
  async trySetBlurredBackground() {
    try {
      const bgEl = document.getElementById('popupBgImg');
      if (!bgEl) return;
      // Some Chromium builds require 'tabs' permission for captureVisibleTab
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'jpeg', quality: 60 });
      if (dataUrl) {
        bgEl.style.backgroundImage = `url(${dataUrl})`;
      }
    } catch (e) {
      // Fallback: leave the overlay color only; no error shown
    }
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

  // Load settings from Sync → Local → localStorage → memory
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
          globalHudEnabled: loadedSettings.globalHudEnabled !== undefined ? loadedSettings.globalHudEnabled : true,
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
        globalHudEnabled: true,
        domains: {},
        series: {}
      };
    }
  }

  // Save settings; prefer Sync, fallback to Local, else browser/memory
  async saveSettings() {
    try {
      if (!this.settings || typeof this.settings !== 'object') {
        return;
      }
      
      const validSettings = {
        globalEnabled: this.settings.globalEnabled !== undefined ? this.settings.globalEnabled : true,
        globalHudEnabled: this.settings.globalHudEnabled !== undefined ? this.settings.globalHudEnabled : true,
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
        
        // Notify content script if present; swallow errors gracefully
        await this.sendMessageToActiveTabSafe({
          action: 'updateSettings',
          settings: validSettings
        });
      }
    } catch (error) {
      this.showStatus('Speichern fehlgeschlagen', 'error');
    }
  }

  // Determine active tab + domain; decide supported/override states and inject if needed
  async detectCurrentContext() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        this.handleUnsupportedSite();
        return;
      }

  this.currentDomain = new URL(tab.url).hostname;
  // Update domain labels where shown
  const curDomEl = document.getElementById('currentDomainName');
  if (curDomEl) curDomEl.textContent = this.currentDomain;
  const unsupportedDomEl = document.getElementById('unsupportedDomainName');
  if (unsupportedDomEl) unsupportedDomEl.textContent = this.currentDomain;
      
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

      // Treat overrides as supported even if not on the built-in list
      const domainOverride = this.settings.domains[this.currentDomain]?.enabled === true;
      if (!isSupported && !domainOverride) {
        this.handleUnsupportedSite();
        return;
      }

      this.lastKnownUnsupportedState = false;
      // If this is an overridden unsupported site, attempt programmatic injection now
      if (!isSupported && domainOverride) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.id) {
            await chrome.runtime.sendMessage({ action: 'injectContentScripts', tabId: activeTab.id });
          }
        } catch (e) {
          // Silent fail; user can try enable buttons
        }
      }
      await this.detectCurrentSeries();
    } catch (error) {
      this.handleUnsupportedSite();
    }
  }

  // Ask content script to detect the current series (if present)
  async detectCurrentSeries() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      const response = await this.sendMessageToActiveTabSafe({ action: 'detectSeries' });
      
      if (response && response.series) {
        this.currentSeries = response.series;
        if (this.currentSeries && this.currentSeries.title) {
          this.uiSeriesTitle = this.currentSeries.title;
        }
      } else {
        this.currentSeries = null;
      }
    } catch (error) {
      this.currentSeries = null;
    }
  }

  // Switch popup into 'unsupported site' compact layout
  handleUnsupportedSite() {
    if (this.lastKnownUnsupportedState !== true) {
      this.lastKnownUnsupportedState = true;
      this.currentSeries = null;
      this.updateUI();
    }
  }

  // Wire global/domain toggles, HUD toggles, skip options, and unsupported-site actions
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

    const hudToggleEl = this.resolveElementByIds('hudEnabled', 'hudToggle');
    this.addToggleListener(hudToggleEl, (checked) => {
      this.settings.globalHudEnabled = checked;
      this.saveSettings();
    });

    const domainHudToggleEl = this.resolveElementByIds('hudDomainEnabled', 'domainHudToggle');
    this.addToggleListener(domainHudToggleEl, (checked) => {
      if (!this.settings.domains[this.currentDomain]) this.settings.domains[this.currentDomain] = {};
      this.settings.domains[this.currentDomain].hudEnabled = checked;
      this.saveSettings();
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

    // Make entire skip-option clickable to toggle its checkbox
    document.querySelectorAll('.skip-option').forEach(opt => {
      if (opt.dataset.bound) return;
      opt.addEventListener('click', (e) => {
        const input = opt.querySelector('input[type="checkbox"]');
        if (!input) return;
        // If the click originated from the actual checkbox, let default behavior handle it
        if (e.target === input) return;
        input.checked = !input.checked;
        // Trigger change to persist setting
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      opt.dataset.bound = 'true';
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

    // Unsupported UI actions
    const enableOnceBtn = document.getElementById('enableOnceBtn');
    if (enableOnceBtn && !enableOnceBtn.dataset.bound) {
      enableOnceBtn.addEventListener('click', async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            await chrome.runtime.sendMessage({ action: 'injectContentScripts', tabId: tab.id });
            this.lastKnownUnsupportedState = false;
            await this.detectCurrentSeries();
            this.updateUI();
            this.showStatus('Auf dieser Seite aktiviert', 'success');
          }
        } catch (e) {
          this.showStatus('Aktivierung fehlgeschlagen', 'error');
        }
      });
      enableOnceBtn.dataset.bound = 'true';
    }

    const enableDomainBtn = document.getElementById('enableDomainBtn');
    if (enableDomainBtn && !enableDomainBtn.dataset.bound) {
      enableDomainBtn.addEventListener('click', async () => {
        try {
          if (!this.settings.domains[this.currentDomain]) this.settings.domains[this.currentDomain] = {};
          this.settings.domains[this.currentDomain].enabled = true;
          await this.saveSettings();
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            await chrome.runtime.sendMessage({ action: 'injectContentScripts', tabId: tab.id });
          }
          this.lastKnownUnsupportedState = false;
          await this.detectCurrentSeries();
          this.updateUI();
          this.showStatus('Für diese Domain aktiviert', 'success');
        } catch (e) {
          this.showStatus('Aktivierung fehlgeschlagen', 'error');
        }
      });
      enableDomainBtn.dataset.bound = 'true';
    }

    const reportSiteBtn = document.getElementById('reportSiteBtn');
    if (reportSiteBtn && !reportSiteBtn.dataset.bound) {
      reportSiteBtn.addEventListener('click', async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const url = tab?.url || '';
          const title = encodeURIComponent(`Support request: ${this.currentDomain}`);
          const body = encodeURIComponent(`Please add support for: ${url}`);
          // Prefer opening GitHub Issues if extension repository is public
          const issuesUrl = `https://github.com/Nick190401/Smart-Skip/issues/new?title=${title}&body=${body}`;
          chrome.tabs.create({ url: issuesUrl });
        } catch (e) {
          // Fallback to mailto
          window.open(`mailto:?subject=${encodeURIComponent('Smart Skip: Unsupported site')}&body=${encodeURIComponent(this.currentDomain)}`);
        }
      });
      reportSiteBtn.dataset.bound = 'true';
    }

    const viewSupportedBtn = document.getElementById('viewSupportedBtn');
    if (viewSupportedBtn && !viewSupportedBtn.dataset.bound) {
      viewSupportedBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://github.com/Nick190401/Smart-Skip#readme' });
      });
      viewSupportedBtn.dataset.bound = 'true';
    }
  }

  // Persist a per-series toggle and broadcast updated settings (best-effort)
  updateSeriesSetting(setting, value) {
    const title = (this.currentSeries && this.currentSeries.title) || this.uiSeriesTitle;
    if (!title) return;
    const seriesKey = `${this.currentDomain}:${title}`;
    
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

  // Switch between supported/unsupported views and refresh sections
  updateUI() {
    if (this.lastKnownUnsupportedState === true) {
      this.showUnsupportedSite();
      return;
    }

    this.showSupportedSite();
    this.updateSettingsUI();
    this.updateSeriesUI();
  }

  // Render unsupported site view
  showUnsupportedSite() {
    const mainContent = document.querySelector('.main-content');
    const unsupportedContent = document.querySelector('.unsupported-content');
    if (mainContent) mainContent.style.display = 'none';
    if (unsupportedContent) unsupportedContent.style.display = 'block';
    try { document.body.classList.add('compact-mode'); } catch (e) {}
  }

  // Render supported site view
  showSupportedSite() {
    const mainContent = document.querySelector('.main-content');
    const unsupportedContent = document.querySelector('.unsupported-content');
    if (mainContent) mainContent.style.display = 'block';
    if (unsupportedContent) unsupportedContent.style.display = 'none';
    try { document.body.classList.remove('compact-mode'); } catch (e) {}
  }

  // Reflect current global/domain/HUD toggle states in the UI
  updateSettingsUI() {
  const globalCheckbox = this.resolveElementByIds('globalEnabled', 'globalToggle');
  const domainCheckbox = this.resolveElementByIds('domainEnabled', 'domainToggle');
  const hudCheckbox = this.resolveElementByIds('hudEnabled', 'hudToggle');
  const hudDomainCheckbox = this.resolveElementByIds('hudDomainEnabled', 'domainHudToggle');

    if (globalCheckbox) this.setToggleState(globalCheckbox, this.settings.globalEnabled);
  if (hudCheckbox) this.setToggleState(hudCheckbox, this.settings.globalHudEnabled !== false);
    if (hudDomainCheckbox) {
      const domainHudSetting = this.settings.domains[this.currentDomain]?.hudEnabled;
      if (domainHudSetting !== undefined) {
        this.setToggleState(hudDomainCheckbox, !!domainHudSetting);
        if (hudDomainCheckbox.tagName === 'INPUT') hudDomainCheckbox.indeterminate = false;
      } else {
        this.setToggleState(hudDomainCheckbox, this.settings.globalHudEnabled !== false);
        if (hudDomainCheckbox.tagName === 'INPUT') hudDomainCheckbox.indeterminate = true;
      }
    }

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

  // Update series title + episode lines and show/hide the section
  updateSeriesUI() {
    const seriesNameElement = this.elementForSeriesName();
    const seriesEpisodeElement = this.elementForSeriesEpisode();
    const seriesSection = this.elementForSeriesSection();

    if (this.currentSeries) {
      if (seriesNameElement) seriesNameElement.textContent = this.currentSeries.title;
      if (seriesEpisodeElement) seriesEpisodeElement.textContent = this.currentSeries.episode || 'Unbekannt';
      if (seriesSection) seriesSection.style.display = 'block';
      this.uiSeriesTitle = this.currentSeries.title;
      this.updateSeriesSettings();
    } else {
      // Fallback: show last-known series for this domain if available
      const lastKnown = this.getLastKnownSeriesForDomain();
      if (lastKnown) {
        if (seriesNameElement) seriesNameElement.textContent = lastKnown.title;
        if (seriesEpisodeElement) seriesEpisodeElement.textContent = 'Zuletzt erkannt';
        if (seriesSection) seriesSection.style.display = 'block';
        this.uiSeriesTitle = lastKnown.title;
        this.updateSeriesSettings();
      } else {
        if (seriesSection) seriesSection.style.display = 'none';
        this.uiSeriesTitle = null;
      }
    }
  }

  // Choose the most recent series entry for the current domain from settings
  getLastKnownSeriesForDomain() {
    try {
      if (!this.currentDomain || !this.settings || !this.settings.series) return null;
      const prefix = `${this.currentDomain}:`;
      let best = null;
      let bestTime = 0;
      for (const key of Object.keys(this.settings.series)) {
        if (!key.startsWith(prefix)) continue;
        const item = this.settings.series[key];
        const ls = item && item.lastSeen ? Date.parse(item.lastSeen) : 0;
        if (ls && ls > bestTime) {
          bestTime = ls;
          best = { title: key.slice(prefix.length) };
        }
      }
      return best;
    } catch (e) { return null; }
  }

  // Initialize per-series checkbox states from stored settings
  updateSeriesSettings() {
    const title = (this.currentSeries && this.currentSeries.title) || this.uiSeriesTitle;
    if (!title) return;
    const seriesKey = `${this.currentDomain}:${title}`;
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

  // Poll for series updates periodically; light-weight in popup context
  startPeriodicUpdates() {
    // Quick burst polling on popup open to catch initial detection
    try {
      let quickPolls = 0;
      const quickInterval = setInterval(() => {
        quickPolls += 1;
        this.detectCurrentSeries().then(() => this.updateSeriesUI());
        if (quickPolls >= 8) { // ~6s at 750ms
          clearInterval(quickInterval);
        }
      }, 750);
    } catch (e) {}

    // Steady-state light polling every 5s
    setInterval(() => {
      this.detectCurrentSeries().then(() => {
        this.updateSeriesUI();
      });
    }, 5000);
  }

  // Apply i18n translations for all [data-i18n] elements
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

  // Show transient status box (success/error/warning/info)
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
