# Issue #030: Expandable Commit Family Tree

- **Status**: Resolved
- **Type**: Feature
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) / [`types.ts`](file:///home/jhonny/Sources/pi-navigator/types.ts) / [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`constants.ts`](file:///home/jhonny/Sources/pi-navigator/constants.ts)

---

## Description

The history list is flat (hash, date, subject) with no relationship visibility. Make a commit's ancestors inspectable in place: pressing `Enter` on a commit row expands its ancestor family as indented rows beneath it, reusing the pane's cursor/scroll idioms. Data comes nearly free from the existing log fetch by adding `--parents`.

## Code References

- [`git.ts:176`](file:///home/jhonny/Sources/pi-navigator/git.ts) (log fetch), `readGitState` parse
- [`types.ts`](file:///home/jhonny/Sources/pi-navigator/types.ts) `GitCommit.parents?`, `GitRow` `commit-child` kind
- [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) `gitRows`/`gitNavRows`/`toggleCommitFamily`/`handleGitInput`/`buildGitRow`

## Potential Solution

`--parents` in the log format (`%h%x1f%p%x1f%ad%x1f%s`); `GitCommit.parents?: string[]`. `gitRows()` computes family rows for expanded commits (parent→child from history, DFS, bounded by `FAMILY_MAX_DEPTH`/`FAMILY_MAX_ROWS`); `gitNavRows()` flattens the expanded tree for nav; `Enter` toggles via a `gitTreeVersion`-keyed cache (mirrors `treeVersion`). Render indents `commit-child` rows by depth.

## Acceptance Criteria

- [x] `Enter` on a commit row expands/collapses its ancestor family (replacing the deferred-notice).
- [x] Merge commits carry two parents; root commits zero; integration test on a real merge.
- [x] Expansion is bounded (`FAMILY_MAX_DEPTH=3`, `FAMILY_MAX_ROWS=16`), tested.
- [x] Expanded family rows are width-safe at all suite sizes.
- [x] `gitNavRows`/cursor/scroll keep working with the expanded tree.
- [x] `npm run typecheck` and `npm test` green.

## Resolution

Added `--parents` and `%p` to the log fetch; `GitCommit.parents?: string[]`; new `GitRow` kind `commit-child`. `gitRows()` builds a parent→child map from history and emits indented ancestor rows for expanded commits (DFS with depth/row caps); caches keyed on a new `gitTreeVersion`. `handleGitInput` Enter on a commit now calls `toggleCommitFamily`. Tests: git integration (merge → 2 parents, root → 0), navigator (expand/collapse, row cap), render (width-safe expanded family). Readme key table updated; version 0.3.0.
