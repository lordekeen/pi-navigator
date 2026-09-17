# Issue #016: `filterRows` Lowercases Every Path Per Filter Keystroke

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: Medium
- **Component**: [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts) / [`filterRows`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L351)

---

## Description

[`filterRows`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L351) calls `child.relPath.toLowerCase()` and `child.name.toLowerCase()` for every node on every filter keystroke — roughly two string allocations per file per keystroke. On large trees this is wasteful since the paths do not change between keystrokes.

## Code References

- [`tree.ts:351-380` (`filterRows`)](file:///home/jhonny/Sources/pi-navigator/tree.ts#L351-L380):
  ```typescript
  const q = query.toLowerCase();
  ...
  const lowerPath = child.relPath.toLowerCase();   // per node, per keystroke
  if (!lowerPath.includes(q)) continue;
  ...
  nameIndex: child.name.toLowerCase().indexOf(q),
  ```

## Potential Solution

Precompute `lowerPath` (and optionally `lowerName`) on the `FileNode` at build time in `buildTree`, so filtering compares against an already-lowercased field. The query is still lowercased once per call.

## Acceptance Criteria

- [x] `FileNode` carries a pre-lowercased path field used by `filterRows`.
- [x] Filter matching semantics (path + name index) are unchanged.
- [x] `npm run typecheck` and `npm test` are green (tree suite included).

## Resolution

Added `lowerName` and `lowerRelPath` fields to `FileNode`, populated once in `makeNode` at tree-build time. `filterRows` now matches against `child.lowerRelPath` / `child.lowerName` instead of calling `.toLowerCase()` per node per keystroke. The query is still lowercased once per call. All test trees go through `buildTree`/`makeNode`, so the new required fields are always present. All 107 tests green.
