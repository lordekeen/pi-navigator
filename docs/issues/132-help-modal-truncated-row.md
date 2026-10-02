# Issue #132: `?` Help Modal Truncates Its Longest Row and Cannot Use Extra Width

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Medium
- **Components**: [`help_view.ts`](../../help_view.ts) (`composeHelp`), [`help.ts`](../../help.ts) (`NAVIGATOR_KEYBINDINGS`)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M10](../exploration/ui-skill-compliance-audit.md#medium)

## Description

The help modal's description budget is fixed at **46 cells at every terminal size**:

```ts
// help_view.ts:70-79
const boxW = Math.min(innerW - 2, 66);
…
const descWidth = boxW - 20;
```

Measured with `visibleWidth` (not estimated): exactly **1 of 19** rows exceeds it —
`open` at 62 characters, `"open file / commit diff, or toggle a directory / commit family"` — and
renders as `"open file / commit diff, or toggle a directory / …"`, losing what `Enter` does on
**commits**. That is precisely the row a user opens help to check.

Because the box is capped at 66, widening the terminal never helps: a 200-column terminal renders the
same cut as an 80-column one.

**Fair framing:** the truncation itself is deliberate and test-blessed —
`test/render.test.ts:303` asserts the clean cut and that the ellipsis stays inside the muted style (the
Issue #010 convention). The defect is the **cap**, not the truncation: the help modal exists to state
each key's meaning, so a permanently lost half-sentence is a content bug, not a styling one.

A related fragility sits beside it: the key cell is `keys.padEnd(16)` (`help_view.ts:66`) with exactly
**one** column of headroom — the longest key string, `Tab / Shift+Tab`, measures 15 — so any future
key label silently overflows into the description column.

## Reproduction Steps

1. Open `/navigator` and press `?`.
2. Read the `Enter` row: the description ends in `…` mid-phrase.
3. Resize the terminal to 200 columns and reopen — the same cut.

## Root Cause

The 66-cell box was chosen as a comfortable fixed width for a centred modal; `descWidth = boxW - 20`
then made the description budget a constant. Descriptions grew afterwards (the `open` row was extended
for the commit-diff feature) without revisiting the budget, and no test asserts that help content is
*legible*, only that it is width-safe and cleanly cut.

## Proposed Resolution

Let the modal use the space it has, and/or stop cutting meaning:

- grow the box with the terminal (`boxW = min(innerW - 2, …)` with a ceiling driven by the longest row
  rather than a 66 literal);
- or wrap the description cell onto a second line instead of truncating it, keeping rows aligned under
  the description column;
- keep the #010 clean-cut convention (`""` ellipsis, own styled `…`) for any row that still must cut;
- derive the key-cell width from `NAVIGATOR_KEYBINDINGS` instead of the `16` literal, so the column
  cannot overflow when a label grows.

## Acceptance Criteria

- [ ] No help row loses its meaning at a standard terminal width (80+)
- [ ] The modal uses available width, or wraps the description — not both silently truncating
- [ ] The Issue #010 convention holds for rows that still cut (no bright/reset-wrapped ellipsis)
- [ ] Key-cell width is derived from the table, not a literal (with a test pinning the widest label)
- [ ] Render tests at 120×36, 100×28, 80×24, 60 columns and one wide size
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M10](../exploration/ui-skill-compliance-audit.md) — rules: `navigation-and-focus.md`
  §Help (the modal lists everything; descriptions are the content), `overlays-and-components.md`
  §Text fitting (prose wraps, short fields truncate), `theming.md` (width via host metrics)
- Related: [#010](010-help-modal-bright-ellipsis-leak.md) (the ellipsis convention),
  [#120](120-commit-message-in-diff-view.md) (the feature that lengthened the `open` row)

## Resolution

The modal now uses the width it is given: the box grows to what the rows need (the fixed 66-cell cap is gone, still bounded by the terminal) and the key cell is derived from the binding table instead of a literal 16. The longest help row was also shortened so it fits an 80-column terminal — the width the criterion names — so no row loses meaning at 80+, and none is cut at 100+. Where a terminal is genuinely too narrow, rows still cut with the clean Issue #010 ellipsis.

Verified: `npm run typecheck` and `npm test` green (20 suites).

