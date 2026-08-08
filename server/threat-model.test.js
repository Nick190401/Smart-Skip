/**
 * Threat model for the API, given that the API key is public.
 *
 * This is NOT a test of api.php — there is no PHP here. It is a port of the
 * decision logic api.php now implements (TOFU binding, verified-only quorum,
 * device + day thresholds, per-domain caps) run against an attacker who holds
 * the key and can mint device IDs freely. It checks that the design does what
 * it claims; the PHP still has to be linted and exercised on staging.
 */
const crypto = require('crypto');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const QUORUM_MIN_DEVICES = 3;
const QUORUM_MIN_DAYS = 2;
const DOMAIN_WRITE_CAP_PER_DAY = 5000;

/** Mirrors the relevant parts of api.php. */
function makeApi({ requireDeviceSecret = false } = {}) {
  const devices = new Map();            // id -> { secretHash }
  const timingWindows = [];             // { seriesKey, type, from, to, deviceId, verified, day }
  const feedback = new Map();           // `${domain}|${sel}|${dev}` -> { hits, misses, verified }
  const domainWrites = new Map();       // `${domain}|${day}` -> count

  const verified = (id, secret) => {
    const d = devices.get(id);
    return !!(d && d.secretHash && secret && d.secretHash === sha256(secret));
  };
  const isBound = (id) => !!devices.get(id)?.secretHash;

  return {
    devices, timingWindows,

    registerDevice(id, secret = '') {
      if (!devices.has(id)) devices.set(id, { secretHash: null });
      const d = devices.get(id);
      if (!d.secretHash) {
        const issued = crypto.randomBytes(32).toString('hex');
        d.secretHash = sha256(issued);
        return { registered: true, device_secret: issued, bound: true };
      }
      return { registered: true, bound: verified(id, secret) };
    },

    recordTimingWindow({ deviceId, secret = '', seriesKey, type, from, to, day }) {
      const v = verified(deviceId, secret);
      if (requireDeviceSecret && !v) return { error: 403 };
      timingWindows.push({ seriesKey, type, from, to, deviceId, verified: v, day });
      return { saved: true };
    },

    recordFeedback({ domain, deviceId, secret = '', selector, success, day }) {
      const v = verified(deviceId, secret);
      if (requireDeviceSecret && !v) return { error: 403 };
      const capKey = `${domain}|${day}`;
      const n = (domainWrites.get(capKey) || 0) + 1;
      domainWrites.set(capKey, n);
      if (n > DOMAIN_WRITE_CAP_PER_DAY) return { error: 429 };
      const k = `${domain}|${selector}|${deviceId}`;
      const row = feedback.get(k) || { hits: 0, misses: 0, verified: v };
      row[success ? 'hits' : 'misses']++;
      row.verified = v;
      feedback.set(k, row);
      return { saved: true };
    },

    // What a normal user is actually served.
    fetchTimings(seriesKey) {
      const clusters = new Map();
      for (const w of timingWindows) {
        if (w.seriesKey !== seriesKey || !w.verified) continue;
        const k = `${w.type}|${Math.round(w.from / 30)}|${Math.round(w.to / 30)}`;
        const c = clusters.get(k) || { type: w.type, devices: new Set(), days: new Set(), rows: 0 };
        c.devices.add(w.deviceId); c.days.add(w.day); c.rows++;
        clusters.set(k, c);
      }
      return [...clusters.values()]
        .filter(c => c.devices.size >= QUORUM_MIN_DEVICES && c.days.size >= QUORUM_MIN_DAYS)
        .sort((a, b) => b.devices.size - a.devices.size)
        .slice(0, 3);
    },

    // Which selectors get suppressed for everyone.
    suppressedSelectors(domain) {
      const per = new Map();
      for (const [k, row] of feedback) {
        const [d, sel, dev] = k.split('|');
        if (d !== domain || !row.verified) continue;
        const agg = per.get(sel) || { hits: 0, misses: 0, devices: new Set() };
        agg.hits += row.hits; agg.misses += row.misses; agg.devices.add(dev);
        per.set(sel, agg);
      }
      const out = [];
      for (const [sel, a] of per) {
        const total = a.hits + a.misses;
        if (a.devices.size >= QUORUM_MIN_DEVICES && total >= 5 && a.hits / total < 0.2) out.push(sel);
      }
      return out;
    },
  };
}

/** The old behaviour: no binding, no verified flag, no day requirement. */
function legacyFetchTimings(windows, seriesKey) {
  const clusters = new Map();
  for (const w of windows) {
    if (w.seriesKey !== seriesKey) continue;
    const k = `${w.type}|${Math.round(w.from / 30)}|${Math.round(w.to / 30)}`;
    const c = clusters.get(k) || { type: w.type, devices: new Set(), rows: 0 };
    c.devices.add(w.deviceId); c.rows++;
    clusters.set(k, c);
  }
  return [...clusters.values()].sort((a, b) => b.devices.size - a.devices.size).slice(0, 3);
}

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) fails++;
};

// ── 1. Trust on first use ───────────────────────────────────────────────────
console.log('\n1. device binding');
{
  const api = makeApi();
  const first = api.registerDevice('dev-1');
  check('first registration issues a token', !!first.device_secret);

  const impostor = api.registerDevice('dev-1', 'wrong'.repeat(10));
  check('claiming a bound id without the token is not bound', impostor.bound === false);
  check('and no second token is handed out', !impostor.device_secret);

  const legit = api.registerDevice('dev-1', first.device_secret);
  check('the holder re-confirms', legit.bound === true);
}

