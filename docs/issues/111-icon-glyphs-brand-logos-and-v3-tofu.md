# Issue #111: Icon Glyphs Show Product Logos (Apple for Images, Ansible for Unmapped Files) and Four Slots Render as Tofu

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Low
- **Component**: [`icons.ts`](file:///home/jhonny/Sources/pi-navigator/icons.ts#L18-L122)

## Description

Every glyph in the icon table was audited against the authoritative Nerd Fonts
v3 registry (`glyphnames.json`, 3.5.1, 10,995 glyphs — generated from the
patched fonts, so absence there means absence from the font). Two defects
surfaced.

**1. Product logos standing in for file types.** The comment on each line named
the *intended* meaning while the codepoint was something else entirely, so
nothing looked wrong in review:

| Codepoint | Registry name | Used for | Rendered as |
| :--- | :--- | :--- | :--- |
| `\uf302` | `linux-apple` | png jpg jpeg gif webp ico bmp avif | the Apple logo |
| `\ue723` | `dev-ansible` | **the generic fallback** | the Ansible logo on every unmapped file |
| `\ue74c` | `dev-grunt` | js mjs cjs | the Grunt build tool |
| `\ue731` | `dev-appwrite` | vue | the Appwrite logo |

**2. Four slots rendered as tofu.** These codepoints are legacy v2 Material
Design Icons values whose ranges Nerd Fonts v3 deleted outright — `f3e0-f3ff`
and `f600-fdff` contain **zero** glyphs in v3.5.1, so they drew nothing on any
v3-patched font:

| Codepoint | Used for |
| :--- | :--- |
| `\uf81a` | cs |
| `\uf72f` | svg |
| `\uf3e2` | lock |
| `\uf718` | license |

Secondary ambiguity (no glyph was wrong, but distinct types were
indistinguishable): yml/yaml shared `\ue60b` — officially `seti-json` **and**
`seti-less` — the whole css family shared `dev-css3`, `.editorconfig` wore a
bookmark (`oct-bookmark`), and toml wore the generic `seti-config`.

## Root Cause

The table is hand-curated and the preview glyph in each comment *is* the
codepoint, but the trailing name was written by hand from intent. A v2-era
codepoint therefore kept a v2-era label: `png: "\uf302", // image` reads
correctly while drawing an apple, and a codepoint whose range v3 deleted
previews as blank, which reads as "no icon yet" rather than "wrong codepoint".
Nothing at runtime can catch either case — pi-tui has no font-capability probe
and icons are explicitly opt-in, so the table is the only source of truth.

## Proposed Fix

Replace every affected codepoint with one verified present in v3, and record
the **registry name** (not an intent label) next to each glyph so the next
audit is a read, not an investigation:

| Slot | Was | Now | Registry name |
| :--- | :--- | :--- | :--- |
| images (8) | `\uf302` apple | `\uf1c5` | `fa-file_image` |
| generic fallback | `\ue723` ansible | `\uf016` | `fa-file_o` |
| js/mjs/cjs | `\ue74c` grunt | `\ue781` | `dev-javascript` |
| vue | `\ue731` appwrite | `\ue8dc` | `dev-vuejs` |
| cs | `\uf81a` tofu | `\ue7b2` | `dev-csharp` |
| svg | `\uf72f` tofu | `\ue698` | `seti-svg` |
| lock | `\uf3e2` tofu | `\uf023` | `fa-lock` |
| license | `\uf718` tofu | `\uf24e` | `fa-balance_scale` |
| yml/yaml | `\ue60b` json/less | `\ue6a8` | `seti-yml` |
| scss/sass | `\ue749` css3 | `\ue74b` | `dev-sass` |
| less | `\ue749` css3 | `\ue758` | `dev-less` |
| toml | `\ue615` config | `\ue6b2` | `custom-toml` |
| .editorconfig | `\uf461` bookmark | `\ue615` | `seti-config` |

`\uf1c5` keeps the images consistent with the sibling `fa-file_lines` (txt/log)
and `fa-file_pdf`, and `\uf016` is a blank document — distinct from the
line-filled `fa-file_lines`. Deliberately unchanged: `.editorconfig`'s
neighbouring `.gitignore`/`.gitattributes` (`fa-git`), and `dev-rust` for `.rs`
(its logo is a gear and can read as "settings", but there is no better Rust
glyph in v3).

## Acceptance Criteria

- [x] No glyph in the table is a product logo for an unrelated file type.
- [x] No glyph falls in a range Nerd Fonts v3 deleted (`f3e0-f3ff`, `f600-fdff`).
- [x] yml/yaml, css/scss/sass/less, and toml each carry a distinct, correct glyph.
- [x] Every codepoint is verified present in `glyphnames.json` 3.5.1.
- [x] `test/icons.test.ts` pins the corrected slots and guards the deleted ranges.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

`icons.ts` now carries registry-accurate names beside every glyph, and the
table header documents the rule (the preview glyph *is* the codepoint; do not
paste codepoints from a v2 cheatsheet) plus the two deleted ranges.

The guard is structural rather than four pinned slots: `icons.ts` exports the
derived `ICON_GLYPHS` list (every glyph the map can emit), and
`test/icons.test.ts` asserts none of them lands in `f3e0-f3ff` or `f600-fdff`.
A future contributor who pastes a v2 codepoint gets a failing test naming the
glyph and its codepoint instead of an invisible icon.

Verified against Nerd Fonts v3.5.1 (`glyphnames.json`, 10,995 glyphs) plus a
per-block occupancy check confirming both deleted ranges are empty. Suite:
19 files / 643 cases (was 639).
