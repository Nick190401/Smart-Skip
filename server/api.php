<?php
/**
 * Smart Skip v2 — REST API
 *
 * Upload to server at: /public_html/smart-skip-api/api.php
 * config.php must reside in the same directory.
 *
 * Endpoint: POST https://your-domain.com/smart-skip-api/api.php
 * Body:      JSON  { "action": "...", ...params }
 * Header:    X-SS2-Key: <API_KEY from config.php>
 */

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/config.php';

// ── CORS ──────────────────────────────────────────────────────────────────────
header('Access-Control-Allow-Origin: '  . ALLOWED_ORIGIN);
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-SS2-Key');
header('Access-Control-Max-Age: 86400');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Nur POST ──────────────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    api_error(405, 'Method Not Allowed');
}

// ── Validate API key ────────────────────────────────────────────
$incomingKey = $_SERVER['HTTP_X_SS2_KEY'] ?? '';
if (!hash_equals(API_KEY, $incomingKey)) {
    api_error(401, 'Unauthorized');
}

// ── Parse body ───────────────────────────────────────────────────────────────
$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body) || empty($body['action'])) {
    api_error(400, 'Invalid request body');
}

$action   = (string) $body['action'];
$deviceId = isset($body['device_id']) ? sanitize_id($body['device_id']) : null;

// ── DB connection ─────────────────────────────────────────────────────────────
$pdo = db_connect();

// ── Rate-limiting (exception: registerDevice is always allowed) ─────────────
if ($action !== 'registerDevice' && $deviceId) {
    check_rate_limit($pdo, $deviceId);
}

