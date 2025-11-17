# Contributing to Smart Skip

Thanks for your interest in improving Smart Skip! This document outlines how to contribute effectively and keep releases tidy.

## Development quick start

1. Clone the repo and load the extension temporarily in Firefox (about:debugging → This Firefox → Load Temporary Add-on → select `manifest.json`).
2. Make changes in `src/` and reload the temporary add-on.
3. Test on at least one supported platform (e.g., Netflix).

## Code style and practices

- Follow existing patterns in `src/content/skipper.js`, `src/background/background.js`, and `src/popup/`.
- Avoid heavy refactors without need. Keep diffs minimal and focused.
- Add comments/JSDoc for new functions and non-obvious logic.
- Use safe messaging wrappers to avoid uncaught exceptions in MV3.

## Versioning policy (SemVer)

- We use Semantic Versioning: MAJOR.MINOR.PATCH
  - PATCH: bug fixes and small changes
  - MINOR: new features and user-visible behavior changes
  - MAJOR: breaking changes (e.g., storage shape, permissions)

Whenever you change core behavior or UI, bump the version in `manifest.json` and update the docs:

- `manifest.json` → `version`
- `README.md` → version badge and Latest Release section
- Optional: add a packaged archive to `versionen/` (for manual distribution)

## Pull requests

Include a short summary and screenshots if UI changes.

Please ensure:
- [ ] Version bumped in `manifest.json` if core files changed
- [ ] README badge and Latest Release updated
- [ ] Tested on at least one streaming platform
- [ ] No console errors and messaging is stable

## Reporting issues and requesting features

Open a GitHub Issue with steps to reproduce (for bugs) or a clear problem statement (for features). Attach screenshots or short clips when helpful.
