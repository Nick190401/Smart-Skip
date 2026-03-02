'use strict';

// DOM refs
const $ = id => document.getElementById(id);

const el = {
  domain:        $('domain-label'),
  aiBadge:       $('ai-badge'),
  statusDot:     $('status-dot'),
  seriesCard:    $('series-card'),
  seriesTitle:   $('series-title'),
  seriesEpisode: $('series-episode'),
  lastAction:    $('last-action'),
  lastActionType:$('last-action-type'),
  globalEnabled:  $('globalEnabled'),
  hudEnabled:     $('hudEnabled'),
  badgeEnabled:   $('badgeEnabled'),
  cloudSync:      $('cloudSync'),
  domainEnabled:  $('domainEnabled'),
  domainRowDesc:  $('domain-row-desc'),
  deleteDataRow:       $('delete-data-row'),
  btnDeleteData:       $('btn-delete-data'),
  deleteConfirmOverlay: $('delete-confirm-overlay'),
  btnDeleteCancel:     $('btn-delete-cancel'),
  btnDeleteConfirm:    $('btn-delete-confirm'),
  // Series-level
  skipIntro:     $('skipIntro'),
  skipRecap:     $('skipRecap'),
  skipCredits:   $('skipCredits'),
  skipAds:       $('skipAds'),
  autoNext:      $('autoNext'),
  // Episode-level overrides
  epSection:     $('episode-section'),
  epLabel:       $('episode-settings-label'),
  epNote:        $('ep-inherit-note'),
  epSkipIntro:   $('ep_skipIntro'),
  epSkipRecap:   $('ep_skipRecap'),
  epSkipCredits: $('ep_skipCredits'),
  epSkipAds:     $('ep_skipAds'),
  epAutoNext:    $('ep_autoNext'),
  btnEpReset:    $('btn-ep-reset'),
  btnSave:       null, // removed — auto-save on change
  toast:         $('toast'),
  seriesLabel:   $('series-settings-label'),
  btnResetDomain: $('btn-reset-domain'),
  btnScanNow:     $('btn-scan-now'),
  snoozeDesc:     $('snooze-desc'),
  statToday:      $('stat-today'),
};

// State
let settings     = null;
let currentSeries = null;
let currentDomain = '';
let _lastAiStatus = 'unavailable'; // stored so renderSettings can re-apply the dot

