# Security review — Smart Skip v2.1.0

Reviewed: extension (manifest, content scripts, page-context interceptor, popup)
and the API (`server/api.php`, `server/config.php`). Date: 2026-08-08.

The governing fact for everything below: **the API key ships inside the
extension.** Anyone can download the store package, unzip it, and read
`content/config.js`. That is not a bug to be fixed — a client-side extension
cannot hold a secret — but it means the key is an obstacle, not an
authentication boundary, and the server must be built as if the key were
published. Several findings follow from taking that seriously.

---

## Fixed in this pass

### 1. Rate limiting could be bypassed completely — API, high

`check_rate_limit()` keyed its bucket on `device_id`, which is a value the caller
puts in the request body. With the key in hand, sending a fresh UUID per request
meant every request landed in its own bucket and no limit was ever reached. The
actions that carry no `device_id` at all — `getConfig`, `fetchSelectors`,
`fetchTimings`, `ping` — were not metered on any axis.

Now a per-IP bucket runs first, for every action, using `REMOTE_ADDR` only
(`X-Forwarded-For` is caller-supplied and would have restored the same bypass).
The IP is stored as an HMAC keyed with `API_KEY`, so `rate_limits` never holds a
raw address. The per-device bucket stays as a secondary limit on honest clients.

New constant `RATE_LIMIT_PER_IP_PER_MIN` (default 300, deliberately generous —
a household behind one NAT shares an address).

### 2. `Access-Control-Allow-Origin: *` — API, medium

Any website could call the API from a visitor's browser and read the response.
`api.php` now reflects only extension origins (`chrome-extension://`,
`moz-extension://`, `safari-web-extension://`) and the supported streaming hosts.

Worth being precise about the value: CORS decides whether a response may be
*read*, not whether a request *runs*. A hostile page can still POST and the write
still lands. Finding 1 is what limits that; this one stops a drive-by page from
reading out of the API using someone else's browser.

Verified against suffix-confusion (`netflix.com.evil.com` → rejected) and scheme
downgrade (`http://www.netflix.com` → rejected).

### 3. Page-declared timing windows went straight into the shared database — extension, high

`SignalCollector` treated every source alike: a window found in `window.__INITIAL_
STATE__`, in an inline JSON blob, or in an XHR body relayed by the page-context
interceptor was recorded locally *and* uploaded to the crowd database.

All three of those are page-controlled. On a streaming site that includes every
third-party tag on the page, so an ad script — or anyone who achieves script
execution on the origin — could publish arbitrary intro/credit windows for real
series keys and have them served to every other user of that series.

The nonce on the interceptor bridge does not close this. It stops unrelated
scripts posting into the channel, but the nonce lives in the injected script's
`src` fragment, which is readable from the DOM until the load handler removes the
tag — and `window.__INITIAL_STATE__` needs no bridge at all. **You cannot hold a
secret in a page's own JavaScript context**, so the nonce is worth having as
friction and worth nothing as a boundary.

Sources are now split into two tiers:

- **OBSERVED** — rendered markers, media text-track cues, a skip button's
  appearance and disappearance, a click that verifiably moved the playhead.
  Uploads immediately.
- **DECLARED** — `xhr`, `ai-xhr`, `window-state`, `inline-script`. Recorded
  locally, held back from upload until an OBSERVED source reports the same
  window; then it is released and labelled with both halves (`xhr+track-cue`).

Local behaviour is unchanged, so a user still benefits from a window their page
declares — the cost of a wrong one stays one undoable skip on one machine
instead of a wrong skip for everyone watching the series.

### 4. Unused `scripting` permission — extension, low (review risk)

Declared in the manifest, never called: no `chrome.scripting`, no
`executeScript`, no `insertCSS` anywhere. Removed. Unused permissions are a
routine store-review rejection and widen the blast radius for no benefit.

### 5. Expired origin-trial token — extension, low

The `trial_tokens` entry expired **2026-06-16**, and was bound to extension ID
`dfoieoljahhkmoeanfnhlpdhniehppei` regardless. Removed. If the Prompt API still
needs a trial on your target Chrome version, mint a fresh token for the real
published ID and re-add it.

