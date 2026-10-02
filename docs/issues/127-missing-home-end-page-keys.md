# Issue #127: No `Home`/`End`/`PageUp`/`PageDown` in Any Mode

- **Status**: Resolved
- **Type**: Enhancement / Keyboard Navigation
- **Severity**: Medium
- **Components**: [`navigator.ts`](../../navigator.ts) (all mode handlers), [`help.ts`](../../help.ts) (`NAVIGATOR_KEYBINDINGS`), [`frame.ts`](../../frame.ts) (hint tables)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M4](../exploration/ui-skill-compliance-audit.md#medium)

## Description

`navigator.ts` contains **zero** references to `Key.home`, `Key.end`, `Key.pageUp` or `Key.pageDown`,
across all six modes (normal/files, normal/git, normal/viewer, filter, search, help). Only the vim half
of each pair exists:

| Intent | Modern key | Classic key | Bound here |
| :--- | :--- | :--- | :--- |
| first / last | `Home` `End` | `g` `G` | `g`/`G` only |
| page | `PageUp` `PageDown` | `Ctrl+U` `Ctrl+D` | `Ctrl+D`/`Ctrl+U` only — and **not in the git pane** |

Movement is fine in both conventions everywhere (`j/k` and arrows), so no mode is stranded for
stepping. What is missing is the jump vocabulary: a `Home`/`End`/`PageDown` user has no key at all,
and the git pane has no half-page jump even in the vim convention.

The host itself ships the vocabulary (`tui.select.pageUp` / `tui.select.pageDown` in
`pi-tui/dist/keybindings.js`), so these are keys the platform already expects to work.

## Reproduction Steps

1. Open the overlay with a tree long enough to scroll.
2. Press `Home` — nothing. `PageDown` — nothing.
3. Focus the git pane, press `Ctrl+D` — nothing (no paging bound there at all).

## Root Cause

The keymap was built from the mockup/plan's key table, which carried the vim/`Ctrl` pairs only. The
"two audiences" rule was applied to *movement* but not to *jumps*.

## Proposed Resolution

Add the modern keys as **aliases** of the existing jumps, not replacements:

- files, git, viewer, help: `Home`/`End` → top/bottom, `PageUp`/`PageDown` → page (or half-page,
  matching the existing `Ctrl+D`/`Ctrl+U` step)
- git pane: add `Ctrl+D`/`Ctrl+U` too, so all three lists agree
- filter/search: `Home`/`End` for first/last match where it is meaningful
- `help.ts` `NAVIGATOR_KEYBINDINGS` (the rendered contract) and the `frame.ts` hint tables updated;
  the footer budget is tight, so the help modal carries the detail and the footer lists only what
  fits per the standard

## Acceptance Criteria

- [ ] `Home`/`End` move to first/last in files, git, viewer and help
- [ ] `PageUp`/`PageDown` page in files, git, viewer and help
- [ ] `g`/`G` and `Ctrl+D`/`Ctrl+U` behave exactly as before (no regression)
- [ ] The git pane gains paging, matching the other panes
- [ ] `NAVIGATOR_KEYBINDINGS` and the hint tables document the new keys; no help/impl drift
- [ ] Tests assert each new alias reaches the same target as its twin
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M4](../exploration/ui-skill-compliance-audit.md) — rule: `navigation-and-focus.md`
  §Two audiences *"Aliases, not replacements. Never ship vim keys and omit the arrows, or vice versa."*
- Related: [#110](110-help-keybinding-description-native-image-drift.md) (help/impl drift class),
  [#004](004-search-navigation-keybindings-inconsistency.md) (key hints per input mode)

## Resolution

`Home`/`End` and `PageUp`/`PageDown` are bound as aliases of the existing first/last and page jumps in the files, git, viewer and help modes, and the git pane gained `Ctrl+D`/`Ctrl+U` so all three lists page alike; `g`/`G` and `Ctrl+D`/`Ctrl+U` behave exactly as before. `NAVIGATOR_KEYBINDINGS`, the help rows and the footer hint tables were updated in the same change, because help/implementation drift had been filed as a real bug here.

Verified: `npm run typecheck` and `npm test` green (20 suites).

