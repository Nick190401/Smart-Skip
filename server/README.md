# Smart Skip v2 — Server Deployment

## Dateien auf Hostinger hochladen

Lade den Inhalt dieses Ordners in ein **neues Verzeichnis** auf deinem Hostinger-Webspace hoch:

```
public_html/
└── smart-skip-api/
    ├── api.php        ← öffentlich erreichbar
    ├── config.php     ← NUR auf Server, nie in Git!
    └── .htaccess      ← schützt config.php
```

---

## 1. Datenbank einrichten

1. Hostinger → HPanel → **Datenbanken → phpMyAdmin**
2. Wähle die Datenbank `u569905441_SmartSkipV2`
3. Klicke auf **SQL** und führe den kompletten Inhalt von `schema.sql` aus

---

## 2. config.php anpassen

Öffne `config.php` und trage ein:

```php
define('DB_PASS', 'DEIN_ECHTES_DATENBANKPASSWORT');
define('API_KEY',  'EIN_LANGER_ZUFÄLLIGER_STRING');
```

Für `API_KEY` empfiehlt sich ein 32+ Zeichen langer zufälliger String.  
Beispiel-Generierung im Terminal: `openssl rand -hex 32`

---

## 3. sync-service.js in der Extension anpassen

Öffne `src-v2/content/sync-service.js` und trage die gleichen Werte ein:

```js
const SYNC_API_BASE = 'https://DEINE-HOSTINGER-DOMAIN.DE/smart-skip-api/api.php';
const SYNC_API_KEY  = 'GLEICHER_STRING_WIE_IN_CONFIG_PHP';
```

> ⚠️  `SYNC_API_KEY` ist kein Geheimnis auf dem selben Level wie das DB-Passwort
> (er steckt im Extension-Code), aber er verhindert unbefugten API-Zugriff.
> Das **Datenbankpasswort** verlässt niemals den Server.

---

## 4. API testen

```bash
curl -s -X POST https://DEINE-DOMAIN.DE/smart-skip-api/api.php \
  -H "Content-Type: application/json" \
  -H "X-SS2-Key: DEIN_API_KEY" \
  -d '{"action":"ping"}'
# Erwartete Antwort: {"ok":true,"pong":true,"ts":...}
```

---

## Was wird gespeichert?

| Tabelle             | Inhalt                              | Personenbezogen? |
|---------------------|-------------------------------------|-----------------|
| `devices`           | Anonyme UUID, Extension-Version     | Nein            |
| `selectors`         | CSS-Selektoren je Domain            | Nein            |
| `device_settings`   | Skip-Einstellungen (per UUID)       | Nein            |
| `skip_events`       | Skip-Typ, Zeitstempel, Domain       | Nein            |
| `selector_feedback` | Treffer/Fehlschlag je Selektor      | Nein            |
| `video_timings`     | Sekunde im Video je Serie + Typ     | Nein            |
| `error_reports`     | Fehlermeldungen (kein Stack-Trace)  | Nein            |
| `rate_limits`       | Anfragen-Zähler (wird regelmäßig gelöscht) | Nein   |

---

## Sicherheitsprinzipien

- **DB-Credentials** nur in `config.php` auf dem Server, nie im Extension-Code
- **config.php** via `.htaccess` von außen geblockt
- **API-Key** als einfacher Abuse-Schutz (im Extension-Code, aber rotierbar per Update)
- **Rate-Limiting**: max. 120 Requests/Gerät/Minute
- **Input-Validierung**: alle Parameter werden sanitized/escaped
- **Keine personenbezogenen Daten**: nur anonyme UUID + technische Metadaten
