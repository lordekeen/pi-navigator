# Issue #058: Untracked Directories Are Dead-End Leaves (Unreachable in Git Mode)

- **Status**: Resolved (v0.6.1)
- **Type**: Bug
- **Severity**: High
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) / [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) / [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts)

---

## Description

In a git repository, the tracked-file listing uses `git status --porcelain -unormal -z` (changed from `-uall` in #024 to bound the untracked listing). With `-unormal`, git reports a **newly created, still-untracked directory as a single record**: `?? newdir/` — one path, **trailing slash**, no children.

`entriesFromPaths` in `index.ts` builds a `FileEntry` for that record with `isDir: false` (it never inspects the slash), and `tree.ts` inserts it as a **file leaf**. Consequences:

- The untracked directory renders as a *file* row in the Files pane and in the git panel's Unstaged group.
- Pressing Enter (either pane) routes to `loadFile` → `stat` → `!isFile()` → the "not a regular file" error card.
- **The contents of the new directory are unreachable** in git mode; the only escape is toggling the filter / switching to filesystem mode.

This is a regression consequence of #024's `-uall` → `-unormal` switch: with `-uall`, every file inside a new directory was listed individually and the tree built normally. The seam (porcelain output → entry build → tree insert) is not covered by any test.

## Reproduction Steps

1. In any tracked repo, `mkdir brandnew && echo hi > brandnew/a.txt` (do not `git add`).
2. Open `/navigator`.
3. Observe `brandnew` listed as a file row with an Unstaged badge.
4. Press Enter → error card: "not a regular file".

## Root Cause

`parsePorcelain` passes `?? newdir/` through verbatim; `entriesFromPaths` does no directory detection; `tree.ts` inserts whatever it receives as a leaf.

## Potential Solution

- In `entriesFromPaths` (or `parsePorcelain`): strip the trailing `/` and determine `isDir` via the slash and/or a `stat` check.
- On expanding such a directory node, fill its children via a bounded filesystem walk (reuse the existing `collectFsEntries` / `walk` machinery, honoring depth caps and ignored names) so the subtree stays bounded.
- Keep the git badge on the directory row (the `??` code applies to the whole directory).

## Acceptance Criteria

- [x] An untracked directory renders as a directory row (expandable) in both the Files pane and the git Unstaged group.
- [x] Expanding it lists its children (bounded walk, cycle/depth guard intact).
- [x] Enter on a file inside it opens the file normally.
- [x] Enter on the directory itself does not route to `loadFile`.
- [x] New test: build a tree from real `?? dir/` porcelain output (currently uncovered seam).
- [x] `npm run typecheck` and `npm test` green.
