/**
 * Verifies the listing text files are paste-ready.
 *
 * The Chrome Web Store description field is plain text and preserves the line
 * breaks it is given — it does not reflow. A paragraph that arrives hard-wrapped
 * at 95 columns therefore renders as a ragged column in the store, so the only
 * safe shape is one paragraph per line and let the store wrap it.
 *
 * Run: node assets/store/listing/check.js
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;

// field file → dashboard limit (null = no published limit)
const LIMITS = {
  'name.txt': 75,
  'short-description.txt': 132,
  'description.txt': 16000,
  'single-purpose.txt': 1000,
  'justify-storage.txt': 1000,
  'justify-tabs.txt': 1000,
  'justify-activetab.txt': 1000,
  'justify-host-permissions.txt': 1000,
  'justify-remote-code.txt': 1000,
};

let problems = 0;

for (const [file, limit] of Object.entries(LIMITS)) {
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) { console.log(`MISSING  ${file}`); problems++; continue; }

  const raw = fs.readFileSync(full, 'utf8');
  if (raw.includes('\r')) { console.log(`CRLF     ${file} — use LF only`); problems++; }

  const text = raw.replace(/\n+$/, '');   // the trailing newline is not pasted
  const len = [...text].length;           // count code points, not UTF-16 units
  const over = len > limit;
  if (over) problems++;

  // Hard-wrap detection: two non-empty lines in a row that are not both bullets
  // and are not a heading followed by its list. A wrapped paragraph always shows
  // up here.
  const lines = text.split('\n');
  const wrapped = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].trim(), b = lines[i + 1].trim();
    if (!a || !b) continue;
    if (b.startsWith('•')) continue;                  // list item after heading or item
    if (a.startsWith('•')) { wrapped.push(i + 2); continue; } // text glued to a list
    wrapped.push(i + 2);
  }
  if (wrapped.length) problems++;

  const longest = Math.max(...lines.map(l => [...l].length));
  console.log(
    `${over || wrapped.length ? 'FAIL' : ' ok '}  ${file.padEnd(30)} ` +
    `${String(len).padStart(5)}/${String(limit).padEnd(5)} chars   ` +
    `longest line ${String(longest).padStart(4)}` +
    (wrapped.length ? `   hard-wrapped at line(s): ${wrapped.join(', ')}` : '')
  );
}

console.log(problems === 0
  ? '\nAll fields paste-ready.'
  : `\n${problems} problem(s) — fix before pasting into the dashboard.`);
process.exit(problems === 0 ? 0 : 1);
