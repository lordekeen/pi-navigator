# Issue #092: Obsolete v2 Commit-Family Row Cap Test Passes Ineffectively Under v3 Semantics

- **Status**: Open
- **Type**: Technical Debt / Test Quality
- **Severity**: Low
- **Component**: [`test/navigator.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts#L544-L569)

---

## Description

In [`test/navigator.test.ts` L544-569](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts#L544-L569), the test `limits commit-family expansion to the row cap (Issue #030)` constructs a 20-commit linear chain and asserts:

```typescript
    const childRows = joined.split("\n").filter((l) => l.includes("  c")) ;
    // Only a bounded number of ancestor rows are rendered.
    expect(childRows.length).toBeLessThan(20);
```

This test was authored under v2 recursive expansion semantics where expanding a commit traversed multiple ancestor generations in a single action. Under v3 semantics (Issue #034), commit family expansion is single-level (`l`/`h` or fallback `Enter` expands only direct parents).

In a linear chain, commit `c0` has only one direct parent (`c1`). Therefore, expanding `c0` renders exactly 1 child row. Because 1 is trivially `< 20`, the test passes regardless of whether `FAMILY_MAX_ROWS` truncation works or is completely removed.

## Root Cause Analysis

Test was not updated when commit family expansion transitioned from multi-generation DFS to single-level step expansion in v3 (#034).

## Potential Solution

Update the test fixture to genuinely exceed `FAMILY_MAX_ROWS`:
1. Use an octopus merge commit with > `FAMILY_MAX_ROWS` direct parents (e.g. 15 parents).
2. Or expand multiple levels iteratively down the tree until `FAMILY_MAX_ROWS` is reached.
3. Explicitly assert the presence of the row cap notice (`… more ancestors (narrow the view or collapse a branch)`) rather than a loose `< 20` row count inequality.

## Acceptance Criteria

- [ ] Test fails if `FAMILY_MAX_ROWS` row bounding logic is disabled.
- [ ] Test verifies that commit family expansion correctly truncates when direct parent count exceeds the configured limit.
- [ ] `npm test` passes.
