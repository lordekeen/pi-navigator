# Issue #113: Git Group Rows Ignore `leftW`, Clipping the Status-Error Hint

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Low
- **Component**: [`git_view.ts`](file:///home/jhonny/Sources/pi-navigator/git_view.ts#L175-L215) (`buildGitRow`)
- **Found by**: two-axis code review of `e2d8042...HEAD` (Standards axis), 2026-09-22

## Description

`buildGitRow(row, selected, leftW, view)` is handed the pane width, and every
branch honours it — the `file` branch sizes the path with `truncateAndWidth`, and
both commit branches size the subject with `hardTruncate`. The `group` branch does
not:

```typescript
if (row.kind === "group") {
  const tone = /* warning | success | dim | muted */;
  line = " " + tone(row.label);          // `leftW` is never read
}
```

That was invisible for as long as every group label happened to fit under
[`LEFT_COLUMN_MAX = 44`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L166):
`Clean — nothing staged or unstaged` is 35 visible cells, `Staged (N)` and
`Unstaged (N)` are shorter. Issue #107 then added a status-error label —
`git status failed — changes not listed (press r to retry)`, **57 visible
cells**, 58 with the leading space — which is **14 cells over the pane width at
every terminal size**.

The consequence is not a broken layout: [`joinLeftRight`](file:///home/jhonny/Sources/pi-navigator/frame.ts#L124-L133)
hard-truncates the left cell at `width - rightW - 1`, so the overlay still fits
the terminal. The consequence is that **the actionable half of the message is
silently cut**:

```text
" git status failed — changes not listed (pre"     ← what renders
                                 "ss r to retry)"  ← what is lost
```

## Reproduction

1. Make `git status` fail — e.g. corrupt the index (`chmod 000 .git/index`), or
   point `GIT_EXEC_PATH`/a `git` wrapper at something that exits non-zero for
   `status` only.
2. Open `/navigator` in a repository at any terminal size (120×36 reproduces).
3. The git pane shows the warning group row clipped mid-word; `(press r to retry)`
   never renders.

`#107`'s Resolution claimed "`padTo` hard-truncates, so the longer label stays
width-safe at every pane width" — `padTo` is applied to the *built* row, but the
join clips the left cell before that, so the row was width-safe and the *label*
was still unreadable. That claim is corrected in the #107 doc.

## Root Cause

The group branch is the one row shape whose text is data-driven rather than
measured-and-fitted, and its missing truncation was masked by the short labels
that existed before #107. Nothing in the render suite exercised the error row, so
the width-safety suite passed while the row exceeded its pane by 14 cells.

## Potential Solution

Truncate the **plain** label to `leftW - 1` *before* styling, reserving one cell
for the repo's own ellipsis (the AGENTS.md / Issue #010 convention: hard-cut plain
text with an empty ellipsis, then re-style — never truncate an already-styled
string, whose injected `\x1b[0m` resets break the surrounding style). The
existing trailing `padTo(line, leftW)` then makes the row exactly `leftW` wide.

## Acceptance Criteria

- [x] A group row is never wider than `leftW`, for any label length or pane width.
- [x] A label that does not fit ends in `…`; a label that fits is unchanged.
- [x] The #107 error hint degrades to `(press r to retry)`-visible-or-ellipsis, never a silent mid-word cut.
- [x] `Clean — nothing staged or unstaged` and `Staged (N)` render byte-identically to before.
- [x] Width-safety coverage at 120×36 / 100×28 / 80×24 / narrow widths includes the git status-error row.

## Resolution

`buildGitRow`'s group branch now sizes its label:

```typescript
const room = Math.max(1, leftW - 1);
let label = row.label;
if (visibleWidth(label) > room) {
  label = hardTruncate(label, Math.max(1, room - 1)) + "\u2026";
}
line = " " + tone(label);
```

Plain-text-first ordering means no styled string is ever truncated, so no
reset-injection class bug is possible. Tests: `test/git_view.test.ts` pins the row
width across a spread of `leftW` values (44/20/10/4/1) plus the ellipsis and the
unchanged short-label case; `test/render.test.ts` drives the real overlay with a
`GitState` carrying `error` and empty change lists and asserts every rendered row
fits the overlay at the suite's sizes. Both were verified to fail against the
pre-fix code.
