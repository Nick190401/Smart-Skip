-- ============================================================
--  Smart Skip v2 — MySQL Schema
--  Datenbank: u569905441_SmartSkipV2
--  Ausführen in: Hostinger → phpMyAdmin → SQL-Tab
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ------------------------------------------------------------
--  1. Geräte (anonyme UUID pro Installation)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id              VARCHAR(36)  NOT NULL,
  extension_ver   VARCHAR(16)  NOT NULL DEFAULT '',
  user_agent      VARCHAR(256) NOT NULL DEFAULT '',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                               ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  2. Crowdsourced DOM-Selektoren (ein Eintrag pro Domain)
--     Werden zusammengeführt: je mehr Geräte bestätigen, desto
--     höher der quality-Score → bessere Selektoren für alle.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS selectors (
  id               INT          NOT NULL AUTO_INCREMENT,
  domain           VARCHAR(128) NOT NULL,
  series_selector  TEXT,
  episode_selector TEXT,
  skip_selectors   JSON,          -- Array von {selector, type, hits}
  quality          FLOAT        NOT NULL DEFAULT 0.5,
  confirmed_total  INT          NOT NULL DEFAULT 0,
  updated_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_domain (domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  3. Per-Gerät-Einstellungen (Settings-Sync)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_settings (
  device_id  VARCHAR(36) NOT NULL,
  settings   JSON        NOT NULL,
  updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
                         ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id),
  CONSTRAINT fk_ds_device
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  4. Skip-Events / Statistiken
--     Jedes automatische Überspringen wird mit Meta-Daten
--     protokolliert. Keine personenbezogenen Daten.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skip_events (
  id             INT          NOT NULL AUTO_INCREMENT,
  device_id      VARCHAR(36)  NOT NULL,
  domain         VARCHAR(128) NOT NULL,
  button_type    VARCHAR(32)  NOT NULL,   -- intro/recap/credits/ads/next
  confidence     FLOAT,
  ai_source      VARCHAR(16),             -- ai / rule
  video_time     FLOAT,                   -- Sekunde im Video
  series_title   VARCHAR(256),
  episode_info   VARCHAR(256),
  ext_version    VARCHAR(16),
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_se_domain  (domain),
  INDEX idx_se_type    (button_type),
  INDEX idx_se_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  5. Selector-Feedback (Treffer / Fehlschläge je Selektor)
--     Ermöglicht Server-seitiges Crowdsourcing-Scoring.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS selector_feedback (
  id          INT          NOT NULL AUTO_INCREMENT,
  domain      VARCHAR(128) NOT NULL,
  button_type VARCHAR(32)  NOT NULL,
  selector    VARCHAR(512) NOT NULL,
  hits        INT          NOT NULL DEFAULT 0,
  misses      INT          NOT NULL DEFAULT 0,
  sources     VARCHAR(64)  NOT NULL DEFAULT '',  -- "ai,rule"
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sf (domain, button_type, selector(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  6. Video-Timing-Daten (wann erscheint Intro/Recap/…?)
--     Crowdsourced: mehrere Geräte liefern Messpunkte.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS video_timings (
  id           INT          NOT NULL AUTO_INCREMENT,
  series_key   VARCHAR(256) NOT NULL,   -- "domain:Serientitel"
  event_type   VARCHAR(32)  NOT NULL,   -- intro/recap/credits
  video_time   FLOAT        NOT NULL,
  device_id    VARCHAR(36)  NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_vt_series (series_key),
  INDEX idx_vt_type   (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  7. Exakte Timing-Fenster {from, to} (von signal-collector)
--     Jedes Gerät sendet beobachtete Intro-/Recap-/Credits-
--     Fenster. Die API clustert sie und gibt die konfidenten
--     Fenster an alle Clients zurück — kein Button nötig.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timing_windows (
  id           INT          NOT NULL AUTO_INCREMENT,
  series_key   VARCHAR(256) NOT NULL,   -- "domain:Serientitel"
  event_type   ENUM('intro','recap','credits','ads','next') NOT NULL,
  from_time    FLOAT        NOT NULL,   -- Sekunde Anfang
  to_time      FLOAT        NOT NULL,   -- Sekunde Ende
  device_id    VARCHAR(36)  NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_tw_series_type (series_key, event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  8. Fehlerberichte
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS error_reports (
  id             INT          NOT NULL AUTO_INCREMENT,
  device_id      VARCHAR(36),
  domain         VARCHAR(128),
  error_message  TEXT,
  url_path       VARCHAR(512),
  ext_version    VARCHAR(16),
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_er_domain  (domain),
  INDEX idx_er_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  9. Rate-Limiting (einfach: Zähler pro Gerät pro Minute)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  device_id  VARCHAR(36)  NOT NULL,
  window_ts  INT          NOT NULL,   -- UNIX-Minute (UNIX_TIMESTAMP / 60)
  req_count  SMALLINT     NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, window_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
