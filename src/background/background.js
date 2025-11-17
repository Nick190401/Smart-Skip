/**
 * Background Service Worker (MV3)
 * - Initializes default settings
 * - Handles runtime messages (seriesDetected, settings ops, script injection)
 * - Bridges storage (sync/local) with safe fallbacks
 */

const DEFAULT_SETTINGS = {
  globalEnabled: true,
  // Global HUD visibility; domains[domain].hudEnabled may override per-domain
  globalHudEnabled: true,
  verboseLogging: false,
  domains: {},
  series: {}
};

// Initialize settings on install/update and migrate legacy shapes
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const result = await chrome.storage.sync.get(['skipperSettings']);
    
    if (!result.skipperSettings) {
      await chrome.storage.sync.set({ skipperSettings: DEFAULT_SETTINGS });
    } else {
      const settings = result.skipperSettings;
      let needsUpdate = false;
      
      if (!settings.series) {
        settings.series = {};
        needsUpdate = true;
      }
      
      if (!settings.domains) {
        settings.domains = {};
        needsUpdate = true;
      }

      // Backfill missing globalHudEnabled with default true
      if (settings.globalHudEnabled === undefined) {
        settings.globalHudEnabled = true;
        needsUpdate = true;
      }
      
      if (settings.domainSettings) {
        Object.keys(settings.domainSettings).forEach(domain => {
          if (!settings.domains[domain]) {
            settings.domains[domain] = { enabled: settings.domainSettings[domain] };
          }
        });
        delete settings.domainSettings;
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        await chrome.storage.sync.set({ skipperSettings: settings });
      }
    }
  } catch (error) {
    // Silent fail
  }
});


// Central message dispatcher
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender, sendResponse);
  return true;
});

async function handleMessage(request, sender, sendResponse) {
  try {
    switch (request.action) {
      case 'buttonClicked':
        await handleButtonClicked(request, sender);
        sendResponse({ success: true });
        break;
        
      case 'seriesDetected':
        await handleSeriesDetected(request, sender);
        sendResponse({ success: true });
        break;
        
      case 'getSettings': {
        const settings = await getSettings();
        sendResponse({ settings });
        break;
      }
        
      case 'saveSettings':
        await saveSettings(request.settings);
        sendResponse({ success: true });
        break;
      
      case 'injectContentScripts':
        await injectContentScripts(request.tabId);
        sendResponse({ success: true });
        break;
        
      default:
        sendResponse({ error: 'Unknown action' });
    }
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

async function handleButtonClicked(request, sender) {
  // No action needed
}

/**
 * Persist lightweight series presence meta to keep last seen shows.
 */
async function handleSeriesDetected(request, sender) {
  try {
    const { series, domain } = request;
    const settings = await getSettings();
    const seriesKey = `${domain}:${series.title}`;
    
    if (!settings.series[seriesKey]) {
      settings.series[seriesKey] = {
        skipIntro: true,
        skipRecap: true,
        skipCredits: true,
        skipAds: true,
        autoNext: false,
        firstDetected: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      };
      
      await saveSettings(settings);
    } else {
      settings.series[seriesKey].lastSeen = new Date().toISOString();
      await saveSettings(settings);
    }

    // Broadcast live update to any open popups or listeners
    try {
      chrome.runtime.sendMessage({ action: 'seriesDetected', series, domain });
    } catch (e) {
      // Silent fail
    }
  } catch (error) {
    // Silent fail
  }
}

/**
 * Load settings with sync → local fallbacks and default hydration.
 */
async function getSettings() {
  try {
    let result = await chrome.storage.sync.get(['skipperSettings']);
    
    if (!result.skipperSettings) {
      result = await chrome.storage.local.get(['skipperSettings']);
    }
    
    if (result.skipperSettings) {
      const settings = result.skipperSettings;
      return {
        globalEnabled: settings.globalEnabled !== undefined ? settings.globalEnabled : true,
        globalHudEnabled: settings.globalHudEnabled !== undefined ? settings.globalHudEnabled : true,
        verboseLogging: settings.verboseLogging !== undefined ? settings.verboseLogging : false,
        domains: settings.domains || {},
        series: settings.series || {}
      };
    }
    
    return DEFAULT_SETTINGS;
  } catch (error) {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save validated settings shape to sync storage (fallback to local on error).
 */
async function saveSettings(settings) {
  try {
    if (!settings || typeof settings !== 'object') {
      throw new Error('Invalid settings structure');
    }
    
    const validSettings = {
      globalEnabled: settings.globalEnabled !== undefined ? settings.globalEnabled : true,
      globalHudEnabled: settings.globalHudEnabled !== undefined ? settings.globalHudEnabled : true,
      verboseLogging: settings.verboseLogging !== undefined ? settings.verboseLogging : false,
      domains: settings.domains || {},
      series: settings.series || {}
    };
    
    try {
      await chrome.storage.sync.set({ skipperSettings: validSettings });
    } catch (syncError) {
      await chrome.storage.local.set({ skipperSettings: validSettings });
    }
  } catch (error) {
    throw error;
  }
}

/**
 * Programmatically inject required scripts into a given tab.
 * Used for unsupported domains when user overrides via popup.
 */
async function injectContentScripts(tabId) {
  try {
    if (!tabId) throw new Error('No tabId provided');
    // Inject language manager first
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/shared/language.js']
    });
    // Then inject the skipper
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/skipper.js']
    });
  } catch (e) {
    throw e;
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const streamingSites = [
      'netflix.com', 'disneyplus.com', 'primevideo.com', 'amazon.com',
      'crunchyroll.com', 'tv.apple.com', 'hulu.com',
      'hbo.com', 'peacocktv.com', 'paramount.com'
    ];
    
    const url = new URL(tab.url);
    const isStreamingSite = streamingSites.some(site => url.hostname.includes(site));
  }
});


