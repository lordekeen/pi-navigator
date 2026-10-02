# Issue #123: `invalidate()` Leaves Styled Caches Stale, So a Theme Change Keeps the Old Colours

- **Status**: Resolved
- **Type**: Bug / Theming
- **Severity**: High
- **Components**: [`navigator.ts`](../../navigator.ts) (`invalidate`, `rowsCache`, `mdCache`)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 H3](../exploration/ui-skill-compliance-audit.md#high)

## Description

The host tells every component when the theme changes — and this overlay acknowledges the call
without doing the work:

```js
// dist/modes/interactive/interactive-mode.js:757
onThemeChange(() => { this.ui.invalidate(); this.updateEditorBorderColor(); this.ui.requestRender(); });
```

```ts
// navigator.ts:546-549
invalidate(): void { this.cachedWidth = undefined; this.cachedLines = undefined; }
```

The caches that actually hold **styled strings** survive, because they are keyed by data identity
and never by theme:

- `rowsCache` — `{ marked, width, wrap, rows }` (`navigator.ts:246`): display rows produced by
  `highlightCode`, i.e. already styled with the theme in force at load time.
- `mdCache` — `{ file, width, lines }` (`navigator.ts:249`): rendered markdown lines.

Consequence: after a live theme switch, an already-open file keeps the **previous** theme's syntax
and markdown colours until the file is reopened (or the width changes, which drops the width-keyed
caches).

## Reproduction Steps

1. Open `/navigator` and view a source file (syntax highlighting visible).
2. Switch the pi theme while the overlay is open.
3. The viewer keeps the old highlighting; the frame around it repaints correctly.
4. Reopen the file (`Enter` twice, or another file and back) — the new colours appear.

## Root Cause

`invalidate()` was implemented as "drop the composed output", which is sufficient for the frame
(it derives styles inside `render`) but not for the loader output, which is highlighted once at
load time and then memoised. The distinction the standard draws is exactly this one — `invalidate()`
clears **derived render state**, not the data cache.

## Proposed Resolution

Clear the theme-derived render state in `invalidate()`: `rowsCache`, `mdCache`, the marked-file
cache and the search-match line map (they are all derived from styled lines). Keep the **data**
cache (`viewerCache` in `index.ts`) intact — re-highlighting is the cheap part, re-reading and
re-hashing files is not.

## Acceptance Criteria

- [ ] A theme switch repaints open content — including syntax highlighting and rendered markdown
- [ ] The file-content cache (`viewerCache`) is **not** dropped by `invalidate()`
- [ ] `invalidate()` clears only derived render state; a comment says which caches are deliberately kept
- [ ] Regression test: call `invalidate()`, assert the styled caches are cleared and the data cache survives
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 H3](../exploration/ui-skill-compliance-audit.md) — rule: `theming.md`
  *"make `invalidate()` clear derived render state (e.g. a cached markdown buffer), so the next render
  picks up the new theme"* and *"never memoise a styled string across renders"*.
- Host trigger: `pi-coding-agent/dist/modes/interactive/interactive-mode.js:757`

## Resolution

`invalidate()` clears the theme-styled derived render state — composed frame, rows/marked rows, rendered markdown, search state — and keeps the data-derived caches, with the kept-vs-cleared split documented where it lives; the file-content cache (`viewerCache`) is deliberately untouched, as required.

The syntax-highlighting criterion is **transferred to [#136](136-viewer-cache-stale-syntax-theme.md)**: highlighting happens upstream at load time (`viewer.ts`), so no amount of derived-cache clearing can repaint it. That half needs a theme-aware seam and is tracked there.

Verified: `npm run typecheck` and `npm test` green (20 suites).