### 6. Explicit CSP for extension pages — extension, hardening

MV3 already applies a strict default. Declaring it (`script-src 'self';
object-src 'none'; base-uri 'none'; form-action 'none'`) makes it explicit and
means a future edit cannot loosen it by accident.

---

## Reviewed and found sound

- **Popup rendering of admin-controlled content.** Announcements, maintenance
  banners, quick actions and broadcasts all pass through `esc()`, and every
  server-supplied URL through `safeUrl()`, which rejects anything that is not
  `http:`/`https:`. That path was the most promising route into a privileged
  surface and it is closed.
- **SQL.** Every query in `api.php` is a prepared statement with bound
  parameters, and `PDO::ATTR_EMULATE_PREPARES` is off. The one interpolated
  identifier (`DELETE FROM \`{$table}\``) iterates a hard-coded array.
- **Interceptor payload filtering.** The page script forwards only bodies that
  match a timing-shaped regex and are under 512 KB, instead of relaying every
  JSON response on the page to anything listening for `message`.
- **Input sanitising.** `sanitize_domain`, `sanitize_enum`, `sanitize_id` and the
  `substr()` caps are applied consistently, and timing values are range-checked.

---

## Open — needs your decision

### A. No proof of ownership on device-scoped actions — API, medium

`deleteMyData`, `loadSettings` and `saveSettings` accept any well-formed
`device_id`. `require_device_id()` validates the *shape*, not the bearer. Anyone
who learns a device ID can read that device's settings — which include the
`series` keys, i.e. what they watch — or delete their data.

What keeps this from being critical: a v4 UUID is 122 bits and nothing in the API
enumerates device IDs. Practical risk today is low.

The fix is trust-on-first-use and is backward compatible:

1. `ALTER TABLE devices ADD COLUMN secret CHAR(64) NULL;`
2. On `registerDevice`, if `secret IS NULL`, generate one and return it; if it is
   set, require the caller to present it.
3. Client stores it in `chrome.storage.local` next to the device ID and sends it
   with the three device-scoped actions.

Existing installs bind on their next start. Unbound IDs stay claimable, but only
by someone who already guessed the UUID.

I did not implement this: it needs a schema migration and a client change, and I
cannot test either against your live database. Deploying it untested would risk
breaking cloud sync for every installed user.

### B. Crowd selectors are executable reach into other users' pages — design

`submitSelectors` accepts arbitrary CSS selectors, merges them into a domain's
shared list, and serves them to everyone on that domain. The extension then
clicks what they match. It cannot run code, but "click this element on every
user's Netflix page" is still real reach.

Existing mitigations are meaningful and already in place: `_isSkipButtonPlausible`
requires an interactive element near the player, the AI/rule classifier must
agree above a confidence threshold, and post-click verification prunes selectors
that do not work. Combined with finding A's fix and finding 1's rate limit, the
cost of a poisoning campaign goes up a lot. Worth considering a minimum number of
*distinct* devices before a selector is served, mirroring what `fetchTimings`
already does with `COUNT(DISTINCT device_id)`.

### C. Consent text does not cover what is actually sent — compliance

Unchanged from the store-listing review. The dialog lists three items; the
payload also includes series title, episode label, button text and attributes,
the active subtitle line, the user-agent, and the entire settings object. Fix the
copy in `shared/i18n.js` or stop sending the surplus fields. Under GDPR, consent
has to be specific about what it covers.

### D. `fetchRemoteConfig` runs before consent — privacy, low

The start-up config fetch happens on every extension start regardless of the
sharing opt-in, so your server sees the user's IP and extension version before
they have agreed to anything. It is defensible as legitimate interest — it is the
kill switch and version gate — but it should be stated in the privacy copy rather
than left implicit.

### E. `server/config.php` holds live credentials

Correctly listed in `.gitignore` and correctly absent from the extension package.
Two notes: the API key is public by construction (see the preamble), so treat any
server behaviour that relies on its secrecy as unprotected; and the DB password,
JWT secret and SMTP password sitting in the same file mean a single file
disclosure — a misconfigured directory listing, a backup left in the web root —
loses all of them at once.

