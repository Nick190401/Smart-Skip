-- Smart Skip v2 — Ticket attachments
-- Run after schema_tickets.sql and schema_ticket_messages.sql

CREATE TABLE IF NOT EXISTS ticket_attachments (
    id            INT UNSIGNED     AUTO_INCREMENT PRIMARY KEY,
    ticket_id     INT UNSIGNED     NULL DEFAULT NULL,   -- NULL until linked to a submitted ticket
    message_id    INT UNSIGNED     NULL DEFAULT NULL,   -- NULL = attached to the ticket body
    original_name VARCHAR(255)     NOT NULL,            -- original filename (display only, never used in paths)
    stored_name   VARCHAR(100)     NOT NULL UNIQUE,     -- UUID-based name on disk
    mime_type     VARCHAR(64)      NOT NULL,
    file_size     INT UNSIGNED     NOT NULL,
    created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_ticket  (ticket_id),
    INDEX idx_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