// Must stay in sync with BLOCKED_DOMAINS in content/skipper.js
const POPUP_BLOCKED_DOMAINS = new Set([
  'www.twitch.tv',
  'twitch.tv',
  'm.twitch.tv',
  'clips.twitch.tv',
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

const DEFAULTS = {
  globalEnabled: true,
  hudEnabled: true,
  badgeEnabled: true,
  domains: {},
  series: {},
};

const SERIES_DEFAULTS = {
  skipIntro: true, skipRecap: true, skipCredits: true, skipAds: true, autoNext: false,
};

// Init
(async function init() {
  // ── PHASE 0: i18n (must finish before any text is rendered) ──────────────
  await i18n.init();
  applyI18n();

  // ── PHASE 1: single parallel batch — tab query + all needed storage keys ─
  // This single await replaces ~7 sequential storage reads and a tab query,
  // so the popup renders from cache ~400 ms sooner on every open.
  const [[tab], cache] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get([
      'ss2', 'ss2_consent', 'ss2_stats', 'lastClick',
      'ss2_ai_status_cache', 'ss2_snooze', 'ss2_ai_banner_dismissed',
    ]),
  ]);

  // Domain
  if (tab?.url) {
    try { currentDomain = new URL(tab.url).hostname; } catch {}
  }
  el.domain.textContent = currentDomain || '—';

  // Consent overlay — data already in cache, no extra await needed
  const consentOverlay = document.getElementById('consent-overlay');
  const ss2_consent = cache.ss2_consent;
  if (!ss2_consent) {
    consentOverlay.style.display = 'flex';
    document.getElementById('btn-consent-yes').addEventListener('click', async () => {
      await chrome.storage.local.set({ ss2_consent: { sync: true, askedAt: Date.now() } });
      consentOverlay.style.display = 'none';
      if (el.cloudSync) el.cloudSync.checked = true;
    });
    document.getElementById('btn-consent-no').addEventListener('click', async () => {
      await chrome.storage.local.set({ ss2_consent: { sync: false, askedAt: Date.now() } });
      consentOverlay.style.display = 'none';
      if (el.cloudSync) el.cloudSync.checked = false;
    });
  } else {
    if (el.cloudSync) el.cloudSync.checked = ss2_consent.sync === true;
  }

  // Settings pre-render from cache — always initialize so renderSettings() never sees null
  settings = cache.ss2 ? { ...DEFAULTS, ...cache.ss2 } : { ...DEFAULTS };

  // Stats pre-render
  const skipStats = cache.ss2_stats || { totalSkipped: 0 };
  const statTotal = document.getElementById('stat-total');
  if (statTotal) statTotal.textContent = skipStats.totalSkipped || 0;
  const todayKey = new Date().toLocaleDateString('sv');
  const todayCount = skipStats.daily?.[todayKey] || 0;
  if (el.statToday) el.statToday.textContent = todayCount;

  // Last skip type + relative time
  const lastClick = cache.lastClick;
  const statLastType = document.getElementById('stat-last-type');
  const statLastTime = document.getElementById('stat-last-time');
  const typeLabels = {
    intro:   i18n.t('hudIntro'),
    recap:   i18n.t('hudRecap'),
    credits: i18n.t('hudCredits'),
    ads:     i18n.t('hudAds'),
    next:    i18n.t('hudNext'),
  };
  if (lastClick?.buttonType) {
    if (statLastType) statLastType.textContent = typeLabels[lastClick.buttonType] || lastClick.buttonType;
    if (statLastTime && lastClick.ts) {
      const diff = Math.round((Date.now() - lastClick.ts) / 60000);
      statLastTime.textContent = diff < 2 ? i18n.t('justNow') : diff < 60 ? i18n.t('agoMinutes').replace('{n}', diff) : i18n.t('agoHours').replace('{n}', Math.round(diff/60));
    }
    el.lastActionType.textContent = typeLabels[lastClick.buttonType] || lastClick.buttonType;
    el.lastAction.style.display = 'flex';
  }

  // AI badge — use cached status for instant display (no flicker)
  _lastAiStatus = cache.ss2_ai_status_cache || 'unavailable';
  updateAIBadge(_lastAiStatus);

  // Snooze — already in cache batch
  _renderSnoozeState(cache.ss2_snooze);

  // ── PHASE 2: first full render from cache ─────────────────────────────────
  renderSettings();
  updateAIBadge(_lastAiStatus); // re-apply after renderSettings (may set is-unsupported)

  // ── PHASE 3: series from per-tab cache (needs tab.id, one focused read) ──
  if (tab?.id) {
    try {
      const tabSeriesKey = `ss2_series_${tab.id}`;
      const seriesEntry = (await chrome.storage.local.get(tabSeriesKey))[tabSeriesKey];
      if (seriesEntry?.series?.title) applySeriesInfo(seriesEntry.series);
    } catch {}
  }

  // ── Live series update listeners ──────────────────────────────────────────
  // Registered after currentDomain is set so the domain check is valid.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'seriesDetected') {
      applySeriesInfo(msg.series);
      renderSettings();
    }
  });
  // Watch storage for the per-tab series cache — catches the race where the
  // popup opened before the content script finished detecting the series.
  if (tab?.id) {
    const watchKey = `ss2_series_${tab.id}`;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const entry = changes[watchKey]?.newValue;
      if (entry?.series?.title) { applySeriesInfo(entry.series); renderSettings(); }
    });
  }

  // ── AI banner setup (wiring + initial visibility from cache) ─────────────
  const aiBanner        = document.getElementById('ai-banner');
  const aiBannerHead    = document.getElementById('ai-banner-head');
  const aiBannerDismiss = document.getElementById('ai-banner-dismiss');

  async function _initAIBanner(status) {
    const { ss2_ai_banner_dismissed } = await chrome.storage.local.get('ss2_ai_banner_dismissed');
    const aiOk = _aiStatusOk(status);
    if (aiOk || ss2_ai_banner_dismissed) { if (aiBanner) aiBanner.style.display = 'none'; return; }
    if (aiBanner) aiBanner.style.display = 'block';
  }
  if (aiBannerHead) aiBannerHead.addEventListener('click', () => aiBanner?.classList.toggle('open'));
  if (aiBannerDismiss) {
    aiBannerDismiss.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.storage.local.set({ ss2_ai_banner_dismissed: true });
      if (aiBanner) aiBanner.style.display = 'none';
    });
  }
  document.querySelectorAll('.ai-step-copy').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = btn.dataset.copy;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = i18n.t('copied');
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = i18n.t('copy'); btn.classList.remove('copied'); }, 2000);
      } catch {}
    });
  });
  // Show banner based on cached AI status immediately; real status will update it below
  _initAIBanner(_lastAiStatus);

  // ── Event listener wiring (no awaits needed) ──────────────────────────────

  // Auto-save on any toggle change
  const autoSaveIds = [
    'globalEnabled','hudEnabled','domainEnabled',
    'skipIntro','skipRecap','skipCredits','skipAds','autoNext',
    'ep_skipIntro','ep_skipRecap','ep_skipCredits','ep_skipAds','ep_autoNext',
  ];
  for (const id of autoSaveIds) {
    const input = document.getElementById(id);
    if (input) input.addEventListener('change', save);
  }

  // Cloud-Sync toggle — save consent choice immediately
  if (el.cloudSync) {
    el.cloudSync.addEventListener('change', async () => {
      const enabled = el.cloudSync.checked;
      const existing = (await chrome.storage.local.get('ss2_consent')).ss2_consent ?? {};
      await chrome.storage.local.set({ ss2_consent: { ...existing, sync: enabled } });
      // SyncService reacts automatically via chrome.storage.onChanged listener
      _updateDeleteDataRow(enabled);
    });
  }

  // Show delete-data action row only when cloud sync is on and a device-id exists
  async function _updateDeleteDataRow(syncOn) {
    if (!el.deleteDataRow) return;
    if (!syncOn) { el.deleteDataRow.style.display = 'none'; return; }
    const { ss2_device_id } = await chrome.storage.local.get('ss2_device_id');
    el.deleteDataRow.style.display = ss2_device_id ? 'block' : 'none';
  }
  _updateDeleteDataRow(el.cloudSync?.checked);

  // DSGVO Art. 17: delete all cloud data for this device
  if (el.btnDeleteData) {
    el.btnDeleteData.addEventListener('click', () => {
      if (el.deleteConfirmOverlay) el.deleteConfirmOverlay.style.display = 'flex';
    });
  }
  if (el.btnDeleteCancel) {
    el.btnDeleteCancel.addEventListener('click', () => {
      if (el.deleteConfirmOverlay) el.deleteConfirmOverlay.style.display = 'none';
    });
  }
  // Route through background SW so this works even on non-streaming pages
  if (el.btnDeleteConfirm) {
    el.btnDeleteConfirm.addEventListener('click', async () => {
      el.btnDeleteConfirm.disabled = true;
      el.btnDeleteConfirm.textContent = '…';
      try {
        const result = await chrome.runtime.sendMessage({ action: 'deleteMyData' });
        if (!result?.ok) throw new Error(result?.error || 'failed');
        if (el.deleteConfirmOverlay) el.deleteConfirmOverlay.style.display = 'none';
        if (el.deleteDataRow)  el.deleteDataRow.style.display = 'none';
        showToast(i18n.t('deleteMyDataDone') || 'Cloud-Daten gelöscht.');
      } catch (e) {
        el.btnDeleteConfirm.disabled = false;
        el.btnDeleteConfirm.textContent = i18n.t('deleteMyDataConfirmBtn') || 'Unwiderruflich löschen';
        showToast(i18n.t('deleteMyDataError') || 'Fehler beim Löschen.');
      }
    });
  }

  // Snooze state renderer (hoisted function declaration — used above in Phase 1)
  function _renderSnoozeState(ss2_snooze) {
    const until = ss2_snooze?.until ?? 0;
    const active = until > Date.now();
    if (el.snoozeDesc) {
      if (active) {
        const remaining = Math.ceil((until - Date.now()) / 60000);
        el.snoozeDesc.textContent = remaining < 60 ? i18n.t('snoozeRemainingMin').replace('{n}', remaining) : i18n.t('snoozeRemainingHour').replace('{n}', Math.ceil(remaining/60));
      } else {
        el.snoozeDesc.textContent = i18n.t('snoozeDescText');
      }
    }
    document.querySelectorAll('.btn-snooze').forEach(btn => {
      const mins = parseInt(btn.dataset.minutes);
      // When snoozed: only highlight the cancel (✕) button; time pills stay neutral
      // (we don't store which duration was chosen — only the expiry timestamp)
      btn.classList.toggle('active', active && mins === 0);
    });
  }

  // Domain reset — clears cached selectors for this domain + triggers rescan
  if (el.btnResetDomain) {
    el.btnResetDomain.addEventListener('click', async () => {
      el.btnResetDomain.classList.add('spinning');
      const { ss2_learn } = await chrome.storage.local.get('ss2_learn');
      if (ss2_learn) {
        if (ss2_learn.selectors) delete ss2_learn.selectors[currentDomain];
        // timings are keyed by seriesKey (domain:title) — must iterate
        if (ss2_learn.timings) {
          for (const k of Object.keys(ss2_learn.timings)) {
            if (k.startsWith(currentDomain + ':')) delete ss2_learn.timings[k];
          }
        }
        if (ss2_learn.feedback) {
          for (const k of Object.keys(ss2_learn.feedback)) {
            if (k.startsWith(currentDomain + ':')) delete ss2_learn.feedback[k];
          }
        }
        await chrome.storage.local.set({ ss2_learn });
      }
      try { await chrome.tabs.sendMessage(tab?.id, { action: 'scanNow' }); } catch {}
      setTimeout(() => el.btnResetDomain.classList.remove('spinning'), 550);
      showToast(i18n.t('domainCacheCleared'));
    });
  }

  // Scan-now — trigger immediate scan on active tab
  if (el.btnScanNow) {
    el.btnScanNow.addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(tab?.id, { action: 'scanNow' });
        showToast(i18n.t('scanStarted'));
      } catch {
        showToast(i18n.t('noPlayerFound'));
      }
    });
  }

  // Snooze pills
  document.querySelectorAll('.btn-snooze').forEach(btn => {
    btn.addEventListener('click', async () => {
      const minutes = parseInt(btn.dataset.minutes);
      await chrome.runtime.sendMessage({ action: 'snooze', minutes });
      const { ss2_snooze: updated } = await chrome.storage.local.get('ss2_snooze');
      _renderSnoozeState(updated);
      if (minutes > 0) {
        showToast(minutes < 60 ? i18n.t('snoozedForMin').replace('{n}', minutes) : i18n.t('snoozedForHour'));
      } else {
        showToast(i18n.t('snoozeCancelled'));
      }
    });
  });

  // Episode reset
  el.btnEpReset.addEventListener('click', async () => {
    const epKey = episodeKey();
    if (!epKey) return;
    if (!settings.episodes) settings.episodes = {};
    settings.episodes[epKey] = {};  // empty = inherit from series
    await sendMessage({ action: 'saveSettings', settings });
    renderEpisodeSection();
    showToast();
  });

  // Insights inspector
  const insDetails = document.getElementById('insights-details');
  insDetails.addEventListener('toggle', () => {
    if (insDetails.open) loadInsights();
  });
  document.getElementById('btn-refresh-insights')
    .addEventListener('click', loadInsights);
  document.getElementById('btn-clear-domain')
    .addEventListener('click', async () => {
      const { ss2_learn } = await chrome.storage.local.get('ss2_learn');
      if (ss2_learn) {
        if (ss2_learn.selectors) delete ss2_learn.selectors[currentDomain];
        if (ss2_learn.feedback) {
          for (const k of Object.keys(ss2_learn.feedback)) {
            if (k.startsWith(currentDomain + ':')) delete ss2_learn.feedback[k];
          }
        }
        await chrome.storage.local.set({ ss2_learn });
        loadInsights();
        showToast();
      }
    });

  // ── PHASE 4: fire-and-forget slow / network operations ───────────────────
  // These run after the UI is already rendered — they patch in fresh data
  // without blocking the popup from appearing.

  const extVersion = chrome.runtime.getManifest().version;

  // Fresh settings from background SW (replaces the cache-based pre-render)
  sendMessage({ action: 'getSettings' }).then(resp => {
    if (resp?.settings) { settings = { ...DEFAULTS, ...resp.settings }; renderSettings(); }
  }).catch(() => {});

  // Content script series fallback — fires only when tab series cache was empty
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'fetchSeries' })
      .then(csResp => { if (csResp?.series) { applySeriesInfo(csResp.series); renderSettings(); } })
      .catch(() => {});
  }

  // Real AI availability — update badge and persist for next popup open (no flicker)
  ssAI.availabilityStatus().then(aiStatus => {
    console.info('[SmartSkip] AI availability =', aiStatus);
    _lastAiStatus = aiStatus;
    updateAIBadge(aiStatus);
    chrome.storage.local.set({ ss2_ai_status_cache: aiStatus }).catch(() => {});
    _initAIBanner(aiStatus);
  }).catch(e => { console.error('[SmartSkip] AI status error:', e); });

  // Server config — broadcasts, version-gate, announcement (slow network call)
  (async () => {
    try {
      let broadcasts = null;
      try {
        const res = await fetch(self.SS2_CONFIG.apiBase, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-SS2-Key': self.SS2_CONFIG.apiKey },
          body:    JSON.stringify({ action: 'getConfig', version: extVersion }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.ok) {
            broadcasts = data.broadcasts;

            // Version-Gate banner
            if (data.version_ok === false) {
              const vg = document.getElementById('version-gate');
              const vgTitle = document.getElementById('version-gate-title');
              const vgSub   = document.getElementById('version-gate-sub');
              const vgLog   = document.getElementById('version-gate-changelog');
              const vgHead  = document.getElementById('version-gate-head');
              if (vg && vgTitle) {
                vgTitle.textContent = i18n.t('updateRequired');
                if (vgSub) vgSub.textContent = i18n.t('updateMinVersion').replace('{min}', data.min_ext_version || '?').replace('{cur}', extVersion);
                if (vgLog && data.changelog?.trim()) {
                  vgLog.textContent = data.changelog.trim();
                  vgHead.addEventListener('click', () => vg.classList.toggle('open'));
                } else {
                  document.getElementById('version-gate-chevron')?.remove();
                }
                vg.style.display = 'flex';
                // Block the whole popup UI
                document.body.classList.add('version-blocked');
              }
            }

            // Show announcement if set
            const announcementBar = document.getElementById('announcement-bar');
            if (announcementBar) {
              const txt = (data.announcement || '').trim();
              if (txt) {
                announcementBar.innerHTML =
                  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 4.01c-1 .49-1.98.689-3 .99-1.121-1.265-2.783-1.337-4.38-.491-1.597.845-2.32 2.78-1.62 4.491.075.204.074.423-.019.616C11.36 11.88 8.5 13 5 12c0 0 4 3 3 6l1.5.5C10 16.286 14 15 16.5 16c2.5 1 5.5-2.5 5.5-6 0-1.021-.225-1.99-.628-2.868A1.013 1.013 0 0 1 21.5 6C21.5 5 22 4.5 22 4.01z"/><path d="M3 15.5l-1.5 4.5"/></svg>
                  <span>${txt}</span>`;
                announcementBar.style.display = 'flex';
              }
            }

            // Show maintenance banner (graceful, non-blocking)
            const maintBanner = document.getElementById('maintenance-banner');
            if (maintBanner) {
              const maintMsg = (data.maintenance_message || '').trim();
              if (maintMsg) {
                let timeHtml = '';
                if (data.maintenance_scheduled?.trim()) {
                  try {
                    const d = new Date(data.maintenance_scheduled);
                    timeHtml = `<div class="maint-time">\uD83D\uDD50 ${d.toLocaleString('de-DE', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}</div>`;
                  } catch (_) {}
                }
                maintBanner.innerHTML =
                  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                  <div><div class="maint-msg">${maintMsg}</div>${timeHtml}</div>`;
                maintBanner.style.display = 'flex';
              }
            }

            // Show quick-actions bar
            const qaBar = document.getElementById('quick-actions-bar');
            if (qaBar && data.quick_actions?.length) {
              qaBar.innerHTML = data.quick_actions.map(qa =>
                `<a href="${qa.url}" target="_blank" rel="noopener"><span class="qa-icon">${qa.icon || '\uD83D\uDD17'}</span>${qa.label}</a>`
              ).join('');
              qaBar.style.display = 'flex';
            }

            // Refresh shared cache so sync-service benefits too
            await chrome.storage.local.set({ ss2_remote_config: { data, fetchedAt: Date.now() } });
          }
        }
      } catch (_) {
        // Offline — fall back to stale cache
        const { ss2_remote_config } = await chrome.storage.local.get('ss2_remote_config');
        broadcasts = ss2_remote_config?.data?.broadcasts;
      }
      if (broadcasts?.length) {
        const typeIcon = {
          info:    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8"/><polyline points="12 12 12 16"/></svg>`,
          success: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
          warning: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
          error:   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
        };
        const typeColor = { info: '#4f8ef7', success: '#34d399', warning: '#fbbf24', error: '#f87171' };
        const typeBg    = { info: 'rgba(79,142,247,.06)', success: 'rgba(52,211,153,.06)', warning: 'rgba(251,191,36,.06)', error: 'rgba(248,113,113,.06)' };
        const banner = document.getElementById('broadcast-banner');
        if (banner) {
          banner.innerHTML = broadcasts.map(bc => {
            const color = typeColor[bc.type] || typeColor.info;
            const bg    = typeBg[bc.type]    || typeBg.info;
            const iconHtml = bc.icon_override
              ? `<span style="font-size:14px;line-height:1">${bc.icon_override}</span>`
              : (typeIcon[bc.type] || typeIcon.info);
            const linkHtml = bc.link_url
              ? `<a class="bc-link" href="${bc.link_url}" target="_blank" rel="noopener" style="color:${color}">${bc.link_text?.trim() || i18n.t('broadcastMore')} \u2192</a>`
              : '';
            const dismissHtml = bc.dismissible
              ? `<button class="bc-dismiss" data-bc-id="${bc.id}">&times; ${i18n.t('broadcastDismiss')}</button>`
              : '';
            return `<div class="bc-item" style="border-left-color:${color};background:${bg}">
              <span class="bc-icon" style="color:${color}">${iconHtml}</span>
              <div class="bc-body">
                <div class="bc-title" style="color:${color}">${bc.title}</div>
                <div class="bc-text">${bc.body}</div>
                ${linkHtml}${dismissHtml}
              </div>
            </div>`;
          }).join('');
          // wire up dismiss buttons (in-session only, no persistence needed)
          banner.querySelectorAll('.bc-dismiss').forEach(btn => {
            btn.addEventListener('click', () => {
              btn.closest('.bc-item')?.remove();
              if (!banner.querySelector('.bc-item')) banner.style.display = 'none';
            });
          });
          banner.style.display = 'flex';
        }
      }
    } catch (_) {}
  })();
})();