---

## Where the API stands with a published key

Straight answer: abuse is now bounded by throughput, not by authentication.
There is no identity in the system. The key proves nothing, and after the fixes
above the only thing standing between a caller and a write is 300 requests per
minute per IP.

What an attacker holding the key can still do, per action:

| Action | Reachable | Impact |
| --- | --- | --- |
| `submitSelectors` | yes | Fill all 20 shared selector slots for a domain. Served to every user on it. |
| `recordFeedback` | yes | Set hits/misses for any domain+selector. See F below. |
| `recordTimingWindow` / `recordTiming` | yes | Vote on the windows everyone receives. See G below. |
| `registerDevice`, `recordEvent`, `reportError`, `submitButtonSignature` | yes | Row growth, analytics pollution. |
| `getConfig` | yes | Read broadcasts, keywords, quick actions, feature flags, changelog. |
| `fetchSelectors`, `fetchTimings`, `ping` | yes | Read-only, low value. |
| `saveSettings`, `loadSettings`, `deleteMyData` | needs the UUID | See A. |

### F. `recordFeedback` can suppress working selectors — API, medium

I listed this under "reviewed and found sound" for its SQL, and missed what it
lets a caller do. `fetchSelectors` drops any selector whose hit rate falls below
20 % over at least 5 data points. That threshold is fed by `recordFeedback`,
which accepts an arbitrary domain, selector and success flag. Five submitted
misses are enough to delete a working selector from what every user receives —
cheaper and quieter than poisoning, and it degrades detection rather than
causing a visible wrong skip. It also writes `selectors.quality` directly.

### G. Free device IDs defeat the anti-sybil measure — API, medium

`fetchTimings` deliberately ranks clusters by `COUNT(DISTINCT device_id)` rather
than row count, so one prolific submitter cannot decide what a series looks
like. That defence assumes a device ID costs something. It does not: it is a
client-generated UUID, unbound and unverified, so a caller mints a thousand
"distinct devices" as easily as one and takes the top-3 cluster slots that every
viewer of that series is served.

This is the strongest argument for finding A. Binding a device ID to a
server-issued secret is not primarily about protecting one user's settings — it
is what gives `COUNT(DISTINCT device_id)` its meaning.

### What would actually close the gap

In rough order of value per effort:

1. **Device binding (finding A).** Makes identity cost something, restores the
   sybil defence, and gives you something to ban.
2. **Quorum with time spread before serving.** Require a selector or window to be
   backed by N distinct *bound* devices across at least two calendar days before
   `fetchSelectors` / `fetchTimings` returns it. Time is the one resource a
   burst cannot fake.
3. **Split reads from writes.** Reads stay open; every write requires the device
   secret. Nothing in the extension needs to write before it has registered.
4. **Per-domain daily write caps and anomaly alerting.** A domain that suddenly
   receives thousands of feedback rows is worth an email, whatever the source.
5. **Rotate the API key with the next release.** Only worth doing alongside the
   above — on its own it buys one release cycle, since the new key ships in the
   new package.

Per-IP limiting is worth having and does not survive a proxy pool. Treat it as
the floor, not the answer.

---

## Verification

- `node --check` clean across all extension scripts.
- Extension regression suites pass: `test-recap-intro`, `test-series-detection`,
  and a new `test-upload-gating` covering finding 3 (declared windows held,
  observed windows uploaded, held windows released on corroboration, no duplicate
  row, local learning unaffected, state cleared on re-arm).
- Origin allow-list logic exercised against 17 cases including suffix confusion
  and scheme downgrade.
- `api.php`, `config.php`, `config.example.php` structurally balanced; every
  constant `api.php` references exists in `config.php`; new functions are
  top-level so PHP hoists them ahead of their call sites.
- **No PHP interpreter was available here, so `php -l` was not run and no request
  was executed against a database.** The API changes are reviewed, not tested.
  Run `php -l server/api.php` and exercise `ping`, `getConfig`, `fetchTimings`
  and one write path on a staging copy before deploying.
