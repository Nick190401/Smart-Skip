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

## Findings raised in round 1

Severity and status as of round 2. A, F and G are fixed; B, C, D and E remain
open and are yours to decide.

### A. No proof of ownership on device-scoped actions — API, medium — **FIXED in round 2**

`deleteMyData`, `loadSettings` and `saveSettings` accepted any well-formed
`device_id`; `require_device_id()` validated the *shape*, not the bearer.

Superseded by finding 7. These three actions now refuse whenever the device is
bound and the caller cannot present its token. Unbound ids stay claimable, but
only by someone who already guessed a 122-bit UUID.

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

## Round 2 — hardening the API against a published key

Everything in this section is implemented. Apply
`server/schema_device_binding.sql`, then deploy `api.php` and `config.php`.

### 7. Device binding, trust on first use — closes A, F and G

`registerDevice` now issues a 32-byte token the first time a device id is
claimed, stores only its SHA-256, and returns the plaintext exactly once. From
then on that token, not the id, is what identifies the installation.

Nothing about the rollout is breaking. `REQUIRE_DEVICE_SECRET` defaults to
`false`: an installation that predates this keeps writing, its rows are simply
marked `verified = 0`, and **unverified rows do not count toward the quorum that
decides what anyone else is served.** The security benefit lands immediately;
flip the flag to `true` once the update has propagated and unverified writes are
refused outright.

Ownership is gated independently of that flag: `loadSettings`, `saveSettings`
and `deleteMyData` refuse as soon as the device *is* bound and the caller cannot
present the token. Knowing a UUID stops being enough the moment that device has
something to protect.

### 8. Quorum on everything that is served

`fetchTimings` now counts only verified rows and requires
`QUORUM_MIN_DEVICES` (3) distinct bound devices **across `QUORUM_MIN_DAYS` (2)
distinct calendar days**. The device count is the half that binding makes
meaningful; the day spread is the half a burst cannot buy at any price.

`fetchSelectors` applies the same rule to suppression, which closes F: feedback
is one row per device now, so five submitted misses from one caller no longer
retire a working selector for everybody.

### 9. Per-domain daily write cap

`DOMAIN_WRITE_CAP_PER_DAY` (5000) bounds the blast radius of a proxy pool, which
per-IP limiting cannot see. It doubles as a signal — a domain that suddenly
produces thousands of writes is worth looking at whoever sent them.

### 10. GDPR deletion was broken — high, and a false claim in the store listing

`deleteMyData` deleted `FROM selector_feedback WHERE device_id = ?`. That column
did not exist. The statement threw, the transaction rolled back, and the endpoint
answered **500 for every user who ever pressed "erase my cloud data"** — nothing
was ever deleted. `video_timings` was missing from the list outright, so timing
samples would have survived even a working deletion.

The migration adds the column and `api.php` adds the missing table. Until this is
deployed, the sentence in the store listing that says there is a button which
erases everything stored under your device ID is **not true**. Deploy before
publishing, or cut the claim.

---

## Where the API stands with a published key

The key still proves nothing — that cannot change while it ships in the package.
What changed is that the key is no longer the thing being relied on. Identity now
comes from a token the server issues and the client holds, and **writes no longer
influence what anyone else receives until a quorum of bound devices, spread over
more than one day, agrees.**

An attacker with the key can still write. They can no longer be heard.

| Action | Can they call it | Can it reach other users |
| --- | --- | --- |
| `recordTimingWindow` / `recordTiming` | yes | no — unverified rows are excluded from `fetchTimings` |
| `recordFeedback` | yes, up to the domain cap | no — suppression needs 3 bound devices |
| `submitSelectors` | yes, up to the domain cap | partly — see B, still the weakest path |
| `recordEvent`, `reportError`, `submitButtonSignature` | yes | no — analytics only |
| `getConfig` | yes | no — read-only |
| `loadSettings`, `saveSettings`, `deleteMyData` | only for an unbound id | no |

### What still gets through

