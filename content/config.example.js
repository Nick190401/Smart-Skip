// Smart Skip v2 — Local Configuration (TEMPLATE)
//
// 1. Copy this file to config.js:
//      copy content\config.example.js content\config.js
//
// 2. Replace the placeholder values below with your actual credentials.
//
// 3. Prevent accidental commits (config.js is already in .gitignore, but
//    also run this once to be safe):
//      git update-index --skip-worktree content/config.js
//
// IMPORTANT: config.js must NEVER be committed — it contains your API key.

window.SS2_CONFIG = {
  // URL of your deployed api.php instance
  apiBase: 'https://your-server.example.com/api.php',

  // Must match API_KEY in server/config.php
  // Generate with: php -r "echo bin2hex(random_bytes(32));"
  apiKey: 'YOUR_RANDOM_API_KEY_MIN_32_CHARS',
};
