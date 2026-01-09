/**
 * VideoPlayerSkipper - Auto-skip intro/recap/credits on streaming platforms
 * Detects current series/episode and auto-clicks skip/next buttons
 * Includes draggable HUD for manual control
 */
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
  
  this.hud = null;
  this.hudStyleEl = null;
  this.hudDragging = false;
  this.hudDragOffset = { x: 0, y: 0 };
  this.autoNextTimeoutId = null;
  this.countdownOverlay = null;
  this.hudHideTimeoutId = null;
  this.hudHideDelay = 2500;
  this.hudBoundContainer = null;
  this.hudInteracting = false;
  this.hudUserMoved = false;
    
    // Time-based skipping for platforms without skip buttons (Viki, etc.)
    this.videoTimeMonitor = null;
    this.lastVideoTime = 0;
    this.introSkipped = false;
    this.outroSkipped = false;
    this.currentVideoElement = null;
    // Multi-sensor intro detection - continuous checking until found
    this.introDetectionCache = null;
    // Frame analysis for visual intro detection
    this.videoFrameAnalyzer = null;
    this.frameSamples = [];
    
    this.supportedDomains = [
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
      'wakanim.',
      'sky.',
      'joyn.',
      'rtl.',
      'prosieben.',
      'zdf.',
      'ard.',
      'mediathek.',
      'viki.com',
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
    
    // Do not early-return on unsupported platforms; the script can be injected programmatically for overrides
    
    this.settings = {
      globalEnabled: true,
      // Controls HUD visibility globally; per-domain can override via domains[domain].hudEnabled
      globalHudEnabled: true,
      verboseLogging: false,
      domains: {},
      series: {}
    };
    
    this.currentSeries = null;
    this.seriesCheckInterval = null;
    
    this.detectedLanguage = null;
    this.buttonPatterns = null;
    
    // Kick off initialization; avoid throwing in constructor
    this.init();

    // Suppress extension context invalidation errors on reload
    try {
      window.addEventListener('unhandledrejection', (e) => {
        const msg = String((e && (e.reason && (e.reason.message || e.reason) || '')) || '').toLowerCase();
        if (msg.includes('extension context invalidated')) {
          e.preventDefault();
        }
      });
      window.addEventListener('error', (e) => {
        const msg = String((e && e.message) || '').toLowerCase();
        if (msg.includes('extension context invalidated')) {
          e.preventDefault();
        }
      });
    } catch (_) {}
  }
  /**
   * Send runtime messages safely (handles extension reload/context invalidation)
   */
  safeRuntimeSendMessage(message) {
    try {
      if (!this.isExtensionContextValid() || !chrome.runtime.sendMessage) return;
      const ret = chrome.runtime.sendMessage(message);
      // Swallow promise rejections
      if (ret && typeof ret.then === 'function') {
        ret.catch(() => {});
      }
    } catch (e) {
      // ignore
    }
  }

  /** Check if extension context is still valid */
  isExtensionContextValid() {
    try {
      return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }
  
  // HUD: creation and behavior
  /** Ensure a single HUD instance is attached to the current player container. */
  ensureHUD() {
    try {
      if (!this.isHudEnabled()) {
        // If disabled but HUD exists, remove it
        if (this.hud && this.hud.parentElement) this.destroyHUD();
        return;
      }
      const container = this.getPlayerContainer();
      if (!container) return;
      // If we already have a HUD in the DOM and it's in the right container, ensure visibility listeners and stop here
      if (this.hud && document.body.contains(this.hud)) {
        if (container.contains(this.hud)) {
          this.setupHudVisibilityListeners(container);
          return;
        } else {
          // Move HUD into the new container
          container.appendChild(this.hud);
          this.restoreHudPosition();
          this.updateHUDState();
          this.setupHudVisibilityListeners(container);
          return;
        }
      }
      
      // Check if a HUD already exists in the container (e.g., from previous instance)
      const existingList = Array.from(container.querySelectorAll('.smart-skip-hud'));
      if (existingList.length > 0) {
        const existing = existingList[0];
        // Remove duplicates if any
        if (existingList.length > 1) {
          existingList.slice(1).forEach(el => { try { el.remove(); } catch (e) {} });
        }
        this.hud = existing;
        this.makeHUDDraggable();
        this.restoreHudPosition();
        // If no saved position and user didn't move it yet, try to avoid overlapping site controls
        if (!this.settings.domains[this.domain]?.hudPos && !this.hudUserMoved) {
          try { this.positionHudSafely(); } catch (e) {}
        }
        this.updateHUDState();
        this.setupHudVisibilityListeners(container);
        return;
      }
      this.injectHUDStyles();
      this.hud = this.buildHUD();
      container.appendChild(this.hud);
      this.makeHUDDraggable();
      this.restoreHudPosition();
      if (!this.settings.domains[this.domain]?.hudPos && !this.hudUserMoved) {
        try { this.positionHudSafely(); } catch (e) {}
      }
      this.updateHUDState();
      this.setupHudVisibilityListeners(container);
    } catch (e) {}
  }

  /** Inject or refresh HUD CSS (auto-hide + glassy style). */
  injectHUDStyles() {
    const css = `
      .smart-skip-hud{position:absolute;right:16px;bottom:16px;z-index:2147483000;background:rgba(20,20,20,.75);backdrop-filter:saturate(1.2) blur(6px);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:10px;box-shadow:0 6px 16px rgba(0,0,0,.4);font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif;user-select:none;opacity:0;pointer-events:none;transform:translateY(6px);transition:opacity .2s ease, transform .2s ease}
      .smart-skip-hud.visible{opacity:1;pointer-events:auto;transform:translateY(0)}
      .smart-skip-hud .hud-header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.12);cursor:move}
      .smart-skip-hud .hud-title{font-size:12px;opacity:.85}
      .smart-skip-hud .hud-spacer{flex:1 1 auto}
      .smart-skip-hud .hud-icon{appearance:none;background:transparent;border:0;color:#fff;opacity:.85;cursor:pointer;font-size:14px;line-height:1;border-radius:6px;padding:2px 6px}
      .smart-skip-hud .hud-icon:hover{opacity:1;background:rgba(255,255,255,.15)}
      .smart-skip-hud .hud-close{appearance:none;background:transparent;border:0;color:#fff;opacity:.8;cursor:pointer;font-size:14px;line-height:1;border-radius:6px;padding:2px 6px}
      .smart-skip-hud .hud-close:hover{opacity:1;background:rgba(255,255,255,.15)}
      .smart-skip-hud .hud-body{display:flex;gap:10px;padding:10px}
      .smart-skip-hud .group{display:flex;gap:8px;align-items:center}
      .smart-skip-hud .group-advanced{display:none}
      .smart-skip-hud.expanded .group-advanced{display:flex}
      .smart-skip-hud button{appearance:none;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}
      .smart-skip-hud button:hover{background:rgba(255,255,255,.18)}
      .smart-skip-hud .toggle{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.9;cursor:pointer}
      .smart-skip-hud .toggle input{accent-color:#22c55e;cursor:pointer}
      .smart-skip-countdown{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);backdrop-filter:blur(2px);z-index:2147483001}
      .smart-skip-countdown .box{background:rgba(15,15,15,.85);border:1px solid rgba(255,255,255,.2);padding:14px 16px;border-radius:10px;display:flex;gap:10px;align-items:center}
      .smart-skip-countdown .num{font-weight:700;font-size:16px;color:#fbbf24}
      .smart-skip-countdown .txt{font-size:13px;opacity:.9}
      .smart-skip-countdown .actions{margin-left:10px}
      .smart-skip-countdown .actions button{padding:6px 10px}
    `;
    // If a style element already exists but is from an older version (without .visible or base opacity), update it
    if (this.hudStyleEl) {
      const text = this.hudStyleEl.textContent || '';
      const hasVisible = text.includes('.smart-skip-hud.visible');
      const hasOpacity = text.includes('opacity:0') && text.includes('pointer-events:none');
      if (!hasVisible || !hasOpacity) {
        try { this.hudStyleEl.textContent = css; } catch (e) {}
      }
      return;
    }
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    this.hudStyleEl = style;
  }

  /** Build the HUD DOM structure (compact primary + advanced group). */
  buildHUD() {
    const root = document.createElement('div');
    root.className = 'smart-skip-hud';

    // Header
    const header = document.createElement('div');
    header.className = 'hud-header';
    const title = document.createElement('span');
    title.className = 'hud-title';
    title.textContent = 'Smart Skip';
    const spacer = document.createElement('div');
    spacer.className = 'hud-spacer';
    const btnMore = document.createElement('button');
    btnMore.className = 'hud-icon';
    btnMore.title = 'Mehr';
    btnMore.setAttribute('data-action', 'toggle-advanced');
    btnMore.textContent = '⋯';
    const btnClose = document.createElement('button');
    btnClose.className = 'hud-close';
    btnClose.title = 'HUD ausblenden';
    btnClose.setAttribute('data-action', 'close');
    btnClose.textContent = '×';
    header.appendChild(title);
    header.appendChild(spacer);
    header.appendChild(btnMore);
    header.appendChild(btnClose);

    // Body
    const body = document.createElement('div');
    body.className = 'hud-body';

    const groupPrimary = document.createElement('div');
    groupPrimary.className = 'group group-primary';
    const btnSkip = document.createElement('button');
    btnSkip.type = 'button';
    btnSkip.setAttribute('data-action', 'skip-now');
    btnSkip.textContent = 'Skip';
    const btnNext = document.createElement('button');
    btnNext.type = 'button';
    btnNext.setAttribute('data-action', 'next');
    btnNext.textContent = 'Next';
    groupPrimary.appendChild(btnSkip);
    groupPrimary.appendChild(btnNext);

    const groupAdvanced = document.createElement('div');
    groupAdvanced.className = 'group group-advanced';

    const btnSkipRecap = document.createElement('button');
    btnSkipRecap.type = 'button';
    btnSkipRecap.setAttribute('data-action', 'skip-recap');
    btnSkipRecap.textContent = 'Skip Recap';
    groupAdvanced.appendChild(btnSkipRecap);

    const mkToggle = (key, labelText) => {
      const label = document.createElement('label');
      label.className = 'toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('data-toggle', key);
      const text = document.createTextNode(labelText);
      label.appendChild(input);
      label.appendChild(text);
      return label;
    };

    groupAdvanced.appendChild(mkToggle('intro', 'Intro'));
    groupAdvanced.appendChild(mkToggle('recap', 'Recap'));
    groupAdvanced.appendChild(mkToggle('credits', 'Credits'));
    groupAdvanced.appendChild(mkToggle('ads', 'Ads'));
    groupAdvanced.appendChild(mkToggle('autonext', 'AutoNext'));

    body.appendChild(groupPrimary);
    body.appendChild(groupAdvanced);

    root.appendChild(header);
    root.appendChild(body);

    this.attachHUDListeners(root);
    return root;
  }

  /** Bind HUD events once: buttons, toggles, drag, and visibility handling. */
  attachHUDListeners(root) {
    if (root.dataset.bound) return; // prevent double-binding
    root.dataset.bound = 'true';
    const getSeriesKey = () => {
      if (!this.currentSeries || !this.currentSeries.title) return null;
      return `${this.domain}:${this.currentSeries.title}`;
    };
    const bySel = (sel) => root.querySelector(sel);

    const btnSkip = bySel('button[data-action="skip-now"]');
    const btnSkipRecap = bySel('button[data-action="skip-recap"]');
    const btnNext = bySel('button[data-action="next"]');
    if (btnSkip) btnSkip.addEventListener('click', () => this.triggerSkipNow());
    if (btnSkipRecap) btnSkipRecap.addEventListener('click', () => this.triggerSkipType('recap'));
    if (btnNext) btnNext.addEventListener('click', () => this.findAndClickNext());
    const btnMore = bySel('button[data-action="toggle-advanced"]');
    if (btnMore) btnMore.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const expanded = this.hud && this.hud.classList.contains('expanded');
      if (expanded) {
        this.hud.classList.remove('expanded');
      } else {
        this.hud.classList.add('expanded');
      }
      try {
        if (!this.settings.domains[this.domain]) this.settings.domains[this.domain] = {};
        this.settings.domains[this.domain].hudExpanded = this.hud.classList.contains('expanded');
        this.saveSettings();
      } catch (err) {}
    });

    const btnClose = bySel('.hud-close');
    if (btnClose) btnClose.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (!this.settings.domains[this.domain]) this.settings.domains[this.domain] = {};
        this.settings.domains[this.domain].hudEnabled = false;
        this.saveSettings();
      } catch (err) {}
      this.destroyHUD();
    });

    // Keep HUD visible while interacting
    root.addEventListener('mouseenter', () => {
      this.hudInteracting = true;
      this.showHUD();
    });
    root.addEventListener('mouseleave', () => {
      this.hudInteracting = false;
      this.scheduleHudAutoHide();
    });

    const toggles = root.querySelectorAll('input[type="checkbox"][data-toggle]');
    toggles.forEach(input => {
      input.addEventListener('change', () => {
        const sk = getSeriesKey();
        if (!sk) return;
        if (!this.settings.series[sk]) {
          this.settings.series[sk] = { skipIntro:true, skipRecap:true, skipCredits:true, skipAds:true, autoNext:false };
        }
        const map = { intro:'skipIntro', recap:'skipRecap', credits:'skipCredits', ads:'skipAds', autonext:'autoNext' };
        const key = map[input.dataset.toggle];
        if (key) {
          this.settings.series[sk][key] = !!input.checked;
          this.saveSettings();
        }
      });
    });
  }

  /** Sync HUD toggle states and expanded state from settings for current series/domain. */
  updateHUDState() {
    if (!this.hud) return;
    const sk = (this.currentSeries && this.currentSeries.title) ? `${this.domain}:${this.currentSeries.title}` : null;
    const set = sk ? (this.settings.series[sk] || {}) : {};
    const check = (name, def) => !!(set[name] !== undefined ? set[name] : def);
    const map = { intro:check('skipIntro', true), recap:check('skipRecap', true), credits:check('skipCredits', true), ads:check('skipAds', true), autonext:check('autoNext', false) };
    this.hud.querySelectorAll('input[type="checkbox"][data-toggle]').forEach(cb => {
      const v = map[cb.dataset.toggle];
      if (typeof v === 'boolean') cb.checked = v;
      cb.disabled = !sk;
    });
    // Apply expanded/collapsed state from per-domain setting (default: collapsed/compact)
    try {
      const expanded = !!this.settings.domains[this.domain]?.hudExpanded;
      if (expanded) this.hud.classList.add('expanded'); else this.hud.classList.remove('expanded');
    } catch (e) {}
  }

  /** Make the HUD draggable within the player container, persisting the position. */
  makeHUDDraggable() {
    if (!this.hud) return;
    if (this.hud.dataset.dragBound) return;
    const header = this.hud.querySelector('.hud-header');
    const root = this.hud;
    if (!header) return;
    const onDown = (e) => {
      // Ignore drag when clicking close button
      if (e && e.target && e.target.closest && e.target.closest('.hud-close')) return;
      this.hudInteracting = true;
      this.hudDragging = true;
      const rect = root.getBoundingClientRect();
      this.hudDragOffset.x = (e.clientX || 0) - rect.left;
      this.hudDragOffset.y = (e.clientY || 0) - rect.top;
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!this.hudDragging) return;
      const container = this.getPlayerContainer();
      const cRect = container.getBoundingClientRect();
      let x = (e.clientX || 0) - cRect.left - this.hudDragOffset.x;
      let y = (e.clientY || 0) - cRect.top - this.hudDragOffset.y;
      x = Math.max(0, Math.min(x, cRect.width - root.offsetWidth));
      y = Math.max(0, Math.min(y, cRect.height - root.offsetHeight));
      root.style.left = x + 'px';
      root.style.top = y + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      this.showHUD();
    };
    const onUp = () => {
      if (!this.hudDragging) return;
      this.hudDragging = false;
      this.hudInteracting = false;
        this.hudUserMoved = true;
      this.saveHudPosition();
      this.scheduleHudAutoHide();
    };
    header.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    this.hud.dataset.dragBound = 'true';
  }

  // Determine if HUD should be shown based on settings
  /** Determine final HUD visibility from global + per-domain flags. */
  isHudEnabled() {
    try {
      const domainSetting = this.settings.domains[this.domain]?.hudEnabled;
      const globalSetting = this.settings.globalHudEnabled;
      const global = (globalSetting === undefined ? true : !!globalSetting);
      return (domainSetting !== undefined) ? !!domainSetting : global;
    } catch (e) {
      return true;
    }
  }

  /**
   * Attach auto-hide listeners on the player container.
   * Rebind safely when the container changes; start hidden and reveal on mouse move.
   */
  setupHudVisibilityListeners(container) {
    try {
      if (!container) return;
      if (this.hudBoundContainer === container && this._onHudMouseMove && this._onHudMouseLeave) return;
      // Unbind old
      if (this.hudBoundContainer && this._onHudMouseMove) {
        try { this.hudBoundContainer.removeEventListener('mousemove', this._onHudMouseMove); } catch (e) {}
      }
      if (this.hudBoundContainer && this._onHudMouseLeave) {
        try { this.hudBoundContainer.removeEventListener('mouseleave', this._onHudMouseLeave); } catch (e) {}
      }
      // Bind new
      this._onHudMouseMove = () => {
        if (!this.isHudEnabled()) return;
        this.showHUDTemporarily();
      };
      this._onHudMouseLeave = () => {
        this.scheduleHudAutoHide(600);
      };
      container.addEventListener('mousemove', this._onHudMouseMove);
      container.addEventListener('mouseleave', this._onHudMouseLeave);
      this.hudBoundContainer = container;
      // Start hidden; will show on first move
      this.hideHUD(true);
    } catch (e) {}
  }

  showHUD() {
    try { if (this.hud) this.hud.classList.add('visible'); } catch (e) {}
  }

  hideHUD(force = false) {
    try {
      if (!this.hud) return;
      if (!force && this.hudInteracting) return;
      this.hud.classList.remove('visible');
    } catch (e) {}
  }

  showHUDTemporarily() {
    this.showHUD();
    this.scheduleHudAutoHide();
  }

  scheduleHudAutoHide(delayMs) {
    try {
      const d = typeof delayMs === 'number' ? delayMs : this.hudHideDelay;
      if (this.hudHideTimeoutId) clearTimeout(this.hudHideTimeoutId);
      this.hudHideTimeoutId = setTimeout(() => {
        this.hideHUD();
        this.hudHideTimeoutId = null;
      }, d);
    } catch (e) {}
  }

  destroyHUD() {
    try {
      if (this.hudHideTimeoutId) { clearTimeout(this.hudHideTimeoutId); this.hudHideTimeoutId = null; }
      if (this.hudBoundContainer) {
        try { if (this._onHudMouseMove) this.hudBoundContainer.removeEventListener('mousemove', this._onHudMouseMove); } catch (e) {}
        try { if (this._onHudMouseLeave) this.hudBoundContainer.removeEventListener('mouseleave', this._onHudMouseLeave); } catch (e) {}
        this.hudBoundContainer = null;
      }
      if (this.countdownOverlay && this.countdownOverlay.parentElement) {
        this.countdownOverlay.remove();
        this.countdownOverlay = null;
      }
      if (this.hud && this.hud.parentElement) {
        this.hud.remove();
      }
      this.hud = null;
      this.hudDragging = false;
    } catch (e) {}
  }

  /** Restore HUD position from per-domain storage; default bottom-right. */
  restoreHudPosition() {
    try {
      const pos = this.settings.domains[this.domain]?.hudPos;
      if (!this.hud) return;
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        this.hud.style.left = pos.x + 'px';
        this.hud.style.top = pos.y + 'px';
        this.hud.style.right = 'auto';
        this.hud.style.bottom = 'auto';
      } else {
        this.hud.style.right = '16px';
        this.hud.style.bottom = '16px';
      }
    } catch (e) {}
  }

  /** Persist HUD position relative to the player container. */
  saveHudPosition() {
    try {
      if (!this.hud) return;
      const rect = this.hud.getBoundingClientRect();
      const container = this.getPlayerContainer();
      const cRect = container.getBoundingClientRect();
      const x = rect.left - cRect.left;
      const y = rect.top - cRect.top;
      if (!this.settings.domains[this.domain]) this.settings.domains[this.domain] = {};
      this.settings.domains[this.domain].hudPos = { x, y };
      this.saveSettings();
    } catch (e) {}
  }

  // Try alternate corners to avoid overlapping native control bars or buttons
  /** Try alternate corners to avoid overlapping native control bars/buttons. */
  positionHudSafely() {
    try {
      if (!this.hud) return;
      const container = this.getPlayerContainer();
      if (!container) return;
      const anchors = [
        { right: 16, bottom: 16 },
        { right: 16, top: 16 },
        { left: 16, top: 16 },
        { left: 16, bottom: 16 }
      ];
      const original = {
        left: this.hud.style.left,
        top: this.hud.style.top,
        right: this.hud.style.right,
        bottom: this.hud.style.bottom
      };
      const controls = this.getControlsRects(container);
      const overlaps = (a, b, pad = 8) => {
        return !(a.right + pad < b.left || a.left - pad > b.right || a.bottom + pad < b.top || a.top - pad > b.bottom);
      };
      const hitsAny = (r) => controls.some(c => overlaps(r, c));

      // If current position is fine, keep it
      let hudRect = this.hud.getBoundingClientRect();
      if (!hitsAny(hudRect)) return;

      for (const anchor of anchors) {
        // Apply anchor
        this.hud.style.left = (anchor.left != null ? anchor.left + 'px' : 'auto');
        this.hud.style.top = (anchor.top != null ? anchor.top + 'px' : 'auto');
        this.hud.style.right = (anchor.right != null ? anchor.right + 'px' : 'auto');
        this.hud.style.bottom = (anchor.bottom != null ? anchor.bottom + 'px' : 'auto');
        // Recalc rect
        hudRect = this.hud.getBoundingClientRect();
        if (!hitsAny(hudRect)) {
          return; // found safe spot
        }
      }
      // Restore if no anchor helped
      this.hud.style.left = original.left;
      this.hud.style.top = original.top;
      this.hud.style.right = original.right;
      this.hud.style.bottom = original.bottom;
    } catch (e) {}
  }

  /** Collect rough rects of native control areas likely to collide with the HUD. */
  getControlsRects(container) {
    try {
      const selectors = [
        // YouTube
        '#movie_player .ytp-chrome-bottom', '#movie_player .ytp-gradient-bottom', '.ytp-chrome-controls',
        // Netflix and generic
        '.watch-video--bottom-controls-container', '[data-uia*="control"]', '.player-controls', '.controls', '[class*="controls"]', '.control-bar', '.bottom-controls', '.vjs-control-bar'
      ];
      const rects = [];
      selectors.forEach(sel => {
        container.querySelectorAll(sel).forEach(el => {
          const r = el.getBoundingClientRect();
          if (r && r.width > 20 && r.height > 10) rects.push(r);
        });
      });
      // Also consider any large button cluster near the bottom 25% of the container
      const cRect = container.getBoundingClientRect();
      const thresholdTop = cRect.top + cRect.height * 0.75;
      container.querySelectorAll('button, [role="button"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.bottom >= thresholdTop && r.width > 20 && r.height > 10) rects.push(r);
      });
      return rects;
    } catch (e) { return []; }
  }

  /** Force a scan and immediate click of any active skip buttons. */
  triggerSkipNow() {
    try {
      const now = Date.now();
      this.lastClickTime = now - this.clickCooldown - 1;
      this.scanForButtons();
    } catch (e) {}
  }

  /** Try to click a specific skip type (e.g., 'recap') via selectors then text/aria. */
  triggerSkipType(type) {
    try {
      const container = this.getPlayerContainer();
      if (!container) return false;
      // First pass: selector-based
      const selectors = this.buttonPatterns.selectors || [];
      for (const selector of selectors) {
        const buttons = container.querySelectorAll(selector);
        for (const button of buttons) {
          const bType = this.getButtonType(button, selector);
          if (bType === type && this.isButtonClickable(button)) {
            this.clickButton(button, `hud ${type}`);
            return true;
          }
        }
      }
      // Second pass: text/aria-based
      const all = container.querySelectorAll('button, [role="button"], a, div[onclick]');
      for (const el of all) {
        const bType = this.getButtonTypeFromText(el);
        if (bType === type && this.shouldClickButton(el)) {
          this.clickButton(el, `hud ${type}`);
          return true;
        }
      }
      return false;
    } catch (e) { return false; }
  }

  /** Attempt to click the next-episode control via selectors, then text/aria. */
  findAndClickNext() {
    try {
      const container = this.getPlayerContainer();
      const selectors = this.buttonPatterns.selectors || [];
      for (const selector of selectors) {
        const buttons = container.querySelectorAll(selector);
        for (const button of buttons) {
          const type = this.getButtonType(button, selector);
          if (type === 'next' && this.isButtonClickable(button)) {
            this.clickButton(button, 'hud next');
            return true;
          }
        }
      }
      const all = container.querySelectorAll('button, [role="button"], a, div[onclick]');
      for (const el of all) {
        const type = this.getButtonTypeFromText(el);
        if (type === 'next' && this.shouldClickButton(el)) {
          this.clickButton(el, 'hud next');
          return true;
        }
      }
      return false;
    } catch (e) { return false; }
  }

  /** Display a cancelable auto-next countdown overlay before clicking next. */
  showAutoNextCountdown(seconds = 5, onDone) {
    try {
      if (this.autoNextTimeoutId) {
        clearTimeout(this.autoNextTimeoutId);
        this.autoNextTimeoutId = null;
      }
      const container = this.getPlayerContainer();
      if (!container) return;
      if (this.countdownOverlay && this.countdownOverlay.parentElement) {
        this.countdownOverlay.remove();
      }
      const overlay = document.createElement('div');
      overlay.className = 'smart-skip-countdown';

      const box = document.createElement('div');
      box.className = 'box';

      const num = document.createElement('span');
      num.className = 'num';
      num.setAttribute('data-role', 'num');
      num.textContent = String(seconds);

      const txt = document.createElement('span');
      txt.className = 'txt';
      txt.textContent = 'Nächste Folge in';

      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.setAttribute('data-action', 'cancel');
      cancelBtn.textContent = 'Abbrechen';
      actions.appendChild(cancelBtn);

      box.appendChild(num);
      box.appendChild(txt);
      box.appendChild(actions);
      overlay.appendChild(box);
      container.appendChild(overlay);
      this.countdownOverlay = overlay;
      let remaining = seconds;
      const numEl = num;
      const cleanup = () => {
        if (this.autoNextTimeoutId) { clearTimeout(this.autoNextTimeoutId); this.autoNextTimeoutId = null; }
        if (this.countdownOverlay && this.countdownOverlay.parentElement) { this.countdownOverlay.remove(); }
        this.countdownOverlay = null;
      };
      const tick = () => {
        remaining -= 1;
        if (numEl) numEl.textContent = String(Math.max(0, remaining));
        if (remaining <= 0) {
          cleanup();
          try { onDone && onDone(); } catch (e) {}
        } else {
          this.autoNextTimeoutId = setTimeout(tick, 1000);
        }
      };
      cancelBtn.addEventListener('click', cleanup);
      this.autoNextTimeoutId = setTimeout(tick, 1000);
    } catch (e) {}
  }
  /** Initialize: detect language, load settings, setup observers, start scanning */
  async init() {
    const url = window.location.href;
    
    // Block only service worker and metrics iframes (not the player iframe!)
    const isServiceWorkerOrMetrics = url.includes('sw_iframe') ||
                                     url.includes('service_worker') ||
                                     url.includes('metrics.crunchyroll.com');
    
    if (isServiceWorkerOrMetrics) {
      return;
    }
    
    // Detect if we're in the Crunchyroll player iframe
    const isCrunchyrollPlayer = url.includes('static.crunchyroll.com') && url.includes('player.html');
    
    if (isCrunchyrollPlayer) {
      // In player iframe: only scan for buttons, no series detection
      this.detectedLanguage = this.detectPageLanguage();
      this.buttonPatterns = this.generateButtonPatterns();
      await this.loadSettings();
      
      // Mark this instance as player iframe (to prevent series detection in start())
      this.isPlayerIframe = true;
      
      // Start button scanning only
      this.start();
      
      if (this.isExtensionContextValid()) {
        try {
          chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            this.handleMessage(request, sender, sendResponse);
            return true;
          });
        } catch (e) {}
      }
      return;
    }
    
    // Main window initialization (full features)
    const isMainWindow = window.self === window.top;
    if (!isMainWindow) {
      return;
    }
    
    this.detectedLanguage = this.detectPageLanguage();
    this.buttonPatterns = this.generateButtonPatterns();
    
    await this.loadSettings();
    
    this.startSeriesDetection();
    this.ensureHUD();
    
    // Only set up Chrome extension listeners if context is valid
    if (this.isExtensionContextValid()) {
      try {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
          this.handleMessage(request, sender, sendResponse);
          return true;
        });
      } catch (e) {
        console.warn('[Skipper] Failed to add runtime message listener:', e);
      }
      
      try {
        chrome.storage.onChanged.addListener((changes) => {
          this.handleStorageChange(changes);
        });
      } catch (e) {
        console.warn('[Skipper] Failed to add storage change listener:', e);
      }
    }
    
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
  }
  
  /** Load settings from storage (sync → local → localStorage fallback) */
  async loadSettings() {
    try {
      if (!this.isExtensionContextValid()) return;
      let loadedSettings = null;
      let loadMethod = '';
      
      // Try chrome.storage.sync first
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
      
      // Fallback to chrome.storage.local
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

  /** Handle storage changes and apply settings updates */
  handleStorageChange(changes) {
    if (changes.skipperSettings) {
      const newSettings = changes.skipperSettings.newValue;
      if (newSettings) {
        const prevHudEnabled = this.isHudEnabled();
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

        // Apply HUD visibility changes live
        const nextHudEnabled = this.isHudEnabled();
        if (nextHudEnabled && !this.hud) {
          this.ensureHUD();
        } else if (!nextHudEnabled && this.hud) {
          this.destroyHUD();
        }
      }
    }
  }
  
  /** Setup series detection with observers and intervals */
  startSeriesDetection() {
    this.detectCurrentSeries();
    
    this.lastUrl = window.location.href;
    
    this.updateSeriesCheckInterval();
    
    this.setupUrlChangeDetection();
    this.setupContentChangeDetection();
    this.setupButtonClickDetection();
    this.setupVideoEventDetection();
  }
  
  /** Adjust series detection frequency based on current context */
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
  
  /** Setup SPA navigation detection (pushState/popstate) */
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
  
  /** Observe DOM mutations for title/series changes */
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
  
  /** Detect user clicks on episode/series elements */
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
  
  /** Setup video element event listeners for series detection */
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
          this.setupTimeBasedSkipping(video);
        });
        
        video.addEventListener('loadedmetadata', () => {
          setTimeout(() => {
            this.detectCurrentSeries();
          }, 500);
          this.setupTimeBasedSkipping(video);
        });
        
        video.addEventListener('playing', () => {
          setTimeout(() => {
            this.detectCurrentSeries();
          }, 1000);
          this.setupTimeBasedSkipping(video);
        });
        
        video.addEventListener('canplay', () => {
          if (video.src && video.src !== video.dataset.lastSrc) {
            video.dataset.lastSrc = video.src;
            setTimeout(() => {
              this.detectCurrentSeries();
            }, 1500);
          }
          this.setupTimeBasedSkipping(video);
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
  
  /** Handle URL changes and trigger series detection */
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
  
  /** Check if URL is a content page (not browse/home) */
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

  /**
   * Detect current series/episode from DOM
   * Uses DOM state hashing to skip redundant runs
   */
  detectCurrentSeries() {
    // Don't run series detection in player iframe
    if (this.isPlayerIframe) {
      return;
    }
    
    const now = Date.now();
    const currentUrl = window.location.href;
    
    // More nuanced DOM state - don't include document.title as it changes too frequently
    const hasVideo = document.querySelector('video') !== null;
    const hasContent = document.querySelector('[data-uia*="title"], [data-uia*="video"], [data-t], h1') !== null;
    const domStateHash = `${hasVideo}-${hasContent}`;
    
    // Throttle only if URL, DOM state, and a very short time (50ms) are identical
    // This prevents rapid re-detections but allows updates when DOM actually changes
    if (this.lastSeriesDetection && 
        this.lastDetectionUrl === currentUrl && 
        this.lastDomStateHash === domStateHash &&
        (now - this.lastSeriesDetection) < 50) {
      if (this.verboseLogging) console.log('[Skipper] throttling detection - too soon');
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
      
      // For Crunchyroll: be VERY conservative - keep current series if we're on any watch/video page OR in iframe
      const isCrunchyroll = this.domain.includes('crunchyroll');
      const isIframeContext = window.location.href.includes('player.html') || 
                             window.location.href.includes('sw_iframe') ||
                             window.location.href.includes('service_worker') ||
                             window.location.href.includes('metrics.crunchyroll.com');
      const crunchyrollWatchPage = isCrunchyroll && (
        window.location.href.includes('/watch') || 
        window.location.pathname.includes('/watch') ||
        document.querySelector('video') !== null ||
        isIframeContext
      );
      
      if (crunchyrollWatchPage && this.currentSeries) {
        // We're on Crunchyroll watch page/iframe but couldn't extract series info
        // This is very common as DOM loads slowly or we're in an iframe - ALWAYS keep current series
        return;
      }
      
      if (!isOnVideoPage && !isOnTitlePage) {
        seriesChanged = true;
      } else if (isOnTitlePage && this.currentSeries) {
        seriesChanged = true;
      } else if (isOnVideoPage) {
        // On video page but couldn't extract info - keep current series for now
        return; 
      } else {
        return;
      }
    } else if (this.currentSeries && newSeries) {
      const titleChanged = newSeries.title !== this.currentSeries.title;
      const episodeChanged = newSeries.episode !== this.currentSeries.episode;
      const sourceChanged = newSeries.source !== this.currentSeries.source;
      
      // If title changed, check if new title looks suspicious/generic
      // If so, ignore it and keep current series
      if (titleChanged) {
        const suspiciousTitles = ['vilos', 'player', 'video', 'content', 'media', 'main', 'watch'];
        const newTitleLower = newSeries.title.toLowerCase();
        const isSuspicious = suspiciousTitles.some(term => newTitleLower === term || newTitleLower.includes(term));
        
        if (isSuspicious) {
          // Keep current series, just update episode if it changed
          if (episodeChanged && newSeries.episode && newSeries.episode !== 'unknown') {
            this.currentSeries.episode = newSeries.episode;
            seriesChanged = true;
          }
          return;
        }
      }
      
      if (titleChanged || episodeChanged || sourceChanged) {
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
      
      // For Crunchyroll: NEVER clear the series if we're on a watch page
      // DOM elements may not be ready yet, but we don't want to lose the series
      const isCrunchyroll = this.domain.includes('crunchyroll');
      const onCrunchyrollWatch = isCrunchyroll && (
        window.location.href.includes('/watch') || 
        window.location.pathname.includes('/watch') ||
        document.querySelector('video') !== null
      );
      
      if (!newSeries && onCrunchyrollWatch && this.currentSeries) {
        return; // Don't clear the series
      }
      
      this.currentSeries = newSeries;
      
      this.updateSeriesCheckInterval();
      try { this.updateHUDState(); } catch (e) {}
      
      if (newSeries) {
        this.safeRuntimeSendMessage({
          action: 'seriesDetected',
          series: newSeries,
          previousSeries: previousSeries,
          domain: this.domain
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

  /** Route to platform-specific series extractor */
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
      } else if (domain.includes('viki.com')) {
        return this.extractVikiSeries();
      } else {
        return this.extractGenericSeries();
      }
    } catch (error) {
      if (this.verboseLogging) console.error('[Skipper] extractSeriesInfo error', error);
      return null;
    }
  }

  /** Extract series/episode info from Netflix DOM */
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

  /** Disney+ extractor. */
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

  /** Prime Video extractor. */
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
    if (!episode) episode = document.querySelector('.atvwebplayersdk-subtitle-text')?.textContent?.trim();
    if (!episode) episode = document.querySelector('h2.atvwebplayersdk-subtitle-text')?.textContent?.trim();
    
    // Clean up episode: remove "Staffel X, F. Y" prefix
    if (episode) {
      episode = episode
        .replace(/^Staffel\s+\d+,\s*F\.\s*\d+\s*/i, '')  // "Staffel 1, F. 9 " → ""
        .replace(/^Season\s+\d+,\s*Ep\.\s*\d+\s*/i, '') // "Season 1, Ep. 9 " → ""
        .replace(/^S\d+,?\s*E\d+\s*/i, '')              // "S1E9 " → ""
        .trim();
    }
    
    if (title) {
      return { title, episode: episode || 'unknown', source: 'prime' };
    }
    
    return null;
  }

  /** Extract series/episode info from YouTube DOM */
  extractYouTubeSeries() {
    let title = document.querySelector('#title h1')?.textContent?.trim();
    if (!title) title = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim();
    if (!title) title = document.title?.replace(' - YouTube', '').trim();
    
    if (title) {
      return { title, episode: 'video', source: 'youtube' };
    }
    return null;
  }

  /** Extract series/episode info from Crunchyroll DOM */
  extractCrunchyrollSeries() {
    try {
      // CRITICAL: Don't run extraction on iframe contexts (player.html, service worker, etc.)
      // These will never have the series metadata and would incorrectly return null
      const url = window.location.href;
      if (url.includes('player.html') || 
          url.includes('sw_iframe.html') || 
          url.includes('service_worker') ||
          url.includes('metrics.crunchyroll.com')) {
        return null;
      }

      // Generic/invalid titles that should be ignored
      const invalidTitles = [
        'crunchyroll',
        'watch',
        'home',
        'browse',
        'search',
        'loading',
        'video',
        'player',
        'stream',
        'anime',
        'watch on crunchyroll',
        'start streaming',
        'vilos',
        'main player',
        'video player',
        'content',
        'unkown',
        'media'
      ];

      // Crunchyroll selectors - try multiple variants
      const titleSelectors = [
        '[data-t="show-title-link"] h4',  // Primary selector
        'a[data-t="show-title-link"] h4',
        '[data-t="show-title-link"]',     // Without h4
        'a[href*="/series/"] h4',         // Series link variant
        '.show-title h4',
        '.show-title',
        'h1[data-t="series-title"]',
        '[class*="show-title"]'
      ];

      let title = null;
      
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        
        if (el && el.textContent && el.textContent.trim().length > 1) {
          const candidate = el.textContent.trim();
          const candidateLower = candidate.toLowerCase();
          
          // Skip if it's a generic/invalid title
          if (!invalidTitles.some(inv => candidateLower === inv || candidateLower.includes(inv))) {
            title = candidate;
            break;
          }
        }
      }

      // If we didn't find a valid title, return null immediately
      if (!title) {
        return null;
      }

      // Episode selectors - try multiple variants
      const episodeSelectors = [
        'h1.heading--nKNOf.title',  // Primary
        'h1.title',
        'h1[class*="heading"]',
        '.episode-title',
        '[data-t="episode-title"]',
        'h1[class*="title"]'
      ];

      let episode = null;
      let episodeTitle = null;
      
      for (const sel of episodeSelectors) {
        const el = document.querySelector(sel);
        
        if (el && el.textContent && el.textContent.trim().length > 0) {
          let text = el.textContent.trim();
          
          // Remove the series title from the episode text if it's there
          if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
            text = text.substring(title.length).replace(/^[\s\-–—|:]+/, '').trim();
          }
          
          // Try to extract episode number and title
          const episodePattern = /^(?:E|Episode|Ep\.?|Folge)\s*(\d+)(?:\s*[-–—|:]\s*(.+))?$/i;
          const seasonEpisodePattern = /^S(\d+)\s*E(\d+)(?:\s*[-–—|:]\s*(.+))?$/i;
          const simpleNumberPattern = /^(\d+)(?:\s*[-–—|:]\s*(.+))?$/;
          
          let match = text.match(episodePattern);
          if (match) {
            episode = `E${match[1]}`;
            episodeTitle = match[2]?.trim() || null;
            break;
          }
          
          match = text.match(seasonEpisodePattern);
          if (match) {
            episode = `S${match[1]}E${match[2]}`;
            episodeTitle = match[3]?.trim() || null;
            break;
          }
          
          match = text.match(simpleNumberPattern);
          if (match && text.length < 150) {
            episode = `E${match[1]}`;
            episodeTitle = match[2]?.trim() || null;
            break;
          }
          
          // If none of the patterns match but text looks reasonable, use it as-is
          if (text.length < 150 && text.length > 0) {
            episode = text;
            break;
          }
        }
      }
      
      // Combine episode number and title if we have both
      if (episode && episodeTitle) {
        episode = `${episode} - ${episodeTitle}`;
      }

      // Clean title if it contains episode info
      if (title) {
        title = title.replace(/\s*[-–—|]\s*(?:Episode|Ep|Folge|E)\.?\s*\d+.*$/i, '').trim();
        title = title.replace(/\s*\|\s*Crunchyroll.*$/i, '').trim();
        title = title.replace(/\s*[-–—|]\s*S\d+E\d+.*$/i, '').trim();
      }

      if (title) {
        return { title, episode: episode || 'unknown', source: 'crunchyroll' };
      }
    } catch (error) {
      console.error('[Skipper] extractCrunchyrollSeries ERROR:', error);
    }
    return null;
  }

  /** Extract series/episode info from Apple TV+ DOM */
  extractAppleTVSeries() {
    let title = document.querySelector('.product-header__title')?.textContent?.trim();
    if (!title) title = document.title?.replace(' - Apple TV+', '').trim();
    
    let episode = document.querySelector('.episode-title')?.textContent?.trim();
    
    if (title) {
      return { title, episode: episode || 'unknown', source: 'appletv' };
    }
    return null;
  }

  /** Extract series/episode info from Viki DOM */
  extractVikiSeries() {
    try {
      // PRIORITY: Try og:title meta tag first (most reliable)
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
      if (ogTitle) {
        // Format: "Glory - Episode 1 | Rakuten Viki"
        const match = ogTitle.match(/^(.+?)\s*-\s*Episode\s*(\d+)(?:\s*[-:]\s*(.+?))?\s*\|\s*Rakuten Viki/i);
        if (match) {
          let episode = `E${match[2]}`;
          if (match[3]) episode += ` - ${match[3].trim()}`;
          
          return { 
            title: match[1].trim(), 
            episode: episode, 
            source: 'viki' 
          };
        }
      }
      
      // Fallback: Try to get series title from page
      let title = document.querySelector('.video-header__title')?.textContent?.trim();
      if (!title) title = document.querySelector('[data-t="title"]')?.textContent?.trim();
      if (!title) title = document.querySelector('.title')?.textContent?.trim();
      if (!title) title = document.querySelector('h1')?.textContent?.trim();
      
      // Try to get episode info
      let episode = null;
      const episodeEl = document.querySelector('.video-header__subtitle');
      if (episodeEl) {
        const epText = episodeEl.textContent.trim();
        // Parse episode like "Episode 1" or "Ep. 1 - Title"
        const match = epText.match(/(?:Episode|Ep\.?)\s*(\d+)(?:\s*[-:]\s*(.+))?/i);
        if (match) {
          episode = `E${match[1]}`;
          if (match[2]) episode += ` - ${match[2].trim()}`;
        } else {
          episode = epText;
        }
      }
      
      // Fallback to URL parsing
      if (!title || !episode) {
        const urlMatch = window.location.pathname.match(/\/videos\/([^\/]+)/);
        if (urlMatch && !title) {
          title = urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        }
      }
      
      // Clean title from common suffixes
      if (title) {
        title = title.replace(/\s*-\s*Viki$/, '').trim();
        title = title.replace(/\s*\|\s*Rakuten Viki$/, '').trim();
      }
      
      if (title) {
        return { title, episode: episode || 'unknown', source: 'viki' };
      }
    } catch (error) {
      console.error('[Skipper] extractVikiSeries error:', error);
    }
    return null;
  }

  /** Generic fallback extractor using DOM heuristics */
  extractGenericSeries() {
    let title = document.querySelector('h1')?.textContent?.trim();
    if (!title) title = document.title?.split(' - ')[0]?.trim();
    
    if (title) {
      return { title, episode: 'unknown', source: 'generic' };
    }
    return null;
  }

  /** Setup time-based intro/outro skipping for platforms without skip buttons */
  setupTimeBasedSkipping(video) {
    if (!video || this.currentVideoElement === video) return;
    
    // Only enable for platforms without native skip buttons
    const needsTimeBasedSkipping = this.domain.includes('viki.com');
    if (!needsTimeBasedSkipping) return;
    
    this.currentVideoElement = video;
    this.introSkipped = false;
    this.outroSkipped = false;
    this.introDetectionCache = null;
    this.frameSamples = [];
    
    // Start visual frame analysis for intro detection
    this.startFrameAnalysis(video);
    
    // Clear existing monitor
    if (this.videoTimeMonitor) {
      clearInterval(this.videoTimeMonitor);
    }
    
    // Monitor video time every 500ms for data-driven detection
    this.videoTimeMonitor = setInterval(() => {
      if (video.paused || !this.isEnabled) return;
      
      const currentTime = video.currentTime;
      const duration = video.duration;
      
      if (isNaN(duration) || duration === 0) return;
      
      const seriesSettings = this.getCurrentSeriesSettings();
      
      // Multi-sensor intro detection - ONLY data-based
      if (!this.introSkipped && seriesSettings.skipIntro && currentTime < 180) {
        // Use cached detection result if available
        let introData = this.introDetectionCache;
        
        // CONTINUOUS detection: Try to detect intro every time until we find one or pass 3 minutes
        // Only avoid re-detection if we already have a cached result
        if (!introData) {
          introData = this.detectIntroEnd(video, currentTime);
          
          if (introData) {
            this.introDetectionCache = introData; // Cache once found
            console.log('[Skipper] ✅ Intro cached for this video:', introData);
          } else {
            // FALLBACK: Check if user has manually defined intro times for this series
            const manualIntro = seriesSettings.manualIntroTimes;
            if (manualIntro && manualIntro.start !== undefined && manualIntro.end !== undefined) {
              introData = { start: manualIntro.start, end: manualIntro.end };
              this.introDetectionCache = introData;
              console.log('[Skipper] ✅ Using manual intro times:', introData);
            }
          }
        }
        
        // Skip if we detected an intro and we're in the intro range
        if (introData && currentTime >= introData.start && currentTime < introData.end) {
          console.log('[Skipper] ⏩ Multi-sensor intro skip:', 
            `${currentTime.toFixed(1)}s → ${introData.end.toFixed(1)}s`,
            `(duration: ${(introData.end - introData.start).toFixed(1)}s)`
          );
          video.currentTime = introData.end;
          this.introSkipped = true;
          this.showSkipNotification('Intro skipped');
        }
      }
      
      // Skip outro/credits (last 120 seconds) - only if video is longer than 3 minutes
      if (!this.outroSkipped && duration > 180 && duration - currentTime < 120 && currentTime > 60 && seriesSettings.skipCredits) {
        console.log('[Skipper] ⏩ Auto-skipping outro at', currentTime, 'seconds');
        video.currentTime = duration - 5; // Go near the end
        this.outroSkipped = true;
        this.showSkipNotification('Credits skipped');
      }
      
      this.lastVideoTime = currentTime;
    }, 500);
    
    // Reset flags on new video
    video.addEventListener('ended', () => {
      this.introSkipped = false;
      this.outroSkipped = false;
      if (this.videoFrameAnalyzer) {
        clearInterval(this.videoFrameAnalyzer);
        this.videoFrameAnalyzer = null;
      }
    });
    
    video.addEventListener('seeked', () => {
      // If user seeks, respect their choice
      if (Math.abs(video.currentTime - this.lastVideoTime) > 10) {
        if (video.currentTime < 150) this.introSkipped = false;
        if (video.duration - video.currentTime > 120) this.outroSkipped = false;
      }
    });
  }

  /** Detect intro end using MULTIPLE data-based methods - NO assumptions */
  detectIntroEnd(video, currentTime) {
    // Don't try to detect intro after 3 minutes (safety limit only)
    if (currentTime > 180) return null;
    
    // Collect evidence from multiple sources
    // Note: These methods are called every 500ms, so they need to be fast
    const evidence = {
      subtitle: this.detectSubtitlePattern(video),
      volume: this.detectVolumePattern(video),
      scene: this.detectSceneChange(video),
      metadata: this.detectMetadataMarkers(video)
    };
    
    // Count how many sources found something
    const foundCount = [evidence.subtitle, evidence.volume, evidence.scene, evidence.metadata]
      .filter(e => e !== null).length;
    
    // Debug: Log what we found (only every 10 seconds to reduce spam)
    if (Math.floor(currentTime / 10) !== Math.floor((this.lastVideoTime || 0) / 10)) {
      console.log('[Skipper] 🔍 Intro detection at', currentTime.toFixed(1), 's:', {
        subtitle: evidence.subtitle ? '✅' : '❌',
        volume: evidence.volume ? '❌' : '❌',
        scene: evidence.scene ? '❌' : '❌',
        metadata: evidence.metadata ? '❌' : '❌',
        total: foundCount
      });
      
      if (foundCount === 0) {
        console.log('[Skipper] 💡 TIP: For Viki, you can manually set intro times in the popup if auto-detection fails');
      }
    }
    
    // Combine evidence - need at least 2 independent confirmations OR 1 high-confidence source
    const detections = [];
    
    if (evidence.subtitle) {
      detections.push({
        source: 'subtitle',
        start: evidence.subtitle.introStart,
        end: evidence.subtitle.introEnd,
        confidence: evidence.subtitle.confidence
      });
    }
    
    if (evidence.volume) {
      detections.push({
        source: 'volume',
        start: evidence.volume.introStart,
        end: evidence.volume.introEnd,
        confidence: evidence.volume.confidence
      });
    }
    
    if (evidence.scene) {
      detections.push({
        source: 'scene',
        start: evidence.scene.introStart,
        end: evidence.scene.introEnd,
        confidence: evidence.scene.confidence
      });
    }
    
    if (evidence.metadata) {
      detections.push({
        source: 'metadata',
        start: evidence.metadata.introStart,
        end: evidence.metadata.introEnd,
        confidence: 1.0 // Metadata is most reliable
      });
    }
    
    // If we have metadata markers (chapters, etc.), trust them completely
    if (evidence.metadata) {
      console.log('[Skipper] 🎯 Using metadata-based intro detection');
      return { start: evidence.metadata.introStart, end: evidence.metadata.introEnd };
    }
    
    // Need at least 2 sources agreeing (within 5 seconds tolerance)
    if (detections.length >= 2) {
      for (let i = 0; i < detections.length; i++) {
        for (let j = i + 1; j < detections.length; j++) {
          const d1 = detections[i];
          const d2 = detections[j];
          
          // Check if both sources agree on intro timing (±5 seconds)
          if (Math.abs(d1.start - d2.start) <= 5 && Math.abs(d1.end - d2.end) <= 5) {
            const avgStart = (d1.start + d2.start) / 2;
            const avgEnd = (d1.end + d2.end) / 2;
            
            console.log('[Skipper] 🎯 Multi-source intro confirmed:', {
              sources: [d1.source, d2.source],
              start: avgStart.toFixed(1),
              end: avgEnd.toFixed(1),
              duration: (avgEnd - avgStart).toFixed(1)
            });
            
            return { start: avgStart, end: avgEnd };
          }
        }
      }
    }
    
    // RELAXED: Single source with high confidence (≥0.8) - was 0.9
    const highConfidence = detections.find(d => d.confidence >= 0.8);
    if (highConfidence) {
      console.log('[Skipper] 🎯 High-confidence intro detected:', highConfidence);
      return { start: highConfidence.start, end: highConfidence.end };
    }
    
    // FALLBACK: If we have subtitle detection with reasonable confidence (≥0.6), use it
    if (evidence.subtitle && evidence.subtitle.confidence >= 0.6) {
      console.log('[Skipper] 🎯 Using subtitle-only detection (confidence:', evidence.subtitle.confidence.toFixed(2), ')');
      return { start: evidence.subtitle.introStart, end: evidence.subtitle.introEnd };
    }
    
    // No reliable detection yet - keep checking
    return null;
  }

  /** Try to detect intro by analyzing subtitle track patterns - DATA ONLY */
  detectSubtitlePattern(video) {
    try {
      // Check for text tracks (subtitles)
      const tracks = Array.from(video.textTracks || []);
      
      // Only log once (first attempt)
      if (!this._subtitleDebugLogged) {
        console.log('[Skipper] 🔍 Subtitle Debug:', {
          totalTracks: tracks.length,
          trackModes: tracks.map(t => ({ kind: t.kind, mode: t.mode, label: t.label }))
        });
        this._subtitleDebugLogged = true;
      }
      
      // Try to find ANY subtitle track (not just showing/hidden)
      let activeTrack = tracks.find(t => t.mode === 'showing');
      if (!activeTrack) activeTrack = tracks.find(t => t.mode === 'hidden');
      if (!activeTrack) activeTrack = tracks.find(t => t.kind === 'subtitles' || t.kind === 'captions');
      
      if (!activeTrack) {
        if (!this._subtitleDebugLogged) {
          console.log('[Skipper] ❌ No subtitle track found');
        }
        return null;
      }
      
      console.log('[Skipper] 📝 Found subtitle track:', {
        kind: activeTrack.kind,
        mode: activeTrack.mode,
        cues: activeTrack.cues?.length || 0
      });
      
      if (!activeTrack.cues) {
        console.log('[Skipper] ❌ No cues available yet');
        return null;
      }
      
      const cues = Array.from(activeTrack.cues);
      if (cues.length < 5) {
        console.log('[Skipper] ⚠️ Not enough cues yet:', cues.length);
        return null; // Need enough data
      }
      
      // Find ALL gaps in subtitles (intros typically have long periods without dialogue)
      const gaps = [];
      for (let i = 0; i < cues.length - 1; i++) {
        const currentCue = cues[i];
        const nextCue = cues[i + 1];
        
        const gapDuration = nextCue.startTime - currentCue.endTime;
        
        // Only consider significant gaps (20+ seconds)
        if (gapDuration >= 20) {
          gaps.push({
            start: currentCue.endTime,
            end: nextCue.startTime,
            duration: gapDuration,
            position: currentCue.endTime
          });
        }
      }
      
      console.log('[Skipper] 📊 Found gaps:', gaps.length, gaps.slice(0, 3));
      
      if (gaps.length === 0) return null;
      
      // Find the longest gap in the first 3 minutes (most likely the intro)
      const earlyGaps = gaps.filter(g => g.position < 180);
      if (earlyGaps.length === 0) return null;
      
      // Sort by duration (longest first)
      earlyGaps.sort((a, b) => b.duration - a.duration);
      
      const longestGap = earlyGaps[0];
      
      // Validate: Gap should start within first 2 minutes and be substantial
      if (longestGap.position <= 120 && longestGap.duration >= 25) {
        // Calculate confidence based on gap duration and position
        const confidence = Math.min(0.95, longestGap.duration / 90);
        
        console.log('[Skipper] ✅ Intro detected via subtitles:', {
          start: longestGap.start.toFixed(1),
          end: longestGap.end.toFixed(1),
          duration: longestGap.duration.toFixed(1),
          confidence: confidence.toFixed(2)
        });
        
        return { 
          introStart: longestGap.start, 
          introEnd: longestGap.end,
          confidence: confidence
        };
      } else {
        console.log('[Skipper] ⚠️ Gap found but invalid:', {
          position: longestGap.position.toFixed(1),
          duration: longestGap.duration.toFixed(1),
          positionOK: longestGap.position <= 120,
          durationOK: longestGap.duration >= 25
        });
      }
    } catch (error) {
      console.error('[Skipper] ❌ Subtitle analysis error:', error);
    }
    
    return null;
  }

  /** Detect intro by analyzing volume levels (intro music is often louder/distinct) */
  detectVolumePattern(video) {
    try {
      // Check if we can access audio context
      if (!window.AudioContext && !window.webkitAudioContext) return null;
      
      // This would require Web Audio API integration
      // For now, we check if video has multiple audio tracks with metadata
      const audioTracks = video.audioTracks;
      if (!audioTracks || audioTracks.length === 0) return null;
      
      // Check for volume metadata in tracks (some platforms provide this)
      // This is a placeholder for future enhancement
      return null;
      
    } catch (error) {
      return null;
    }
  }

  /** Detect scene changes (intro often has distinct visual patterns) */
  detectSceneChange(video) {
    try {
      // Method 1: Check seekable ranges for chapter markers
      const seekable = video.seekable;
      if (seekable && seekable.length > 0) {
        for (let i = 0; i < seekable.length; i++) {
          const start = seekable.start(i);
          const end = seekable.end(i);
          
          // Look for chapter-like segments in intro range
          if (start > 5 && start < 120 && (end - start) > 20 && (end - start) < 120) {
            return {
              introStart: start,
              introEnd: end,
              confidence: 0.7
            };
          }
        }
      }
      
      // Method 2: Sample video frames to detect visual transitions
      // This is more CPU-intensive but works without subtitles
      if (video.readyState >= 2 && video.duration > 60) {
        return this.analyzeVideoFrames(video);
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /** Analyze video frames to detect intro by visual changes */
  analyzeVideoFrames(video) {
    try {
      // Create a canvas to sample video frames
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 160;  // Low resolution for speed
      canvas.height = 90;
      
      // We'll track frame similarity - intro often has consistent visuals
      // then a sharp change when the show starts
      const frameSamples = [];
      const sampleTimes = [];
      
      // Sample every 5 seconds for the first 2 minutes
      for (let t = 0; t < Math.min(120, video.duration); t += 5) {
        sampleTimes.push(t);
      }
      
      // Store current time to restore later
      const originalTime = video.currentTime;
      let samplesCollected = 0;
      
      // This would need to be async and run over time
      // For now, we'll return null and implement this as a background task
      // in setupTimeBasedSkipping
      
      return null;
      
    } catch (error) {
      return null;
    }
  }

  /** Start real-time frame analysis to detect visual changes (intro detection) */
  startFrameAnalysis(video) {
    try {
      console.log('[Skipper] 🎥 Starting frame analysis...', {
        readyState: video.readyState,
        duration: video.duration,
        currentTime: video.currentTime
      });
      
      if (!video || video.readyState < 2) {
        console.log('[Skipper] ⚠️ Video not ready yet, will retry...');
        // Retry when video is ready
        video.addEventListener('loadeddata', () => {
          console.log('[Skipper] ✅ Video ready, starting frame analysis');
          this.startFrameAnalysis(video);
        }, { once: true });
        return;
      }
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      
      if (!ctx) {
        console.error('[Skipper] ❌ Could not get canvas context');
        return;
      }
      
      canvas.width = 64;  // Very low res for performance
      canvas.height = 36;
      
      console.log('[Skipper] ✅ Canvas created:', canvas.width, 'x', canvas.height);
      
      let lastBrightness = null;
      let lastChange = 0;
      let stableFrames = 0;
      let potentialIntroStart = null;
      let potentialIntroEnd = null;
      
      // Sample frames every 2 seconds
      const sampleFrame = () => {
        // Don't stop if paused, only if video ended or past 3 minutes
        if (!video || video.ended || video.currentTime > 180) {
          console.log('[Skipper] 🛑 Stopping frame analysis:', {
            ended: video?.ended,
            currentTime: video?.currentTime
          });
          return;
        }
        
        try {
          // Draw current frame
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          
          // Calculate average brightness
          let totalBrightness = 0;
          for (let i = 0; i < imageData.data.length; i += 4) {
            const r = imageData.data[i];
            const g = imageData.data[i + 1];
            const b = imageData.data[i + 2];
            totalBrightness += (r + g + b) / 3;
          }
          const avgBrightness = totalBrightness / (canvas.width * canvas.height);
          
          // Detect significant brightness changes (scene changes)
          if (lastBrightness !== null) {
            const change = Math.abs(avgBrightness - lastBrightness);
            const currentTime = video.currentTime;
            
            console.log('[Skipper] 🎨 Frame analysis:', {
              time: currentTime.toFixed(1),
              brightness: avgBrightness.toFixed(1),
              change: change.toFixed(1)
            });
            
            // Large change = scene transition
            if (change > 30) {
              console.log('[Skipper] 📸 Scene change detected at', currentTime.toFixed(1), 's');
              
              // First major change in first 30 seconds = likely intro start
              if (!potentialIntroStart && currentTime < 30) {
                potentialIntroStart = Math.max(0, currentTime - 2);
                console.log('[Skipper] 🎬 Potential intro START:', potentialIntroStart.toFixed(1));
              }
              // Major change after intro start = likely intro end
              else if (potentialIntroStart && !potentialIntroEnd && currentTime > potentialIntroStart + 20) {
                potentialIntroEnd = currentTime;
                console.log('[Skipper] 🎬 Potential intro END:', potentialIntroEnd.toFixed(1));
                
                // Cache this detection
                if (potentialIntroEnd - potentialIntroStart >= 30 && potentialIntroEnd - potentialIntroStart <= 120) {
                  this.introDetectionCache = {
                    start: potentialIntroStart,
                    end: potentialIntroEnd
                  };
                  console.log('[Skipper] ✅ Visual intro detection cached:', this.introDetectionCache);
                }
              }
              
              lastChange = currentTime;
              stableFrames = 0;
            } else {
              stableFrames++;
            }
          }
          
          lastBrightness = avgBrightness;
          
        } catch (e) {
          console.error('[Skipper] ❌ Frame analysis error:', e);
        }
      };
      
      // Sample immediately
      setTimeout(sampleFrame, 100);
      
      // Then sample every 2 seconds
      this.videoFrameAnalyzer = setInterval(sampleFrame, 2000);
      
      console.log('[Skipper] ✅ Frame analyzer started (interval every 2s)');
      
      // Also stop after 3 minutes
      setTimeout(() => {
        if (this.videoFrameAnalyzer) {
          clearInterval(this.videoFrameAnalyzer);
          this.videoFrameAnalyzer = null;
          console.log('[Skipper] 🛑 Frame analysis stopped (3 min limit)');
        }
      }, 180000);
      
    } catch (error) {
      console.error('[Skipper] ❌ Could not start frame analysis:', error);
    }
  }

  /** Check for metadata markers (chapters, TextTrack metadata) */
  detectMetadataMarkers(video) {
    try {
      // Check for metadata tracks (some platforms use these for chapters)
      const tracks = Array.from(video.textTracks || []);
      const metadataTrack = tracks.find(t => t.kind === 'metadata' || t.kind === 'chapters');
      
      // Only log once
      if (!this._metadataDebugLogged) {
        console.log('[Skipper] 🔍 Metadata Debug:', {
          totalTracks: tracks.length,
          hasMetadata: !!metadataTrack,
          kinds: tracks.map(t => t.kind)
        });
        this._metadataDebugLogged = true;
      }
      
      if (metadataTrack && metadataTrack.cues) {
        const cues = Array.from(metadataTrack.cues);
        console.log('[Skipper] 📊 Metadata cues:', cues.length);
        
        // Look for intro markers
        for (const cue of cues) {
          const text = cue.text?.toLowerCase() || '';
          
          // Check for intro-related keywords
          if (text.includes('intro') || text.includes('opening') || text.includes('op')) {
            console.log('[Skipper] ✅ Found intro marker in metadata:', text);
            return {
              introStart: cue.startTime,
              introEnd: cue.endTime,
              confidence: 1.0 // Metadata is most reliable
            };
          }
        }
      }
      
      // Check for chapter metadata in video element attributes
      if (video.dataset?.chapters) {
        try {
          const chapters = JSON.parse(video.dataset.chapters);
          const introChapter = chapters.find(c => 
            c.title?.toLowerCase().includes('intro') || 
            c.title?.toLowerCase().includes('opening')
          );
          
          if (introChapter) {
            console.log('[Skipper] ✅ Found intro chapter in dataset:', introChapter);
            return {
              introStart: introChapter.start,
              introEnd: introChapter.end,
              confidence: 1.0
            };
          }
        } catch (e) {
          // Invalid JSON
        }
      }
      
      return null;
    } catch (error) {
      console.error('[Skipper] ❌ Metadata error:', error);
      return null;
    }
  }

  /** Show a temporary notification when auto-skipping */
  showSkipNotification(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: bold;
      z-index: 999999;
      pointer-events: none;
      animation: fadeInOut 2s ease-in-out;
    `;
    notification.textContent = message;
    
    // Add fade animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fadeInOut {
        0% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
        20% { opacity: 1; transform: translateX(-50%) translateY(0); }
        80% { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(notification);
    
    setTimeout(() => {
      notification.remove();
      style.remove();
    }, 2000);
  }

  /** Save settings to chrome.storage (sync → local fallback) */
  async saveSettings() {
    try {
      if (!this.settings || typeof this.settings !== 'object') {
        return;
      }
      if (!this.isExtensionContextValid()) return;
      
      const validSettings = {
        globalEnabled: this.settings.globalEnabled !== undefined ? this.settings.globalEnabled : true,
        globalHudEnabled: this.settings.globalHudEnabled !== undefined ? this.settings.globalHudEnabled : true,
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

  /** Handle runtime messages from popup/background */
  handleMessage(request, sender, sendResponse) {
    switch (request.action) {
      case 'detectSeries':
        // Player iframe should not respond to series detection requests
        // Only the main window has series information
        if (this.isPlayerIframe) {
          return; // Don't respond
        }
        
        sendResponse({ series: this.currentSeries });
        break;
        
      case 'updateSettings':
        if (request.settings) {
          const prevHud = this.isHudEnabled();
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

          const nextHud = this.isHudEnabled();
          if (nextHud && !this.hud) this.ensureHUD();
          if (!nextHud && this.hud) this.destroyHUD();
        }
        sendResponse({ success: true });
        break;
        
      case 'clearIntroCache':
        // Clear cached intro detection so new manual times take effect immediately
        this.introDetectionCache = null;
        if (request.manualTimes) {
          console.log('[Skipper] 🎯 Manual intro times updated:', request.manualTimes);
          // Cache the manual times immediately
          this.introDetectionCache = {
            start: request.manualTimes.start,
            end: request.manualTimes.end
          };
        } else {
          console.log('[Skipper] 🗑️ Manual intro times cleared');
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
  
  /** Begin scanning and observers when enabled. */
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

    // Don't run series detection in player iframe
    if (!this.isPlayerIframe && typeof this.detectCurrentSeries === 'function') {
      this.detectCurrentSeries();
    }
    // Ensure HUD reflects current visibility when starting observers
    try { this.ensureHUD(); } catch (e) {}
  }
  
  /** Stop observers/intervals to reduce overhead when disabled. */
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
  
  /**
   * Scan the player container for actionable buttons using selectors then text/aria.
   * Applies timing and visibility guards to avoid false positives.
   */
  scanForButtons() {
    if (!this.isEnabled) return;
    
    // Only scan for buttons on video/watch pages, not on browse/list pages
    const url = window.location.href;
    const isOnWatchPage = url.includes('/watch') || 
                         url.includes('/video') || 
                         url.includes('/player') ||
                         url.includes('static.crunchyroll.com/vilos'); // Player iframe
    
    // Skip button scanning on non-watch pages (browse, search, list pages, etc.)
    if (!isOnWatchPage && !document.querySelector('video')) {
      return;
    }
    
    const now = Date.now();
    if (now - this.lastClickTime < this.clickCooldown) {
      return;
    }
    
    // Limit scanning to the video/player area to avoid touching large sidebars (e.g., YouTube recommendations)
    // Special case for Crunchyroll player iframe: use document instead of container
    let container = this.getPlayerContainer();
    const isCrunchyrollPlayer = window.location.hostname.includes('static.crunchyroll.com') && 
                                window.location.pathname.includes('player.html');
    if (isCrunchyrollPlayer) {
      container = document;
    }
    if (!container) return;

    // For Crunchyroll player iframe, use global settings since we don't detect series there
    const seriesSettings = isCrunchyrollPlayer ? this.settings : this.getCurrentSeriesSettings();
    
    let clicked = false;
    for (const selector of this.buttonPatterns.selectors) {
      const buttons = container.querySelectorAll(selector);
      for (const button of buttons) {
        const buttonType = this.getButtonType(button, selector);
        
        // For Crunchyroll player iframe, always skip (use defaults)
        const shouldClick = isCrunchyrollPlayer 
          ? (['intro','recap','credits','ads'].includes(buttonType)) // Always skip in player iframe
          : (['intro','recap','credits','ads'].includes(buttonType))
            && buttonType !== 'watch-abspann' && buttonType !== 'watch'
            && this.shouldSkipButtonType(buttonType, seriesSettings);
            
        if (shouldClick && this.isButtonClickable(button)) {
          console.log(`[Skipper] ✅ Clicking ${buttonType} button`);
          this.clickButton(button, `selector: ${selector} (${buttonType})`);
          clicked = true;
          break;
        }
      }
      if (clicked) break;
    }
    if (!clicked) {
      const allButtons = container.querySelectorAll('button, [role="button"], a, div[onclick]');
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
        const buttons = container.querySelectorAll(selector);
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
      const allButtons = container.querySelectorAll('button, [role="button"], a, div[onclick]');
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

  /** Get player container element (scoped to avoid sidebars) */
  getPlayerContainer() {
    try {
      
      //Domain-specific fallback for Prime
      if (
      window.location.hostname.includes('primevideo.') ||
      (window.location.hostname.includes('amazon.') && window.location.pathname.includes('/gp/video'))
      ) {
      return document.body;
      }
      
      // Prefer the nearest ancestor of a <video>
      const video = document.querySelector('video');
      if (video) {
        let node = video;
        for (let i = 0; i < 6 && node; i++) {
          const cls = (node.className || '').toString().toLowerCase();
          if (node.id === 'movie_player' || cls.includes('html5-video-player') || cls.includes('player') || cls.includes('video-player')) {
            return node;
          }
          node = node.parentElement;
        }
        // fallback: use the closest section that contains the video element
        return video.closest('#player, ytd-player, .player, .video-player') || video.parentElement || document.body;
      }
      // Domain-specific fallback for YouTube
      if (window.location.hostname.includes('youtube.com')) {
        const el = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        if (el) return el;
      }

      // Last resort: restrict to main area if available
      return document.querySelector('#player, .player, .video-player') || document.body;
    } catch (e) {
      return document.body;
    }
  }
  
  /** Get current series settings (with defaults) */
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
  
  /** Classify button type by selector and text (intro/recap/credits/ads/next) - Multi-language support */
  getButtonType(button, selector) {
    const text = (button.textContent || button.getAttribute('aria-label') || button.title || '').toLowerCase();
    const selectorLower = selector.toLowerCase();

    // Multi-language "watch" patterns
    const watchPatterns = [
      'ansehen', 'anschauen', 'watch', 'view', 'play', 'abspielen', 'schauen',
      'ver', 'voir', 'guarda', 'assistir', 'bekijken', 'oglądać', 'смотреть', '見る', '시청', '观看'
    ];
    
    // Multi-language "credits" patterns
    const creditsPatterns = [
      'abspann', 'credits', 'créditos', 'crédits', 'crediti', 'aftiteling', 
      'napisy końcowe', 'титры', 'クレジット', '크레딧', '片尾', 'ending', 'outro'
    ];

    const isWatchButton = watchPatterns.some(pattern => text.includes(pattern));
    const isCreditsButton = creditsPatterns.some(pattern => text.includes(pattern));

    // Netflix-specific data attributes
    if (button.getAttribute('data-uia') === 'watch-credits-seamless-button') {
      return 'watch-abspann';
    }
    if (button.getAttribute('data-uia') === 'next-episode-seamless-button') {
      return 'next';
    }
    
    // Watch Credits button
    if (isCreditsButton && isWatchButton) {
      if (window.location.hostname.includes('netflix.')) {
        return 'watch-abspann';
      }
      return 'watch';
    }

    if (isWatchButton) {
      return 'watch';
    }
    
    // Selector-based classification
    if (selectorLower.includes('intro') || selectorLower.includes('opening')) return 'intro';
    if (selectorLower.includes('recap') || selectorLower.includes('previously')) return 'recap';
    if (selectorLower.includes('credits') || selectorLower.includes('end') || selectorLower.includes('closing')) return 'credits';
    if (selectorLower.includes('ad') || selectorLower.includes('advertisement')) return 'ads';
    if (selectorLower.includes('next') || selectorLower.includes('continue') || selectorLower.includes('advance')) return 'next';
    
    // Multi-language "skip" patterns
    const skipPatterns = [
      'skip', 'überspringen', 'pular', 'saltar', 'passer', 'salta', 
      'overslaan', 'pomiń', 'пропустить', 'スキップ', '건너뛰기', '跳过'
    ];
    const isSkipButton = skipPatterns.some(pattern => text.includes(pattern));
    
    if (isSkipButton) {
      // Multi-language intro patterns
      if (text.includes('intro') || text.includes('opening') || text.includes('vorspann') || 
          text.includes('abertura') || text.includes('générique') || text.includes('apertura') ||
          text.includes('オープニング') || text.includes('오프닝') || text.includes('片头')) {
        return 'intro';
      }
      
      // Multi-language recap patterns
      if (text.includes('recap') || text.includes('previously') || text.includes('zuvor') || 
          text.includes('zusammenfassung') || text.includes('rückblick') || text.includes('resumen') ||
          text.includes('résumé') || text.includes('resumo') || text.includes('riepilogo') ||
          text.includes('samenvatting') || text.includes('podsumowanie') || text.includes('要約') ||
          text.includes('요약') || text.includes('回顾')) {
        return 'recap';
      }
      
      // Multi-language credits patterns (already checked above)
      if (isCreditsButton) {
        return 'credits';
      }
      
      // Multi-language ad patterns
      if (text.includes('ad') || text.includes('anzeige') || text.includes('werbung') ||
          text.includes('anuncio') || text.includes('publicité') || text.includes('pubblicit') ||
          text.includes('anúncio') || text.includes('advertentie') || text.includes('reklama') ||
          text.includes('реклама') || text.includes('広告') || text.includes('광고') || text.includes('广告')) {
        return 'ads';
      }
      
      return 'unknown-skip';
    }
    
    // Check aria-label as fallback
    const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
    const ariaHasSkip = skipPatterns.some(pattern => ariaLabel.includes(pattern));
    
    if (ariaHasSkip) {
      if (ariaLabel.includes('intro') || ariaLabel.includes('opening') || ariaLabel.includes('vorspann') ||
          ariaLabel.includes('abertura') || ariaLabel.includes('générique') || ariaLabel.includes('apertura') ||
          ariaLabel.includes('オープニング') || ariaLabel.includes('오프닝') || ariaLabel.includes('片头')) return 'intro';
      if (ariaLabel.includes('recap') || ariaLabel.includes('previously') || ariaLabel.includes('zusammenfassung')) return 'recap';
      if (creditsPatterns.some(p => ariaLabel.includes(p))) return 'credits';
      if (ariaLabel.includes('ad') || ariaLabel.includes('anzeige') || ariaLabel.includes('werbung')) return 'ads';
      return 'unknown-skip';
    }
    
    // Also check aria-label for opening/intro without "skip" text
    if (ariaLabel) {
      if (ariaLabel.includes('intro') || ariaLabel.includes('opening') || ariaLabel.includes('vorspann') ||
          ariaLabel.includes('abertura') || ariaLabel.includes('générique') || ariaLabel.includes('apertura') ||
          ariaLabel.includes('オープニング') || ariaLabel.includes('오프닝') || ariaLabel.includes('片头')) return 'intro';
      if (ariaLabel.includes('recap') || ariaLabel.includes('previously') || ariaLabel.includes('zusammenfassung') ||
          ariaLabel.includes('rückblick') || ariaLabel.includes('zuvor')) return 'recap';
      if (creditsPatterns.some(p => ariaLabel.includes(p))) return 'credits';
    }
    
    return 'unknown';
  }
  
  /** Text/aria-only classifier as a secondary pass - Multi-language support */
  getButtonTypeFromText(button) {
    const text = (button.textContent || '').toLowerCase();
    const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
    const combinedText = text + ' ' + ariaLabel;

    // Multi-language intro patterns
    // English, German, Spanish, French, Portuguese, Italian, Dutch, Polish, Russian, Japanese, Korean, Chinese
    if (/intro|opening|vorspann|abertura|générique|apertura|オープニング|오프닝|片头/.test(combinedText)) {
      return 'intro';
    }
    
    // Multi-language recap patterns
    if (/recap|previously|zuvor|rückblick|zusammenfassung|resumen|résumé|resumo|riepilogo|samenvatting|podsumowanie|要約|요약|回顾/.test(combinedText)) {
      return 'recap';
    }
    
    // Multi-language credits/ending patterns
    if (/credits|abspann|ending|outro|créditos|crédits|crediti|aftiteling|napisy końcowe|титры|クレジット|크레딧|片尾/.test(combinedText)) {
      // Make sure it's not a "Watch Credits" button
      if (/watch|ansehen|schaue|ver|voir|guarda|assistir|bekijken|oglądać|смотреть|見る|시청|观看/.test(combinedText)) {
        return 'watch-credits';
      }
      return 'credits';
    }
    
    // Multi-language ad patterns
    if (/ad|anzeige|werbung|commercial|anuncio|publicité|pubblicit|anúncio|advertentie|reklama|реклама|広告|광고|广告/.test(combinedText)) {
      return 'ads';
    }
    
    // Multi-language next episode patterns
    if (/next|nächste|continue|weiter|fortsetzen|siguiente|próximo|suivant|prossimo|próximo|volgende|następny|следующий|次|다음|下一个/.test(combinedText)) {
      return 'next';
    }
    
    // Multi-language skip patterns
    if (/skip|überspringen|vorspulen|pular|saltar|passer|salta|overslaan|pomiń|пропустить|スキップ|건너뛰기|跳过/.test(combinedText)) {
      // Try to infer type from context
      if (/intro|opening|vorspann|abertura|générique|オープニング/.test(combinedText)) return 'intro';
      if (/credits|abspann|ending|créditos|クレジット|片尾/.test(combinedText)) return 'credits';
      if (/recap|previously|zusammenfassung|resumen|résumé|要約/.test(combinedText)) return 'recap';
      // Default to generic skip (treat as ads)
      return 'unknown-skip';
    }
    
    return 'unknown';
  }
  
  /** Decide whether a classified button type should be auto-clicked. */
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
  
  /** Detect platform auto-advance overlays and drive them with a countdown. */
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
          // show cancelable countdown then click
          this.showAutoNextCountdown(5, () => {
            if (this.isButtonClickable(nextButton)) {
              this.clickButton(nextButton, `auto-advance popup (${selector})`);
            } else {
              this.findAndClickNext();
            }
          });
          return;
        }
      }
    }
  }

  // Placeholder methods that would be implemented
  /** Detect page language (placeholder hooking to richer logic if needed). */
  detectPageLanguage() {
    return 'de';
  }

  /** Provide platform-agnostic selector patterns, kept narrow to player area. */
  generateButtonPatterns() {
    // Narrower, player-scoped selectors to reduce false positives.
    return {
      selectors: [
        '[data-uia*="skip"]',
        '[data-uia*="next"]',
        // Explicit recap/intro patterns to improve reliability on Netflix and others
        '[data-uia*="recap"]',
        '[data-uia*="previously"]',
        '[data-uia="player-skip-recap"]',
        '[data-uia="player-skip-intro"]',
        'button[class*="skip-recap"], [class*="skip-recap"]',
        'button[aria-label*="Recap"], button[aria-label*="Previously"], [aria-label*="Recap"], [aria-label*="Previously"]',
        '[data-testid*="skip"]',
        '[data-testid="skipIntro"]',
        // Crunchyroll: Direct selector for skip intro button
        '[data-testid="skipIntroText"]',
        '[aria-label*="Opening"][role="button"]',
        '[aria-label*="opening"][role="button"]',
        '[aria-label*="Skip"][role="button"]',
        '[aria-label*="skip"][role="button"]',
        '[aria-label*="überspringen"][role="button"]',
        '[aria-label*="Überspringen"][role="button"]',
        'button:has([data-testid="skipIntroText"])',
        'button:has([data-testid*="skip"])',
        '[role="button"]:has([data-testid="skipIntroText"])',
        '[data-qa*="skip"]',
        // Amazon Prime Video specific selectors
        '.atvwebplayersdk-skipelement-button',
        'button.atvwebplayersdk-skipelement-button',
        '[class*="atvwebplayersdk-skipelement"]',
        // Crunchyroll-specific selectors
        '[class*="skip-button"]',
        '[class*="skipButton"]',
        'button[class*="chromeless-button"]',
        '.static-button',
        'button[class*="erc-"]',
        // Generic skip/next buttons
        'button[class*="skip"], button[class*="Skip"], .skip-button, .skipBtn, .skip',
        'button[class*="next"], .next-button, .nextBtn, .player-controls button',
        // generic player wrappers
        '.player .skip-button, .player .next-button, .video-player .skip-button'
      ]
    };
  }

  /** Enable/disable verbose logging */
  setVerboseLogging(enabled) {
    this.verboseLogging = enabled;
  }

  /** Check if button is visible and clickable */
  isButtonClickable(button) {
    try {
      if (!button) return false;

      // Basic checks
      if (button.disabled) return false;

      const style = window.getComputedStyle(button);
      if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
      
      // Check opacity - must be reasonably visible (> 0.1)
      const opacity = parseFloat(style.opacity || '1');
      if (opacity < 0.1) return false;

      // Must have some layout size and be in the viewport
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (rect.bottom <= 0 || rect.top >= (window.innerHeight || document.documentElement.clientHeight)) return false;

      // offsetParent null indicates not displayed in many browsers, keep as fallback
      if (button.offsetParent === null && style.position !== 'fixed') return false;

      return true;
    } catch (e) {
      return false;
    }
  }

  /** Additional safety checks (avoid navigation links, verify control elements) */
  shouldClickButton(button) {
    // Don't click plain links that navigate away unless they are clearly skip/next controls
    try {
      if (!this.isButtonClickable(button)) return false;

      const tag = (button.tagName || '').toLowerCase();
      const href = button.getAttribute && button.getAttribute('href');
      const hasOnclick = !!(button.getAttribute && button.getAttribute('onclick'));

      // If it's a link without an onclick handler and it would navigate away, avoid clicking it
      if (tag === 'a' && href && !hasOnclick) {
        // allow anchors that are fragment links or javascript pseudo-links
        if (!href.startsWith('#') && !href.startsWith('javascript:')) {
          return false;
        }
      }

      // If the button text/aria doesn't indicate a skip/next/credits/ad, require explicit data attributes
      const text = (button.textContent || button.getAttribute && button.getAttribute('aria-label') || '').toLowerCase();
      const dataAttrs = (button.getAttribute && (
        button.getAttribute('data-uia') || button.getAttribute('data-testid') || button.getAttribute('data-qa') || button.getAttribute('data-automation-id')
      ) || '').toLowerCase();

      // Multi-language patterns for skip/next/credits buttons
      // Covers: English, German, Spanish, French, Portuguese, Italian, Dutch, Polish, Russian, Japanese, Korean, Chinese
      const skipPatterns = /skip|intro|opening|recap|previously|credits|abspann|ad|werbung|next|weiter|continue|nächste|fortsetzen|überspringen|vorspulen|ending|outro|pular|saltar|passer|salta|overslaan|pomiń|пропустить|スキップ|건너뛰기|跳过|vorspann|abertura|générique|apertura|オープニング|오프닝|片头|zuvor|rückblick|zusammenfassung|resumen|résumé|resumo|riepilogo|samenvatting|podsumowanie|要約|요약|回顾|créditos|crédits|crediti|aftiteling|napisy końcowe|титры|クレジット|크레딧|片尾|anzeige|anuncio|publicité|pubblicit|anúncio|advertentie|reklama|реклама|広告|광고|广告|siguiente|próximo|suivant|prossimo|volgende|następny|следующий|次|다음|下一个/i;
      const looksLikeControl = skipPatterns.test(text + ' ' + dataAttrs);

      if (looksLikeControl) return true;

      // Allow clicking if element explicitly contains skip/next attributes even when text isn't present
      if (dataAttrs && /(skip|next|postplay|autoplay|postplay)/.test(dataAttrs)) return true;

      // As a last resort, require proximity to a video element to reduce false positives
      const nearVideo = !!(button.closest && (button.closest('.player') || button.closest('.video-player') || button.closest('[data-uia*="player"]')));
      if (nearVideo) return true;

      // also check if a video exists nearby (within document) and the button is inside a container that also contains a video
      let ancestor = button.parentElement;
      let levels = 0;
      while (ancestor && levels < 4) {
        if (ancestor.querySelector && ancestor.querySelector('video')) {
          return true;
        }
        ancestor = ancestor.parentElement;
        levels++;
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  shouldClickBasedOnTiming(button) {
    // For Netflix: Only click "Next Episode" if it's in the post-play UI, not the control bar
    if (window.location.hostname.includes('netflix.com')) {
      const buttonDataUia = button.getAttribute('data-uia');
      
      // Explicitly block control bar next buttons
      const isControlBarNext = buttonDataUia === 'control-next';
      if (isControlBarNext) {
        return false; // Never click the control bar next button
      }
      
      // Check if button is in post-play container
      const isInPostPlay = button.closest('[data-uia*="postplay"]') || 
                          button.closest('.postplay') ||
                          button.closest('[class*="PostPlay"]') ||
                          button.closest('[class*="post-play"]');
      
      // If it has next-episode data attribute, it's the post-play button
      const hasNextEpisodeAttr = buttonDataUia === 'next-episode-seamless-button';
      
      if (hasNextEpisodeAttr) {
        return true;
      }
      
      // Don't click if it's in the control bar
      const isInControls = button.closest('.watch-video--bottom-controls-container') ||
                          button.closest('[class*="PlayerControls"]') ||
                          button.closest('.PlayerControls') ||
                          button.closest('[class*="controls"]');
      
      if (isInControls && !isInPostPlay && !hasNextEpisodeAttr) {
        return false; // Don't click control bar buttons
      }
      
      // Only click if in post-play or has the specific next-episode attribute
      return isInPostPlay || hasNextEpisodeAttr;
    }
    
    return true;
  }

  /** Click button safely and send telemetry to background */
  clickButton(button, reason) {
    if (!button || !this.isButtonClickable(button)) return;
    
    this.lastClickTime = Date.now();
    
    try {
      button.click();
      
      this.safeRuntimeSendMessage({
        action: 'buttonClicked',
        buttonText: button.textContent || button.getAttribute('aria-label') || 'Unknown',
        domain: this.domain,
        reason: reason
      });
    } catch (error) {
      // Silent fail
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    try {
      if (!window.videoPlayerSkipper || !(window.videoPlayerSkipper instanceof VideoPlayerSkipper)) {
        window.videoPlayerSkipper = new VideoPlayerSkipper();
      }
    } catch (error) {
      console.error('[Skipper] Failed to initialize:', error);
    }
  });
} else {
  try {
    if (!window.videoPlayerSkipper || !(window.videoPlayerSkipper instanceof VideoPlayerSkipper)) {
      window.videoPlayerSkipper = new VideoPlayerSkipper();
    }
  } catch (error) {
    console.error('[Skipper] Failed to initialize:', error);
  }
}