// ── Router ────────────────────────────────────────────────────────────────────
switch ($action) {

    // ------------------------------------------------------------------
    //  Register or update a device (first call on extension start)
    // ------------------------------------------------------------------
    case 'registerDevice':
        require_device_id($deviceId);
        $ver  = substr((string)($body['version']   ?? ''), 0, 16);
        $ua   = substr((string)($body['user_agent'] ?? ''), 0, 256);
        $stmt = $pdo->prepare(
            'INSERT INTO devices (id, extension_ver, user_agent)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE extension_ver=VALUES(extension_ver),
                                     user_agent=VALUES(user_agent)'
        );
        $stmt->execute([$deviceId, $ver, $ua]);
        api_ok(['registered' => true]);
        break;

    // ------------------------------------------------------------------
    //  Fetch crowd-sourced selectors for a domain
    // ------------------------------------------------------------------
    case 'fetchSelectors':
        $domain = sanitize_domain($body['domain'] ?? '');
        if (!$domain) api_error(400, 'domain required');

        $stmt = $pdo->prepare(
            'SELECT series_selector, episode_selector, skip_selectors, quality, confirmed_total
             FROM selectors WHERE domain = ? LIMIT 1'
        );
        $stmt->execute([$domain]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            api_ok(['found' => false]);
        }

        // Filter out skip selectors that have consistently bad feedback
        // (hit_rate < 20% with at least 5 data points)
        $skipSelectors = json_decode($row['skip_selectors'] ?? '[]', true);
        if (!empty($skipSelectors)) {
            $fbStmt = $pdo->prepare(
                'SELECT selector, hits, misses FROM selector_feedback
                 WHERE domain = ? AND (hits + misses) >= 5'
            );
            $fbStmt->execute([$domain]);
            $badSelectors = [];
            foreach ($fbStmt->fetchAll(PDO::FETCH_ASSOC) as $fb) {
                $total = $fb['hits'] + $fb['misses'];
                if ($total > 0 && ($fb['hits'] / $total) < 0.2) {
                    $badSelectors[] = $fb['selector'];
                }
            }
            if (!empty($badSelectors)) {
                $skipSelectors = array_values(array_filter(
                    $skipSelectors,
                    fn($s) => !in_array($s, $badSelectors, true)
                ));
            }
        }
        $row['skip_selectors'] = $skipSelectors;
        api_ok(['found' => true, 'selectors' => $row]);
        break;

    // ------------------------------------------------------------------
    //  Neue / verbesserte Selektoren einreichen
    // ------------------------------------------------------------------
    case 'submitSelectors':
        require_device_id($deviceId);
        $domain  = sanitize_domain($body['domain'] ?? '');
        if (!$domain) api_error(400, 'domain required');

        $serSel  = substr((string)($body['series_selector']  ?? ''), 0, 512) ?: null;
        $epSel   = substr((string)($body['episode_selector'] ?? ''), 0, 512) ?: null;
        $skipRaw = $body['skip_selectors'] ?? [];
        if (!is_array($skipRaw)) $skipRaw = [];
        $quality = (float)($body['quality'] ?? 0.5);
        $quality = max(0.0, min(1.0, $quality));

        // Merge skip_selectors: union with existing (deduplicate, cap at 20)
        $existStmt = $pdo->prepare('SELECT skip_selectors FROM selectors WHERE domain = ? LIMIT 1');
        $existStmt->execute([$domain]);
        $existRow  = $existStmt->fetch(PDO::FETCH_ASSOC);
        $existing  = $existRow ? json_decode($existRow['skip_selectors'] ?? '[]', true) : [];
        if (!is_array($existing)) $existing = [];
        $merged   = array_values(array_unique(array_merge($existing, array_slice($skipRaw, 0, 20))));
        $merged   = array_slice($merged, 0, 20);
        $skipJson = json_encode($merged);

        // Merge: quality is running weighted average
        $stmt = $pdo->prepare(
            'INSERT INTO selectors (domain, series_selector, episode_selector, skip_selectors, quality, confirmed_total)
             VALUES (?, ?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
               series_selector  = IF(? IS NOT NULL, ?, series_selector),
               episode_selector = IF(? IS NOT NULL, ?, episode_selector),
               skip_selectors   = ?,
               quality          = (quality * confirmed_total + ?) / (confirmed_total + 1),
               confirmed_total  = confirmed_total + 1'
        );
        $stmt->execute([
            $domain, $serSel, $epSel, $skipJson, $quality,
            $serSel, $serSel, $epSel, $epSel, $skipJson, $quality,
        ]);
        api_ok(['saved' => true]);
        break;

    // ------------------------------------------------------------------
    //  Skip-Event protokollieren (Statistiken / Analytics)
    // ------------------------------------------------------------------
    case 'recordEvent':
        require_device_id($deviceId);
        ensure_device_exists($pdo, $deviceId);
        $domain      = sanitize_domain($body['domain']       ?? '');
        $buttonType  = sanitize_enum($body['button_type']    ?? '', ['intro','recap','credits','ads','next']);
        $confidence  = isset($body['confidence'])  ? (float)$body['confidence']  : null;
        $aiSource    = sanitize_enum($body['ai_source']      ?? '', ['ai','rule','']);
        $videoTime   = isset($body['video_time'])  ? (float)$body['video_time']  : null;
        $seriesTitle = substr((string)($body['series_title'] ?? ''), 0, 256) ?: null;
        $episodeInfo = substr((string)($body['episode_info'] ?? ''), 0, 256) ?: null;
        $extVer      = substr((string)($body['version']      ?? ''), 0, 16);

        if (!$domain || !$buttonType) api_error(400, 'domain and button_type required');

        $stmt = $pdo->prepare(
            'INSERT INTO skip_events
               (device_id, domain, button_type, confidence, ai_source, video_time, series_title, episode_info, ext_version)
             VALUES (?,?,?,?,?,?,?,?,?)'
        );
        $stmt->execute([$deviceId, $domain, $buttonType, $confidence, $aiSource ?: null,
                        $videoTime, $seriesTitle, $episodeInfo, $extVer]);
        api_ok(['saved' => true]);
        break;

    // ------------------------------------------------------------------
    //  Submit a button fingerprint — for cross-platform pattern training
    //  (no extra schema required).
    //  Button texts are stored in selector_feedback with sources='text_pattern'
    //  so we can later build a list of common skip phrases per domain.
    // ------------------------------------------------------------------
    case 'submitButtonSignature':
        require_device_id($deviceId);
        $domain     = sanitize_domain($body['domain'] ?? '');
        $buttonType = sanitize_enum($body['type'] ?? '', ['intro','recap','credits','ads','next']);
        $btnText    = substr(trim((string)($body['text'] ?? '')), 0, 120);

        if (!$domain || !$buttonType || !$btnText) {
            // Not enough data to learn from — silently accept.
            api_ok(['saved' => false]);
        }

        $stmt = $pdo->prepare(
            'INSERT INTO selector_feedback (domain, button_type, selector, hits, misses, sources)
             VALUES (?, ?, ?, 1, 0, ?)
             ON DUPLICATE KEY UPDATE
               hits    = hits + 1,
               sources = VALUES(sources)'
        );
        $stmt->execute([$domain, $buttonType, $btnText, 'text_pattern']);
        api_ok(['saved' => true]);
        break;

    // ------------------------------------------------------------------
    //  Selector-Feedback (Klick hat funktioniert / nicht funktioniert)
    // ------------------------------------------------------------------
    case 'recordFeedback':
        require_device_id($deviceId);
        $domain     = sanitize_domain($body['domain']      ?? '');
        $buttonType = sanitize_enum($body['button_type']   ?? '', ['intro','recap','credits','ads','next']);
        $selector   = substr((string)($body['selector']    ?? ''), 0, 512);
        $success    = !empty($body['success']);
        $sources    = substr((string)($body['sources'] ?? ''), 0, 64);

        if (!$domain || !$buttonType || !$selector) api_error(400, 'domain, button_type and selector required');

        $hits   = $success ? 1 : 0;
        $misses = $success ? 0 : 1;
        $stmt = $pdo->prepare(
            'INSERT INTO selector_feedback (domain, button_type, selector, hits, misses, sources)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               hits    = hits   + VALUES(hits),
               misses  = misses + VALUES(misses),
               sources = VALUES(sources)'
        );
        $stmt->execute([$domain, $buttonType, $selector, $hits, $misses, $sources]);

        // Propagate feedback quality back into the selectors table.
        // Compute hit_rate across ALL feedback for this domain and adjust quality.
        // Only do this when enough data exists (>= 5 total feedback entries).
        $qStmt = $pdo->prepare(
            'SELECT SUM(hits) AS total_hits, SUM(hits + misses) AS total_events
             FROM selector_feedback WHERE domain = ?'
        );
        $qStmt->execute([$domain]);
        $qRow = $qStmt->fetch(PDO::FETCH_ASSOC);
        if ($qRow && (int)$qRow['total_events'] >= 5) {
            $hitRate = (float)$qRow['total_hits'] / (float)$qRow['total_events'];
            // Blend existing quality (80%) with new empirical hit rate (20%) per update
            $pdo->prepare(
                'UPDATE selectors SET quality = quality * 0.8 + ? * 0.2 WHERE domain = ?'
            )->execute([$hitRate, $domain]);
        }
        api_ok(['saved' => true]);
        break;

    // ------------------------------------------------------------------
    //  Submit an exact timing window {from, to} (signal-collector)
    //  Stored separately in timing_windows; fetchTimings returns
    //  clustered windows with confidence — no button required.
    // ------------------------------------------------------------------
    case 'recordTimingWindow':
        require_device_id($deviceId);
        ensure_device_exists($pdo, $deviceId);
        $seriesKey = substr((string)($body['series_key'] ?? ''), 0, 256);
        $eventType = sanitize_enum($body['event_type'] ?? '', ['intro','recap','credits','ads','next']);
        $from      = isset($body['from']) ? (float)$body['from'] : null;
        $to        = isset($body['to'])   ? (float)$body['to']   : null;

        if (!$seriesKey || !$eventType || $from === null || $to === null) {
            api_error(400, 'series_key, event_type, from and to required');
        }
        if ($from < 0 || $to > 7200 || $to <= $from) {
            api_error(400, 'timing values out of range');
        }

        // One row per device per window (see schema_timing_dedup.sql). Repeat
        // sightings raise `observations` instead of inserting another vote, so a
        // single device cannot outweigh the rest of the crowd by volume.
        $stmt = $pdo->prepare(
            'INSERT INTO timing_windows (series_key, event_type, from_time, to_time, device_id)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE observations = observations + 1'
        );
        $stmt->execute([$seriesKey, $eventType, $from, $to, $deviceId]);
        api_ok(['saved' => true]);
        break;

    // ------------------------------------------------------------------
    //  Video-Timing einreichen (crowdsourced Intro-Zeitpunkte)
    // ------------------------------------------------------------------
    case 'recordTiming':
        require_device_id($deviceId);
        ensure_device_exists($pdo, $deviceId);
        $seriesKey = substr((string)($body['series_key']  ?? ''), 0, 256);
        $eventType = sanitize_enum($body['event_type']    ?? '', ['intro','recap','credits','ads','next']);
        $videoTime = isset($body['video_time']) ? (float)$body['video_time'] : null;

        if (!$seriesKey || !$eventType || $videoTime === null) {
            api_error(400, 'series_key, event_type and video_time required');
        }
        // Plausibility check: 0–7200 s (2 h max)
        if ($videoTime < 0 || $videoTime > 7200) api_error(400, 'video_time out of range');

        $stmt = $pdo->prepare(
            'INSERT INTO video_timings (series_key, event_type, video_time, device_id)
             VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([$seriesKey, $eventType, $videoTime, $deviceId]);
        api_ok(['saved' => true]);
        break;

    // ------------------------------------------------------------------
    //  Fetch crowd-sourced timing windows for a series
    // ------------------------------------------------------------------
    case 'fetchTimings':
        $seriesKey = substr((string)($body['series_key'] ?? ''), 0, 256);
        if (!$seriesKey) api_error(400, 'series_key required');

        // Adaptive window: AVG ± 1.5*STDDEV + fixed pad.
        // Window tightens automatically as more crowd-samples arrive.
        // With only 1 sample: falls back to ±15 s around avg.
        $stmt = $pdo->prepare(
            'SELECT event_type,
                    ROUND(AVG(video_time), 1)    AS avg_time,
                    ROUND(STDDEV(video_time), 1) AS stddev_time,
                    COUNT(*)                     AS samples
             FROM video_timings
             WHERE series_key = ?
             GROUP BY event_type'
        );
        $stmt->execute([$seriesKey]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $windows = [];
        foreach ($rows as $r) {
            $avg    = (float)$r['avg_time'];
            $stddev = (float)$r['stddev_time'];
            $n      = (int)$r['samples'];
            // With 1 sample stddev=0; use 15s floor. Spread shrinks as n grows.
            $spread = max(15.0, $stddev * 1.5);
            // Extra conservative pad for small sample counts
            $safePad = $n < 5 ? 15.0 : ($n < 20 ? 8.0 : 4.0);
            $windows[$r['event_type']] = [
                'avg'     => $avg,
                'from'    => max(0.0, round($avg - $spread - $safePad, 1)),
                'to'      => round($avg + $spread + $safePad, 1),
                'samples' => $n,
            ];
        }

        // Merge exact {from, to} windows from timing_windows table.
        // Cluster nearby submissions (within 30 s of each other) and return
        // the top-3 clusters per type ordered by observation count.
        // These are used by the client at higher confidence than statistical
        // point-in-time data — enough observations → skip without any button.
        // Ranked by how many *distinct devices* back a cluster, not by how many
        // rows it has. Only the top three clusters per type are returned, so the
        // ordering decides what every user of the series is told — raw row count
        // let one prolific submitter decide that.
        $winStmt = $pdo->prepare(
            'SELECT event_type,
                    ROUND(AVG(from_time), 1) AS avg_from,
                    ROUND(AVG(to_time),   1) AS avg_to,
                    COUNT(DISTINCT device_id) AS devices,
                    COUNT(*)                  AS cnt
             FROM timing_windows
             WHERE series_key = ?
             GROUP BY event_type, ROUND(from_time / 30), ROUND(to_time / 30)
             ORDER BY event_type, devices DESC, cnt DESC'
        );
        $winStmt->execute([$seriesKey]);
        $exactRows = $winStmt->fetchAll(PDO::FETCH_ASSOC);

        $exactByType = [];
        foreach ($exactRows as $r) {
            $t = $r['event_type'];
            if (!isset($exactByType[$t])) $exactByType[$t] = [];
            if (count($exactByType[$t]) < 3) {
                $exactByType[$t][] = [
                    'from'    => (float)$r['avg_from'],
                    'to'      => (float)$r['avg_to'],
                    'count'   => (int)$r['cnt'],
                    'devices' => (int)$r['devices'],
                ];
            }
        }
        foreach ($exactByType as $type => $exacts) {
            if (isset($windows[$type])) {
                $windows[$type]['exact'] = $exacts;
            } else {
                // Exact windows present but no individual data points
                $windows[$type] = ['exact' => $exacts];
            }
        }

        api_ok(['windows' => $windows]);
        break;

    // ------------------------------------------------------------------
    //  Save settings (settings sync)
    // ------------------------------------------------------------------
    case 'saveSettings':
        require_device_id($deviceId);
        ensure_device_exists($pdo, $deviceId);
        $settings = $body['settings'] ?? null;
        if (!is_array($settings)) api_error(400, 'settings object required');

        $stmt = $pdo->prepare(
            'INSERT INTO device_settings (device_id, settings)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE settings = VALUES(settings)'
        );
        $stmt->execute([$deviceId, json_encode($settings)]);
        api_ok(['saved' => true]);
        break;

    // ------------------------------------------------------------------
    //  Load settings (settings sync)
    // ------------------------------------------------------------------
    case 'loadSettings':
        require_device_id($deviceId);
        $stmt = $pdo->prepare(
            'SELECT settings, updated_at FROM device_settings WHERE device_id = ?'
        );
        $stmt->execute([$deviceId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            api_ok(['found' => false]);
            break;
        }
        api_ok(['found' => true, 'settings' => json_decode($row['settings'], true), 'updated_at' => $row['updated_at']]);
        break;

    // ------------------------------------------------------------------
    //  Submit an error report
    // ------------------------------------------------------------------
    case 'reportError':
        // Rate-limit error reports even without device_id to prevent abuse
        if ($deviceId) {
            check_rate_limit($pdo, $deviceId);
        } else {
            // Anonymous IP-based rate limit: use hashed IP as pseudo device_id
            $anonId = 'anon_' . substr(hash('sha256', $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 24);
            check_rate_limit($pdo, $anonId);
        }
        $domain   = sanitize_domain($body['domain']  ?? '');
        $message  = substr((string)($body['message'] ?? ''), 0, 1024);
        $urlPath  = substr((string)($body['url']     ?? ''), 0, 512);
        $extVer   = substr((string)($body['version'] ?? ''), 0, 16);

        $stmt = $pdo->prepare(
            'INSERT INTO error_reports (device_id, domain, error_message, url_path, ext_version)
             VALUES (?, ?, ?, ?, ?)'
        );
        $stmt->execute([$deviceId ?: null, $domain ?: null, $message, $urlPath, $extVer]);
        api_ok(['saved' => true]);
        break;

    // ------------------------------------------------------------------
    //  GDPR Art. 17 — delete all data for a device
    // ------------------------------------------------------------------
    case 'deleteMyData':
        require_device_id($deviceId);
        // Transactional: clean up all tables that reference device_id.
        // FK ON DELETE CASCADE handles device_settings automatically,
        // but skip_events, selector_feedback, timing_windows, error_reports
        // and rate_limits are deleted explicitly for maximum transparency.
        try {
            $pdo->beginTransaction();
            foreach ([
                'skip_events',
                'selector_feedback',
                'timing_windows',
                'error_reports',
                'rate_limits',
                'device_settings',
            ] as $table) {
                $pdo->prepare("DELETE FROM `{$table}` WHERE device_id = ?")
                    ->execute([$deviceId]);
            }
            // Delete the device itself last (FK constraint) — also removes device_settings via CASCADE
            $pdo->prepare('DELETE FROM devices WHERE id = ?')->execute([$deviceId]);
            $pdo->commit();
        } catch (PDOException $e) {
            $pdo->rollBack();
            api_error(500, 'Deletion failed');
        }
        api_ok(['deleted' => true]);
        break;

    // ------------------------------------------------------------------
    //  Health check
    // ------------------------------------------------------------------
    case 'ping':
        api_ok(['pong' => true, 'ts' => time()]);
        break;

    // ------------------------------------------------------------------
    //  Extension configuration (feature flags, broadcasts, keywords,
    //  domain rules) — fetched on extension startup
    // ------------------------------------------------------------------
    case 'getConfig':
        $cfgDomain = sanitize_domain($body['domain'] ?? '');
        $cfgVer    = substr((string)($body['version'] ?? ''), 0, 16);

        // Feature-Flags + Server-Einstellungen aus admin_settings
        $cfgSettings = [];
        foreach ($pdo->query('SELECT setting_key, setting_value FROM admin_settings')->fetchAll() as $r) {
            $cfgSettings[$r['setting_key']] = $r['setting_value'];
        }

        // Active broadcasts that have started and have not yet expired
        $cfgBroadcasts = $pdo->query(
            "SELECT id, title, body, type, link_url, link_text, icon_override, dismissible
               FROM broadcasts
              WHERE is_active = 1
                AND (expires_at IS NULL OR expires_at > NOW())
                AND (starts_at IS NULL OR starts_at <= NOW())
              ORDER BY created_at DESC"
        )->fetchAll();

        // Admin-defined quick-action buttons
        $cfgQuickActions = $pdo->query(
            "SELECT label, url, icon FROM quick_actions
              WHERE is_active = 1 ORDER BY sort_order, created_at LIMIT 3"
        )->fetchAll();

        // Admin-managed skip keywords
        $cfgKeywords = $pdo->query(
            'SELECT keyword, lang FROM skip_keywords ORDER BY lang, keyword'
        )->fetchAll();

        // Domain-specific rules for the current domain
        $cfgDisabled = false;
        $cfgTrusted  = false;
        $cfgBlockTel = false;
        if ($cfgDomain) {
            $drStmt = $pdo->prepare('SELECT rule_type FROM domain_rules WHERE domain = ?');
            $drStmt->execute([$cfgDomain]);
            foreach ($drStmt->fetchAll() as $r) {
                if ($r['rule_type'] === 'disable_extension')  $cfgDisabled = true;
                if ($r['rule_type'] === 'trusted_domain')     $cfgTrusted  = true;
                if ($r['rule_type'] === 'block_telemetry')    $cfgBlockTel = true;
            }
        }

        // Version gate: check whether the extension is too old
        $minVer = trim($cfgSettings['min_ext_version'] ?? '');
        $versionOk = !$minVer || !$cfgVer ||
                     version_compare($cfgVer, $minVer, '>=');

        api_ok([
            'feature_flags'    => [
                'ai_scan'       => ($cfgSettings['feature_ai_scan']        ?? '1') === '1',
                'cloud_sync'    => ($cfgSettings['feature_cloud_sync']     ?? '1') === '1',
                'timing'        => ($cfgSettings['feature_timing']         ?? '1') === '1',
                'keywords_sync' => ($cfgSettings['feature_keywords_sync']  ?? '1') === '1',
            ],
            'broadcasts'       => $cfgBroadcasts,
            'quick_actions'    => $cfgQuickActions,
            'keywords'         => $cfgKeywords,
            'domain_disabled'  => $cfgDisabled,
            'domain_trusted'   => $cfgTrusted,
            'block_telemetry'  => $cfgBlockTel,
            'version_ok'       => $versionOk,
            'min_ext_version'  => $minVer,
            'changelog'        => $cfgSettings['changelog']        ?? '',
            'announcement'     => $cfgSettings['api_announcement'] ?? '',
            'maintenance'      => ($cfgSettings['maintenance_mode'] ?? '0') === '1',
            'maintenance_message'   => $cfgSettings['maintenance_message']   ?? '',
            'maintenance_scheduled' => $cfgSettings['maintenance_scheduled'] ?? '',
        ]);
        break;

    default:
        api_error(400, 'Unknown action: ' . htmlspecialchars($action, ENT_QUOTES));
}

// ═════════════════════════════════════════════════════════════════════════════
//  Helper functions
// ═════════════════════════════════════════════════════════════════════════════

// db_connect() is defined in config.php (shared with auth.php).
// The guard below prevents a fatal redeclaration if both files are ever included together.
if (!function_exists('db_connect')):
function db_connect(): PDO {
    try {
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                       DB_HOST, DB_PORT, DB_NAME);
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        return $pdo;
    } catch (PDOException $e) {
        if (DEBUG_MODE) {
            api_error(500, 'DB connection failed: ' . $e->getMessage());
        }
        api_error(500, 'Database unavailable');
    }
}
endif; // db_connect guard

function check_rate_limit(PDO $pdo, string $deviceId): void {
    $window = (int)floor(time() / 60);
    try {
        $pdo->prepare(
            'INSERT INTO rate_limits (device_id, window_ts, req_count) VALUES (?, ?, 1)
             ON DUPLICATE KEY UPDATE req_count = req_count + 1'
        )->execute([$deviceId, $window]);

        $stmt = $pdo->prepare(
            'SELECT req_count FROM rate_limits WHERE device_id = ? AND window_ts = ?'
        );
        $stmt->execute([$deviceId, $window]);
        $count = (int)($stmt->fetchColumn() ?: 0);

        if ($count > RATE_LIMIT_PER_MIN) {
            api_error(429, 'Rate limit exceeded');
        }

        // Prune stale entries occasionally
        if (rand(0, 100) === 0) {
            $pdo->prepare('DELETE FROM rate_limits WHERE window_ts < ?')
                ->execute([$window - 5]);
        }
    } catch (PDOException $_) {
        // Don't let rate-limiting errors abort the actual request
    }
}

function ensure_device_exists(PDO $pdo, string $deviceId): void {
    $pdo->prepare(
        'INSERT IGNORE INTO devices (id) VALUES (?)'
    )->execute([$deviceId]);
}

function require_device_id(?string $id): void {
    if (!$id || !preg_match('/^[0-9a-f\-]{32,36}$/i', $id)) {
        api_error(400, 'Valid device_id required');
    }
}

function sanitize_id(string $s): string {
    return preg_replace('/[^0-9a-f\-]/i', '', substr($s, 0, 36));
}

function sanitize_domain(string $s): string {
    // Hostname only, no full URLs
    $s = strtolower(trim($s));
    $s = preg_replace('/[^a-z0-9\.\-]/', '', $s);
    return substr($s, 0, 128);
}

function sanitize_enum(string $s, array $allowed): string {
    return in_array($s, $allowed, true) ? $s : '';
}

function api_ok(array $data): void {
    echo json_encode(['ok' => true] + $data);
    exit;
}

function api_error(int $code, string $message): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $message]);
    exit;
}
