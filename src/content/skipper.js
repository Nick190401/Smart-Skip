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
    
    this.currentSeries = null;
    this.seriesCheckInterval = null;
    this.seriesDetectionTimeout = null;
    this.lastUrl = null;
    this.lastSeriesDetection = 0;
    this.lastDetectionUrl = null;
    this.lastDomStateHash = null;
    
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
    
    this.isSupportedPlatform = this.supportedDomains.some(domain => {
      if (domain.endsWith('.')) {
        return this.domain.startsWith(domain) || this.domain.includes('.' + domain.slice(0, -1) + '.');
      } else {
        return this.domain === domain || this.domain.endsWith('.' + domain);
      }
    });
    
    if (!this.isSupportedPlatform) {
      return;
    }
    
    this.settings = {
      globalEnabled: true,
      verboseLogging: false,
      domains: {},
      series: {}
    };
    
    this.currentSeries = null;
    this.seriesCheckInterval = null;
    
    this.detectedLanguage = null;
    this.buttonPatterns = null;
    
    this.init();
  }
  
  async init() {
    if (!this.isSupportedPlatform) {
      return;
    }
    
    this.detectedLanguage = this.detectPageLanguage();
    this.buttonPatterns = this.generateButtonPatterns();
    
    await this.loadSettings();
    
    this.startSeriesDetection();
    
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.handleMessage(request, sender, sendResponse);
      return true;
    });
    
    window.__autoSkipper = {
      start: () => this.start(),
      stop: () => this.stop(),
      scan: () => this.scanForButtons(),
      setVerbose: (enabled) => this.setVerboseLogging(enabled),
      getDetectedLanguage: () => this.detectedLanguage,
      getPatterns: () => this.buttonPatterns,
      getCurrentSeries: () => this.currentSeries,
      instance: this
    };
    
    if (this.isEnabled) {
      this.start();
    }
    
    chrome.storage.onChanged.addListener((changes) => {
      this.handleStorageChange(changes);
    });
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
            loadMethod = 'sync';
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
              loadMethod = 'local';
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
            loadMethod = 'localStorage';
          }
        } catch (lsError) {
          // Silent fail
        }
      }
      
      if (!loadedSettings && window.skipperSettings) {
        loadedSettings = window.skipperSettings;
        loadMethod = 'memory';
      }
      
      if (loadedSettings) {
        this.settings = { ...this.settings, ...loadedSettings };
      }
      
      this.verboseLogging = this.settings.verboseLogging;
      
      const domainSetting = this.settings.domains[this.domain]?.enabled;
      if (domainSetting !== undefined) {
        this.isEnabled = domainSetting;
      } else {
        this.isEnabled = this.settings.globalEnabled;
      }
      
    } catch (error) {
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
  
  startSeriesDetection() {
    this.detectCurrentSeries();
    
    this.lastUrl = window.location.href;
    
    this.updateSeriesCheckInterval();
    
    this.setupUrlChangeDetection();
    this.setupContentChangeDetection();
    this.setupButtonClickDetection();
    this.setupVideoEventDetection();
  }
  
  updateSeriesCheckInterval() {
    if (this.seriesCheckInterval) {
      clearInterval(this.seriesCheckInterval);
    }
    
    const isOnContentPage = this.isOnPotentialContentPage();
    const shouldCheckFrequently = !this.currentSeries || (isOnContentPage && !this.currentSeries);
    
    const interval = shouldCheckFrequently ? 3000 : 30000;
    const reason = this.currentSeries ? 'series detected' : (isOnContentPage ? 'on content page but no series detected' : 'no series detected');
    
    this.seriesCheckInterval = setInterval(() => {
      this.detectCurrentSeries();
    }, interval);
  }
  
  isOnPotentialContentPage() {
    const url = window.location.href;
    const domain = window.location.hostname;
    
    const contentPagePatterns = [
      '/watch/', '/title/',
      '/series/', '/movies/', '/video/',
      '/detail/', '/gp/video/',
      '/watch?v=',
      '/watch/', '/series/',
      '/show/', '/movie/',
      '/play/', '/stream/', '/episode/', '/season/'
    ];
    
    const isContentPage = contentPagePatterns.some(pattern => url.includes(pattern));
    
    const hasVideo = document.querySelector('video') !== null;
    
    const isBrowsePage = url.includes('/browse') || url.includes('/home') || url.includes('/search');
    
    const result = (isContentPage || hasVideo) && !isBrowsePage;
    
    return result;
  }
  
  setupUrlChangeDetection() {
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
    this.contentObserver = new MutationObserver((mutations) => {
      let shouldCheckSeries = false;
      
      for (const mutation of mutations) {
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
        
        if (mutation.type === 'attributes' && 
            mutation.target.matches &&
            mutation.target.matches('[data-uia*="title"], [data-uia*="series"], [data-uia*="episode"]')) {
          shouldCheckSeries = true;
          break;
        }
      }
      
      if (shouldCheckSeries) {
        if (this.seriesDetectionTimeout) {
          clearTimeout(this.seriesDetectionTimeout);
        }
        this.seriesDetectionTimeout = setTimeout(() => {
          this.detectCurrentSeries();
        }, 500);
      }
    });
    
    this.contentObserver.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-uia', 'data-testid', 'data-automation-id', 'title', 'aria-label']
    });
  }
  
  setupButtonClickDetection() {
    document.addEventListener('click', (event) => {
      const target = event.target;
      const button = target.closest('button, [role="button"], a');
      
      if (!button) return;
      
      const buttonText = (button.textContent || '').toLowerCase();
      const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
      const className = (button.className || '').toLowerCase();
      const href = button.getAttribute('href') || '';
      
      const nextEpisodePatterns = [
        'next episode', 'nächste episode', 'nächste folge', 'next', 'weiter',
        'continue watching', 'weiter schauen', 'continuer', 'siguiente',
        'nächste', 'continue', 'play next', 'automatisch weiter'
      ];

      const isNextEpisodeButton = nextEpisodePatterns.some(pattern => 
        buttonText.includes(pattern) || ariaLabel.includes(pattern) || className.includes(pattern)
      );

      const dataAttrs = ['data-uia', 'data-testid', 'data-automation-id', 'data-t'];
      const hasNextEpisodeDataAttr = dataAttrs.some(attr => {
        const value = (button.getAttribute(attr) || '').toLowerCase();
        return value.includes('next') || value.includes('episode') || value.includes('seamless') || 
               value.includes('auto-advance') || value.includes('continue');
      });

      if (isNextEpisodeButton || hasNextEpisodeDataAttr) {
        this.lastSeriesDetection = 0;
        this.lastDetectionUrl = null;
        this.lastDomStateHash = null;
        
        setTimeout(() => {
          this.detectCurrentSeries();
        }, 1000);
        
        setTimeout(() => {
          this.detectCurrentSeries();
        }, 3000);
        
        setTimeout(() => {
          this.detectCurrentSeries();
        }, 6000);
        
        return;
      }

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

      let mightChangeSeries = false;
      for (const pattern of navigationPatterns) {
        if (buttonText.includes(pattern) || ariaLabel.includes(pattern) || className.includes(pattern)) {
          mightChangeSeries = true;
          break;
        }
      }
      
      if (!mightChangeSeries && href) {
        for (const pattern of seriesChangePatterns) {
          if (href.includes(pattern)) {
            mightChangeSeries = true;
            break;
          }
        }
      }
      
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
            break;
          }
        }
      }
      
      if (mightChangeSeries) {
        setTimeout(() => {
          this.detectCurrentSeries();
        }, 2000);
        
        setTimeout(() => {
          this.detectCurrentSeries();
        }, 5000);
      }
    }, true);
  }
  
  setupVideoEventDetection() {
    const checkVideoEvents = () => {
      const videos = document.querySelectorAll('video');
      
      videos.forEach((video, index) => {
        if (video.dataset.skipperListenersAdded) return;
        video.dataset.skipperListenersAdded = 'true';
        
        video.addEventListener('loadstart', () => {
          setTimeout(() => {
            this.detectCurrentSeries();
          }, 1000);
        });
        
        video.addEventListener('loadedmetadata', () => {
          setTimeout(() => {
            this.detectCurrentSeries();
          }, 500);
        });
        
        video.addEventListener('playing', () => {
          setTimeout(() => {
            this.detectCurrentSeries();
          }, 1000);
        });
        
        video.addEventListener('canplay', () => {
          if (video.src && video.src !== video.dataset.lastSrc) {
            video.dataset.lastSrc = video.src;
            setTimeout(() => {
              this.detectCurrentSeries();
            }, 1500);
          }
        });
      });
    };
    
    checkVideoEvents();
    
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
      this.lastUrl = currentUrl;
      
      const wasOnContentPage = this.lastUrl && this.isUrlContentPage(this.lastUrl);
      const isNowOnContentPage = this.isUrlContentPage(currentUrl);
      
      if (isNowOnContentPage && (!this.currentSeries || wasOnContentPage !== isNowOnContentPage)) {
        this.updateSeriesCheckInterval();
      }
      
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
    const now = Date.now();
    const currentUrl = window.location.href;
    
    const hasVideo = document.querySelector('video') !== null;
    const hasNetflixContent = document.querySelector('[data-uia*="title"], [data-uia*="video"]') !== null;
    const domStateHash = `${hasVideo}-${hasNetflixContent}-${document.title}`;
    
    if (this.lastSeriesDetection && 
        this.lastDetectionUrl === currentUrl && 
        this.lastDomStateHash === domStateHash &&
        (now - this.lastSeriesDetection) < 200) {
      return;
    }
    
    this.lastSeriesDetection = now;
    this.lastDetectionUrl = currentUrl;
    this.lastDomStateHash = domStateHash;
    
    const newSeries = this.extractSeriesInfo();
    
    const isOnTitlePage = window.location.href.includes('/title/') && 
                         !window.location.href.includes('/watch/');
    const isOnBrowsePage = window.location.href.includes('/browse');
    
    if (isOnBrowsePage && this.currentSeries) {
      this.currentSeries = null;
      this.updateSeriesCheckInterval();
      return;
    }
    
    let seriesChanged = false;
    
    if (!this.currentSeries && newSeries) {
      seriesChanged = true;
    } else if (this.currentSeries && !newSeries) {
      const isOnVideoPage = window.location.href.includes('/watch/') && 
                           document.querySelector('video') !== null;
      
      const isOnTitlePage = window.location.href.includes('/title/') && 
                           !window.location.href.includes('/watch/');
      
      if (!isOnVideoPage && !isOnTitlePage) {
        seriesChanged = true;
      } else if (isOnTitlePage && this.currentSeries) {
        seriesChanged = true;
      } else if (isOnVideoPage) {
        return; 
      } else {
        return;
      }
    } else if (this.currentSeries && newSeries) {
      const titleChanged = newSeries.title !== this.currentSeries.title;
      const episodeChanged = newSeries.episode !== this.currentSeries.episode;
      const sourceChanged = newSeries.source !== this.currentSeries.source;
      
      if (titleChanged) {
        seriesChanged = true;
      }
      
      if (episodeChanged) {
        seriesChanged = true;
      }
      
      if (sourceChanged) {
        seriesChanged = true;
      }
    }
    
    if (seriesChanged) {
      const previousSeries = this.currentSeries;
      
      if (!newSeries && isOnTitlePage && this.currentSeries) {
        newSeries = {
          title: this.currentSeries.title,
          episode: 'browsing',
          source: this.currentSeries.source
        };
      }
      
      this.currentSeries = newSeries;
      
      this.updateSeriesCheckInterval();
      
      if (newSeries) {
        chrome.runtime.sendMessage({
          action: 'seriesDetected',
          series: newSeries,
          previousSeries: previousSeries,
          domain: this.domain
        }).catch(error => {
          // Silent fail
        });
        
        const seriesKey = `${this.domain}:${newSeries.title}`;
        if (!this.settings.series[seriesKey]) {
          this.settings.series[seriesKey] = {
            skipIntro: true,
            skipRecap: true,
            skipCredits: true,
            skipAds: true,
            autoNext: false
          };
          this.saveSettings();
        }
        
        const currentSettings = this.getCurrentSeriesSettings();
      }
    }
  }

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
      return null;
    }
  }

  extractNetflixSeries() {
    let title = null;
    let episode = null;
    
    const isWatchPage = window.location.href.includes('/watch/');
    const isTitlePage = window.location.href.includes('/title/') && !window.location.href.includes('/watch/');
    const isBrowsePage = window.location.href.includes('/browse');
    const hasVideo = document.querySelector('video') !== null;
    
    if (isBrowsePage) {
      return null;
    }
    
    const videoTitleElement = document.querySelector('[data-uia="video-title"]');
    if (videoTitleElement) {
      const h4Element = videoTitleElement.querySelector('h4');
      if (h4Element?.textContent?.trim()) {
        const candidateTitle = h4Element.textContent.trim();
        
        if (candidateTitle.length > 2 && !/^\d+$/.test(candidateTitle)) {
          title = candidateTitle;
          
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
            }
          }
        }
      }
    }
    
    if (!title) {
      const seriesSelectors = [
        '[data-uia="title-card-series-title"]',
        '[data-uia="previewModal-seriesTitle"]', 
        '[data-uia="dp-series-title"]',
        'h4[data-uia="fallback-text-video-title"]',
        'h1[class*="ltr-"]',
        'h2[class*="ltr-"]',
        '.billboard-title',
        '.title-info-metadata h1'
      ];
      
      for (const selector of seriesSelectors) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          const candidateTitle = element.textContent.trim();
          
          const episodePattern = /^(Episode|E)\s*\d+|^\d+\.\s|^S\d+E\d+|^\d+:\s|^Folge\s*\d+|^Flg\.\s*\d+|^Teil\s*\d+|^Chapter\s*\d+|^Kapitel\s*\d+/i;
          const timePattern = /^\d+:\d+/;
          const mixedEpisodePattern = /.*Flg\.\s*\d+|.*Folge\s*\d+|.*Episode\s*\d+|.*Teil\s*\d+/i;
          
          if (!episodePattern.test(candidateTitle) && 
              !timePattern.test(candidateTitle) && 
              !mixedEpisodePattern.test(candidateTitle)) {
            if (candidateTitle.length > 2 && !/^\d+$/.test(candidateTitle)) {
              title = candidateTitle;
              break;
            }
          }
        }
      }
    }
    
    if (isWatchPage || hasVideo) {
      const episodeSelectors = [
        '[data-uia="episode-selector"] button[aria-expanded="false"]',
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
          
          if (title) {
            candidateEpisode = candidateEpisode.replace(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '').trim();
          }
          candidateEpisode = candidateEpisode.replace(/^[:\-–—]\s*/, '').trim();
          
          if (candidateEpisode.length > 0) {
            episode = candidateEpisode;
            break;
          }
        }
      }
    } else if (isTitlePage) {
      episode = 'browsing';
    }
    
    if (!title) {
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
        
        if (!episode) {
          const episodeMatch = docTitle.match(/(?:Episode|Folge|Teil|Chapter)\s*(\d+[^-]*)/i);
          if (episodeMatch) {
            episode = episodeMatch[1].trim();
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
        }
      }
    }
    
    if (title) {
      const episodePatterns = [
        /Flg\.\s*\d+.*/i,
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
          title = cleaned;
          break;
        }
      }
      
      if (episode && episode !== 'unknown') {
        const episodeEscaped = episode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cleanedWithEpisode = title.replace(new RegExp(`\\s*[-:–—]\\s*${episodeEscaped}.*$`, 'i'), '').trim();
        if (cleanedWithEpisode !== title && cleanedWithEpisode.length > 2) {
          title = cleanedWithEpisode;
        }
      }
      
      title = title.replace(/\s+/g, ' ').trim();
    }
    
    if (!title) {
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
            break;
          }
        }
      }
    }
    
    if (title) {
      title = title
        .replace(/\s+/g, ' ')
        .replace(/^[:\-–—\s]+/, '')
        .replace(/[:\-–—\s]+$/, '')
        .trim();
      
      const genericTitles = ['Netflix', 'Startseite', 'Home', 'Watch', 'Video', 'Player', 'Movie', 'Film'];
      const isGeneric = genericTitles.some(generic => 
        title.toLowerCase() === generic.toLowerCase() ||
        title.toLowerCase().includes(`watch ${title.toLowerCase()}`) ||
        title.toLowerCase().includes(`stream ${title.toLowerCase()}`)
      );
      
      if (isGeneric || title.length < 2) {
        return null;
      }
      
      if (!episode || episode === 'unknown' || episode.length === 0) {
        const currentTimeElement = document.querySelector('.watch-video--duration-timer, .video-player-time');
        if (currentTimeElement) {
          episode = 'playing';
        } else {
          episode = 'unknown';
        }
      }
      
      return { title, episode: episode || 'unknown', source: 'netflix' };
    }
    
    if (!title && this.currentSeries && this.currentSeries.source === 'netflix') {
      const isOnNetflixPage = window.location.href.includes('/watch/') || 
                             window.location.href.includes('/title/') ||
                             document.querySelector('video') !== null;
      
      if (isOnNetflixPage && isWatchPage) {
        return this.currentSeries;
      }
    }
    
    return null;
  }

  extractDisneyPlusSeries() {
    let title = document.querySelector('[data-testid="series-title"]')?.textContent?.trim();
    if (!title) title = document.querySelector('.series-title')?.textContent?.trim();
    
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
      return { title, episode: episode || 'unknown', source: 'disney+' };
    }
    
    return null;
  }

  extractPrimeVideoSeries() {
    let title = document.querySelector('[data-automation-id="title"]')?.textContent?.trim();
    if (!title) title = document.querySelector('h1[data-automation-id="title"]')?.textContent?.trim();
    if (!title) title = document.querySelector('[data-testid="dv-node-dp-title"]')?.textContent?.trim();
    
    if (title) {
      title = title
        .replace(/:\s*Episode\s*\d+.*$/i, '')
        .replace(/:\s*S\d+E\d+.*$/i, '')
        .replace(/\s*-\s*Season\s*\d+.*$/i, '')
        .trim();
    }
    
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
      return { title, episode: episode || 'unknown', source: 'prime' };
    }
    
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
    if (!title) {
      const h4 = document.querySelector('h4.text--gq6o-.text--is-fixed-size--5i4oU.text--is-semibold--AHOYN.text--is-l--iccTo');
      if (h4 && h4.textContent) {
        title = h4.textContent.trim();
      }
    }
    if (!title) title = document.title?.replace(' - Crunchyroll', '').trim();

    let episode = document.querySelector('[data-t="episode-title"]')?.textContent?.trim();
    if (!episode) episode = document.querySelector('.episode-title')?.textContent?.trim();
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
    let title = document.querySelector('h1')?.textContent?.trim();
    if (!title) title = document.title?.split(' - ')[0]?.trim();
    
    if (title) {
      return { title, episode: 'unknown', source: 'generic' };
    }
    return null;
  }

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
      } catch (syncError) {
        await chrome.storage.local.set({ skipperSettings: validSettings });
      }
    } catch (error) {
      // Silent fail
    }
  }

  handleMessage(request, sender, sendResponse) {
    switch (request.action) {
      case 'detectSeries':
        this.lastSeriesDetection = 0;
        this.lastDetectionUrl = null;
        this.lastDomStateHash = null;
        
        this.detectCurrentSeries();
        
        sendResponse({ series: this.currentSeries });
        break;
        
      case 'updateSettings':
        if (request.settings) {
          this.settings = { ...this.settings, ...request.settings };
          this.verboseLogging = this.settings.verboseLogging;
          
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
    
    this.observer = new MutationObserver(() => {
      this.scanForButtons();
    });
    
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-uia', 'data-testid', 'data-automation-id']
    });
    
    this.pollInterval = setInterval(() => {
      this.scanForButtons();
    }, 500);
    
    this.scanForButtons();

    if (typeof this.detectCurrentSeries === 'function') {
      this.detectCurrentSeries();
    }
  }
  
  stop() {
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
  
  scanForButtons() {
    if (!this.isEnabled) return;
    
    const now = Date.now();
    if (now - this.lastClickTime < this.clickCooldown) {
      return;
    }
    
    const seriesSettings = this.getCurrentSeriesSettings();
    
    let clicked = false;
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

    if (seriesSettings.autoNext) {
      for (const selector of this.buttonPatterns.selectors) {
        const buttons = document.querySelectorAll(selector);
        for (const button of buttons) {
          const buttonType = this.getButtonType(button, selector);
          if (buttonType === 'next'
              && buttonType !== 'watch-abspann' && buttonType !== 'watch'
              && this.shouldSkipButtonType(buttonType, seriesSettings)
              && this.isButtonClickable(button)
              && this.shouldClickBasedOnTiming(button)) {
            this.clickButton(button, `selector: ${selector} (${buttonType})`);
            return;
          }
        }
      }
      const allButtons = document.querySelectorAll('button, [role="button"], a, div[onclick]');
      for (const button of allButtons) {
        const buttonType = this.getButtonTypeFromText(button);
        if (buttonType === 'next'
            && buttonType !== 'watch-abspann' && buttonType !== 'watch'
            && this.shouldSkipButtonType(buttonType, seriesSettings)
            && this.shouldClickButton(button)
            && this.shouldClickBasedOnTiming(button)) {
          this.clickButton(button, `text/aria pattern match (${buttonType})`);
          return;
        }
      }
      this.checkForAutoAdvancePopup();
    }
  }
  
  getCurrentSeriesSettings() {
    if (this.currentSeries && this.currentSeries.title) {
      const seriesKey = `${this.domain}:${this.currentSeries.title}`;
      const settings = this.settings.series[seriesKey];
      
      if (settings) {
        return settings;
      } else {
        return {
          skipIntro: true,
          skipRecap: true,
          skipCredits: true,
          skipAds: true,
          autoNext: false
        };
      }
    }
    
    return {
      skipIntro: false,
      skipRecap: false,
      skipCredits: false,
      skipAds: true,
      autoNext: false
    };
  }
  
  getButtonType(button, selector) {
    const text = (button.textContent || button.getAttribute('aria-label') || button.title || '').toLowerCase();
    const selectorLower = selector.toLowerCase();

    const watchPatterns = [
      'ansehen', 'anschauen', 'watch', 'view', 'play', 'abspielen', 'schauen',
      'ver', 'voir', 'guarda', 'assistir', 'bekijken', 'oglądać', 'смотреть', '見る', '시청', '观看'
    ];
    const creditsPatterns = [
      'abspann', 'credits', 'créditos', 'crédits', 'crediti', 'créditos', 'aftiteling', 'napisy końcowe', 'титры', 'クレジット', '크레딧', '片尾'
    ];

    const isWatchButton = watchPatterns.some(pattern => text.includes(pattern));
    const isCreditsButton = creditsPatterns.some(pattern => text.includes(pattern));

    if (button.getAttribute('data-uia') === 'watch-credits-seamless-button') {
      return 'watch-abspann';
    }
    if (button.getAttribute('data-uia') === 'next-episode-seamless-button') {
      return 'next';
    }
    if (isCreditsButton && isWatchButton) {
      if (window.location.hostname.includes('netflix.')) {
        return 'watch-abspann';
      }
      return 'watch';
    }

    if (isWatchButton) {
      return 'watch';
    }
    
    if (selectorLower.includes('intro') || selectorLower.includes('opening')) return 'intro';
    if (selectorLower.includes('recap') || selectorLower.includes('previously')) return 'recap';
    if (selectorLower.includes('credits') || selectorLower.includes('end') || selectorLower.includes('closing')) return 'credits';
    if (selectorLower.includes('ad') || selectorLower.includes('advertisement')) return 'ads';
    if (selectorLower.includes('next') || selectorLower.includes('continue') || selectorLower.includes('advance')) return 'next';
    
    const skipPatterns = ['skip', 'überspringen', 'pular'];
    const isSkipButton = skipPatterns.some(pattern => text.includes(pattern));
    
    if (isSkipButton) {
      if (text.includes('intro') || text.includes('opening') || text.includes('vorspann')) return 'intro';
      if (text.includes('recap') || text.includes('previously') || text.includes('zuvor')) return 'recap';
      if (text.includes('credits') || text.includes('abspann') || text.includes('end')) return 'credits';
      if (text.includes('ad') || text.includes('anzeige') || text.includes('werbung')) return 'ads';
      return 'unknown-skip';
    }
    
    if (text.includes('skip') || text.includes('überspringen')) {
      return 'unknown-skip';
    }
    
    const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('skip') || ariaLabel.includes('überspringen')) {
      if (ariaLabel.includes('intro') || ariaLabel.includes('opening')) return 'intro';
      if (ariaLabel.includes('recap') || ariaLabel.includes('previously')) return 'recap';
      if (ariaLabel.includes('credits') || ariaLabel.includes('abspann')) return 'credits';
      if (ariaLabel.includes('ad') || ariaLabel.includes('anzeige')) return 'ads';
      return 'unknown-skip';
    }
    
    return 'unknown';
  }
  
  getButtonTypeFromText(button) {
    const text = (button.textContent || button.getAttribute('aria-label') || '').toLowerCase();

    if (text.includes('intro') || text.includes('opening') || text.includes('vorspann')) return 'intro';
    if (text.includes('recap') || text.includes('previously') || text.includes('zuvor')) return 'recap';
    if (text.includes('credits') || text.includes('abspann') || text.includes('end')) return 'credits';
    if (text.includes('ad') || text.includes('anzeige') || text.includes('werbung')) return 'ads';
    if (text.includes('next') || text.includes('nächste') || text.includes('continue') || text.includes('weiter')) return 'next';
    
    return 'unknown';
  }
  
  shouldSkipButtonType(buttonType, seriesSettings) {
    if (buttonType === 'watch-abspann' || buttonType === 'watch') {
      return false;
    }
    
    switch (buttonType) {
      case 'intro': return seriesSettings.skipIntro;
      case 'recap': return seriesSettings.skipRecap;
      case 'credits': return seriesSettings.skipCredits;
      case 'ads': return seriesSettings.skipAds;
      case 'next': return seriesSettings.autoNext;
      case 'unknown-skip': return seriesSettings.skipAds;
      default: return false;
    }
  }
  
  checkForAutoAdvancePopup() {
    const autoAdvanceSelectors = [
      '[data-uia="postplay-still-frame"]',
      '[data-uia="postplay-modal"]',
      '.postplay-overlay',
      '.autoplay-overlay',
      '.next-episode-overlay'
    ];
    
    for (const selector of autoAdvanceSelectors) {
      const popup = document.querySelector(selector);
      if (popup) {
        const nextButton = popup.querySelector('button, [role="button"]');
        if (nextButton && this.isButtonClickable(nextButton)) {
          this.clickButton(nextButton, `auto-advance popup (${selector})`);
          return;
        }
      }
    }
  }

  // Placeholder methods that would be implemented
  detectPageLanguage() {
    return 'de';
  }

  generateButtonPatterns() {
    return {
      selectors: [
        '[data-uia*="skip"]',
        '[data-uia*="next"]',
        '[data-testid*="skip"]',
        '.skip-button',
        '.next-button'
      ]
    };
  }

  setVerboseLogging(enabled) {
    this.verboseLogging = enabled;
  }

  isButtonClickable(button) {
    return button && 
           button.offsetParent !== null && 
           !button.disabled &&
           button.style.display !== 'none' &&
           button.style.visibility !== 'hidden';
  }

  shouldClickButton(button) {
    return this.isButtonClickable(button);
  }

  shouldClickBasedOnTiming(button) {
    return true;
  }

  clickButton(button, reason) {
    if (!button || !this.isButtonClickable(button)) return;
    
    this.lastClickTime = Date.now();
    
    try {
      button.click();
      
      chrome.runtime.sendMessage({
        action: 'buttonClicked',
        buttonText: button.textContent || button.getAttribute('aria-label') || 'Unknown',
        domain: this.domain,
        reason: reason
      }).catch(() => {
        // Silent fail
      });
    } catch (error) {
      // Silent fail
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.videoPlayerSkipper = new VideoPlayerSkipper();
  });
} else {
  window.videoPlayerSkipper = new VideoPlayerSkipper();
}
