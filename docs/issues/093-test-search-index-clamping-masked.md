# Issue #093: Search Index Clamping Test Masked by Re-typing Query in `navigator.test.ts`

- **Status**: Resolved
- **Type**: Technical Debt / Test Quality
- **Severity**: Low
- **Component**: [`test/navigator.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts#L1444-L1487)

---

## Description

In [`test/navigator.test.ts` L1444-1487](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts#L1444-L1487), the test `clamps searchIndex when toggling into rendered mode produces fewer matches (#052)` aims to verify that toggling markdown view mode (`m`) clamps `searchIndex` when rendered markdown contains fewer matches than code view:

```typescript
    // Toggle to rendered view (2 matches): searchIndex must be clamped (#052).
    harness.overlay.handleInput("m");
    harness.overlay.render(120);

    // Re-enter search mode and re-type the query: the match count is now 2 and
    // the rendered counter must stay in range after cycling past the end.
    harness.overlay.handleInput("/");
    for (const ch of "item") {
      harness.overlay.handleInput(ch);
    }
```

When `/` is pressed and characters are typed, the overlay starts a new search operation, which resets `searchIndex` to 0.

Because `searchIndex` is reset by the new query input, the test never checks whether the pre-existing `searchIndex` (which was at match index 5 out of 6) was clamped to index 1 upon pressing `m`.

If the clamping logic in `recomputeSearchOnLines` were deleted, this test would still pass because cycling 5 times on the re-typed query tests normal search navigation clamping, not the mode-toggle clamping introduced by #052.

## Root Cause Analysis

The test inadvertently resets search state by re-initiating search mode with a typed query instead of asserting on the clamped state immediately following the `m` keystroke.

## Potential Solution

Verify the clamped state immediately after pressing `m`:
1. Check the rendered search bar match counter immediately after `harness.overlay.handleInput("m")`.
2. Or re-open search mode without typing a new query (e.g. using existing query navigation or inspecting the active match index).

## Acceptance Criteria

- [x] Test directly verifies that toggling `m` clamps `searchIndex` from out-of-bounds to the last valid match index without re-typing the query.
- [x] Test fails if the clamping logic in `recomputeSearchOnLines` is removed.
- [x] `npm test` passes.

## Resolution

Exposed public `getSearchState(): { query: string; index: number; total: number }` method on `NavigatorOverlay` in `navigator.ts` and updated the search index clamping test in `test/navigator.test.ts` to directly verify clamped search state immediately upon toggling into rendered mode (`m`) without re-typing query characters.
