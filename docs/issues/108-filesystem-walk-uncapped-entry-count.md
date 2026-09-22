# Issue #108: Filesystem Walk Lacks Upper Bound on Total Entry Count

- **Status**: Resolved
- **Type**: Technical Debt / Resource Bounds
- **Severity**: Low
- **Component**: [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L91-L145)

## Description

The async filesystem walk in [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L91) ([`collectFsEntries`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L76) and [`collectDirEntries`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L52)) is bounded by:
- Recursion depth: [`MAX_TREE_DEPTH = 6`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L44)
- Ignored directory names: [`IGNORED_NAMES`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L47)
- Symlink cycle detection: `visited: Set<string>`

However, there is no maximum limit on the total number of entries accumulated in the `entries: TreeEntry[]` array.

In repositories containing large untracked folders (e.g. data directories, unignored caches, or fixture directories with 50,000+ files within 6 directory levels), or when running outside of Git in a large directory tree, the walk will traverse and store every file in memory. This leads to high memory consumption, slow tree builds, and potential TUI lag when sorting thousands of entries.

## Proposed Fix

Introduce a reasonable safety threshold (e.g., `MAX_FS_ENTRIES = 25_000` in [`constants.ts`](file:///home/jhonny/Sources/pi-navigator/constants.ts)). When the entry count exceeds this cap, stop further directory descents and flag the tree as truncated.

## Acceptance Criteria

- [x] A maximum entry count cap is enforced during `walk`.
- [x] Traversals hitting the cap stop further descents without throwing.
- [x] Unit tests in `test/tree.test.ts` verify behavior when exceeding the entry cap.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

`MAX_FS_ENTRIES = 25_000` (`constants.ts`) bounds the walk through a shared
`TreeWalkBudget`:

- `tree.ts`: `createTreeWalkBudget(maxEntries = MAX_FS_ENTRIES)`; the budget is
  checked before every push and before every descent, so hitting the cap stops
  both. A module-private `WeakMap` holds the cumulative count per budget, which
  is what lets several `collectDirEntries` calls in git mode draw on ONE combined
  cap (a per-call `entries.length` check would multiply it); the exported budget
  stays `{ max, truncated }`. `truncated` is true only when the cap actually
  dropped work — natural completion at exactly the cap stays false.
- `collectFsEntries(cwd, opts?)` now returns `{ entries, truncated }`;
  `opts.maxEntries` is the test seam. `collectDirEntries(cwd, relDir, budget?)`
  shares a budget when one is passed and creates its own otherwise.
- `index.ts` consumes the flag at all three walk sites (fs mode, the
  empty-repository fallback, and git-mode untracked-dir filling) and surfaces a
  one-time warning via `makeWarningNotifier`, so an incomplete tree is never
  silent.

Tests: cap stops collection without throwing; under-cap and exactly-at-cap are
not truncated; descents are dropped once the cap is hit; two `collectDirEntries`
calls sharing a budget respect the combined cap.
