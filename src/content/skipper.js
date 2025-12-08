/**
 * VideoPlayerSkipper (Content Script)
 * - Detects current series/episode and auto-clicks Skip/Next controls
 * - Renders a lightweight, draggable HUD with compact/advanced modes
 * - Minimizes interference by scoping actions to the player container
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
  // HUD and countdown state
  this.hud = null;
  this.hudStyleEl = null;
  this.hudDragging = false;
  this.hudDragOffset = { x: 0, y: 0 };
  this.autoNextTimeoutId = null;
  this.countdownOverlay = null;
  // HUD visibility state
  this.hudHideTimeoutId = null;
  this.hudHideDelay = 2500;
  this.hudBoundContainer = null;
  this.hudInteracting = false;
  this.hudUserMoved = false;
    
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

    // Swallow noisy rejections when the extension reloads and invalidates the context
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
   * Safely send a runtime message without throwing if extension context is invalidated
   * (e.g., during reload/navigation) or when no receiver is present.
   */
  safeRuntimeSendMessage(message) {
    try {
      if (!this.isExtensionContextValid() || !chrome.runtime.sendMessage) return;
      const ret = chrome.runtime.sendMessage(message);
      // If Promise-like (Firefox/Chromium MV3), swallow rejections
      if (ret && typeof ret.then === 'function') {
        ret.catch(() => {});
      }
    } catch (e) {
      // ignore
    }
  }

  /** Check whether the extension context is still valid (not reloaded). */
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
  /** Initialization pipeline: detect language, load settings, wire observers, start. */
  async init() {
    // CRITICAL: Don't initialize in iframe contexts - only in main page
    const url = window.location.href;
    const isIframeContext = url.includes('player.html') || 
                           url.includes('sw_iframe') ||
                           url.includes('service_worker') ||
                           url.includes('metrics.crunchyroll.com') ||
                           url.includes('static.crunchyroll.com') ||
                           window.self !== window.top;
    
    if (isIframeContext) {
      console.log('[Skipper] 🚫 SKIPPING INITIALIZATION - running in iframe/worker context:', url);
      return; // Don't initialize anything in iframes
    }
    
    console.log('[Skipper] ✅ INITIALIZING - main page context:', url);
    
    // Initialization proceeds regardless of built-in supported platforms; actual enablement is controlled by settings
    
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
  
  /** Load settings from storage with multi-layer fallbacks and set enable flags. */
  async loadSettings() {
    try {
      if (!this.isExtensionContextValid()) return;
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

  /** React to storage updates and hot-apply HUD enable/disable and runtime flags. */
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

        // Reflect HUD visibility changes live
        const nextHudEnabled = this.isHudEnabled();
        if (nextHudEnabled && !this.hud) {
          this.ensureHUD();
        } else if (!nextHudEnabled && this.hud) {
          this.destroyHUD();
        }
      }
    }
  }
  
  /** Setup series detection loops and observers. */
  startSeriesDetection() {
    this.detectCurrentSeries();
    
    this.lastUrl = window.location.href;
    
    this.updateSeriesCheckInterval();
    
    this.setupUrlChangeDetection();
    this.setupContentChangeDetection();
    this.setupButtonClickDetection();
    this.setupVideoEventDetection();
  }
  
  /** Adjust series detection frequency based on current context. */
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
  
  /** Hook into SPA navigation APIs to re-detect series on URL changes. */
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
  
  /** Observe DOM mutations for title/series indicators and debounce detection. */
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
  
  /** Heuristics: user clicks suggesting series change trigger re-detection. */
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
  
  /** Listen to <video> lifecycle events to time series detection accurately. */
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
  
  /** Re-evaluate series when URL transitions occur, with gentle delay. */
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
  
  /** Coarse filter to distinguish content pages from browse/home. */
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
   * Core series detection orchestrator.
   * Uses lightweight hashing to skip redundant runs and defers to domain-specific extractors.
   */
  detectCurrentSeries() {
    const now = Date.now();
    if (this.verboseLogging) {
      try {
        console.log('[Skipper] detectCurrentSeries called', { url: window.location.href, lastUrl: this.lastUrl, currentSeries: this.currentSeries });
      } catch (e) {}
    }
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
    if (this.verboseLogging) {
      try {
        console.log('[Skipper] extractSeriesInfo =>', newSeries);
      } catch (e) {}
    }
    
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
        if (this.verboseLogging) {
          console.log('[Skipper] Crunchyroll watch page/iframe but no series extracted - keeping current:', this.currentSeries);
        }
        return;
      }
      
      if (!isOnVideoPage && !isOnTitlePage) {
        seriesChanged = true;
      } else if (isOnTitlePage && this.currentSeries) {
        seriesChanged = true;
      } else if (isOnVideoPage) {
        // On video page but couldn't extract info - keep current series for now
        // But log this for debugging
        if (this.verboseLogging) {
          console.log('[Skipper] Video page but no series extracted - keeping current:', this.currentSeries);
        }
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
          if (this.verboseLogging) {
            console.log('[Skipper] Ignoring suspicious title change:', {
              from: this.currentSeries.title,
              to: newSeries.title,
              reason: 'appears to be generic/player element'
            });
          }
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
        if (this.verboseLogging) {
          console.log('[Skipper] Series change detected:', {
            titleChanged,
            episodeChanged,
            sourceChanged,
            old: this.currentSeries,
            new: newSeries
          });
        }
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
        if (this.verboseLogging) {
          console.log('[Skipper] Crunchyroll: refusing to clear series on watch page');
        }
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

  /** Dispatch to domain extractors or generic fallback. */
  extractSeriesInfo() {
    const domain = this.domain;

    try {
      if (this.verboseLogging) {
        console.log('[Skipper] extractSeriesInfo for domain', domain);
      }

      if (domain.includes('netflix.com')) {
        if (this.verboseLogging) console.log('[Skipper] using Netflix extractor');
        return this.extractNetflixSeries();
      } else if (domain.includes('disneyplus.com') || domain.includes('disney.com')) {
        if (this.verboseLogging) console.log('[Skipper] using Disney+ extractor');
        return this.extractDisneyPlusSeries();
      } else if (domain.includes('primevideo.com') || domain.includes('amazon.')) {
        if (this.verboseLogging) console.log('[Skipper] using Prime Video extractor');
        return this.extractPrimeVideoSeries();
      } else if (domain.includes('youtube.com')) {
        if (this.verboseLogging) console.log('[Skipper] using YouTube extractor');
        return this.extractYouTubeSeries();
      } else if (domain.includes('crunchyroll.com')) {
        if (this.verboseLogging) console.log('[Skipper] using Crunchyroll extractor');
        return this.extractCrunchyrollSeries();
      } else if (domain.includes('apple.com')) {
        if (this.verboseLogging) console.log('[Skipper] using Apple TV extractor');
        return this.extractAppleTVSeries();
      } else {
        if (this.verboseLogging) console.log('[Skipper] using Generic extractor');
        return this.extractGenericSeries();
      }
    } catch (error) {
      if (this.verboseLogging) console.error('[Skipper] extractSeriesInfo error', error);
      return null;
    }
  }

  /** Netflix extractor: robust title/episode inference across pages. */
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

  /** YouTube extractor (treats single videos as a series-like unit). */
  extractYouTubeSeries() {
    let title = document.querySelector('#title h1')?.textContent?.trim();
    if (!title) title = document.querySelector('h1.ytd-video-primary-info-renderer')?.textContent?.trim();
    if (!title) title = document.title?.replace(' - YouTube', '').trim();
    
    if (title) {
      return { title, episode: 'video', source: 'youtube' };
    }
    return null;
  }

  /** Crunchyroll extractor. */
  extractCrunchyrollSeries() {
    try {
      console.log('[Skipper] extractCrunchyrollSeries - attempting selectors on URL:', window.location.href);

      // CRITICAL: Don't run extraction on iframe contexts (player.html, service worker, etc.)
      // These will never have the series metadata and would incorrectly return null
      const url = window.location.href;
      if (url.includes('player.html') || 
          url.includes('sw_iframe.html') || 
          url.includes('service_worker') ||
          url.includes('metrics.crunchyroll.com')) {
        console.log('[Skipper] Skipping Crunchyroll extraction - running in iframe/worker context');
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
      console.log('[Skipper] Trying', titleSelectors.length, 'title selectors...');
      
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        console.log('[Skipper] Selector:', sel, '=> Element:', el ? 'FOUND' : 'null', el?.textContent?.substring(0, 50));
        
        if (el && el.textContent && el.textContent.trim().length > 1) {
          const candidate = el.textContent.trim();
          const candidateLower = candidate.toLowerCase();
          
          // Skip if it's a generic/invalid title
          if (!invalidTitles.some(inv => candidateLower === inv || candidateLower.includes(inv))) {
            title = candidate;
            console.log('[Skipper] ✓ FOUND TITLE from', sel, ':', title);
            break;
          } else {
            console.log('[Skipper] ✗ Skipping generic title from', sel, ':', candidate);
          }
        }
      }

      // If we didn't find a valid title, return null immediately
      if (!title) {
        console.log('[Skipper] ✗ NO VALID TITLE FOUND - returning null');
        return null;
      }
      
      console.log('[Skipper] Using title:', title);

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
      
      console.log('[Skipper] Trying', episodeSelectors.length, 'episode selectors...');
      
      for (const sel of episodeSelectors) {
        const el = document.querySelector(sel);
        console.log('[Skipper] Episode selector:', sel, '=> Element:', el ? 'FOUND' : 'null', el?.textContent?.substring(0, 50));
        
        if (el && el.textContent && el.textContent.trim().length > 0) {
          let text = el.textContent.trim();
          
          // Remove the series title from the episode text if it's there
          if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
            text = text.substring(title.length).replace(/^[\s\-–—|:]+/, '').trim();
          }
          
          console.log('[Skipper] Episode candidate text:', text);
          
          // Try to extract episode number and title
          const episodePattern = /^(?:E|Episode|Ep\.?|Folge)\s*(\d+)(?:\s*[-–—|:]\s*(.+))?$/i;
          const seasonEpisodePattern = /^S(\d+)\s*E(\d+)(?:\s*[-–—|:]\s*(.+))?$/i;
          const simpleNumberPattern = /^(\d+)(?:\s*[-–—|:]\s*(.+))?$/;
          
          let match = text.match(episodePattern);
          if (match) {
            episode = `E${match[1]}`;
            episodeTitle = match[2]?.trim() || null;
            console.log('[Skipper] ✓ Parsed episode (pattern 1):', episode, episodeTitle);
            break;
          }
          
          match = text.match(seasonEpisodePattern);
          if (match) {
            episode = `S${match[1]}E${match[2]}`;
            episodeTitle = match[3]?.trim() || null;
            console.log('[Skipper] ✓ Parsed episode (season pattern):', episode, episodeTitle);
            break;
          }
          
          match = text.match(simpleNumberPattern);
          if (match && text.length < 150) {
            episode = `E${match[1]}`;
            episodeTitle = match[2]?.trim() || null;
            console.log('[Skipper] ✓ Parsed episode (simple number):', episode, episodeTitle);
            break;
          }
          
          // If none of the patterns match but text looks reasonable, use it as-is
          if (text.length < 150 && text.length > 0) {
            episode = text;
            console.log('[Skipper] ✓ Using full text as episode:', episode);
            break;
          }
        }
      }
      
      // Combine episode number and title if we have both
      if (episode && episodeTitle) {
        episode = `${episode} - ${episodeTitle}`;
      }

      console.log('[Skipper] Final episode value:', episode || 'unknown');

      // Clean title if it contains episode info
      if (title) {
        const originalTitle = title;
        title = title.replace(/\s*[-–—|]\s*(?:Episode|Ep|Folge|E)\.?\s*\d+.*$/i, '').trim();
        title = title.replace(/\s*\|\s*Crunchyroll.*$/i, '').trim();
        title = title.replace(/\s*[-–—|]\s*S\d+E\d+.*$/i, '').trim();
        if (originalTitle !== title) {
          console.log('[Skipper] Cleaned title from:', originalTitle, 'to:', title);
        }
      }

      if (title) {
        const result = { title, episode: episode || 'unknown', source: 'crunchyroll' };
        console.log('[Skipper] ✓ CRUNCHYROLL SERIES DETECTED:', result);
        return result;
      }
    } catch (error) {
      console.error('[Skipper] ✗ extractCrunchyrollSeries ERROR:', error);
    }
    console.log('[Skipper] ✗ extractCrunchyrollSeries returning null');
    return null;
  }

  /** Apple TV+ extractor. */
  extractAppleTVSeries() {
    let title = document.querySelector('.product-header__title')?.textContent?.trim();
    if (!title) title = document.title?.replace(' - Apple TV+', '').trim();
    
    let episode = document.querySelector('.episode-title')?.textContent?.trim();
    
    if (title) {
      return { title, episode: episode || 'unknown', source: 'appletv' };
    }
    return null;
  }

  /** Fallback extractor using document/title heuristics. */
  extractGenericSeries() {
    let title = document.querySelector('h1')?.textContent?.trim();
    if (!title) title = document.title?.split(' - ')[0]?.trim();
    
    if (title) {
      return { title, episode: 'unknown', source: 'generic' };
    }
    return null;
  }

  /** Persist current settings back to storage (sync → local fallback). */
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

  /** Handle messages from popup/background (detect, update settings, ping, etc.). */
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

    if (typeof this.detectCurrentSeries === 'function') {
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
    
    const now = Date.now();
    if (now - this.lastClickTime < this.clickCooldown) {
      return;
    }
    
    // Limit scanning to the video/player area to avoid touching large sidebars (e.g., YouTube recommendations)
    const container = this.getPlayerContainer();
    if (!container) return;

    const seriesSettings = this.getCurrentSeriesSettings();
    
    let clicked = false;
    for (const selector of this.buttonPatterns.selectors) {
      const buttons = container.querySelectorAll(selector);
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

  // Try to scope queries to the actual player container to avoid touching sidebars (e.g., YouTube #secondary)
  /** Try to scope actions to the most likely player container. */
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
  
  /** Gather effective per-series settings (with defaults). */
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
  
  /** Classify a button by selector and textual/aria cues into intro/recap/credits/ads/next. */
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
      if (text.includes('recap') || text.includes('previously') || text.includes('zuvor') || text.includes('zusammenfassung') || text.includes('rückblick')) return 'recap';
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
  
  /** Text/aria-only classifier as a secondary pass. */
  getButtonTypeFromText(button) {
    const text = (button.textContent || button.getAttribute('aria-label') || '').toLowerCase();

    // Intro patterns (English + German)
    if (/intro|opening|vorspann/.test(text)) return 'intro';
    
    // Recap patterns (English + German)
    if (/recap|previously|zuvor|rückblick/.test(text)) return 'recap';
    
    // Credits/Ending patterns (English + German)
    // "Credits Überspringen", "Abspann überspringen", "Skip Credits", "Skip Ending"
    if (/credits|abspann|ending|outro/.test(text)) {
      // Make sure it's not a "Watch Credits" or similar button
      if (/watch|ansehen|schaue/.test(text)) return 'watch-credits';
      return 'credits';
    }
    
    // Ad patterns (English + German)
    if (/ad|anzeige|werbung|commercial/.test(text)) return 'ads';
    
    // Next episode patterns (English + German)
    if (/next|nächste|continue|weiter|fortsetzen/.test(text)) return 'next';
    
    // Generic skip pattern (catches "Überspringen", "Skip", etc.)
    if (/skip|überspringen|vorspulen/.test(text)) {
      // Try to infer type from context
      if (/intro|opening/.test(text)) return 'intro';
      if (/credits|abspann|ending/.test(text)) return 'credits';
      if (/recap|previously/.test(text)) return 'recap';
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

  /** Enable/disable verbose logging dynamically. */
  setVerboseLogging(enabled) {
    this.verboseLogging = enabled;
  }

  /** Visibility/viewport checks to ensure the button is actionable. */
  isButtonClickable(button) {
    try {
      if (!button) return false;

      // Basic checks
      if (button.disabled) return false;

      const style = window.getComputedStyle(button);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;

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

  /** Additional safety checks to avoid navigating links or non-control elements. */
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
      const skipPatterns = /skip|intro|opening|recap|previously|credits|abspann|ad|werbung|next|weiter|continue|nächste|fortsetzen|überspringen|vorspulen|ending|outro/i;
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
    return true;
  }

  /** Click the element safely and log the action via background for telemetry. */
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
        console.log('[Skipper] Initialized on DOMContentLoaded');
      }
    } catch (error) {
      console.error('[Skipper] Failed to initialize:', error);
    }
  });
} else {
  try {
    if (!window.videoPlayerSkipper || !(window.videoPlayerSkipper instanceof VideoPlayerSkipper)) {
      window.videoPlayerSkipper = new VideoPlayerSkipper();
      console.log('[Skipper] Initialized immediately');
    }
  } catch (error) {
    console.error('[Skipper] Failed to initialize:', error);
  }
}
