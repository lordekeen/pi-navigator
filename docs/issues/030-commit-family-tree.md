# Issue #030: Expandable Commit Family Tree

> **Superseded in part by v3**: the Enter-only toggle, missing `▸`/`▾`
> marker, and silent `FAMILY_MAX_DEPTH` truncation resolved by
> [`docs/plans/commit-detail-family-tree-v3-plan.md`](../plans/commit-detail-family-tree-v3-plan.md)
> (implemented as [#034](034-commit-diff-view.md)). v3 keeps the data
> groundwork here (`--parents`, `parents?`, `commit-child`) but moves family
> expansion to `l`/`h` (file-pane idiom) and gives Enter the commit-diff view.

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

**v3 follow-up:** the nteraction/keys changed (`l`/`h` expand/collapse, Enter opens a diff), family became one-level-per-expand, and truncation is now surfaced — see [#034](034-commit-diff-view.md).