// ── 2. Sybil flood against the served timing windows ────────────────────────
console.log('\n2. sybil flood — 1000 invented devices vs 3 real users');
{
  const api = makeApi();
  const SERIES = 'netflix.com:Some Show';

  // Three genuine users, bound, reporting the true intro across two days.
  for (let i = 0; i < 3; i++) {
    const id = `real-${i}`;
    const { device_secret } = api.registerDevice(id);
    for (const day of ['2026-08-07', '2026-08-08']) {
      api.recordTimingWindow({ deviceId: id, secret: device_secret, seriesKey: SERIES,
        type: 'intro', from: 60, to: 150, day });
    }
  }

  // Attacker with the public key, minting UUIDs, never registering.
  for (let i = 0; i < 1000; i++) {
    api.recordTimingWindow({ deviceId: `sybil-${i}`, seriesKey: SERIES,
      type: 'intro', from: 900, to: 1100, day: '2026-08-08' });
  }

  const legacy = legacyFetchTimings(api.timingWindows, SERIES);
  check('BEFORE: the flood would have taken the top slot',
        legacy[0].devices.size === 1000 && legacy[0].type === 'intro',
        `top cluster backed by ${legacy[0].devices.size} "devices"`);

  const served = api.fetchTimings(SERIES);
  check('AFTER: only the genuine window is served', served.length === 1);
  check('AFTER: it is the real one', served[0] && served[0].devices.size === 3,
        served[0] ? `from ${[...served[0].days].length} days, ${served[0].devices.size} devices` : 'nothing served');
}

// ── 3. Sybil flood by an attacker who does register ─────────────────────────
console.log('\n3. attacker who pays the registration cost');
{
  const api = makeApi();
  const SERIES = 'netflix.com:Some Show';
  for (let i = 0; i < 50; i++) {
    const id = `paid-${i}`;
    const { device_secret } = api.registerDevice(id);
    // All on one day — the burst has to come back tomorrow to count.
    api.recordTimingWindow({ deviceId: id, secret: device_secret, seriesKey: SERIES,
      type: 'intro', from: 900, to: 1100, day: '2026-08-08' });
  }
  check('a single-day burst is still not served', api.fetchTimings(SERIES).length === 0,
        '50 bound devices, one calendar day');

  for (let i = 0; i < 50; i++) {
    api.recordTimingWindow({ deviceId: `paid-${i}`, secret: null, seriesKey: SERIES,
      type: 'intro', from: 900, to: 1100, day: '2026-08-09' });
  }
  check('...and returning without the token does not help either',
        api.fetchTimings(SERIES).length === 0, 'second day, unverified rows');
}

// ── 3b. The residual risk, stated rather than glossed over ──────────────────
console.log('\n3b. patient attacker: keeps the tokens, comes back tomorrow');
{
  const api = makeApi();
  const SERIES = 'netflix.com:Some Show';
  const held = [];
  for (let i = 0; i < 50; i++) {
    const id = `patient-${i}`;
    held.push([id, api.registerDevice(id).device_secret]);
  }
  for (const day of ['2026-08-08', '2026-08-09']) {
    for (const [id, secret] of held) {
      api.recordTimingWindow({ deviceId: id, secret, seriesKey: SERIES,
        type: 'intro', from: 900, to: 1100, day });
    }
  }
  const served = api.fetchTimings(SERIES);
  check('this DOES succeed — the quorum raises cost, it does not close the hole',
        served.length === 1 && served[0].devices.size === 50,
        'registered 50 devices, held the tokens, wrote on two days');
  console.log('        └─ residual: needs registration + persistence + two days,');
  console.log('           all of which are visible in domain_write_caps and the');
  console.log('           verified/unverified ratio. Detection, not prevention.');
}

// ── 4. Selector suppression ─────────────────────────────────────────────────
console.log('\n4. suppressing a working selector');
{
  const api = makeApi();
  for (let i = 0; i < 20; i++) {
    api.recordFeedback({ domain: 'netflix.com', deviceId: `attacker-${i}`,
      selector: '[data-uia="player-skip-intro"]', success: false, day: '2026-08-08' });
  }
  check('unverified misses cannot retire a selector',
        api.suppressedSelectors('netflix.com').length === 0, '20 unbound devices, all misses');

  for (let i = 0; i < 3; i++) {
    const id = `honest-${i}`;
    const { device_secret } = api.registerDevice(id);
    for (let n = 0; n < 2; n++) {
      api.recordFeedback({ domain: 'netflix.com', deviceId: id, secret: device_secret,
        selector: '[data-uia="broken"]', success: false, day: '2026-08-08' });
    }
  }
  check('genuine agreement still retires a broken one',
        api.suppressedSelectors('netflix.com').includes('[data-uia="broken"]'));
}

// ── 5. Owner actions ────────────────────────────────────────────────────────
console.log('\n5. reading another device\'s settings');
{
  const api = makeApi();
  const { device_secret } = api.registerDevice('victim');
  const bound = (id, secret) => {
    const d = api.devices.get(id);
    if (!d?.secretHash) return 'open';
    return d.secretHash === sha256(secret || '') ? 'allowed' : 'denied';
  };
  check('knowing the UUID is no longer enough', bound('victim', '') === 'denied');
  check('the owner still gets in', bound('victim', device_secret) === 'allowed');
}

// ── 6. Hard mode ────────────────────────────────────────────────────────────
console.log('\n6. REQUIRE_DEVICE_SECRET = true');
{
  const api = makeApi({ requireDeviceSecret: true });
  const r = api.recordTimingWindow({ deviceId: 'x', seriesKey: 's', type: 'intro',
    from: 1, to: 2, day: '2026-08-08' });
  check('unverified writes are refused outright', r.error === 403);
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
