-- ---------------------------------------------------------------------------
--  Smart Skip v2 — one device, one vote per timing window
-- ---------------------------------------------------------------------------
--  timing_windows had no uniqueness constraint, so every submission inserted a
--  new row. fetchTimings ranks clusters by raw row count and returns only the
--  top three per type, which meant volume decided which window every user of a
--  series receives:
--
--    * a single device re-submitting could outvote the genuine cluster and
--      push it out of the top three entirely;
--    * even in normal use, a heavy re-watcher's rows outweighed everyone else's.
--
--  After this migration a device contributes at most one row per window, and
--  repeat sightings are counted in `observations` instead of new rows.
--
--  Apply once:  mysql -u <user> -p <db> < schema_timing_dedup.sql
-- ---------------------------------------------------------------------------

-- 1. device_id must participate in a unique key, so it cannot stay NULL
--    (MySQL treats every NULL as distinct and would not deduplicate them).
UPDATE timing_windows SET device_id = '' WHERE device_id IS NULL;
ALTER TABLE timing_windows
  MODIFY COLUMN device_id VARCHAR(36) NOT NULL DEFAULT '';

-- 2. Bucket the boundaries so near-identical resubmissions collapse together.
--    10 s is well below the 30 s clustering used when reading the data back.
ALTER TABLE timing_windows
  ADD COLUMN from_bucket INT AS (FLOOR(from_time / 10)) STORED,
  ADD COLUMN to_bucket   INT AS (FLOOR(to_time   / 10)) STORED,
  ADD COLUMN observations INT NOT NULL DEFAULT 1;

-- 3. Collapse the duplicates that already exist, keeping the oldest row and
--    carrying the duplicate count into `observations`.
UPDATE timing_windows t
  JOIN (
    SELECT MIN(id) AS keep_id, COUNT(*) AS n
    FROM timing_windows
    GROUP BY series_key, event_type, device_id, from_bucket, to_bucket
  ) d ON t.id = d.keep_id
  SET t.observations = d.n;

DELETE t1 FROM timing_windows t1
  JOIN timing_windows t2
    ON  t1.series_key  = t2.series_key
    AND t1.event_type  = t2.event_type
    AND t1.device_id   = t2.device_id
    AND t1.from_bucket = t2.from_bucket
    AND t1.to_bucket   = t2.to_bucket
    AND t1.id          > t2.id;

-- 4. Enforce it from here on.
ALTER TABLE timing_windows
  ADD UNIQUE KEY uniq_tw_device_window
    (series_key, event_type, device_id, from_bucket, to_bucket);
