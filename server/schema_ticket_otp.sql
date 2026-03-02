-- Einmal-Codes (OTP) für den passwortlosen Ticket-Zugang
CREATE TABLE IF NOT EXISTS ticket_otp (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email      VARCHAR(254) NOT NULL,
    code       CHAR(6)      NOT NULL,
    expires_at TIMESTAMP    NOT NULL,
    used_at    TIMESTAMP    NULL DEFAULT NULL,
    created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_otp_lookup (email, code, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
