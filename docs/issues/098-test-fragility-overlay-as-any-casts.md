# Issue #098: Test Fragility: Tests Inspect Private Component Fields via `(overlay as any)` Casts

- **Status**: Open
- **Type**: Technical Debt / Test Quality
- **Severity**: Low
- **Component**: [`test/navigator.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts)

---

## Description

In [`test/navigator.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts), the test suite bypasses TypeScript encapsulation by casting `NavigatorOverlay` instances to `any` to assert on private internal fields:
- `(overlay as any).viewHscroll` (lines 1153, 1175, 1375, 1381, 1501, 1510, 1522)
- `(harness.overlay as any).cachedLines` (lines 1500, 1509, 1519, 1523)
- `vi.spyOn(harness.overlay as any, "getRenderedMarkdownLines")` (line 1534)
- `const overlay = harness.overlay as any` (line 1720)

Relying on private fields couples unit tests to internal variable names and caching strategies. Refactoring internal state management or renaming private fields breaks the test suite even when the external behavior, keyboard interactions, and rendered output remain completely intact.

## Root Cause Analysis

Convenience assertions were added during bug fixes (e.g. #053, #054, #059) to inspect internal variables instead of asserting on observable public output.

## Potential Solution

1. Replace `viewHscroll` assertions with checks on observable rendered output (e.g. the viewer header `col N` badge or visible text column offsets).
2. For cache hit/invalidation testing, verify observable behavior (such as render timing or pure function call counts) or provide explicit, typed inspection test seams.

## Acceptance Criteria

- [ ] Private field casts (`(overlay as any)`) in `test/navigator.test.ts` are eliminated or replaced with public API / rendered output assertions.
- [ ] Tests remain resilient to internal component refactors.
- [ ] `npm test` passes.
