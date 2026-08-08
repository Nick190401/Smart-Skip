-- ═══════════════════════════════════════════════════════════════════════════
--  Smart Skip v2 — device binding, per-device votes, write caps
--
--  Rationale: the API key ships inside the extension and is readable by anyone
--  who unzips the store package, so it proves nothing. Every defence that
--  assumed "one caller = one device_id" was therefore free to bypass — a caller
--  simply invents a new UUID per request.
--
--  This migration makes a device identity cost something (a server-issued
--  secret), records who cast each vote, and lets the read paths require a
--  quorum of *bound* devices before crowd data is served to anyone.
--
--  Safe to run on a live database: every statement is additive, existing rows
--  keep working, and nothing is dropped except one index that is immediately
--  replaced by a wider one.
--
--  Apply:  mysql -u USER -p DBNAME < schema_device_binding.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Device binding (trust on first use) ─────────────────────────────────
--  `secret` holds a SHA-256 hash, never the token itself: a database dump must
--  not hand out the ability to impersonate every device in it.
ALTER TABLE devices
  ADD COLUMN secret   CHAR(64)  NULL DEFAULT NULL AFTER id,
  ADD COLUMN bound_at TIMESTAMP NULL DEFAULT NULL AFTER secret;

-- ── 2. Per-device selector feedback ────────────────────────────────────────
--  The old unique key was (domain, button_type, selector), so every device's
--  feedback collapsed into one row and five submitted misses were enough to
--  push a working selector below the 20 % hit-rate threshold and delete it from
--  what every user receives. Votes are now attributed, and the read path counts
--  distinct bound devices instead of trusting a running total.
ALTER TABLE selector_feedback
  ADD COLUMN device_id VARCHAR(36) NULL DEFAULT NULL AFTER domain,
  ADD COLUMN verified  TINYINT(1)  NOT NULL DEFAULT 0;

ALTER TABLE selector_feedback DROP INDEX uq_sf;
ALTER TABLE selector_feedback
  ADD UNIQUE KEY uq_sf (domain, button_type, selector(255), device_id);
ALTER TABLE selector_feedback
  ADD INDEX idx_sf_lookup (domain, verified);

-- ── 3. Mark crowd votes as bound / unbound ─────────────────────────────────
--  Existing rows stay verified = 0. They keep working locally for whoever
--  submitted them, but they no longer count toward the quorum that decides what
--  is served to everyone — which is the point.
ALTER TABLE timing_windows ADD COLUMN verified TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE video_timings  ADD COLUMN verified TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE timing_windows ADD INDEX idx_tw_quorum (series_key, event_type, verified);
ALTER TABLE video_timings  ADD INDEX idx_vt_quorum (series_key, event_type, verified);

-- ── 4. Per-domain daily write cap ──────────────────────────────────────────
--  A separate table rather than reusing rate_limits: that one is keyed on
--  minute windows and its pruning sweep would delete day-scoped rows on sight.
CREATE TABLE IF NOT EXISTS domain_write_caps (
  domain     VARCHAR(128) NOT NULL,
  day        DATE         NOT NULL,
  writes     INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── 5. Housekeeping ────────────────────────────────────────────────────────
--  deleteMyData referenced selector_feedback.device_id, which did not exist —
--  the DELETE threw, the transaction rolled back, and the endpoint answered
--  500 for every user who ever pressed "delete my cloud data". Step 2 adds the
--  column, so that statement now resolves. video_timings was missing from the
--  deletion list entirely and is added in api.php alongside this migration.
