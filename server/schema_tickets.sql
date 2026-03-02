-- ============================================================
--  Smart Skip v2 — Tickets (Support / Bug-Meldungen)
--  Ausführen in: Hostinger → phpMyAdmin → SQL-Tab
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------
--  10. Support-Tickets
--      Nutzer (auch nicht-eingeloggte) können Support-Tickets
--      oder Bug-Reports einreichen. Admins können antworten
--      und den Status verwalten.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  id           INT          NOT NULL AUTO_INCREMENT,
  user_id      INT          NULL,                         -- NULL = anonym
  name         VARCHAR(128) NOT NULL DEFAULT '',
  email        VARCHAR(256) NOT NULL,
  category     ENUM('bug','support','feature','other') NOT NULL DEFAULT 'support',
  subject      VARCHAR(256) NOT NULL,
  body         TEXT         NOT NULL,
  status       ENUM('open','in_progress','closed') NOT NULL DEFAULT 'open',
  priority     ENUM('low','normal','high')          NOT NULL DEFAULT 'normal',
  admin_reply  TEXT         NULL,
  admin_id     INT          NULL,
  replied_at   TIMESTAMP    NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_tk_status   (status),
  INDEX idx_tk_category (category),
  INDEX idx_tk_email    (email(64)),
  INDEX idx_tk_user     (user_id),
  INDEX idx_tk_created  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
