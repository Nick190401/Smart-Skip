#!/usr/bin/env bash
#
# Builds the two uploadable archives:
#
#   dist/smart-skip-<version>.zip   the extension package for the Developer
#                                   Dashboard. manifest.json sits at the ZIP
#                                   root, which is what the store requires.
#   dist/smart-skip-store-assets-<version>.zip
#                                   screenshots, promo tiles and the listing
#                                   text. Not uploaded as an archive — the
#                                   dashboard takes images one at a time and
#                                   text by paste — this is for archiving and
#                                   for handing to whoever fills the form.
#
# Staging directory rather than `zip -x`: the exclude list would have to know
# about every directory that must not ship, and a new one added later would
# silently end up in the package. An allow-list cannot leak that way.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION=$(node -p "require('./manifest.json').version")

DIST="$ROOT/dist"
STAGE="$DIST/.stage-ext"
PKG="$DIST/smart-skip-$VERSION.zip"
ASSETS="$DIST/smart-skip-store-assets-$VERSION.zip"

rm -rf "$STAGE" "$PKG" "$ASSETS"
mkdir -p "$STAGE" "$DIST"

# ── extension package ─────────────────────────────────────────────────────────
# Only what the manifest, the popup or the runtime actually loads.
copy() { mkdir -p "$STAGE/$(dirname "$1")"; cp "$ROOT/$1" "$STAGE/$1"; }

copy manifest.json
copy LICENSE

copy background/background.js

for f in config.js platforms.js media-context.js learning-store.js sync-service.js \
         ai-classifier.js dom-scanner.js signal-collector.js timing-skipper.js \
         skipper.js page-interceptor.js; do
  copy "content/$f"
done

for f in defaults.js ai-utils.js i18n.js; do copy "shared/$f"; done

for f in popup.html popup.css popup.js; do copy "popup/$f"; done

# Only the sizes the manifest names. icon-source.svg, icon-256 and the promo
# renders in assets/icons are development artefacts.
for s in 16 32 48 96 128; do copy "assets/icons/icon-$s.png"; done

# Every file the manifest points at has to be in the staging tree, or the store
# rejects the upload with an error that does not name the file.
node - "$STAGE" <<'NODE'
const fs = require('fs'), path = require('path');
const stage = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const refs = new Set([
  ...m.content_scripts.flatMap(c => c.js),
  m.background.service_worker,
  m.action.default_popup,
  ...Object.values(m.action.default_icon),
  ...Object.values(m.icons),
  ...m.web_accessible_resources.flatMap(w => w.resources),
]);
const missing = [...refs].filter(f => !fs.existsSync(path.join(stage, f)));
if (missing.length) {
  console.error('manifest references files that are not staged:\n  ' + missing.join('\n  '));
  process.exit(1);
}
console.log(`  manifest: ${refs.size} referenced files, all staged`);
NODE

( cd "$STAGE" && zip -q -r -X "$PKG" . )
rm -rf "$STAGE"

# ── store assets ──────────────────────────────────────────────────────────────
( cd "$ROOT/assets/store" && zip -q -r -X "$ASSETS" \
    01-auto-skip.png 02-back-to-back.png 03-on-device-ai.png \
    04-no-skip-button.png 05-per-series-control.png \
    promo-small-tile-440x280.png promo-marquee-1400x560.png \
    listing-en.md listing )

echo
echo "  $(basename "$PKG")    $(du -k "$PKG" | cut -f1) KB"
echo "  $(basename "$ASSETS")  $(du -k "$ASSETS" | cut -f1) KB"
