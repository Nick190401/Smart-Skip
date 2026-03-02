-- ============================================================
--  Smart Skip v2 — User Accounts Migration
--  In phpMyAdmin → SQL-Tab ausführen (ergänzend zu schema.sql)
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------
--  10. Benutzer-Accounts (für die Website)
--      Passwörter werden mit Argon2ID gehasht (PHP password_hash)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INT          NOT NULL AUTO_INCREMENT,
  email          VARCHAR(255) NOT NULL,
  username       VARCHAR(40)  NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  is_admin       TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login     TIMESTAMP    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  11. Rate-Limiting für auth.php (Login/Register Brute-Force-Schutz)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key     CHAR(64)          NOT NULL,
  cnt          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  window_start DATETIME          NOT NULL,
  PRIMARY KEY (rate_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ersten Admin-Account manuell anlegen (Passwort über PHP setzen):
-- UPDATE users SET is_admin = 1 WHERE email = 'deine@email.de';

-- ------------------------------------------------------------
--  12. Admin-Einstellungen (Key-Value-Store für Server-Toggles)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_settings (
  setting_key   VARCHAR(64) NOT NULL,
  setting_value TEXT        NOT NULL DEFAULT '',
  updated_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Standard-Werte einfügen (werden nicht überschrieben, falls schon vorhanden)
INSERT IGNORE INTO admin_settings (setting_key, setting_value) VALUES
  ('registration_open',    '1'),
  ('maintenance_mode',     '0'),
  ('api_announcement',     ''),
  ('min_ext_version',      ''),
  ('changelog',            ''),
  ('feature_ai_scan',      '1'),
  ('feature_cloud_sync',   '1'),
  ('feature_timing',       '1'),
  ('feature_keywords_sync','1'),
  ('maintenance_message',   ''),
  ('maintenance_scheduled',  '');

-- ------------------------------------------------------------
--  13. Broadcasts / Push-Nachrichten (Admin → alle Extensions)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broadcasts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title          VARCHAR(120) NOT NULL,
  body           TEXT         NOT NULL,
  type           ENUM('info','warning','error','success') NOT NULL DEFAULT 'info',
  starts_at      DATETIME     NULL     DEFAULT NULL,
  expires_at     DATETIME     NULL     DEFAULT NULL,
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  link_url       VARCHAR(500) NULL     DEFAULT NULL,
  link_text      VARCHAR(100) NULL     DEFAULT NULL,
  icon_override  VARCHAR(100) NULL     DEFAULT NULL,
  dismissible    TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  14. Skip-Keywords (vom Admin verwaltete Keyword-Liste)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skip_keywords (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  keyword    VARCHAR(100) NOT NULL,
  lang       CHAR(5)      NOT NULL DEFAULT 'all',
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_kw (keyword, lang)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  14b. Quick-Actions (Admin-definierte Popup-Buttons, max 3)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quick_actions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  label      VARCHAR(50)  NOT NULL,
  url        VARCHAR(500) NOT NULL,
  icon       VARCHAR(50)  NOT NULL DEFAULT '🔗',
  sort_order TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------
--  15. Domain-Regeln (Blocklist / Disable / Trusted)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domain_rules (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain     VARCHAR(128) NOT NULL,
  rule_type  ENUM('block_telemetry','disable_extension','trusted_domain') NOT NULL,
  note       VARCHAR(255) NOT NULL DEFAULT '',
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_dr (domain, rule_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
