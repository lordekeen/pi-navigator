# Issue #023: Filesystem Walk Is a Serial DFS

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: Low
- **Component**: [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts) / `walk`

---

## Description

The filesystem walk ([`tree.ts` `walk`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L65)) descends directories one at a time (`await walk(...)` in a loop). It is bounded by `MAX_TREE_DEPTH` and `IGNORED_NAMES`, and the probe design means it only re-walks on actual change (not on idle/hidden/filter), so the impact is limited. Still, on large trees the serial I/O could be parallelized.

## Code References

- [`tree.ts:65-110` (`walk`)](file:///home/jhonny/Sources/pi-navigator/tree.ts#L65-L110)

## Potential Solution

`Promise.all` over child directories per level. Keep the depth cap and ignored-name filtering. Acceptable to defer — the probe gating already avoids walks on idle ticks.

## Acceptance Criteria

- [x] Directory enumeration is parallelized per level (if implemented).
- [x] Depth cap and ignored-name semantics are preserved.
- [x] `npm run typecheck` and `npm test` are green (tree suite included).

## Resolution

`walk` now collects each level's subdirectory descents into a `descents` array and `await Promise.all(descents)` at the end, so all child directories at a given depth are walked concurrently instead of one-at-a-time. All `visited` Set adds happen synchronously before any descent starts, so the cycle guard remains sound under the fan-out. `MAX_TREE_DEPTH`, `IGNORED_NAMES`, symlink handling (broken/cycle/dir), and the entry-push order within a level are unchanged; the fs walk tests confirm the entry set, ignored-name skipping, dot-entry inclusion, symlink leaf/cycle/dir behavior, and the depth cap (`deep7` recursed into, children not listed) all still hold. All 107 tests green.
