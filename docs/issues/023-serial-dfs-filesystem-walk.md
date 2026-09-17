# Issue #023: Filesystem Walk Is a Serial DFS

- **Status**: Open
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

- [ ] Directory enumeration is parallelized per level (if implemented).
- [ ] Depth cap and ignored-name semantics are preserved.
- [ ] `npm run typecheck` and `npm test` are green (tree suite included).
