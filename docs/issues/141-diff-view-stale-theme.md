# Issue #141: Commit-Diff View Keeps the Previous Theme's Colours After a Theme Switch

- **Status**: Resolved
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

## Resolution Design (frozen 2026-10-04)

The #136 pattern one layer down: retain the styling *source* and the key, re-style lazily — no
git read on the invalidate path. The diff pipeline's source is not text but the plain
message + diff lines, and its styler is `diff.ts`, so the composition and its restyle live
there rather than in `restyleViewerFile` (which stays syntax-only and theme-free).

1. **Retain the styling source.** `ViewerFile` gains
   `styleDiff?: { message: { subject: string; body: string[] }; lines: string[] }` — the
   plain material `loadCommit` styled (the structural mirror of `diff.ts`'s `CommitMessage`,
   inlined so `types.ts` keeps its dependency-free direction). Diffs are uncached, so this
   is the only retained copy; bounded by the existing diff caps.
2. **One composer, one restyler in `diff.ts`.** The message/diff assembly currently inline in
   `session.ts` `loadCommit` (message lines, a blank separator only when a diff body follows,
   then styled diff lines) becomes `composeDiffLines(source, T)`; `loadCommit` calls it. The
   new `restyleDiffViewerFile(file, T, styleKey)` returns the same reference when the file is
   not a diff, carries no `styleDiff`, or already matches the key; otherwise it returns a new
   `ViewerFile` with `lines: composeDiffLines(file.styleDiff, T)` and the new key. Pure,
   synchronous, no git access. `NavigatorTheme` stays a parameter — the host's live theme
   proxy is behind it, so re-styling picks up the switch.
3. **The style key covers the diff roles too.** `theme.ts`'s retained-content fingerprint is
   extended from the highlight tokens to the union with the diff composer's roles (`text`,
   `accent`, `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`). One key covers both
   retained-content kinds; over-approximation costs at most one extra no-op-for-nothing
   restyle, under-approximation is the bug class being fixed. The list is renamed to match
   (it is no longer only `highlightCode`'s token set).
4. **`invalidate()` dispatches on kind.** `loadCommit` stamps `styleDiff` and
   `styleKey` on the returned `ViewerFile`; the overlay's invalidate branch calls
   `restyleDiffViewerFile(..., this.T, this.styleKey())` for `kind: "diff"` and
   `restyleViewerFile(..., this.styleKey())` otherwise, before clearing the derived caches
   (a small private helper keeps it to one line at the call site).

Cost profile: a theme switch re-styles the open diff with prefix wrapping only — no
highlighting, no `git show` — and a resize invalidate costs nothing because the key is
unchanged. Diff lines remain uncached, as before.

## Acceptance Criteria

- [x] A theme switch repaints an open commit diff without reopening the commit
- [x] The invalidate path still performs no git reads
- [x] Regression test: style a diff under theme A, switch to B, assert the rendered rows use B
- [x] `npm run typecheck` and `npm test` green

## Resolution

Implemented as designed (2026-10-04), version 0.14.5:

- `ViewerFile` gained `styleDiff` (the plain message + diff lines the view was composed
  from); `session.ts` `loadCommit` stamps it plus `styleKey` and composes through the new
  `diff.ts` `composeDiffLines` (the assembly extracted from `loadCommit`).
- `diff.ts` `restyleDiffViewerFile(file, T, styleKey)` recomposes from the retained source
  under the current theme; same reference when the file is not a diff, carries no source, or
  the key matches.
- `NavigatorOverlay.invalidate()` routes through a private `restyleOpenFile()` that dispatches
  on kind: the diff composer for `kind: "diff"`, `restyleViewerFile` otherwise.
- `theme.ts`'s retained-content fingerprint (`VIEWER_STYLE_TOKENS`) now includes the diff
  roles (`text`, `accent`, `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`) so one key
  covers both retained kinds; the over-approximation is documented.
- Tests (+14; 21 suites / 844 cases): `composeDiffLines` assembly edges (`composeDiffLines`
  separator presence, empty-message/empty-diff/empty-both), `restyleDiffViewerFile`
  recompose and identity semantics, the `loadCommit` stamp, the production-path invalidate
  restyle with `loadCommit` still called once, the resize no-op, and the extended token
  coverage. The navigator theme-switch test was red against the pre-fix dispatch.

Verified: `npm run typecheck` clean; `npm test` 844/844 green across 21 suites.

## References

- [#136](136-viewer-cache-stale-syntax-theme.md) — the file-viewer half (the mechanism this
  issue extends)
- [#120](120-commit-message-in-diff-view.md) — where `styleCommitMessage` joined the diff path
- `docs/plans/commit-detail-family-tree-v3-plan.md` — the diff pipeline's design