Stated plainly, because the quorum raises cost rather than closing the hole: an
attacker who **registers devices properly, keeps the tokens, and writes on two
separate days** does reach the served set. The threat-model simulation
(`server/threat-model.test.js`, case 3b) demonstrates exactly that and asserts it
succeeds — 50 bound devices over two days take the cluster.

What that now requires is registration, persistence and patience, and all three
leave marks: `domain_write_caps` shows the volume, the verified/unverified ratio
shows the shape, and `devices.bound_at` shows a burst of registrations. That is
detection, not prevention. If you want prevention, the next step is per-device
reputation — a device whose submissions are repeatedly contradicted by others
stops counting — which needs a scoring pass over historical data rather than a
request-time check.

`submitSelectors` (finding B) remains the weakest path, because a selector is
merged into a domain's shared list without a device quorum. Applying the same
`COUNT(DISTINCT device_id) >= QUORUM_MIN_DEVICES` gate there is the obvious next
change; it needs per-device selector rows the way feedback now has them.

### F. `recordFeedback` can suppress working selectors — API, medium — **FIXED in round 2**

I listed this under "reviewed and found sound" for its SQL, and missed what it
lets a caller do. `fetchSelectors` drops any selector whose hit rate falls below
20 % over at least 5 data points. That threshold is fed by `recordFeedback`,
which accepts an arbitrary domain, selector and success flag. Five submitted
misses are enough to delete a working selector from what every user receives —
cheaper and quieter than poisoning, and it degrades detection rather than
causing a visible wrong skip. It also writes `selectors.quality` directly.

### G. Free device IDs defeat the anti-sybil measure — API, medium — **FIXED in round 2**

`fetchTimings` deliberately ranks clusters by `COUNT(DISTINCT device_id)` rather
than row count, so one prolific submitter cannot decide what a series looks
like. That defence assumes a device ID costs something. It does not: it is a
client-generated UUID, unbound and unverified, so a caller mints a thousand
"distinct devices" as easily as one and takes the top-3 cluster slots that every
viewer of that series is served.

This is the strongest argument for finding A. Binding a device ID to a
server-issued secret is not primarily about protecting one user's settings — it
is what gives `COUNT(DISTINCT device_id)` its meaning.

### Rollout order

1. `mysql -u USER -p DBNAME < server/schema_device_binding.sql` — additive only,
   safe on a live database.
2. Deploy `api.php` + `config.php`. Cloud sync keeps working for old clients.
3. Ship the extension update so clients start binding.
4. Watch `SELECT verified, COUNT(*) FROM timing_windows GROUP BY verified`.
   When verified dominates, set `REQUIRE_DEVICE_SECRET = true`.
5. Only then consider rotating `API_KEY` — on its own it buys one release cycle,
   since the new key ships in the new package.

---

## Verification

- `node --check` clean across all extension scripts.
- Extension regression suites pass: `test-recap-intro`, `test-series-detection`,
  and a new `test-upload-gating` covering finding 3 (declared windows held,
  observed windows uploaded, held windows released on corroboration, no duplicate
  row, local learning unaffected, state cleared on re-arm).
- Origin allow-list logic exercised against 17 cases including suffix confusion
  and scheme downgrade.
- `server/threat-model.test.js` ports the API's new decision logic to JS and runs
  an attacker holding the public key against it: TOFU binding, a 1000-device
  sybil flood (which took the top cluster before and reaches nobody now), a
  registered burst confined to one day, selector suppression, owner actions, and
  the residual case that still succeeds. `node server/threat-model.test.js`.
- `api.php`, `config.php`, `config.example.php` structurally balanced; every
  constant `api.php` references exists in `config.php`; new functions are
  top-level so PHP hoists them ahead of their call sites.
- **No PHP interpreter was available here, so `php -l` was not run and no request
  was executed against a database.** The API changes are reviewed, not tested.
  Run `php -l server/api.php` and exercise `ping`, `getConfig`, `fetchTimings`
  and one write path on a staging copy before deploying.
