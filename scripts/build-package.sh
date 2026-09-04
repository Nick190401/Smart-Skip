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
# Usage:
#   scripts/build-package.sh              bump the patch level, then build
#   scripts/build-package.sh minor        2.1.0 -> 2.2.0
#   scripts/build-package.sh major        2.1.0 -> 3.0.0
#   scripts/build-package.sh 2.4.1        set an explicit version
#   scripts/build-package.sh --no-bump    rebuild the version in the manifest
#
# The bump is the default because the Developer Dashboard refuses an upload
# whose version already exists — a package built at the version currently in
# the store is dead on arrival, so producing one silently is the wrong default.
#
# Staging directory rather than `zip -x`: the exclude list would have to know
# about every directory that must not ship, and a new one added later would
# silently end up in the package. An allow-list cannot leak that way.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

DIST="$ROOT/dist"
STAGE="$DIST/.stage-ext"
ASSET_STAGE="$DIST/.stage-assets"
MANIFEST_BACKUP=""
# The archives are built under a temporary name and moved into place at the very
# end, so a build that fails half way leaves the previous package where it was
# rather than deleting a good archive and putting nothing back.
PKG_TMP="$DIST/.building-pkg.zip"
ASSETS_TMP="$DIST/.building-assets.zip"

# A failed build must not leave the working tree on a version that was never
# packaged: the next run would bump past it and skip a number in the store.
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ] && [ -n "$MANIFEST_BACKUP" ] && [ -f "$MANIFEST_BACKUP" ]; then
    mv -f "$MANIFEST_BACKUP" "$ROOT/manifest.json"
    echo "  build failed — manifest.json rolled back" >&2
  fi
  rm -f "$MANIFEST_BACKUP" "$PKG_TMP" "$ASSETS_TMP"
  rm -rf "$STAGE" "$ASSET_STAGE"
  exit "$rc"
}
trap cleanup EXIT

# ── preflight ─────────────────────────────────────────────────────────────────
# Checked before anything is written, so a missing tool costs a second rather
# than a half-built dist/ and a bumped manifest.
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v zip  >/dev/null 2>&1 || {
  echo "zip is required and is not on PATH." >&2
  echo "Git for Windows does not ship it; install it via Git Bash's package" >&2
  echo "manager, MSYS2 (pacman -S zip), or scoop/choco (choco install zip)." >&2
  exit 1
}

# config.js is gitignored, so a fresh clone has the template with placeholder
# credentials in it. Shipping that produces an extension that installs cleanly
# and then fails every server call.
if grep -q 'YOUR_RANDOM_API_KEY\|your-server\.example\.com' content/config.js 2>/dev/null; then
  echo "content/config.js still holds template placeholders — fill it in first." >&2
  exit 1
fi

# ── version ───────────────────────────────────────────────────────────────────
CURRENT=$(node -p "require('./manifest.json').version")
BUMP="${1:-patch}"

case "$BUMP" in
  --no-bump)
    VERSION="$CURRENT"
    ;;
  major|minor|patch)
    VERSION=$(node - "$CURRENT" "$BUMP" <<'NODE'
const [current, kind] = process.argv.slice(2);
const parts = current.split('.').map(Number);
while (parts.length < 3) parts.push(0);
if (parts.length > 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 65535)) {
  console.error(`manifest version "${current}" is not a valid Chrome version string`);
  process.exit(1);
}
const i = { major: 0, minor: 1, patch: 2 }[kind];
parts[i]++;
for (let j = i + 1; j < parts.length; j++) parts[j] = 0;
process.stdout.write(parts.join('.'));
NODE
)
    ;;
  *)
    # An explicit version. Chrome accepts one to four dot-separated integers
    # in 0..65535, and rejects leading zeros — validate here rather than
    # discovering it at upload time.
    VERSION=$(node - "$BUMP" <<'NODE'
const v = process.argv[2];
if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(v)
    || v.split('.').some(n => Number(n) > 65535)) {
  console.error(`"${v}" is not a valid version. Use major|minor|patch, `
    + `--no-bump, or one to four integers 0-65535 (e.g. 2.4.1).`);
  process.exit(1);
}
process.stdout.write(v);
NODE
)
    ;;
esac

if [ "$VERSION" != "$CURRENT" ]; then
  MANIFEST_BACKUP="$DIST/.manifest.bak"
  mkdir -p "$DIST"
  cp "$ROOT/manifest.json" "$MANIFEST_BACKUP"
  # Rewrite the one field rather than re-serialising: JSON.stringify would
  # reformat the whole manifest and bury the real change in the diff.
  node - "$VERSION" <<'NODE'
const fs = require('fs');
const next = process.argv[2];
const src  = fs.readFileSync('manifest.json', 'utf8');
const re   = /("version"\s*:\s*")[^"]*(")/;
if (!re.test(src)) { console.error('manifest.json has no version field'); process.exit(1); }
fs.writeFileSync('manifest.json', src.replace(re, `$1${next}$2`));
NODE
  echo "  version:  $CURRENT -> $VERSION"
else
  echo "  version:  $VERSION (unchanged)"
fi

PKG="$DIST/smart-skip-$VERSION.zip"
ASSETS="$DIST/smart-skip-store-assets-$VERSION.zip"

rm -rf "$STAGE" "$ASSET_STAGE" "$PKG_TMP" "$ASSETS_TMP"
mkdir -p "$STAGE" "$ASSET_STAGE" "$DIST"

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
# rejects the upload with an error that does not name the file. The staged
# scripts are also parsed here — a syntax error otherwise ships as a review
# round trip instead of a build failure.
node - "$STAGE" "$VERSION" <<'NODE'
const fs = require('fs'), path = require('path'), vm = require('vm');
const [stage, expected] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));

if (m.version !== expected) {
  console.error(`staged manifest says ${m.version}, expected ${expected}`);
  process.exit(1);
}

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

const scripts = [...refs].filter(f => f.endsWith('.js'));
for (const f of scripts) {
  try {
    new vm.Script(fs.readFileSync(path.join(stage, f), 'utf8'), { filename: f });
  } catch (err) {
    console.error(`${f} does not parse: ${err.message}`);
    process.exit(1);
  }
}
console.log(`  manifest: ${refs.size} referenced files staged, ${scripts.length} scripts parse`);
NODE

( cd "$STAGE" && zip -q -r -X "$PKG_TMP" . )

# ── store assets ──────────────────────────────────────────────────────────────
# Staged the same way and for the same reason: naming what ships beats
# excluding what must not.
for f in 01-auto-skip.png 02-back-to-back.png 03-on-device-ai.png \
         04-no-skip-button.png 05-per-series-control.png \
         promo-small-tile-440x280.png promo-marquee-1400x560.png \
         listing-en.md; do
  cp "$ROOT/assets/store/$f" "$ASSET_STAGE/$f"
done
cp -r "$ROOT/assets/store/listing" "$ASSET_STAGE/listing"

( cd "$ASSET_STAGE" && zip -q -r -X "$ASSETS_TMP" . )

mv -f "$PKG_TMP" "$PKG"
mv -f "$ASSETS_TMP" "$ASSETS"

echo
echo "  $(basename "$PKG")    $(du -k "$PKG" | cut -f1) KB"
echo "  $(basename "$ASSETS")  $(du -k "$ASSETS" | cut -f1) KB"
echo
echo "  Upload $(basename "$PKG") at"
echo "  https://chrome.google.com/webstore/devconsole -> the item -> Package -> Upload new package"
if [ "$VERSION" != "$CURRENT" ]; then
  echo
  echo "  manifest.json now says $VERSION — commit it so the repo matches the store."
fi
