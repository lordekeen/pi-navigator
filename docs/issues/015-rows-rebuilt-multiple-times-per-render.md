# Issue #015: `filesRows` / `gitRows` / `gitNavRows` Rebuilt Multiple Times Per Render

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: Medium
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts)

---

## Description

A single render pass calls `filesRows()`, `gitRows()`, and `gitNavRows()` multiple times. Notably [`gitNavRows()`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L289-L290) re-invokes [`gitRows()`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L261) and filters it, and the flatten/filter arrays are rebuilt 2–3× per render (render path at [`navigator.ts:811-827`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L811-L827) plus cursor/footer lookups).

## Code References

- [`navigator.ts:255` (`filesRows`)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L255), [`navigator.ts:261` (`gitRows`)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L261), [`navigator.ts:289-290` (`gitNavRows`)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L289-L290)
- [`navigator.ts:811-827`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L811-L827) — multiple invocations in the render body.
- [`navigator.ts:1109`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1109), [`navigator.ts:584`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L584) — additional calls in footer/cursor paths.

## Potential Solution

Memoize the three row arrays per `(tree, gitState, hidden, filter, cursor)` state key, invalidated when any of those change. `gitNavRows` then derives from the memoized `gitRows` without re-filtering.

## Acceptance Criteria

- [x] Each of `filesRows`/`gitRows`/`gitNavRows` is built at most once per render.
- [x] Cursor movement, counts, and footer match counts remain correct.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Each method now memoizes on the inputs that actually affect its output: `filesRows` on `(root ref, filterQuery, showHidden, treeVersion)`, `gitRows` and `gitNavRows` on the `git` ref. A `treeVersion` counter is bumped on every in-place expansion mutation (Enter/l/h toggle, `expandAncestors`) so the cache catches changes that don't swap the root reference; a `setTree` call with the same root ref (gitCode-only idle update) correctly reuses the cached row list since git codes don't change which rows exist. Within one render pass the repeated `filesRows()`/`gitRows()`/`gitNavRows()` calls now build each array once. All 107 tests green (incl. expand/collapse on Enter).
