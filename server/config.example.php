<?php
/**
 * Smart Skip v2 — Server-Konfiguration (VORLAGE)
 *
 * 1. Diese Datei nach config.php kopieren:
 *      cp config.example.php config.php
 *
 * 2. Die Platzhalter unten durch echte Werte ersetzen.
 *
 * WICHTIG: config.php darf NIEMALS in das Git-Repository eingecheckt werden.
 *          Sie ist in server/.gitignore eingetragen.
 */

// ── Datenbank ─────────────────────────────────────────────────────────────────
define('DB_HOST', 'localhost');
define('DB_PORT', 3306);
define('DB_NAME', 'your_database_name');
define('DB_USER', 'your_database_user');
define('DB_PASS', 'YOUR_DATABASE_PASSWORD');         // ← ersetzen

// ── API-Authentifizierung ─────────────────────────────────────────────────────
// Generiere einen langen, zufälligen String (min. 32 Zeichen), z.B. mit:
//   php -r "echo bin2hex(random_bytes(32));"
//
// Derselbe Wert muss in src-v2/content/sync-service.js als SYNC_API_KEY stehen.
define('API_KEY', 'YOUR_RANDOM_API_KEY_MIN_32_CHARS'); // ← ersetzen

// ── Optionale Einstellungen ───────────────────────────────────────────────────
// Maximale Einträge die vor dem Aufräumen gespeichert werden
define('MAX_SELECTOR_ENTRIES', 500);
define('MAX_TIMING_ENTRIES',   1000);

// ── User-Auth (auth.php) ──────────────────────────────────────────────────────
// Geheimer Schlüssel zum Signieren von JWTs — mindestens 32 zufällige Zeichen.
// Generieren mit:  php -r "echo bin2hex(random_bytes(32));"
// NIEMALS in ein öffentliches Repository einchecken!
define('JWT_SECRET', 'YOUR_JWT_SECRET_MIN_32_CHARS');   // ← ersetzen

// ── SMTP (für OTP-E-Mails) ─────────────────────────────────────────────────
// Port 465 = implizites SSL (SMTPS)
define('SMTP_HOST',      'smtp.hostinger.com');         // ← dein SMTP-Server
define('SMTP_PORT',      465);
define('SMTP_USER',      'YOUR_SMTP_USER');              // ← ersetzen
define('SMTP_PASS',      'YOUR_SMTP_PASSWORD');          // ← ersetzen
define('SMTP_FROM',      'YOUR_FROM_ADDRESS');           // ← ersetzen
define('SMTP_FROM_NAME', 'Smart Skip Support');

// Erlaubte Origins für auth.php (Auth-API nie mit Wildcard betreiben!)
define('AUTH_ALLOWED_ORIGINS', [
    'https://deine-domain.de',
    'http://localhost:5173',  // lokale Entwicklung
]);
