const DEFAULT_SETTINGS = {
  globalEnabled: true,
  verboseLogging: false,
  domains: {},
  series: {}
};

// Initialize extension
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    // Load existing settings or set defaults
    const result = await chrome.storage.sync.get(['skipperSettings']);
    
    if (!result.skipperSettings) {
      await chrome.storage.sync.set({ skipperSettings: DEFAULT_SETTINGS });
    } else {
      // Migrate old settings if needed
      const settings = result.skipperSettings;
      let needsUpdate = false;
      
      // Ensure new structure exists
      if (!settings.series) {
        settings.series = {};
        needsUpdate = true;
      }
      
      if (!settings.domains) {
        settings.domains = {};
        needsUpdate = true;
      }
      
      // Migrate old domainSettings to new domains structure
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
    // Error initializing extension - silently fail
  }
});



// Handle messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender, sendResponse);
  return true; // Keep message channel open for async response
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
        
      case 'getSettings':
        const settings = await getSettings();
        sendResponse({ settings });
        break;
        
      case 'saveSettings':
        await saveSettings(request.settings);
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
  const { buttonText, domain } = request;
  
  // Notification logic removed
}

async function handleSeriesDetected(request, sender) {
  const { series, domain } = request;
  
  try {
    const settings = await getSettings();
    const seriesKey = `${domain}:${series.title}`;
    
    // Auto-create series entry with default settings if it doesn't exist
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
      
      // Notification logic removed
    } else {
      // Update last seen
      settings.series[seriesKey].lastSeen = new Date().toISOString();
      await saveSettings(settings);
    }
    
  } catch (error) {
    // Error handling series detection - silently fail
  }
}

async function getSettings() {
  try {
    // Try sync storage first
    let result = await chrome.storage.sync.get(['skipperSettings']);
    
    if (!result.skipperSettings) {
      result = await chrome.storage.local.get(['skipperSettings']);
    }
    
    if (result.skipperSettings) {
      // Validate settings structure
      const settings = result.skipperSettings;
      return {
        globalEnabled: settings.globalEnabled !== undefined ? settings.globalEnabled : true,
        verboseLogging: settings.verboseLogging !== undefined ? settings.verboseLogging : false,
        domains: settings.domains || {},
        series: settings.series || {}
      };
    }
    
    // Return defaults if nothing found
    return DEFAULT_SETTINGS;
  } catch (error) {
    return DEFAULT_SETTINGS;
  }
}

async function saveSettings(settings) {
  try {
    // Validate settings structure
    if (!settings || typeof settings !== 'object') {
      throw new Error('Invalid settings structure');
    }
    
    const validSettings = {
      globalEnabled: settings.globalEnabled !== undefined ? settings.globalEnabled : true,
      verboseLogging: settings.verboseLogging !== undefined ? settings.verboseLogging : false,
      domains: settings.domains || {},
      series: settings.series || {}
    };
    
    // Try sync storage first
    try {
      await chrome.storage.sync.set({ skipperSettings: validSettings });
    } catch (syncError) {
      await chrome.storage.local.set({ skipperSettings: validSettings });
    }
  } catch (error) {
    throw error;
  }
}

// Listen for tab updates to detect streaming sites
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const streamingSites = [
      'netflix.com', 'disneyplus.com', 'primevideo.com', 'amazon.com',
      'youtube.com', 'crunchyroll.com', 'tv.apple.com', 'hulu.com',
      'hbo.com', 'peacocktv.com', 'paramount.com'
    ];
    
    const url = new URL(tab.url);
    const isStreamingSite = streamingSites.some(site => url.hostname.includes(site));
  }
});


