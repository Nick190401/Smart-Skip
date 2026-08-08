# Chrome Web Store listing — Smart Skip (EN)

The Developer Dashboard fields are **plain text**. They preserve the line breaks you paste and
do not reflow, so a paragraph that arrives hard-wrapped renders as a ragged column in the
store. Every file in [`listing/`](listing/) is therefore written one paragraph per line:
open it, select all, paste. Nothing to reformat, nothing to strip.

Do not paste from this file — it is the index, and its own text is wrapped for reading.

## Which file goes in which field

| Dashboard field | File | Used |
| --- | --- | --- |
| Store listing → Item name | [`listing/name.txt`](listing/name.txt) | 52 / 75 |
| Store listing → Summary | [`listing/short-description.txt`](listing/short-description.txt) | 120 / 132 |
| Store listing → Description | [`listing/description.txt`](listing/description.txt) | 4 437 / 16 000 |
| Privacy → Single purpose | [`listing/single-purpose.txt`](listing/single-purpose.txt) | 379 |
| Privacy → `storage` justification | [`listing/justify-storage.txt`](listing/justify-storage.txt) | 475 |
| Privacy → `tabs` justification | [`listing/justify-tabs.txt`](listing/justify-tabs.txt) | 366 |
| Privacy → `activeTab` justification | [`listing/justify-activetab.txt`](listing/justify-activetab.txt) | 257 |
| Privacy → host permission justification | [`listing/justify-host-permissions.txt`](listing/justify-host-permissions.txt) | 590 |
| Privacy → remote code justification | [`listing/justify-remote-code.txt`](listing/justify-remote-code.txt) | 416 |

**Category:** Entertainment (secondary: Productivity, if offered).

Run [`node assets/store/listing/check.js`](listing/check.js) after any edit. It checks each
file against its field limit, rejects CRLF, and fails on hard-wrapped paragraphs — the failure
mode that is invisible in an editor and obvious in the store.

## Data usage checkboxes

Tick these **only if the opt-in sharing feature ships**:

- **Website content** — yes. On opt-in, the subtitle line active at the moment of a skip, the
  visible button text, and the series/episode title read from the player are transmitted.
- **User activity** — yes. Which segment was skipped, on which domain, at which position.
- **Personally identifiable information** — no.
- **Health, financial, authentication, personal communications, location** — no.

Then certify: data is not sold, is not used for anything unrelated to the item's single
purpose, and is not used for creditworthiness or lending.

## Item name vs. manifest

`manifest.json` says `Smart Skip v2`. The store name and the manifest name do not have to
match, but a version number inside a visible product name ages badly — hence the proposed
store name without it.

## Two things to fix before submitting

**1. `scripting` is declared but never called.** `grep -rn "chrome.scripting"` finds nothing,
and there is no `executeScript` or `insertCSS` anywhere. Unused permissions are a routine
review rejection. Remove it from `manifest.json`.

**2. The in-product consent screen under-discloses.** The consent dialog lists three items:
anonymous device ID, which buttons were detected and clicked, and video timestamps. What
`recordEvent` actually transmits on opt-in also includes the series title, the episode label,
the visible button text and its attributes, the active subtitle line, and the user-agent
string — and `saveSettings` mirrors the entire settings object. The listing copy above
discloses all of it, which is the honest position, but it now says more than the consent
screen does. Under GDPR, consent has to be specific about what it covers. Either extend
`consentPoint1`–`consentPoint3` in `shared/i18n.js` to match, or stop sending the fields that
are not needed.