// i18n: apply data-i18n attributes to DOM
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (key) el.textContent = i18n.t(key);
  });
  // button titles
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = i18n.t(key);
  });
  // placeholder for save button - removed (auto-save)
  //
}

// Insights Inspector
async function loadInsights() {
  const badge = document.getElementById('insights-badge');
  const body  = document.getElementById('insights-body');
  badge.textContent = i18n.t('insightsLoading');

  const { ss2_learn } = await chrome.storage.local.get('ss2_learn') || {};
  const learn = ss2_learn || {};

  const selData  = learn.selectors?.[currentDomain];
  const fbPrefix = currentDomain + ':';
  const fbItems  = Object.entries(learn.feedback  || {}).filter(([k]) => k.startsWith(fbPrefix));
  const timPrefix = currentDomain + ':';
  const timItems  = Object.entries(learn.timings  || {}).filter(([k]) => k.startsWith(timPrefix));

  const parts = [];
  let totalSelectors = 0;

  // Selektoren
  if (selData) {
    const rows = [];
    const score = selData.quality ?? 0;
    const scoreClass = score >= 0.75 ? 'score-high' : score >= 0.4 ? 'score-medium' : 'score-low';

    if (selData.seriesSelector) {
      rows.push(insRow('Serie', selData.seriesSelector, `Q ${(score*100).toFixed(0)}%`, scoreClass));
      totalSelectors++;
    }
    if (selData.episodeSelector) {
      rows.push(insRow('Episode', selData.episodeSelector, `Q ${(score*100).toFixed(0)}%`, scoreClass));
      totalSelectors++;
    }
    for (const s of (selData.skipSelectors || [])) {
      const sel = typeof s === 'string' ? s : s.selector;
      rows.push(insRow('Skip', sel, '', scoreClass));
      totalSelectors++;
    }
    if (rows.length) {
      parts.push(`<div class="insight-group"><h3>${i18n.t('insightsSelectors')}</h3>${rows.join('')}</div>`);
    }
  }

  // Feedback
  if (fbItems.length) {
    const rows = fbItems.map(([k, v]) => {
      const type     = k.slice(fbPrefix.length);
      const hitRate  = v.hits + v.misses > 0 ? Math.round(v.hits / (v.hits + v.misses) * 100) : 0;
      const sc       = hitRate >= 75 ? 'score-high' : hitRate >= 40 ? 'score-medium' : 'score-low';
      return insRow(type, v.selector || '—', `${v.hits}✓ ${v.misses}✗`, sc);
    });
    parts.push(`<div class="insight-group"><h3>${i18n.t('insightsFeedback')}</h3>${rows.join('')}</div>`);
  }

  // Timings
  if (timItems.length) {
    const rows = [];
    for (const [seriesKey, types] of timItems) {
      const seriesName = seriesKey.slice(timPrefix.length);
      for (const [type, bucket] of Object.entries(types)) {
        const times = Array.isArray(bucket) ? bucket : (bucket._local || []);
        if (!times.length) continue;
        const avg = (times.reduce((a,b) => a+b, 0) / times.length).toFixed(0);
        rows.push(insRow(`${seriesName} · ${type}`, `⌀ ${avg}s`, `${times.length} ${i18n.t('insightsDataPoints')}`, 'score-medium'));
      }
    }
    if (rows.length) {
      parts.push(`<div class="insight-group"><h3>${i18n.t('insightsTimings')}</h3>${rows.join('')}</div>`);
    }
  }

  body.innerHTML = parts.length
    ? parts.join('')
    : `<p class="insights-empty">${i18n.t('insightsEmpty')}</p>`;

  badge.textContent = totalSelectors ? `${totalSelectors} ${i18n.t('insightsSelectors')}` : fbItems.length ? `${fbItems.length} ${i18n.t('insightsFeedback')}` : '–';
}

