class VideoPlayerSkipper {
  constructor() {
    this.isEnabled = true;
    this.verboseLogging = false;
    this.domain = window.location.hostname;
    this.observer = null;
    this.contentObserver = null;
    this.pollInterval = null;
    this.lastClickTime = 0;
    this.clickCooldown = 1000;
    
    // Series detection state for intelligent skipping decisions
    this.currentSeries = null;
    this.seriesCheckInterval = null;
    this.seriesDetectionTimeout = null;
    this.lastUrl = null;
    this.lastSeriesDetection = 0; // Cache for series detection
    this.lastDetectionUrl = null; // URL-based cache
    this.lastDomStateHash = null; // DOM state for cache validation
    
    this.supportedDomains = [
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
    
    // Check if current domain is supported - important for performance and security
    this.isSupportedPlatform = this.supportedDomains.some(domain => {
      // Handle TLD-flexible matching: netflix. matches netflix.com, netflix.de, etc.
      if (domain.endsWith('.')) {
        return this.domain.startsWith(domain) || this.domain.includes('.' + domain.slice(0, -1) + '.');
      } else {
        // Exact domain matching for complete domains
        return this.domain === domain || this.domain.endsWith('.' + domain);
      }
    });
    
    if (!this.isSupportedPlatform) {
      return;
    }
    
    // Supported platform detected
    
    // Settings hierarchy: series-specific > domain-specific > global
    this.settings = {
      globalEnabled: true,
      verboseLogging: false,
      domains: {},
      series: {}
    };
    
    this.currentSeries = null;
    this.seriesCheckInterval = null;
    
    // Language detection for multi-language button text matching
    this.detectedLanguage = null;
    this.buttonPatterns = null;
    
    this.init();
  }
  
  async init() {
    if (!this.isSupportedPlatform) {
      return;
    }

    // Initializing Smart Skip on supported platform
    
    this.detectedLanguage = this.detectPageLanguage();
    this.buttonPatterns = this.generateButtonPatterns();
    
    // Language and patterns generated
    
    await this.loadSettings();
    
    this.startSeriesDetection();
    
    // Popup communication channel
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.handleMessage(request, sender, sendResponse);
      return true;
    });
    
    // Debug interface for manual testing
    window.__autoSkipper = {
      start: () => this.start(),
      stop: () => this.stop(),
      scan: () => this.scanForButtons(),
      setVerbose: (enabled) => this.setVerboseLogging(enabled),
      // refreshLanguage: () => this.refreshLanguageDetection(), // COMMENTED OUT - function is unused
      getDetectedLanguage: () => this.detectedLanguage,
      getPatterns: () => this.buttonPatterns,
      getCurrentSeries: () => this.currentSeries,
      instance: this
    };
    
    if (this.isEnabled) {
      this.start();
    }
    
