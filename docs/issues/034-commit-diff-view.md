# Issue #034: Commit Detail/Diff View + v3 Family-Tree Drift Fix

- **Status**: Resolved
- **Type**: Feature (with drift-resolution of #030)
- **Severity**: Medium
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) / [`types.ts`](file:///home/jhonny/Sources/pi-navigator/types.ts) / [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`diff.ts`](file:///home/jhonny/Sources/pi-navigator/diff.ts) / [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts)

---

## Description

Two coupled changes from `docs/plans/commit-detail-family-tree-v3-plan.md`:

1. **Commit detail/diff view** (the deferred v2 feature): Enter on a commit opens its diff in the existing viewer pane, matching the lazygit/gitui/tig pattern of a flat log + separate detail view.
2. **Drift fixes for the #030 family tree**: `Enter` was the only expand key and `commit-child` rows were non-actionable (`Enter` fell through to a no-op `else return`), the `▸`/`▾` marker was never rendered, and `FAMILY_MAX_DEPTH` truncation was silent. The v3 plan resolves all three with the file pane's collapsible-tree idiom.

## Root cause (drift)

`#030` shipped a deep DFS family: `Enter` on a commit expanded the *whole* ancestor chain to `FAMILY_MAX_DEPTH` in one call. That meant:

- `commit-child` rows had no expand key at all (`handleGitInput` only toggled `commit`), so once a chain was fully expanded you could only collapse the anchor.
- The `▸`/`▾` marker was dropped from both `commit` and `commit-child` rows (the plan §2 said to add it; the implementation never did).
- Truncation at `FAMILY_MAX_DEPTH` was silent — rows past the cap simply vanished.

## Fix

### Feature A — drill-down family tree (file-pane idiom)

- **One level per expand**: `gitRows()` emits only each expanded commit's **direct parents** (depth = anchor depth + 1), computed by a walk over the *current* `gitExpanded` state (`commitDepth`) so collapse correctly resets indents. Expanding a parent in turn reveals its own parents — the recursion becomes user-driven rather than a single deep DFS.
- **Markers**: new `commitMarker()` — `▾` expanded, `▸` has in-history parents, blank for a root. Both `commit` and `commit-child` rows render it, with width accounting (`arrow + indent + marker + hash + sep`).
- **Actionable `commit-child`**: `l`/`→` expands a family (top-level or child); `h`/`←` collapses it, and on a `commit-child` also steps the cursor out to the expanded anchor parent (file-pane parity).
- **No silent cut**: expanding at `FAMILY_MAX_DEPTH` shows a notice `max depth reached — collapse a parent to go deeper`; when `FAMILY_MAX_ROWS` ends the walk mid-anchor, a dim `… more ancestors` group row (cursor-skipped) is emitted.

### Feature B — commit diff view

- **`readCommitDiff`** (`git.ts`): resolves the short hash (`rev-parse --verify --quiet`), reads the body with `git show --no-color --no-renames --first-parent --pretty=format:` (merge commits show their own first-parent delta instead of an empty combined diff), reads stats via `git show --numstat`, caps the body at the viewer caps (`MAX_HIGHLIGHT_BYTES`/`MAX_HIGHLIGHT_LINES`), CR-normalizes, and never throws (bogus hash → `cannot read commit`). Statistics fold into a `notice` like `commit abc1234 · 2 files · +5 −1`.
- **`styleDiffLines`** (`diff.ts`): inline prefix styler — `+`→`T.success`, `-`→`T.error`, `@@`→`T.accent`, `diff `/`index `/`+++ `/`--- `/`new file`/`deleted file`/`Binary files`→`T.muted`, context→`T.text`. git.ts stays theme-free; the styler runs in index.ts (loader applies theme, matching viewer.ts).
- **`ViewerFile.kind === "diff"`** (`types.ts`): `lines` are already styled; `commitHash`, `parents` added. The viewer's text-like path handles it (gutter/wrap/scroll/search); only `buildViewerHeader` (shows `commit <hash>`) and the notice row (`T.dim`, not warning) differ.
- **`NavigatorOptions.loadCommit`** (`navigator.ts`): optional injection parallel to `loadFile`. `openCommit()` reuses the `loadSeq` race guard; `relPath` = `commit:<hash>` so caches/header key on it and index.ts skips the mtime poll for `commit:` paths. When `loadCommit` is absent, Enter falls back to the family toggle (v2 behavior) so existing harnesses stay green.

## Acceptance Criteria

- [x] Enter on a `commit` (with `loadCommit`) opens its diff in the viewer (focus moves, `viewFile.kind === "diff"`, `commitHash` matches); Enter on a `commit-child` does the same.
- [x] `l` on a collapsed commit expands one level; `h` collapses; a `commit-child` with an expanded subtree and `h` steps the cursor out to its anchor.
- [x] Depth cap: `l` at `FAMILY_MAX_DEPTH` shows the `max depth reached` notice and does not expand.
- [x] Row cap: `FAMILY_MAX_ROWS` end-of-walk emits the dim `… more ancestors` hint instead of silent truncation.
- [x] Markers `▸`/`▾` render on commit rows; root commits show none.
- [x] Diff lines/notice are width-safe at 120/100/80/50 with no bright-ellipsis leak on long styled lines.
- [x] Fallback: no `loadCommit` → Enter toggles the family (no regression to #030 tests).
- [x] `readCommitDiff`: root/normal/merge commit stats correct, no throw on a bogus hash.
- [x] `npm run typecheck` and `npm test` green (136 tests).

## Resolution

Implemented per the v3 plan §1/§2. Git: `readCommitDiff` + `CommitDiff`. Types: `ViewerKind` gains `"diff"`, `ViewerFile` gains `commitHash?`/`parents?`. New `diff.ts` prefix styler. Navigator: one-level family emission with `commitDepth` walk, `commitMarker`, `l`/`h`-driven expansion with depth notice + row-cap hint row, `openCommit`, diff branch in `buildViewerHeader`/`buildRightRows`, `loadCommit` option. index.ts: `loadCommit` impl (`readCommitDiff` + `styleDiffLines`), mtime-poll skip for `commit:` paths. Tests: git integration (root/normal/merge/bogus), navigator (Enter→diff, l/h, depth cap, fallback), render (diff width-safety). README/AGENTS/DESIGN updated; version 0.3.2 → 0.4.0.