function insRow(label, selector, meta, scoreClass) {
  const esc = s => s.replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<div class="insight-row">
    <div class="insight-score ${scoreClass}"></div>
    <span class="insight-meta" style="min-width:56px;color:var(--text)">${esc(label)}</span>
    <span class="insight-sel" title="${esc(selector)}">${esc(selector)}</span>
    ${meta ? `<span class="insight-meta">${esc(meta)}</span>` : ''}
  </div>`;
}

// Render
// Known streaming domains — used by the unsupported-site banner
// Must stay in sync with manifest.json content_scripts.matches
const STREAMING_DOMAINS = new Set([
  'www.netflix.com','netflix.com',
  'www.disneyplus.com','disneyplus.com',
  'www.primevideo.com','primevideo.com',
  'www.amazon.de','www.amazon.com','www.amazon.co.uk','www.amazon.fr',
  'www.amazon.it','www.amazon.es','www.amazon.ca','www.amazon.com.au',
  'www.amazon.co.jp','www.amazon.in','www.amazon.com.br','www.amazon.com.mx',
  'www.amazon.nl','www.amazon.se','www.amazon.pl',
  'www.crunchyroll.com','crunchyroll.com',
  'www.paramountplus.com','paramountplus.com',
  'www.max.com','max.com',
  'tv.apple.com',
  'www.hulu.com','hulu.com',
  'www.viki.com','viki.com',
  'www.hbomax.com','hbomax.com',
  'www.peacocktv.com','peacocktv.com',
  'www.funimation.com','funimation.com',
  'www.wakanim.tv','wakanim.tv',
  'www.sky.de','sky.de',
  'www.joyn.de','joyn.de',
  'www.rtl.de','rtl.de',
  'www.prosieben.de','prosieben.de',
  'www.zdf.de','zdf.de',
  'www.ard.de','ard.de',
  'www.vimeo.com','vimeo.com',
  'www.dailymotion.com','dailymotion.com',
]);

function renderSettings() {
  el.globalEnabled.checked = settings.globalEnabled !== false;
  el.hudEnabled.checked    = settings.hudEnabled    !== false;
  el.badgeEnabled.checked  = settings.badgeEnabled  !== false;

  // Unsupported-site banner
  const unsupportedBanner = document.getElementById('unsupported-banner');
  const unsupportedNote   = document.getElementById('unsupported-banner-note');
  const unsupportedSub    = document.getElementById('unsupported-banner-sub');
  if (unsupportedBanner) {
    const isBlocked    = POPUP_BLOCKED_DOMAINS.has(currentDomain);
    const isStreaming  = STREAMING_DOMAINS.has(currentDomain);
    const hasNoTab     = !currentDomain;
    const isUnsupported = hasNoTab || isBlocked || (!isStreaming && !!currentDomain);
    document.body.classList.toggle('is-unsupported', isUnsupported);
    unsupportedBanner.style.display = isUnsupported ? 'block' : 'none';
    if (isUnsupported) {
      if (hasNoTab) {
        if (unsupportedSub) unsupportedSub.textContent = '';
        if (unsupportedNote) unsupportedNote.textContent = i18n.t('noActiveTab');
      } else if (isBlocked) {
        if (unsupportedSub) unsupportedSub.textContent = ` — ${currentDomain}`;
        if (unsupportedNote) unsupportedNote.textContent = i18n.t('unsupportedBlocked');
      } else {
        if (unsupportedSub) unsupportedSub.textContent = ` — ${currentDomain}`;
        if (unsupportedNote) unsupportedNote.textContent = i18n.t('unsupportedUnknown');
      }
    }
  }

  // Domain-level toggle
  if (currentDomain) {
    const blocked = POPUP_BLOCKED_DOMAINS.has(currentDomain);
    const domainCfg = settings.domains?.[currentDomain];
    el.domainEnabled.checked  = !blocked && domainCfg?.enabled !== false;
    el.domainEnabled.disabled = blocked;
    el.domainRowDesc.textContent = blocked
      ? i18n.t('domainNotSupported').replace('{domain}', currentDomain)
      : currentDomain;
    document.getElementById('domain-row').classList.toggle('row-locked', blocked);
  }

  const ss = seriesSettings();
  el.skipIntro.checked   = ss.skipIntro;
  el.skipRecap.checked   = ss.skipRecap;
  el.skipCredits.checked = ss.skipCredits;
  el.skipAds.checked     = ss.skipAds;
  el.autoNext.checked    = ss.autoNext;

  if (currentSeries) {
    el.seriesCard.classList.remove('empty');
    el.seriesTitle.textContent   = currentSeries.title;
    const epCode2 = currentSeries.episode !== 'unknown' ? currentSeries.episode : '';
    const epName2  = currentSeries.episodeName || '';
    el.seriesEpisode.textContent = epCode2 && epName2 ? `${epCode2} \u00B7 ${epName2}`
                                   : epCode2 || epName2 || '';
    el.seriesLabel.textContent   = `${i18n.t('seriesHeadingPrefix')} — ${currentSeries.title}`;
  }

  renderEpisodeSection();
}

function renderEpisodeSection() {
  const epKey = episodeKey();
  if (!epKey || !currentSeries?.episode || currentSeries.episode === 'unknown') {
    el.epSection.style.display = 'none';
    return;
  }
  el.epSection.style.display = 'block';
  el.epLabel.textContent = `${i18n.t('episodeHeadingPrefix')} ${currentSeries.episode} — Override`;

  const ss  = seriesSettings();
  const eps = episodeSettings();  // only explicitly set fields
  const effective = { ...ss, ...eps };

  el.epSkipIntro.checked   = effective.skipIntro;
  el.epSkipRecap.checked   = effective.skipRecap;
  el.epSkipCredits.checked = effective.skipCredits;
  el.epSkipAds.checked     = effective.skipAds;
  el.epAutoNext.checked    = effective.autoNext;

  // Highlight labels where episode overrides the series value
  const fields = ['skipIntro','skipRecap','skipCredits','skipAds','autoNext'];
  const hasAnyOverride = fields.some(f => f in eps);
  el.epNote.textContent = hasAnyOverride
    ? i18n.t('episodeOverrideActive')
    : i18n.t('episodeInheritNote');

  document.querySelectorAll('.ep-label').forEach(lbl => {
    const field = lbl.dataset.field;
    const overridden = field in eps && eps[field] !== ss[field];
    lbl.classList.toggle('overridden', overridden);
  });
}

function applySeriesInfo(series) {
  currentSeries = series;
  el.seriesCard.classList.remove('empty');
  el.seriesTitle.textContent = series.title;
  const epCode = series.episode !== 'unknown' ? series.episode : '';
  const epName = series.episodeName || '';
  el.seriesEpisode.textContent = epCode && epName ? `${epCode} · ${epName}`
                                 : epCode || epName || '';
  el.seriesLabel.textContent = `${i18n.t('seriesHeadingPrefix')} — ${series.title}`;
}

function seriesSettings() {
  const key = currentSeries ? `${currentDomain}:${currentSeries.title}` : null;
  return (key && settings.series?.[key]) ? { ...SERIES_DEFAULTS, ...settings.series[key] } : { ...SERIES_DEFAULTS };
}

function episodeKey() {
  if (!currentSeries?.episode || currentSeries.episode === 'unknown') return null;
  return `${currentDomain}:${currentSeries.title}:${currentSeries.episode}`;
}

function episodeSettings() {
  const key = episodeKey();
  return (key && settings.episodes?.[key]) ? settings.episodes[key] : {};
}

// Save
async function save() {
  settings.globalEnabled = el.globalEnabled.checked;
  settings.hudEnabled    = el.hudEnabled.checked;
  settings.badgeEnabled  = el.badgeEnabled.checked;

  // Domain-level override
  if (currentDomain) {
    if (!settings.domains) settings.domains = {};
    if (!settings.domains[currentDomain]) settings.domains[currentDomain] = {};
    settings.domains[currentDomain].enabled = el.domainEnabled.checked;
  }

  if (currentSeries) {
    // Series-level
    const key = `${currentDomain}:${currentSeries.title}`;
    settings.series[key] = {
      ...(settings.series[key] || SERIES_DEFAULTS),
      skipIntro:   el.skipIntro.checked,
      skipRecap:   el.skipRecap.checked,
      skipCredits: el.skipCredits.checked,
      skipAds:     el.skipAds.checked,
      autoNext:    el.autoNext.checked,
    };

    // Episode-level override (only when section visible)
    const epKey = episodeKey();
    if (epKey && el.epSection.style.display !== 'none') {
      const ss = settings.series[key];
      if (!settings.episodes) settings.episodes = {};
      // Only save fields that explicitly differ from the series setting
      const override = {};
      if (el.epSkipIntro.checked   !== ss.skipIntro)   override.skipIntro   = el.epSkipIntro.checked;
      if (el.epSkipRecap.checked   !== ss.skipRecap)   override.skipRecap   = el.epSkipRecap.checked;
      if (el.epSkipCredits.checked !== ss.skipCredits) override.skipCredits = el.epSkipCredits.checked;
      if (el.epSkipAds.checked     !== ss.skipAds)     override.skipAds     = el.epSkipAds.checked;
      if (el.epAutoNext.checked    !== ss.autoNext)    override.autoNext    = el.epAutoNext.checked;
      settings.episodes[epKey] = override;
    }
  }

  await sendMessage({ action: 'saveSettings', settings });
  renderEpisodeSection(); // refresh override highlights
  showToast();
}

// Normalize across old Prompt API (readily/after-download/no) and
// new Chrome 138+ API (available/downloadable/downloading/unavailable).
function _aiStatusOk(s) {
  // Docs pattern: available !== 'unavailable' means AI is present
  return s !== 'unavailable' && s !== 'no' && s !== 'unknown' && !!s;
}
function _aiStatusPending(s) {
  return s === 'after-download' || s === 'downloadable' || s === 'downloading';
}

// Helpers
function updateAIBadge(status) {
  const dot = el.statusDot;
  if (!dot) return;

  // On unsupported sites Smart Skip isn't running — show a neutral "inactive" dot
  if (document.body.classList.contains('is-unsupported')) {
    dot.className = 'status-dot off';
    dot.dataset.tooltip = i18n.t('tooltipInactive');
    dot.dataset.label   = i18n.t('statusInactive');
    return;
  }

  if (_aiStatusOk(status) && !_aiStatusPending(status)) {
    dot.className = 'status-dot ready';
    dot.dataset.tooltip = i18n.t('tooltipAiReady');
    dot.dataset.label   = i18n.t('statusAiActive');
  } else if (_aiStatusPending(status)) {
    dot.className = 'status-dot rule';
    dot.dataset.tooltip = i18n.t('tooltipAiPending');
    dot.dataset.label   = i18n.t('statusRules');
  } else {
    // 'no' | 'unavailable' | anything else
    dot.className = 'status-dot off';
    dot.dataset.tooltip = i18n.t('tooltipAiOff');
    dot.dataset.label   = i18n.t('statusInactive');
  }
}

function showToast(msg) {
  el.toast.textContent = msg ?? i18n.t('toastSaved');
  el.toast.classList.add('show');
  setTimeout(() => el.toast.classList.remove('show'), 2500);
}

// ── Floating tooltip engine ────────────────────────────────────────────
(function () {
  const tt = document.getElementById('tt');
  if (!tt) return;
  let showTimer = null;
  let hideTimer = null;

  function position(target) {
    const tw = tt.offsetWidth;
    const th = tt.offsetHeight;
    const r  = target.getBoundingClientRect();
    const gap = 10;
    const bodyW = document.documentElement.clientWidth;
    let top = r.top - th - gap;
    const below = top < 4;
    if (below) top = r.bottom + gap;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(6, Math.min(left, bodyW - tw - 6));
    tt.style.top  = top  + 'px';
    tt.style.left = left + 'px';
    tt.classList.toggle('below', below);
  }

  function show(target) {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    const text = target.dataset.tooltip;
    if (!text) return;
    // 600 ms delay before appearing
    showTimer = setTimeout(() => {
      tt.classList.remove('visible');
      tt.textContent = text;
      tt.style.display = 'block';
      position(target);
      requestAnimationFrame(() => tt.classList.add('visible'));
    }, 600);
  }

  function hide() {
    clearTimeout(showTimer);
    tt.classList.remove('visible');
    hideTimer = setTimeout(() => { tt.style.display = 'none'; }, 200);
  }

  document.querySelectorAll('[data-tooltip]').forEach(node => {
    node.addEventListener('mouseenter', () => show(node));
    node.addEventListener('mouseleave', hide);
    node.addEventListener('click',      hide);
  });
}());

function sendMessage(payload) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(payload, r => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    } catch { resolve(null); }
  });
}