    // React to settings changes from popup
    chrome.storage.onChanged.addListener((changes) => {
      this.handleStorageChange(changes);
    });
  }
  
  /**
   * Loads settings with fallback chain: sync -> local -> localStorage -> memory
   * This ensures settings work even in temporary/development extensions
   */
  async loadSettings() {
    try {
      let loadedSettings = null;
      let loadMethod = '';
      
      // Try sync storage first (cross-device syncing)
      try {
        if (chrome.storage && chrome.storage.sync) {
          const result = await chrome.storage.sync.get(['skipperSettings']);
          if (result.skipperSettings) {
            loadedSettings = result.skipperSettings;
            loadMethod = 'sync';
          }
        }
      } catch (syncError) {
        // Sync storage failed - try other methods
      }
      
      // Fallback to local storage
      if (!loadedSettings) {
        try {
          if (chrome.storage && chrome.storage.local) {
            const result = await chrome.storage.local.get(['skipperSettings']);
            if (result.skipperSettings) {
              loadedSettings = result.skipperSettings;
              loadMethod = 'local';
            }
          }
        } catch (localError) {
          // Local storage failed - try other methods
        }
      }
      
      // Fallback to browser localStorage (for temporary extensions)
      if (!loadedSettings) {
        try {
          const storedSettings = localStorage.getItem('skipperSettings');
          if (storedSettings) {
            loadedSettings = JSON.parse(storedSettings);
            loadMethod = 'localStorage';
          }
        } catch (lsError) {
          // localStorage failed
        }
      }
      
      // Final fallback to in-memory storage
      if (!loadedSettings && window.skipperSettings) {
        loadedSettings = window.skipperSettings;
        loadMethod = 'memory';
      }
      
      if (loadedSettings) {
        this.settings = { ...this.settings, ...loadedSettings };
      } else {
        // Using default settings
      }
      
      this.verboseLogging = this.settings.verboseLogging;
      
      // Determine enabled status: domain-specific overrides global
      const domainSetting = this.settings.domains[this.domain]?.enabled;
      if (domainSetting !== undefined) {
        this.isEnabled = domainSetting;
      } else {
        this.isEnabled = this.settings.globalEnabled;
      }
      
      // Settings loaded successfully
    } catch (error) {
      // Failed to load settings - use safe defaults
      this.isEnabled = true;
      this.verboseLogging = false;
    }
  }

  handleStorageChange(changes) {
    if (changes.skipperSettings) {
      const newSettings = changes.skipperSettings.newValue;
      if (newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        
        this.verboseLogging = this.settings.verboseLogging;
        
        // Re-evaluate enabled status and restart if needed
        const domainSetting = this.settings.domains[this.domain]?.enabled;
        const newEnabled = domainSetting !== undefined ? domainSetting : this.settings.globalEnabled;
        
        if (newEnabled !== this.isEnabled) {
          this.isEnabled = newEnabled;
          this.stop();
          if (this.isEnabled) {
            this.start();
          }
        }
      }
    }
  }

  // === SERIES DETECTION SYSTEM ===
  // Intelligently detects current series/episode for context-aware skipping
  
  startSeriesDetection() {
    this.detectCurrentSeries();
    
    this.lastUrl = window.location.href;
    
    // Adaptive polling: frequent when searching, infrequent when series detected
    this.updateSeriesCheckInterval();
    
    // Multi-layered detection for SPA navigation and content changes
    this.setupUrlChangeDetection();
    this.setupContentChangeDetection();
    this.setupButtonClickDetection();
    this.setupVideoEventDetection();
  }
  
  updateSeriesCheckInterval() {
    if (this.seriesCheckInterval) {
      clearInterval(this.seriesCheckInterval);
    }
    
    // Intelligent interval based on context
    const isOnContentPage = this.isOnPotentialContentPage();
    const shouldCheckFrequently = !this.currentSeries || (isOnContentPage && !this.currentSeries);
    
    const interval = shouldCheckFrequently ? 3000 : 30000;
    const reason = this.currentSeries ? 'series detected' : (isOnContentPage ? 'on content page but no series detected' : 'no series detected');
    
    // Setting series check interval
    
    this.seriesCheckInterval = setInterval(() => {
      this.detectCurrentSeries();
    }, interval);
  }
  
  isOnPotentialContentPage() {
    const url = window.location.href;
    const domain = window.location.hostname;
    
    // Check if we're on a page that typically contains series content
    const contentPagePatterns = [
      // Netflix
      '/watch/', '/title/',
      // Disney+
      '/series/', '/movies/', '/video/',
      // Prime Video
      '/detail/', '/gp/video/',
      // YouTube
      '/watch?v=',
      // Crunchyroll
      '/watch/', '/series/',
      // Apple TV+
      '/show/', '/movie/',
      // HBO Max / Max
      '/series/', '/movies/', '/episode/',
      // Generic patterns
      '/play/', '/stream/', '/episode/', '/season/'
    ];
    
    const isContentPage = contentPagePatterns.some(pattern => url.includes(pattern));
    
    // Also check if there's a video element present (good indicator of content page)
    const hasVideo = document.querySelector('video') !== null;
    
    // Don't consider browse pages as content pages
    const isBrowsePage = url.includes('/browse') || url.includes('/home') || url.includes('/search');
    
    const result = (isContentPage || hasVideo) && !isBrowsePage;
    
    // Content page detection complete
    
    return result;
  }
  
  setupUrlChangeDetection() {
    // Hook into SPA navigation by overriding history API
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    
    history.pushState = (...args) => {
      originalPushState.apply(history, args);
      this.handleUrlChange();
    };
    
    history.replaceState = (...args) => {
      originalReplaceState.apply(history, args);
      this.handleUrlChange();
    };
    
    window.addEventListener('popstate', () => {
      this.handleUrlChange();
    });
    
    window.addEventListener('hashchange', () => {
      this.handleUrlChange();
    });
  }
  
  setupContentChangeDetection() {
    // Monitor DOM changes that indicate new series/episode content
    this.contentObserver = new MutationObserver((mutations) => {
      let shouldCheckSeries = false;
      
      for (const mutation of mutations) {
        // Document title changes
        if (mutation.type === 'childList' && 
            mutation.target === document.head &&
            mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.tagName === 'TITLE') {
              shouldCheckSeries = true;
              break;
            }
          }
        }
        
        // Video title/metadata changes
        if (mutation.type === 'childList' || mutation.type === 'characterData') {
          const target = mutation.target;
          
          if (target.matches && (
            target.matches('[data-uia*="title"]') ||
            target.matches('[data-uia*="series"]') ||
            target.matches('[data-uia*="episode"]') ||
            target.matches('.video-title') ||
            target.matches('.series-title') ||
            target.matches('.episode-title')
          )) {
            shouldCheckSeries = true;
            break;
          }
          
          if (target.closest && (
            target.closest('[data-uia*="title"]') ||
            target.closest('[data-uia*="series"]') ||
            target.closest('[data-uia*="episode"]') ||
            target.closest('.video-title') ||
            target.closest('.series-title') ||
            target.closest('.episode-title')
          )) {
            shouldCheckSeries = true;
            break;
          }
        }
        
        // Attribute changes on title elements
        if (mutation.type === 'attributes' && 
            mutation.target.matches &&
            mutation.target.matches('[data-uia*="title"], [data-uia*="series"], [data-uia*="episode"]')) {
          shouldCheckSeries = true;
          break;
        }
      }
      
      if (shouldCheckSeries) {
        // Debounce to prevent excessive detection calls
        if (this.seriesDetectionTimeout) {
          clearTimeout(this.seriesDetectionTimeout);
        }
        this.seriesDetectionTimeout = setTimeout(() => {
          this.detectCurrentSeries();
        }, 500);
      }
    });
    
    // Watch entire document for series-related changes
    this.contentObserver.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-uia', 'data-testid', 'data-automation-id', 'title', 'aria-label']
    });
  }
  
  setupButtonClickDetection() {
    // Listen for navigation that might change series/episode context
    document.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('button, [role="button"], a');
      
      if (!button) return;
      
      const buttonText = (button.textContent || '').toLowerCase();
      const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
      const className = (button.className || '').toLowerCase();
      const href = button.getAttribute('href') || '';
      
      // Check for next episode buttons first (require immediate force detection)
      const nextEpisodePatterns = [
        'next episode', 'nächste episode', 'nächste folge', 'next', 'weiter',
        'continue watching', 'weiter schauen', 'continuer', 'siguiente',
        'nächste', 'continue', 'play next', 'automatisch weiter'
      ];

      const isNextEpisodeButton = nextEpisodePatterns.some(pattern => 
        buttonText.includes(pattern) || ariaLabel.includes(pattern) || className.includes(pattern)
      );

      // Also check data attributes for next episode indicators
      const dataAttrs = ['data-uia', 'data-testid', 'data-automation-id', 'data-t'];
      const hasNextEpisodeDataAttr = dataAttrs.some(attr => {
        const value = (button.getAttribute(attr) || '').toLowerCase();
        return value.includes('next') || value.includes('episode') || value.includes('seamless') || 
               value.includes('auto-advance') || value.includes('continue');
      });

      if (isNextEpisodeButton || hasNextEpisodeDataAttr) {
        // Next Episode Button clicked - forcing immediate series detection
        
        // Force immediate cache reset and detection for next episode
        this.lastSeriesDetection = 0;
        this.lastDetectionUrl = null;
        this.lastDomStateHash = null;
        
        // Multiple checks to ensure we catch the series update after episode change
        setTimeout(() => {
          this.detectCurrentSeries();
        }, 1000);
        
        setTimeout(() => {
          this.detectCurrentSeries();
        }, 3000);
        
        setTimeout(() => {
          this.detectCurrentSeries();
        }, 6000);
        
        return; // Skip general navigation detection for next episode buttons
      }

      // Patterns that suggest navigation to new content
      const navigationPatterns = [
        'previous episode', 'vorherige folge',
        'episode', 'folge', 'staffel', 'season',
        'play', 'watch', 'schauen', 'abspielen',
        'browse', 'durchsuchen', 'search', 'suche',
        'title-card', 'billboard', 'jaw-bone', 'preview-modal',
        'my list', 'meine liste', 'watchlist',
        'hero-', 'collection-', 'episode-',
        'dv-node-', 'av-', 'detail-page',
        'playlist', 'channel', 'video',
        'thumbnail', 'poster', 'cover', 'tile'
      ];

      const seriesChangePatterns = [
        '/title/', '/series/', '/show/', '/watch/', '/video/',
        '/movie/', '/film/', '/anime/', '/drama/',
        '/episode/', '/folge/', '/season/', '/staffel/'
      ];

      let mightChangeSeries = false;      // Check button text and aria-label
      for (const pattern of navigationPatterns) {
        if (buttonText.includes(pattern) || ariaLabel.includes(pattern) || className.includes(pattern)) {
          mightChangeSeries = true;
          // Verbose debug log removed: "${pattern}" in "${buttonText || ariaLabel}"`);
          break;
        }
      }
      
      // Check href for series change patterns
      if (!mightChangeSeries && href) {
        for (const pattern of seriesChangePatterns) {
          if (href.includes(pattern)) {
            mightChangeSeries = true;
            // Verbose debug log removed: "${pattern}" in "${href}"`);
            break;
          }
        }
      }
      
      // Check for data attributes that suggest navigation
      if (!mightChangeSeries) {
        const dataAttrs = ['data-uia', 'data-testid', 'data-automation-id', 'data-t'];
        for (const attr of dataAttrs) {
          const value = (button.getAttribute(attr) || '').toLowerCase();
          if (value && (
            value.includes('title') || value.includes('episode') || value.includes('series') ||
            value.includes('watch') || value.includes('play') || value.includes('next') ||
            value.includes('prev') || value.includes('browse') || value.includes('search')
          )) {
            mightChangeSeries = true;
            // Verbose debug log removed: "${value}"`);
            break;
          }
        }
      }
      
      if (mightChangeSeries) {
        // Verbose debug log removed
        
        // Delayed detection to allow page transitions
        setTimeout(() => {
          // Verbose debug log removed
          this.detectCurrentSeries();
        }, 2000);
        
        // Second check for slow-loading content
        setTimeout(() => {
          // Verbose debug log removed
          this.detectCurrentSeries();
        }, 5000);
      }
    }, true);
  }
  
  setupVideoEventDetection() {
    // Monitor video events that indicate episode changes
    const checkVideoEvents = () => {
      const videos = document.querySelectorAll('video');
      
      videos.forEach((video, index) => {
        // Prevent duplicate listeners
        if (video.dataset.skipperListenersAdded) return;
        video.dataset.skipperListenersAdded = 'true';
        
        // Verbose debug log removed
        
        // Key video events that suggest new content
        video.addEventListener('loadstart', () => {
          // Verbose debug log removed
          setTimeout(() => {
            this.detectCurrentSeries();
          }, 1000);
        });
        
        video.addEventListener('loadedmetadata', () => {
          // Verbose debug log removed
          
          setTimeout(() => {
            this.detectCurrentSeries();
          }, 500);
        });
        
        video.addEventListener('playing', () => {
          // Verbose debug log removed
          setTimeout(() => {
            this.detectCurrentSeries();
          }, 1000);
        });
        
        // Source changes indicate new episodes
        video.addEventListener('canplay', () => {
          if (video.src && video.src !== video.dataset.lastSrc) {
            // Verbose debug log removed
            video.dataset.lastSrc = video.src;
            setTimeout(() => {
              this.detectCurrentSeries();
            }, 1500);
          }
        });
      });
    };
    
    checkVideoEvents();
    
    // Watch for new video elements being added
    const videoObserver = new MutationObserver((mutations) => {
      let newVideoAdded = false;
      
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'VIDEO' || node.querySelector('video')) {
              newVideoAdded = true;
            }
          }
        });
      });
      
      if (newVideoAdded) {
        // Verbose debug log removed
        setTimeout(checkVideoEvents, 500);
      }
    });
    
    videoObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    this.videoObserver = videoObserver;
  }
  
  handleUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== this.lastUrl) {
      // Verbose debug log removed
      this.lastUrl = currentUrl;
      
      // Don't immediately clear series - let detection validate it
      const wasOnContentPage = this.lastUrl && this.isUrlContentPage(this.lastUrl);
      const isNowOnContentPage = this.isUrlContentPage(currentUrl);
      
      if (isNowOnContentPage && (!this.currentSeries || wasOnContentPage !== isNowOnContentPage)) {
        // Verbose debug log removed
        this.updateSeriesCheckInterval();
      }
      
      // Allow page to load before detecting series
      setTimeout(() => {
        this.detectCurrentSeries();
      }, 1000);
    }
  }
  
  isUrlContentPage(url) {
    if (!url) return false;
    
    const contentPagePatterns = [
      '/watch/', '/title/', '/series/', '/movies/', '/video/',
      '/detail/', '/gp/video/', '/watch?v=', '/show/', '/movie/',
      '/episode/', '/season/', '/play/', '/stream/'
    ];
    
    const isContentPage = contentPagePatterns.some(pattern => url.includes(pattern));
    const isBrowsePage = url.includes('/browse') || url.includes('/home') || url.includes('/search');
    
    return isContentPage && !isBrowsePage;
  }

  detectCurrentSeries() {
    // Smart cache - prevent excessive detection but allow after DOM changes
    const now = Date.now();
    const currentUrl = window.location.href;
    
    // Check if DOM might have changed (page reload, new content)
    const hasVideo = document.querySelector('video') !== null;
    const hasNetflixContent = document.querySelector('[data-uia*="title"], [data-uia*="video"]') !== null;
    const domStateHash = `${hasVideo}-${hasNetflixContent}-${document.title}`;
    
    // Only cache if same URL AND same DOM state AND within short timeframe
    if (this.lastSeriesDetection && 
        this.lastDetectionUrl === currentUrl && 
        this.lastDomStateHash === domStateHash &&
        (now - this.lastSeriesDetection) < 200) {
      // Skip detection only if everything is identical
      return;
    }
    
    this.lastSeriesDetection = now;
    this.lastDetectionUrl = currentUrl;
    this.lastDomStateHash = domStateHash;
    
    const newSeries = this.extractSeriesInfo();
    
    // Special page type handling
    const isOnTitlePage = window.location.href.includes('/title/') && 
                         !window.location.href.includes('/watch/');
    const isOnBrowsePage = window.location.href.includes('/browse');
    
    // Clear series when just browsing
    if (isOnBrowsePage && this.currentSeries) {
      // Verbose debug log removed
      this.currentSeries = null;
      this.updateSeriesCheckInterval();
      return;
    }
    
    // Intelligent series change detection
    let seriesChanged = false;
    
    if (!this.currentSeries && newSeries) {
      seriesChanged = true;
      // Verbose debug log removed
    } else if (this.currentSeries && !newSeries) {
      // Conservative approach: only clear if definitely not on content page
      const isOnVideoPage = window.location.href.includes('/watch/') && 
                           document.querySelector('video') !== null;
      
      const isOnTitlePage = window.location.href.includes('/title/') && 
                           !window.location.href.includes('/watch/');
      
      if (!isOnVideoPage && !isOnTitlePage) {
        seriesChanged = true;
        // Verbose debug log removed');
      } else if (isOnTitlePage && this.currentSeries) {
        seriesChanged = true;
        // Verbose debug log removed
      } else if (isOnVideoPage) {
        // Verbose debug log removed
        return; 
      } else {
        // Verbose debug log removed
        return;
      }
    } else if (this.currentSeries && newSeries) {
      // Detailed comparison for updates
      const titleChanged = newSeries.title !== this.currentSeries.title;
      const episodeChanged = newSeries.episode !== this.currentSeries.episode;
      const sourceChanged = newSeries.source !== this.currentSeries.source;
      
      if (titleChanged) {
        // Verbose debug log removed
        seriesChanged = true;
      }
      
      if (episodeChanged) {
        // Verbose debug log removed
        seriesChanged = true;
      }
      
      if (sourceChanged) {
        // Verbose debug log removed
        seriesChanged = true;
      }
    }
    
    if (seriesChanged) {
      const previousSeries = this.currentSeries;
      
      // Special handling for title page browsing
      if (!newSeries && isOnTitlePage && this.currentSeries) {
        newSeries = {
          title: this.currentSeries.title,
          episode: 'browsing',
          source: this.currentSeries.source
        };
        // Verbose debug log removed
      }
      
      this.currentSeries = newSeries;
      
      this.updateSeriesCheckInterval();
      
      if (newSeries) {
        // Debug log removed`);
        
        // Notify background script
        chrome.runtime.sendMessage({
          action: 'seriesDetected',
          series: newSeries,
          previousSeries: previousSeries,
          domain: this.domain
        }).catch(error => {
          // Verbose debug log removed
        });
        
        // Auto-create default settings for new series
        const seriesKey = `${this.domain}:${newSeries.title}`;
        if (!this.settings.series[seriesKey]) {
          this.settings.series[seriesKey] = {
            skipIntro: true,
            skipRecap: true,
            skipCredits: true,
            skipAds: true,
            autoNext: false
          };
          // Verbose debug log removed
          this.saveSettings();
        } else {
          // Verbose debug log removed
        }
        
        const currentSettings = this.getCurrentSeriesSettings();
        // Verbose debug log removed
      } else {
        // Debug log removed
      }
    } else if (newSeries) {
      // Reduce log spam for unchanged series
      if (Math.random() < 0.1) {
        // Verbose debug log removed
      }
    } else if (this.currentSeries) {
      if (Math.random() < 0.05) {
        // Verbose debug log removed
      }
    } else {
      if (Math.random() < 0.05) {
        // Verbose debug log removed
      }
    }
  }

  // === PLATFORM-SPECIFIC SERIES EXTRACTION ===
  // Each platform has unique DOM structure and naming conventions
  
  extractSeriesInfo() {
    const domain = this.domain;
    
    try {
      if (domain.includes('netflix.com')) {
        return this.extractNetflixSeries();
      } else if (domain.includes('disneyplus.com') || domain.includes('disney.com')) {
        return this.extractDisneyPlusSeries();
      } else if (domain.includes('primevideo.com') || domain.includes('amazon.')) {
        return this.extractPrimeVideoSeries();
      } else if (domain.includes('youtube.com')) {
        return this.extractYouTubeSeries();
      } else if (domain.includes('crunchyroll.com')) {
        return this.extractCrunchyrollSeries();
      } else if (domain.includes('apple.com')) {
        return this.extractAppleTVSeries();
      } else {
        return this.extractGenericSeries();
      }
    } catch (error) {
      // Verbose debug log removed
      return null;
    }
  }

  /**
   * Netflix series extraction - complex due to dynamic content and multiple page types
   * Must distinguish between series titles and episode titles, handle different page types
   */
  extractNetflixSeries() {
    let title = null;
    let episode = null;
    
    // Page type detection for different extraction strategies
    const isWatchPage = window.location.href.includes('/watch/');
    const isTitlePage = window.location.href.includes('/title/') && !window.location.href.includes('/watch/');
    const isBrowsePage = window.location.href.includes('/browse');
    const hasVideo = document.querySelector('video') !== null;
    
    if (isBrowsePage) {
      // Verbose debug log removed
      return null;
    }
    
    // Verbose debug log removed
    
    // Smart extraction from video-title structure
    const videoTitleElement = document.querySelector('[data-uia="video-title"]');
    if (videoTitleElement) {
      // Verbose debug log removed
      
      // Look for h4 (series title) inside video-title
      const h4Element = videoTitleElement.querySelector('h4');
      if (h4Element?.textContent?.trim()) {
        const candidateTitle = h4Element.textContent.trim();
        // Verbose debug log removed
        
        // Basic validation for series title
        if (candidateTitle.length > 2 && !/^\d+$/.test(candidateTitle)) {
          title = candidateTitle;
          
          // Extract episode info from spans
          const spans = videoTitleElement.querySelectorAll('span');
          if (spans.length > 0) {
            let episodeInfo = [];
            spans.forEach(span => {
              const text = span.textContent?.trim();
              if (text) {
                episodeInfo.push(text);
              }
            });
            
            if (episodeInfo.length > 0) {
              episode = episodeInfo.join(' - ');
              // Verbose debug log removed
            }
          }
        }
      }
    }
    
    // Fallback to other selectors if video-title didn't work
    if (!title) {
      const seriesSelectors = [
        '[data-uia="title-card-series-title"]',
        '[data-uia="previewModal-seriesTitle"]', 
        '[data-uia="dp-series-title"]',
        'h4[data-uia="fallback-text-video-title"]',
        'h1[class*="ltr-"]', // Common Netflix class pattern
        'h2[class*="ltr-"]',
        '.billboard-title',
        '.title-info-metadata h1'
      ];
      
      for (const selector of seriesSelectors) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          const candidateTitle = element.textContent.trim();
          // Verbose debug log removed
          
          // Filter out episode-like titles
          const episodePattern = /^(Episode|E)\s*\d+|^\d+\.\s|^S\d+E\d+|^\d+:\s|^Folge\s*\d+|^Flg\.\s*\d+|^Teil\s*\d+|^Chapter\s*\d+|^Kapitel\s*\d+/i;
          const timePattern = /^\d+:\d+/;
          const mixedEpisodePattern = /.*Flg\.\s*\d+|.*Folge\s*\d+|.*Episode\s*\d+|.*Teil\s*\d+/i;
          
          if (!episodePattern.test(candidateTitle) && 
              !timePattern.test(candidateTitle) && 
              !mixedEpisodePattern.test(candidateTitle)) {
            if (candidateTitle.length > 2 && !/^\d+$/.test(candidateTitle)) {
              title = candidateTitle;
              // Verbose debug log removed
              break;
            } else {
              // Verbose debug log removed: "${candidateTitle}"`);
            }
          } else {
            // Verbose debug log removed: "${candidateTitle}"`);
          }
        }
      }
    }
    
    // Episode extraction (only on watch pages with video) - optimized selectors
    if (isWatchPage || hasVideo) {
      const episodeSelectors = [
        '[data-uia="episode-selector"] button[aria-expanded="false"]', // Most reliable
        '[data-uia="episode-title"]',
        '[data-uia="episode-number"]',
        '.episode-selector button',
        '.current-episode',
        '*[data-uia*="episode"]'
      ];
      
      for (const selector of episodeSelectors) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          let candidateEpisode = element.textContent.trim();
          
          // Clean episode info (remove series title if present)
          if (title) {
            candidateEpisode = candidateEpisode.replace(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
          }
          candidateEpisode = candidateEpisode.replace(/^[:\-–—]\s*/, '').trim();
          
          if (candidateEpisode.length > 0) {
            episode = candidateEpisode;
            // Verbose debug log removed
            break;
          }
        }
      }
    } else if (isTitlePage) {
      episode = 'browsing';
      // Verbose debug log removed
    }
    
    // Fallback to document title with aggressive cleaning
    if (!title) {
      // Verbose debug log removed
      const docTitle = document.title?.replace(' - Netflix', '').replace(' | Netflix', '').trim();
      
      if (docTitle && docTitle !== 'Netflix' && docTitle.length > 0) {
        let cleanedTitle = docTitle
          .replace(/:\s*Episode\s*\d+.*$/i, '')
          .replace(/:\s*S\d+E\d+.*$/i, '')
          .replace(/:\s*\d+\..*$/i, '')
          .replace(/\s*-\s*Episode.*$/i, '')
          .replace(/\s*-\s*Folge.*$/i, '')
          .replace(/:\s*Folge\s*\d+.*$/i, '')
          .replace(/:\s*Teil\s*\d+.*$/i, '')
          .replace(/:\s*Chapter\s*\d+.*$/i, '')
          .replace(/\s*-\s*Season\s*\d+.*$/i, '')
          .replace(/\s*-\s*Staffel\s*\d+.*$/i, '')
          .replace(/\s*-\s*\d+:\d+.*$/i, '')
          .trim();
        
        // Extract episode from document title if not found yet
        if (!episode) {
          const episodeMatch = docTitle.match(/(?:Episode|Folge|Teil|Chapter)\s*(\d+[^-]*)/i);
          if (episodeMatch) {
            episode = episodeMatch[1].trim();
            // Verbose debug log removed
          }
        }
        
        if (cleanedTitle && 
            cleanedTitle !== 'Netflix' && 
            cleanedTitle !== 'Startseite' && 
            cleanedTitle !== 'Home' &&
            cleanedTitle !== 'Watch' &&
            cleanedTitle.length > 2 &&
            !/^\d+$/.test(cleanedTitle)) {
          title = cleanedTitle;
          // Verbose debug log removed
        } else {
          // Verbose debug log removed
        }
      } else {
        // Verbose debug log removed
      }
    }
    
    // Advanced title cleaning - remove episode patterns that leaked through
    if (title) {
      const episodePatterns = [
        /Flg\.\s*\d+.*/i,          // "Flg. 14Dungeon" -> "Black Clover"
        /Folge\s*\d+.*/i,
        /Teil\s*\d+.*/i,
        /Kapitel\s*\d+.*/i,
        /Episode\s*\d+.*/i,
        /Ep\.\s*\d+.*/i,
        /Chapter\s*\d+.*/i,
        /S\d+E\d+.*/i,
        /Season\s*\d+.*/i,
        /Staffel\s*\d+.*/i,
        /\s*-\s*\d+.*/,
        /\s*:\s*\d+.*/,
        /\d+\.\s*.*/,
      ];
      
      const originalTitle = title;
      
      for (const pattern of episodePatterns) {
        const cleaned = title.replace(pattern, '').trim();
        if (cleaned.length > 2 && cleaned !== title) {
          // Verbose debug log removed`);
          title = cleaned;
          break;
        }
      }
      
      // Remove episode info if it was mixed into title
      if (episode && episode !== 'unknown') {
        const episodeEscaped = episode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cleanedWithEpisode = title.replace(new RegExp(`\\s*[-:–—]\\s*${episodeEscaped}.*$`, 'i'), '').trim();
        if (cleanedWithEpisode !== title && cleanedWithEpisode.length > 2) {
          // Verbose debug log removed
          title = cleanedWithEpisode;
        }
      }
      
      title = title.replace(/\s+/g, ' ').trim();
      
      if (originalTitle !== title) {
        // Verbose debug log removed
      }
    }
    
    // URL-based detection fallback
    if (!title) {
      // Verbose debug log removed
      
      const url = window.location.href;
      const titleMatch = url.match(/\/title\/(\d+)/);
      
      if (titleMatch) {
        const metaSelectors = [
          'meta[property="og:title"]',
          'meta[name="title"]',
          'meta[property="twitter:title"]',
          'meta[name="description"]'
        ];
        
        for (const selector of metaSelectors) {
          const metaElement = document.querySelector(selector);
          const content = metaElement?.getAttribute('content')?.trim();
          
          if (content && 
              content !== 'Netflix' && 
              !content.includes('Watch ') &&
              !content.includes('Episode ') &&
              content.length > 2) {
            title = content.replace(' - Netflix', '').replace(' | Netflix', '').trim();
            // Verbose debug log removed
            break;
          }
        }
      }
    }
    
    // Final validation and return
    if (title) {
      title = title
        .replace(/\s+/g, ' ')
        .replace(/^[:\-–—\s]+/, '')
        .replace(/[:\-–—\s]+$/, '')
        .trim();
      
      // Reject generic titles
      const genericTitles = ['Netflix', 'Startseite', 'Home', 'Watch', 'Video', 'Player', 'Movie', 'Film'];
      const isGeneric = genericTitles.some(generic => 
        title.toLowerCase() === generic.toLowerCase() ||
        title.toLowerCase().includes(`watch ${title.toLowerCase()}`) ||
        title.toLowerCase().includes(`stream ${title.toLowerCase()}`)
      );
      
      if (isGeneric || title.length < 2) {
        // Verbose debug log removed
        return null;
      }
      
      // Ensure episode has meaningful content
      if (!episode || episode === 'unknown' || episode.length === 0) {
        const currentTimeElement = document.querySelector('.watch-video--duration-timer, .video-player-time');
        if (currentTimeElement) {
          episode = 'playing';
        } else {
          episode = 'unknown';
        }
      }
      
      // Verbose debug log removed
      return { title, episode: episode || 'unknown', source: 'netflix' };
    }
    
    // Final fallback: preserve existing series if still on watch page
    if (!title && this.currentSeries && this.currentSeries.source === 'netflix') {
      const isOnNetflixPage = window.location.href.includes('/watch/') || 
                             window.location.href.includes('/title/') ||
                             document.querySelector('video') !== null;
      
      if (isOnNetflixPage && isWatchPage) {
        // Verbose debug log removed`);
        return this.currentSeries;
      }
    }
    
    // Verbose debug log removed
    return null;
  }

  extractDisneyPlusSeries() {
    // Try series-specific selectors first
    let title = document.querySelector('[data-testid="series-title"]')?.textContent?.trim();
    if (!title) title = document.querySelector('.series-title')?.textContent?.trim();
    
    // Clean video title if series title not found
    if (!title) {
      const videoTitle = document.querySelector('[data-testid="video-title"]')?.textContent?.trim();
      if (videoTitle) {
        title = videoTitle
          .replace(/:\s*Episode\s*\d+.*$/i, '')
          .replace(/:\s*S\d+E\d+.*$/i, '')
          .replace(/\s*-\s*Episode.*$/i, '')
          .trim();
      }
    }
    
    // Document title fallback
    if (!title) {
      title = document.title?.replace(' | Disney+', '').trim();
      if (title) {
        title = title
          .replace(/:\s*Episode\s*\d+.*$/i, '')
          .replace(/:\s*S\d+E\d+.*$/i, '')
          .trim();
      }
    }
    
    let episode = document.querySelector('[data-testid="episode-title"]')?.textContent?.trim();
    if (!episode) episode = document.querySelector('.episode-title')?.textContent?.trim();
    
    if (title) {
      // Verbose debug log removed
      return { title, episode: episode || 'unknown', source: 'disney+' };
    }
    
    // Verbose debug log removed
    return null;
  }

  extractPrimeVideoSeries() {
    // Try different selectors for series title
    let title = document.querySelector('[data-automation-id="title"]')?.textContent?.trim();
    if (!title) title = document.querySelector('h1[data-automation-id="title"]')?.textContent?.trim();
    if (!title) title = document.querySelector('[data-testid="dv-node-dp-title"]')?.textContent?.trim();
    
    // Clean up title if it contains episode info
    if (title) {
      title = title
        .replace(/:\s*Episode\s*\d+.*$/i, '')
        .replace(/:\s*S\d+E\d+.*$/i, '')
        .replace(/\s*-\s*Season\s*\d+.*$/i, '')
        .trim();
    }
    
    // Fallback to document title
    if (!title) {
      title = document.title?.replace(' - Prime Video', '').trim();
      if (title) {
        title = title
          .replace(/:\s*Episode\s*\d+.*$/i, '')
          .replace(/:\s*S\d+E\d+.*$/i, '')
          .trim();
      }
    }
    
    let episode = document.querySelector('[data-automation-id="episode-info"]')?.textContent?.trim();
    if (!episode) episode = document.querySelector('.episode-info')?.textContent?.trim();
    if (!episode) episode = document.querySelector('[data-testid="episode-title"]')?.textContent?.trim();
    
    if (title) {
      // Verbose debug log removed
      return { title, episode: episode || 'unknown', source: 'prime' };
    }
    
    // Verbose debug log removed
    return null;
  }

  extractYouTubeSeries() {
    let title = document.querySelector('#title h1')?.textContent?.trim();
    if (!title) title = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim();
    if (!title) title = document.title?.replace(' - YouTube', '').trim();
    
    if (title) {
      return { title, episode: 'video', source: 'youtube' };
    }
    return null;
  }

  extractCrunchyrollSeries() {
    let title = document.querySelector('[data-t="series-title"]')?.textContent?.trim();
    if (!title) title = document.querySelector('.series-title')?.textContent?.trim();
    // Add support for Crunchyroll's h4 series title
    if (!title) {
      const h4 = document.querySelector('h4.text--gq6o-.text--is-fixed-size--5i4oU.text--is-semibold--AHOYN.text--is-l--iccTo');
      if (h4 && h4.textContent) {
        title = h4.textContent.trim();
      }
    }
    if (!title) title = document.title?.replace(' - Crunchyroll', '').trim();

    let episode = document.querySelector('[data-t="episode-title"]')?.textContent?.trim();
    if (!episode) episode = document.querySelector('.episode-title')?.textContent?.trim();
    // Add support for Crunchyroll's h1 episode title
    if (!episode) {
      const h1 = document.querySelector('h1.heading--nKNOf.heading--is-xs--UyvXH.heading--is-family-type-one--GqBzU.title');
      if (h1 && h1.textContent) {
        episode = h1.textContent.trim();
      }
    }

    if (title) {
      return { title, episode: episode || 'unknown', source: 'crunchyroll' };
    }
    return null;
  }

  extractAppleTVSeries() {
    let title = document.querySelector('.product-header__title')?.textContent?.trim();
    if (!title) title = document.title?.replace(' - Apple TV+', '').trim();
    
    let episode = document.querySelector('.episode-title')?.textContent?.trim();
    
    if (title) {
      return { title, episode: episode || 'unknown', source: 'appletv' };
    }
    return null;
  }

  extractGenericSeries() {
    // Generic extraction from page title and common selectors
    let title = document.querySelector('h1')?.textContent?.trim();
    if (!title) title = document.title?.split(' - ')[0]?.trim();
    
    if (title) {
      return { title, episode: 'unknown', source: 'generic' };
    }
    return null;
  }

  /**
   * Saves settings with sync preference and local fallback
   */
  async saveSettings() {
    try {
      if (!this.settings || typeof this.settings !== 'object') {
        return;
      }
      
      const validSettings = {
        globalEnabled: this.settings.globalEnabled !== undefined ? this.settings.globalEnabled : true,
        verboseLogging: this.settings.verboseLogging !== undefined ? this.settings.verboseLogging : false,
        domains: this.settings.domains || {},
        series: this.settings.series || {}
      };
      
      try {
        await chrome.storage.sync.set({ skipperSettings: validSettings });
        // Verbose debug log removed
      } catch (syncError) {
        await chrome.storage.local.set({ skipperSettings: validSettings });
        // Verbose debug log removed
      }
    } catch (error) {
      // Error saving settings - silently fail
    }
  }

  // Message handler for popup communication
  handleMessage(request, sender, sendResponse) {
    switch (request.action) {
      case 'detectSeries':
        // Force-refresh detection when popup requests it (bypass cache)
        this.lastSeriesDetection = 0; // Reset cache
        this.lastDetectionUrl = null;
        this.lastDomStateHash = null;
        
        // Force immediate detection
        this.detectCurrentSeries();
        
        sendResponse({ series: this.currentSeries });
        break;
        
      case 'updateSettings':
        if (request.settings) {
          this.settings = { ...this.settings, ...request.settings };
          this.verboseLogging = this.settings.verboseLogging;
          
          // Update enabled status
          const domainSetting = this.settings.domains[this.domain]?.enabled;
          const newEnabled = domainSetting !== undefined ? domainSetting : this.settings.globalEnabled;
          
          if (newEnabled !== this.isEnabled) {
            this.isEnabled = newEnabled;
            this.stop();
            if (this.isEnabled) {
              this.start();
            }
          }
        }
        sendResponse({ success: true });
        break;
        
      case 'test':
        this.scanForButtons();
        sendResponse({ success: true });
        break;
        
      case 'ping':
        sendResponse({ pong: true });
        break;
        
      default:
        sendResponse({ error: 'Unknown action' });
    }
  }
  
  start() {
    if (!this.isEnabled) return;
    
    // Debug log removed
    
    // Set up MutationObserver
    this.observer = new MutationObserver(() => {
      this.scanForButtons();
    });
    
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-uia', 'data-testid', 'data-automation-id']
    });
    
    // Set up polling interval
    this.pollInterval = setInterval(() => {
      this.scanForButtons();
    }, 500);
    
    // Initial scan
    this.scanForButtons();

    // Sofortige Serienerkennung nach Start (wichtig für Reload/F5)
    if (typeof this.detectCurrentSeries === 'function') {
      this.detectCurrentSeries();
    }
  }
  
  stop() {
    // Debug log removed
    
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    
    if (this.contentObserver) {
      this.contentObserver.disconnect();
      this.contentObserver = null;
    }
    
    if (this.videoObserver) {
      this.videoObserver.disconnect();
      this.videoObserver = null;
    }
    
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    
    if (this.seriesCheckInterval) {
      clearInterval(this.seriesCheckInterval);
      this.seriesCheckInterval = null;
    }
    
    if (this.seriesDetectionTimeout) {
      clearTimeout(this.seriesDetectionTimeout);
      this.seriesDetectionTimeout = null;
    }
  }
  
  // === BUTTON SCANNING AND CLICKING SYSTEM ===
  // Core functionality for finding and clicking skip buttons
  
  scanForButtons() {
    if (!this.isEnabled) return;
    
    const now = Date.now();
    if (now - this.lastClickTime < this.clickCooldown) {
      return;
    }
    
    // Verbose debug log removed
    
    const seriesSettings = this.getCurrentSeriesSettings();
    
    // Sicherstellen, dass niemals "watch-abspann" oder "watch" Buttons geklickt werden
    let clicked = false;
    // Zuerst alle erlaubten Skip-Buttons (intro, recap, credits, ads) klicken, aber niemals 'watch-abspann' oder 'watch'
    for (const selector of this.buttonPatterns.selectors) {
      const buttons = document.querySelectorAll(selector);
      for (const button of buttons) {
        const buttonType = this.getButtonType(button, selector);
        if ((['intro','recap','credits','ads'].includes(buttonType))
            && buttonType !== 'watch-abspann' && buttonType !== 'watch'
            && this.shouldSkipButtonType(buttonType, seriesSettings)
            && this.isButtonClickable(button)) {
          this.clickButton(button, `selector: ${selector} (${buttonType})`);
          clicked = true;
          break;
        }
      }
      if (clicked) break;
    }
    if (!clicked) {
      // Textbasierte Suche für erlaubte Skip-Buttons
      const allButtons = document.querySelectorAll('button, [role="button"], a, div[onclick]');
      for (const button of allButtons) {
        const buttonType = this.getButtonTypeFromText(button);
        if ((['intro','recap','credits','ads'].includes(buttonType))
            && buttonType !== 'watch-abspann' && buttonType !== 'watch'
            && this.shouldSkipButtonType(buttonType, seriesSettings)
            && this.shouldClickButton(button)) {
          this.clickButton(button, `text/aria pattern match (${buttonType})`);
          clicked = true;
          break;
        }
      }
    }

    // Wenn autoNext aktiv ist, next-Buttons IMMER klicken (unabhängig von anderen Skips)
    if (seriesSettings.autoNext) {
      // Selector-basierte Suche
      for (const selector of this.buttonPatterns.selectors) {
        const buttons = document.querySelectorAll(selector);
        for (const button of buttons) {
          const buttonType = this.getButtonType(button, selector);
          if (buttonType === 'next'
              && buttonType !== 'watch-abspann' && buttonType !== 'watch'
              && this.shouldSkipButtonType(buttonType, seriesSettings)
              && this.isButtonClickable(button)
              && this.shouldClickBasedOnTiming(button, selector)) {
            this.clickButton(button, `selector: ${selector} (${buttonType})`);
            // NICHT clicked = true setzen, damit andere Skips weiterhin gesucht werden
          }
        }
      }
      // Text/Aria-basierte Suche
      const allButtons = document.querySelectorAll('button, [role="button"], a, div[onclick]');
      for (const button of allButtons) {
        const buttonType = this.getButtonTypeFromText(button);
        if (buttonType === 'next'
            && buttonType !== 'watch-abspann' && buttonType !== 'watch'
            && this.shouldSkipButtonType(buttonType, seriesSettings)
            && this.shouldClickButton(button)
            && this.shouldClickBasedOnTiming(button)) {
          this.clickButton(button, `text/aria pattern match (${buttonType})`);
          // NICHT clicked = true setzen
        }
      }
      // Special handling for auto-advance popups
      this.checkForAutoAdvancePopup();
    }
  }
  
  /**
   * Returns settings for current series with intelligent fallbacks
   * Series-specific > Default series settings > Conservative fallback
   */
  getCurrentSeriesSettings() {
    if (this.currentSeries && this.currentSeries.title) {
      const seriesKey = `${this.domain}:${this.currentSeries.title}`;
      const settings = this.settings.series[seriesKey];
      
      // Verbose debug log removed
      // Verbose debug log removed
      // Verbose debug log removed
      
      if (settings) {
        // Verbose debug log removed
        return settings;
      } else {
        // Verbose debug log removed
        // Default settings for detected but unconfigured series
        return {
          skipIntro: true,
          skipRecap: true,
          skipCredits: true,
          skipAds: true,
          autoNext: false
        };
      }
    }
    
    // Verbose debug log removed
    // Conservative settings when no series context available
    return {
      skipIntro: false,
      skipRecap: false,
      skipCredits: false,
      skipAds: true,    // Always safe to skip ads
      autoNext: false
    };
  }
  
  getButtonType(button, selector) {
    const text = (button.textContent || button.getAttribute('aria-label') || button.title || '').toLowerCase();
    const selectorLower = selector.toLowerCase();

    // Multilingual patterns for "watch/view" and "credits/abspann"
    const watchPatterns = [
      'ansehen', 'anschauen', 'watch', 'view', 'play', 'abspielen', 'schauen',
      'ver', 'voir', 'guarda', 'assistir', 'bekijken', 'oglądać', 'смотреть', '見る', '시청', '观看'
    ];
    const creditsPatterns = [
      'abspann', 'credits', 'créditos', 'crédits', 'crediti', 'créditos', 'aftiteling', 'napisy końcowe', 'титры', 'クレジット', '크레딧', '片尾'
    ];

    const isWatchButton = watchPatterns.some(pattern => text.includes(pattern));
    const isCreditsButton = creditsPatterns.some(pattern => text.includes(pattern));

    // Robust Netflix 'Abspann ansehen' detection via data-uia attribute (language-independent)
    if (button.getAttribute('data-uia') === 'watch-credits-seamless-button') {
      return 'watch-abspann';
    }
    // Robust Netflix 'Nächste Folge' detection via data-uia attribute (language-independent)
    if (button.getAttribute('data-uia') === 'next-episode-seamless-button') {
      return 'next';
    }
    // Special check for "Abspann ansehen" ("Watch credits" etc.) - block for all supported languages
    if (isCreditsButton && isWatchButton) {
      if (window.location.hostname.includes('netflix.')) {
        return 'watch-abspann';
      }
      return 'watch'; // fallback for other platforms
    }

    if (isWatchButton) {
      return 'watch'; // Special type for watch buttons that we should never click for skipping
    }
    
    // Selector-based detection (most reliable)
    if (selectorLower.includes('intro') || selectorLower.includes('opening')) return 'intro';
    if (selectorLower.includes('recap') || selectorLower.includes('previously')) return 'recap';
    if (selectorLower.includes('credits') || selectorLower.includes('end') || selectorLower.includes('closing')) return 'credits';
    if (selectorLower.includes('ad') || selectorLower.includes('advertisement')) return 'ads';
    if (selectorLower.includes('next') || selectorLower.includes('continue') || selectorLower.includes('advance')) return 'next';
    
    // Text content detection - but only for SKIP buttons (must contain "skip" or "überspringen")
    const skipPatterns = ['skip', 'überspringen', 'pular']; // Removed "weiter" and "next" as they're too generic
    const isSkipButton = skipPatterns.some(pattern => text.includes(pattern));
    
    if (isSkipButton) {
      if (text.includes('intro') || text.includes('opening') || text.includes('vorspann')) return 'intro';
      if (text.includes('recap') || text.includes('previously') || text.includes('zuvor') || text.includes('bisher')) return 'recap';
      if (text.includes('credits') || text.includes('abspann') || text.includes('end') || text.includes('ende')) return 'credits';
      if (text.includes('ad') || text.includes('anzeige') || text.includes('werbung') || text.includes('advertisement')) return 'ads';
      if (text.includes('next') || text.includes('nächste') || text.includes('continue') || text.includes('weiter')) return 'next';
      return 'ads'; // Default generic skip to ads (safest)
    }
    
    // Pure skip button detection
    if (text.includes('skip') || text.includes('überspringen')) {
      if (text.includes('intro') || text.includes('opening')) return 'intro';
      if (text.includes('recap') || text.includes('zuvor')) return 'recap';
      if (text.includes('credits') || text.includes('abspann')) return 'credits';
      if (text.includes('ad') || text.includes('anzeige')) return 'ads';
      return 'ads'; // Default generic skip to ads (safest)
    }
    
    // Aria-label analysis - only for skip actions
    const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('skip') || ariaLabel.includes('überspringen')) {
      if (ariaLabel.includes('intro') || ariaLabel.includes('opening')) return 'intro';
      if (ariaLabel.includes('recap') || ariaLabel.includes('previously')) return 'recap';
      if (ariaLabel.includes('credits') || ariaLabel.includes('end')) return 'credits';
      if (ariaLabel.includes('ad') || ariaLabel.includes('advertisement')) return 'ads';
      if (ariaLabel.includes('next') || ariaLabel.includes('continue')) return 'next';
    }
    
    // Verbose debug log removed
    return 'unknown';
  }
  
  getButtonTypeFromText(button) {
    const text = (button.textContent || button.getAttribute('aria-label') || '').toLowerCase();

    if (text.includes('intro') || text.includes('opening') || text.includes('vorspann')) return 'intro';
    if (text.includes('recap') || text.includes('previously') || text.includes('zuvor')) return 'recap';
    if (text.includes('credits') || text.includes('abspann') || text.includes('end')) return 'credits';
    if (text.includes('ad') || text.includes('anzeige') || text.includes('werbung')) return 'ads';
    if (text.includes('next') || text.includes('nächste') || text.includes('continue')) return 'next';

    return 'unknown';
  }
  
  /**
   * Determines if a button type should be skipped based on series settings
   * Includes intelligent fallback for unknown button types
   */
  shouldSkipButtonType(buttonType, seriesSettings) {
    let shouldSkip = false;
    
    switch (buttonType) {
      case 'intro':
        shouldSkip = seriesSettings.skipIntro;
        break;
      case 'recap':
        shouldSkip = seriesSettings.skipRecap;
        break;
      case 'credits':
        shouldSkip = seriesSettings.skipCredits;
        break;
      case 'ads':
        shouldSkip = seriesSettings.skipAds;
        break;
      case 'next':
        shouldSkip = seriesSettings.autoNext;
        break;
      case 'watch-abspann':
        // Never click "Abspann ansehen" on Netflix
        shouldSkip = false;
        break;
      case 'watch':
        // NEVER click watch/view buttons - they're for viewing content, not skipping
        shouldSkip = false;
        break;
      default:
        // Conservative handling of unknown buttons
        if (this.currentSeries && this.currentSeries.title) {
          shouldSkip = seriesSettings.skipAds; // Use ad setting for unknown on known series
        } else {
          shouldSkip = false; // Don't skip unknown buttons without series context
        }
        break;
    }
    
    const currentSeries = this.currentSeries?.title || 'No series detected';
    // Verbose debug log removed
    // Verbose debug log removed
    
    return shouldSkip;
  }
  
  checkForAutoAdvancePopup() {
    // Netflix-specific auto-advance popup detection
    const seamlessButton = document.querySelector('[data-uia="next-episode-seamless-button"]');
    
    if (seamlessButton && this.isButtonClickable(seamlessButton)) {
      // Verify this is actually the end-of-episode popup
      const parent = seamlessButton.closest('[class*="seamless"], [class*="auto-advance"], [class*="up-next"]');
      const hasCountdown = parent && parent.querySelector('[class*="countdown"], [class*="timer"], [class*="seconds"]');
      
      // Check video progress for additional validation
      const video = document.querySelector('video');
      let nearEnd = false;
      
      if (video && video.duration && video.currentTime) {
        const progress = video.currentTime / video.duration;
        const timeLeft = video.duration - video.currentTime;
        nearEnd = progress > 0.85 || timeLeft < 180; // Last 15% or 3 minutes
      }
      
      if (hasCountdown || nearEnd) {
        // Verbose debug log removed
        this.clickButton(seamlessButton, 'Netflix auto-advance popup');
      } else {
        // Verbose debug log removed
      }
    }
  }
  
  /**
   * Smart timing check for next episode buttons - prevents premature clicks
   * Only allows next episode clicks in proper auto-advance contexts
   */
  shouldClickBasedOnTiming(button, selector = '') {
    const buttonText = this.getElementText(button).toLowerCase();
    const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
    
    const isNextEpisodeButton = this.isNextEpisodeButton(buttonText, ariaLabel, selector);
    
    if (isNextEpisodeButton) {
      // Next episode buttons should only be clicked in auto-advance popups
      return this.isInAutoAdvancePopup(button);
    }
    
    // All other skip buttons (intro, recap, credits, ads) can be clicked anytime
    return true;
  }
  
  isNextEpisodeButton(text, ariaLabel, selector) {
    const nextEpisodePatterns = [
      'next episode', 'nächste episode', 'nächste folge', 'épisode suivant', 
      'siguiente episodio', 'episodio successivo', 'próximo episódio',
      'volgende aflevering', 'następny odcinek', 'следующий эпизод',
      '次のエピソード', '다음 에피소드', '下一集',
      'continue watching', 'weiter schauen', 'continuer à regarder'
    ];
    
    // Check specific Netflix selectors
    const nextEpisodeSelectors = [
      '[data-uia="next-episode-seamless-button"]',
      '[data-uia="watch-video-button"]',
      '[data-testid="up-next-button"]',
      '[data-automation-id="next-episode-button"]',
      '[data-t="next-episode-button"]',
      '[data-metrics-location="next_episode"]'
    ];
    
    // Check if selector matches next episode patterns
    if (nextEpisodeSelectors.some(sel => selector.includes(sel))) {
      return true;
    }
    
    // Check if text contains next episode patterns
    return nextEpisodePatterns.some(pattern => 
      text.includes(pattern.toLowerCase()) || ariaLabel.includes(pattern.toLowerCase())
    );
  }
  
  isInAutoAdvancePopup(button) {
    // Look for popup/overlay indicators in parent elements
    let parent = button.parentElement;
    let depth = 0;
    
    while (parent && depth < 10) {
      const parentClass = parent.className || '';
      const parentId = parent.id || '';
      const ariaLabel = parent.getAttribute('aria-label') || '';
      
      // Check for auto-advance popup indicators
      const popupIndicators = [
        'popup', 'overlay', 'modal', 'dialog', 'seamless', 'auto-advance',
        'up-next', 'countdown', 'timer', 'auto-play', 'next-up'
      ];
      
      const hasPopupIndicator = popupIndicators.some(indicator => 
        parentClass.toLowerCase().includes(indicator) || 
        parentId.toLowerCase().includes(indicator) ||
        ariaLabel.toLowerCase().includes(indicator)
      );
      
      if (hasPopupIndicator) {
        // Verbose debug log removed
        return true;
      }
      
      // Netflix-specific auto-advance detection
      if (parentClass.includes('watch-video--') || 
          parentClass.includes('next-episode') ||
          parent.querySelector('[data-uia="next-episode-seamless-button"]')) {
        // Verbose debug log removed
        return true;
      }
      
      // Countdown timer indicates auto-advance
      const hasCountdown = parent.querySelector('[class*="countdown"], [class*="timer"], [class*="seconds"]');
      if (hasCountdown) {
        // Verbose debug log removed
        return true;
      }
      
      parent = parent.parentElement;
      depth++;
    }
    
    // Video progress check: only allow if very close to end
    const video = document.querySelector('video');
    if (video && video.duration && video.currentTime) {
      const progress = video.currentTime / video.duration;
      const timeLeft = video.duration - video.currentTime;
      
      if (progress > 0.9 || timeLeft < 120) { // Last 10% or 2 minutes
        // Verbose debug log removed}% complete, ${Math.round(timeLeft)}s left) - allowing next episode`);
        return true;
      } else {
        // Verbose debug log removed}% complete, ${Math.round(timeLeft)}s left) - blocking next episode`);
        return false;
      }
    }
    
    // Verbose debug log removed
    return false;
  }
  
  shouldClickButton(element) {
    if (!this.isButtonClickable(element)) return false;
    
    const text = this.getElementText(element).toLowerCase();
    const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
    const title = (element.getAttribute('title') || '').toLowerCase();
    
    // Check text patterns
    for (const pattern of this.buttonPatterns.textPatterns) {
      if (text.includes(pattern.toLowerCase()) || 
          ariaLabel.includes(pattern.toLowerCase()) || 
          title.includes(pattern.toLowerCase())) {
        return true;
      }
    }
    
    return false;
  }
  
  isButtonClickable(element) {
    if (!element || element.offsetParent === null) return false;
    
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    
    // Check if element is disabled
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    
    // Check if element has been clicked recently
    if (element.dataset.skipperClicked) {
      const clickTime = parseInt(element.dataset.skipperClicked);
      if (Date.now() - clickTime < 10000) { // 10 second cooldown per button
        return false;
      }
    }
    
    return true;
  }
  
  getElementText(element) {
    // Get all text content including pseudo-elements
    let text = element.textContent || '';
    
    // Also check for text in child elements
    const textNodes = element.querySelectorAll('*');
    for (const node of textNodes) {
      text += ' ' + (node.textContent || '');
    }
    
    return text.trim();
  }
  
  /**
   * Comprehensive button click simulation with multiple interaction methods
   * Includes pre-click mouse movement for platforms that require hover
   */
  async clickButton(button, reason) {
    try {
      // Zusätzlicher Schutz: Niemals "Abspann ansehen" oder "watch" klicken
      const buttonType = this.getButtonType(button, "");
      const buttonTypeText = this.getButtonTypeFromText(button);
      if (buttonType === 'watch-abspann' || buttonType === 'watch' || buttonTypeText === 'watch-abspann' || buttonTypeText === 'watch') {
        return;
      }

      // Prevent rapid repeated clicks on same button
      button.dataset.skipperClicked = Date.now().toString();
      this.lastClickTime = Date.now();

      // Pre-click mouse movement (some platforms require hover)
      const video = document.querySelector('video');
      if (video) {
        this.simulateMouseEvent(video, 'mousemove');
        await this.sleep(100);
      }

      // Comprehensive click simulation
      this.simulateMouseEvent(button, 'mouseover');
      await this.sleep(50);

      this.simulateMouseEvent(button, 'mousedown');
      this.simulateMouseEvent(button, 'mouseup');
      this.simulateMouseEvent(button, 'click');

      // Keyboard fallback for accessibility
      if (button.focus) button.focus();
      this.simulateKeyEvent(button, 'keydown', 13); // Enter key

      // Direct onclick handler invocation
      if (button.onclick) {
        button.onclick();
      }

      // Notify background script for statistics/debugging
      chrome.runtime.sendMessage({
        action: 'buttonClicked',
        buttonText: this.getElementText(button),
        domain: this.domain,
        reason: reason
      }).catch(error => {
        // Verbose debug log removed
      });

    } catch (error) {
      // Error clicking button - silently fail
    }
  }
  
  simulateMouseEvent(element, eventType) {
    const rect = element.getBoundingClientRect();
    const event = new MouseEvent(eventType, {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    });
    element.dispatchEvent(event);
  }
  
  simulateKeyEvent(element, eventType, keyCode) {
    const event = new KeyboardEvent(eventType, {
      view: window,
      bubbles: true,
      cancelable: true,
      keyCode: keyCode,
      which: keyCode
    });
    element.dispatchEvent(event);
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  setVerboseLogging(enabled) {
    this.verboseLogging = enabled;
    chrome.storage.sync.set({ verboseLogging: enabled });
  }
  
  // POTENTIALLY UNUSED - Language detection refresh function
  // Only called from debug interface, not used in main functionality
  // refreshLanguageDetection() {
  //   const oldLanguage = this.detectedLanguage;
  //   this.detectedLanguage = this.detectPageLanguage();
  //   this.buttonPatterns = this.generateButtonPatterns();
  //   
  //   if (oldLanguage !== this.detectedLanguage) {
  //     // Debug log removed
  //     // Verbose debug log removed
  //   }
  //   
  //   return this.detectedLanguage;
  // }
  
  log(message) {
    // Logging disabled for production
  }
  
  verboseLog(message) {
    // Verbose logging disabled for production
  }
  
  // === LANGUAGE DETECTION AND MULTI-LANGUAGE SUPPORT ===
  // Intelligent language detection for accurate button text matching
  
  detectPageLanguage() {
    // Multi-source language detection with fallback chain
    let language = 'en';
    
    // HTML lang attribute (most reliable)
    const htmlLang = document.documentElement.lang;
    if (htmlLang) {
      language = htmlLang.split('-')[0].toLowerCase();
    }
    
    // Meta content-language tag
    const metaLang = document.querySelector('meta[http-equiv="content-language"]');
    if (metaLang && metaLang.content) {
      language = metaLang.content.split('-')[0].toLowerCase();
    }
    
    // Browser language fallback
    if (!htmlLang && !metaLang) {
      language = navigator.language.split('-')[0].toLowerCase();
    }
    
    // Content analysis for additional validation
    const contentLanguage = this.detectLanguageFromContent();
    if (contentLanguage) {
      language = contentLanguage;
    }
    
    return language;
  }
  
  detectLanguageFromContent() {
    // Analyze page content for language indicators
    const languageIndicators = {
      'de': ['überspringen', 'weiter', 'nächste', 'folge', 'episode', 'intro', 'abspann', 'werbung'],
      'fr': ['passer', 'suivant', 'épisode', 'générique', 'publicité'],
      'es': ['saltar', 'siguiente', 'episodio', 'créditos', 'anuncio'],
      'it': ['salta', 'prossimo', 'episodio', 'crediti', 'pubblicità'],
      'pt': ['pular', 'próximo', 'episódio', 'créditos', 'anúncio'],
      'nl': ['overslaan', 'volgende', 'aflevering', 'aftiteling', 'reclame'],
      'pl': ['pomiń', 'następny', 'odcinek', 'napisy', 'reklama'],
      'ru': ['пропустить', 'следующий', 'эпизод', 'титры', 'реклама'],
      'ja': ['スキップ', '次', 'エピソード', 'クレジット', '広告'],
      'ko': ['건너뛰기', '다음', '에피소드', '크레딧', '광고'],
      'zh': ['跳过', '下一个', '剧集', '字幕', '广告']
    };
    
    const pageText = document.body.textContent.toLowerCase();
    const scores = {};
    
    // Score each language based on keyword frequency
    for (const [lang, words] of Object.entries(languageIndicators)) {
      scores[lang] = 0;
      for (const word of words) {
        const regex = new RegExp(word.toLowerCase(), 'g');
        const matches = pageText.match(regex);
        if (matches) {
          scores[lang] += matches.length;
        }
      }
    }
    
    // Return language with highest score if significant
    const maxScore = Math.max(...Object.values(scores));
    if (maxScore > 2) { // Require at least 3 matches for confidence
      return Object.keys(scores).find(lang => scores[lang] === maxScore);
    }
    
    return null;
  }
  
  /**
   * Generates language-specific button patterns for text matching
   * Excludes next episode patterns to prevent premature episode skipping
   */
  generateButtonPatterns() {
    const detectedLang = this.detectPageLanguage();
    
    // Base patterns - EXCLUDES next episode to prevent premature clicking
    const basePatterns = {
      textPatterns: [
        // English (always included as fallback)
        'skip intro', 'skip opening', 'skip recap', 'skip credits', 'skip ad', 'skip ads',
        'watch credits', 'skip song', 'skip trailer'
      ],
      ariaPatterns: [
        'skip intro', 'skip recap', 'skip credits', 'skip ad'
      ]
    };
    
    // Language-specific patterns - EXCLUDES next episode to prevent issues
    const languagePatterns = {
      'de': {
        textPatterns: [
          'intro überspringen', 'vorspann überspringen', 'zusammenfassung überspringen',
          'abspann überspringen', 'werbung überspringen', 'trailer überspringen',
          'abspann ansehen'
        ],
        ariaPatterns: ['intro überspringen', 'abspann überspringen']
      },
      'fr': {
        textPatterns: [
          'passer l\'intro', 'passer le générique', 'passer la récap', 'passer la pub',
          'passer la bande-annonce'
        ],
        ariaPatterns: ['passer l\'intro']
      },
      'es': {
        textPatterns: [
          'saltar intro', 'saltar créditos', 'saltar resumen', 'saltar anuncio',
          'saltar tráiler'
        ],
        ariaPatterns: ['saltar intro']
      },
      'it': {
        textPatterns: [
          'salta intro', 'salta crediti', 'salta riassunto', 'salta pubblicità',
          'salta trailer'
        ],
        ariaPatterns: ['salta intro']
      },
      'pt': {
        textPatterns: [
          'pular intro', 'pular créditos', 'pular resumo', 'pular anúncio',
          'pular trailer'
        ],
        ariaPatterns: ['pular intro']
      },
      'nl': {
        textPatterns: [
          'intro overslaan', 'aftiteling overslaan', 'samenvatting overslaan', 'reclame overslaan',
          'trailer overslaan'
        ],
        ariaPatterns: ['intro overslaan']
      },
      'pl': {
        textPatterns: [
          'pomiń intro', 'pomiń napisy końcowe', 'pomiń streszczenie', 'pomiń reklamę',
          'pomiń zwiastun'
        ],
        ariaPatterns: ['pomiń intro']
      },
      'ru': {
        textPatterns: [
          'пропустить заставку', 'пропустить титры', 'пропустить краткое содержание', 'пропустить рекламу',
          'пропустить трейлер'
        ],
        ariaPatterns: ['пропустить заставку']
      },
      'ja': {
        textPatterns: [
          'オープニングをスキップ', 'エンディングをスキップ', 'あらすじをスキップ', '広告をスキップ',
          '予告をスキップ'
        ],
        ariaPatterns: ['オープニングをスキップ']
      },
      'ko': {
        textPatterns: [
          '오프닝 건너뛰기', '엔딩 건너뛰기', '요약 건너뛰기', '광고 건너뛰기',
          '예고편 건너뛰기'
        ],
        ariaPatterns: ['오프닝 건너뛰기']
      },
      'zh': {
        textPatterns: [
          '跳过片头', '跳过片尾', '跳过摘要', '跳过广告', '跳过预告'
        ],
        ariaPatterns: ['跳过片头']
      }
    };
    
    // Combine base patterns with detected language patterns
    if (languagePatterns[detectedLang]) {
      basePatterns.textPatterns.push(...languagePatterns[detectedLang].textPatterns);
      basePatterns.ariaPatterns.push(...languagePatterns[detectedLang].ariaPatterns);
    }
    
    // Add CSS selectors - REMOVING most next episode selectors
    basePatterns.selectors = [
      '[data-uia="player-skip-intro"]',
      '[data-uia="player-skip-recap"]',
      '[data-uia="player-skip-credits"]',

      
      // Disney+ - ONLY skip buttons
      '[data-testid="skip-intro-button"]',
      '[data-testid="skip-recap-button"]',
      '[data-testid="skip-credits-button"]',
      
      // Prime Video - ONLY skip buttons
      '[data-automation-id="skip-intro-button"]',
      '[data-automation-id="skip-recap-button"]',
      
      // YouTube - Keep ad skip buttons
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      '[aria-label*="Skip ad"]',
      '[aria-label*="Werbung überspringen"]',
      
      // Crunchyroll - ONLY skip buttons
      '[data-t="skip-intro-button"]',
      '[data-t="skip-outro-button"]',
      
      // Apple TV+ - ONLY skip buttons
      '[data-metrics-location="skip_intro"]',
      '[data-metrics-location="skip_recap"]',
      
      // Generic selectors - be more specific to avoid next episode
      'button[class*="skip-intro"]',
      'button[class*="skip-recap"]',
      'button[class*="skip-credits"]',
      'button[class*="skip-ad"]',
      'button[id*="skip-intro"]',
      'button[id*="skip-recap"]',
      '.skip-intro-button',
      '.skip-recap-button',
      '.skip-credits-button',
      '.skip-ad-button'
    ];
    
    // Verbose debug log removed
    // Verbose debug log removed
    
    return basePatterns;
  }
}

// Initialize the skipper when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new VideoPlayerSkipper();
  });
} else {
  new VideoPlayerSkipper();
}
