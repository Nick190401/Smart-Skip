# Copilot Instructions for Smart Skip

These are project-specific guidelines for GitHub Copilot and contributors to keep the extension versioning and documentation consistent.

## Versioning policy (SemVer)

- Use Semantic Versioning: MAJOR.MINOR.PATCH
  - PATCH: Bug fixes, small internal tweaks, doc-only changes that affect screenshots or UI copy
  - MINOR: New features, user-visible behavior changes, new UI components, new domain support
  - MAJOR: Breaking changes (settings shape changes, permission changes, or removed features)

## When to bump the version

Bump the version in `manifest.json` whenever any of the following occur:
- Files under `src/` change (content/background/popup/shared logic)
- `manifest.json` capabilities/permissions change
- UI/UX changes that are visible to users
- Any fix with user-visible impact

Small internal refactors that do not change behavior may defer the bump, but prefer bumping PATCH to keep releases traceable.

## What to update with the bump

When you bump the version to X.Y.Z:
1. Update `manifest.json` → `version: "X.Y.Z"`
2. Update the version badge in `README.md` to X.Y.Z
3. Update the "Latest Release" section in `README.md` (version label + date + highlights)
4. If you package a build, add/update the archive in `versionen/` → `Smart-SkipX.Y.Z.zip` (optional for local dev)

## PR checklist (quick)

Before opening a PR that touches core files:
- [ ] Version bumped in `manifest.json`
- [ ] `README.md` badge updated and Latest Release section adjusted
- [ ] Tested on at least one supported platform
- [ ] No uncaught console errors, messaging remains robust

## Notes for Copilot

- Prefer minimal diffs that keep public APIs and file style intact unless change requires otherwise.
- If you change `src/` logic, assume a PATCH bump at least; MINOR for new features.
- Keep storage shape compatible; if you migrate, add background migration + MAJOR/MINOR bump accordingly.
- Maintain i18n keys consistency in `src/shared/language.js` when adding UI text.
