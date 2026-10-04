# Issue #141: Commit-Diff View Keeps the Previous Theme's Colours After a Theme Switch

- **Status**: Open
- **Type**: Bug / Theming
- **Severity**: Medium
- **Component(s)**: [../../session.ts](../../session.ts), [../../navigator.ts](../../navigator.ts), [../../viewer.ts](../../viewer.ts)
- **Found by**: orchestrator while implementing [#136](136-viewer-cache-stale-syntax-theme.md)

## Description

[#136](136-viewer-cache-stale-syntax-theme.md) makes the *file* viewer repaint on a theme
switch: `ViewerFile` retains the pre-highlight source (`styleText`) and the style key it was
highlighted under (`styleKey`), and `restyleViewerFile` re-runs `highlightCode` when the key
is stale. A `kind: "diff"` `ViewerFile` has neither field, so `restyleViewerFile` no-ops on it
and the commit-diff view keeps the previous theme's `styleDiffLines` / `styleCommitMessage`
colours until the commit is reopened.

The diff pipeline bakes the theme in exactly as the file pipeline does, but at a different
site: `session.ts` `loadCommit` applies `styleCommitMessage(diff.message, deps.theme)` and
`styleDiffLines(diff.lines, deps.theme)`, where `deps.theme` is the `NavigatorTheme` whose
closures read pi's live theme proxy. So re-running the styling would pick up the new theme —
what is missing is only the retained raw material (message + plain diff lines) and a restyle
branch for diffs.

## Reproduction Steps

1. Open `/navigator`, focus the git pane, press Enter on a commit to open its diff.
2. Switch the pi theme.
3. Observe: frame, borders and search marks repaint; the diff's `+`/`-`/`@@` colours and the
   commit message do not. Pressing `r` reloads the diff and repaints it.

## Root Cause

Diff lines are styled once in `session.ts` `loadCommit` and held as already-styled strings in
the overlay's `viewFile`. `navigator.invalidate()` re-derives everything downstream of those
strings but cannot re-run `styleDiffLines`/`styleCommitMessage`, and the raw input is dropped.
Diffs are not in `viewerCache`, so the #136 cache-restyle mechanism never sees them either.

## Proposed Resolution (not yet designed)

Retain the raw styling input on diff `ViewerFile`s (plain diff lines + message, or a dedicated
`styleText`-like field) and extend the invalidate/restyle path with a diff branch that re-runs
`styleDiffLines` + `styleCommitMessage` under the current theme. Decide whether that lives in
`restyleViewerFile` (which would then need the `NavigatorTheme`, changing its signature) or in
a session-level helper called from the overlay's invalidate. Bounded by the existing diff caps
(`MAX_HIGHLIGHT_BYTES` / `MAX_HIGHLIGHT_LINES`), so retention cost matches the file viewer's.

## Acceptance Criteria

- [ ] A theme switch repaints an open commit diff without reopening the commit
- [ ] The invalidate path still performs no git reads
- [ ] Regression test: style a diff under theme A, switch to B, assert the rendered rows use B
- [ ] `npm run typecheck` and `npm test` green

## References

- [#136](136-viewer-cache-stale-syntax-theme.md) — the file-viewer half (the mechanism this
  issue extends)
- [#120](120-commit-message-in-diff-view.md) — where `styleCommitMessage` joined the diff path
- `docs/plans/commit-detail-family-tree-v3-plan.md` — the diff pipeline's design
