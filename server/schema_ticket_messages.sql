-- Ticket-Nachrichten-Thread
-- Ermöglicht Hin-und-Her-Kommunikation zwischen Nutzer und Support-Team.

CREATE TABLE IF NOT EXISTS ticket_messages (
    id          INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
    ticket_id   INT UNSIGNED    NOT NULL,
    sender_type ENUM('user','admin') NOT NULL DEFAULT 'user',
    sender_name VARCHAR(128)    NOT NULL DEFAULT '',
    body        TEXT            NOT NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_messages_ticket (ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
