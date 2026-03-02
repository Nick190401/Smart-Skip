<div align="center">

# Smart Skip v2

**Automatically skips intros, recaps, credits and ads on streaming platforms — powered by on-device AI.**

[![Chrome](https://img.shields.io/badge/Chrome-127%2B-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-brightgreen)](https://developer.chrome.com/docs/extensions/mv3/)
[![License: Custom](https://img.shields.io/badge/License-Custom%20Non--Commercial-blue.svg)](LICENSE)
[![Gemini Nano](https://img.shields.io/badge/AI-Gemini%20Nano-8B5CF6?logo=google&logoColor=white)](https://developer.chrome.com/docs/ai/built-in)

> Looking for v1? → [`smartskipv1`](../../tree/smartskipv1) branch

</div>

---

## What it does

Smart Skip watches what you're playing and clicks the skip button for you — across any streaming platform, in any language. There are no hardcoded selectors per site. Instead it uses **Gemini Nano** (Chrome's built-in on-device AI) to figure out the page structure, remembers what it learns, and gets smarter over time.

- Skips intros, recaps, end credits and mid-roll ads
- Works on 25+ platforms without platform-specific hacks
- All AI runs locally — nothing leaves your browser unless you opt in to cloud sync
- Per-series and per-episode settings so you stay in control

---

## Features

| | |
|---|---|
| **On-device AI** | Gemini Nano via `window.ai.languageModel` — no external AI API, no usage costs |
| **Multi-layer detection** | AI DOM scan → full-document text scan (12+ languages) → learned selectors |
| **Self-improving** | Successful skips are stored locally; optionally crowd-sourced with consent |
| **Episode-level timing** | Learns when skip buttons typically appear per episode, not just per series |
| **Privacy-first** | No PII, no fingerprinting — cloud sync uses an anonymous UUID and is always opt-in |
| **Universal** | Adapts to any player DOM; no vendor class names hardcoded |
| **Keyboard shortcut** | `Alt+S` for a manual scan |

---

## Supported Platforms

Netflix · Disney+ · Amazon Prime Video · Crunchyroll · Hulu · Apple TV+ · Max · Paramount+ · Peacock · Funimation · Wakanim · Sky · Joyn · RTL · ProSieben · ZDF · ARD · Viki · Twitch · Vimeo · Dailymotion · and more

---

## Requirements

- **Chrome 138+** with the Gemini Nano Prompt API enabled
- Enable `chrome://flags/#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
- Enable `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → **Enabled**
- Relaunch Chrome, then open `chrome://components` and click **Check for update** on *Optimization Guide On Device Model*
- The extension falls back to rule-based detection if Gemini Nano is unavailable

---

## Installation

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the root of this repository (the folder containing `manifest.json`)

---

## Project Structure

```
/
├── manifest.json          Chrome MV3 manifest
├── background/
│   └── background.js      Service worker
├── content/
│   ├── skipper.js         Main orchestrator — observers, scan loop, meta detection
│   ├── platforms.js       Platform registry (BasePlatform + per-site adapters)
│   ├── ai-classifier.js   Gemini Nano button classifier + rule fallback
│   ├── dom-scanner.js     AI DOM scanner — discovers selectors from the live page
│   ├── learning-store.js  Local persistence (chrome.storage.local)
│   └── sync-service.js    Optional cloud sync — consent-gated
├── popup/
│   ├── popup.html
│   └── popup.js
├── shared/
│   └── i18n.js            EN + DE built-in; other languages translated via Gemini Nano
├── assets/
│   └── icons/
└── server/                Self-hosted cloud backend (optional)
    ├── api.php
    ├── config.example.php
    ├── schema.sql
    └── .htaccess
```

---

## How it works

### Skip button detection

Finding the right element to click is a three-step process:

1. **AI DOM scanner** — Gemini Nano reads a trimmed DOM snapshot and identifies CSS selectors and button text patterns for the current site. Results are cached in memory (10 min) and persisted to `LearningStore` with a 7-day TTL, so future visits don't need another AI call.

2. **Text-content scan** — every interactive element on the page is checked against skip keywords in 12+ languages. No class names or IDs are assumed, so it works even when a platform changes their markup.

3. **Periodic safety net** — a scan runs every 2 seconds while a video is playing. This catches buttons that are injected after the initial page load via React portals or timed callbacks.

### Series and episode detection

| Priority | Method | Notes |
|---|---|---|
| 1 | `platform.extractMeta()` | Synchronous, platform-aware DOM read |
| 2 | `domScanner.scan()` | AI-discovered selectors, cached per domain |
| 3 | `_parseTitle(document.title)` | Regex fallback |
| 4 | Raw `document.title` | Last resort; retries continue in the background |

### Learning loop

```
skip clicked  →  record timing at episode key  +  series key  (local)
              →  submit to cloud API            (only with consent)

next visit    →  predict window: episode key first, series key as fallback
              →  scan frequency adapts around the predicted window
                 (predictions are hints only — they never block a scan)
```

---

## Cloud sync (optional, self-hosted)

All cloud features are **opt-in**. The server is a single PHP file that runs on any shared host.

### Setup

```bash
# Copy and fill in the config template
cp server/config.example.php server/config.php
# Generate an API key: php -r "echo bin2hex(random_bytes(32));"

# Import the schema
mysql -u youruser -p yourdb < server/schema.sql

# Upload api.php, .htaccess, config.php to your web host

# Point the extension at your server
# In content/sync-service.js:
#   const SYNC_API_BASE = 'https://your-domain.com/api.php';
#   const SYNC_API_KEY  = 'your-generated-key';
```

### API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `fetchSelectors` | GET | Crowd-sourced selectors for a domain |
| `submitSelectors` | POST | Submit locally discovered selectors |
| `fetchTimings` | GET | Timing windows for a series or episode key |
| `recordFeedback` | POST | Report skip success or failure |

Auth: `X-SS2-Key: <your key>`

---

## Storage

| Key | What's stored |
|---|---|
| `ss2` | User settings |
| `ss2_learn` | Selectors, timing patterns, feedback — everything the extension learns |
| `ss2_device_id` | Anonymous UUID — only created after the user consents to cloud sync |
| `ss2_consent` | `{ sync: bool }` |
| `ss2_stats` | Local skip count and stats |
| `ss2_i18n_${lang}` | Translated UI strings cached for 30 days |

---

## Privacy

- No personal data is ever collected or transmitted.
- Cloud sync uses a random anonymous `ss2_device_id` — no name, email, or IP is stored.
- Cloud sync is **disabled by default** and requires explicit user consent.
- Consent can be revoked at any time from the popup; cloud activity stops immediately.
- Gemini Nano runs entirely on-device — no prompts or page content leave the browser.

---

## Contributing

1. Fork, then create a feature branch: `git checkout -b feature/my-improvement`
2. Keep changes generic — platform-specific hacks are rejected in favour of improving the universal mechanism.
3. Open a pull request against `main`.

### Core Rules

- ❌ No platform-specific CSS selectors — improve the universal scanner instead
- ❌ Timing predictions are hints only — never block a scan based on them
- ❌ No network calls before `ss2_consent.sync === true`
- ❌ No PII beyond the anonymous device UUID
- ❌ No hardcoded single-language button text — use multi-language patterns

---

## License

Custom non-commercial license — free for personal, educational and research use. Commercial use and resale are not permitted. See [LICENSE](LICENSE) for the full terms.

---

**Developed by [KernelMinds.de](https://kernelminds.de)**
