# Issue #022: Full-Tree `applyGitCodes` Walk Every Tick Even When Status Unchanged

- **Status**: Open
- **Type**: Enhancement / Performance
- **Severity**: Low
- **Component**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) / [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts)

---

## Description

On poll ticks where the tree signature did not change, [`applyGitCodes(root, gitCodeMap(git))`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L248) still walks every node every ~3s ([`index.ts:176` and `index.ts:181`](file:///home/jhonny/Sources/pi-navigator/index.ts#L176)). Cost is O(tree size) with Map lookups — fine for small trees, wasteful for large repos when nothing changed.

## Code References

- [`index.ts:176`](file:///home/jhonny/Sources/pi-navigator/index.ts#L176) and [`index.ts:181`](file:///home/jhonny/Sources/pi-navigator/index.ts#L181) — unconditional `applyGitCodes`.
- [`tree.ts:248` (`applyGitCodes`)](file:///home/jhonny/Sources/pi-navigator/tree.ts#L248)

## Potential Solution

Skip the walk when the git status probe equals the previous probe (status unchanged ⇒ codes unchanged). Only re-apply when the porcelain output actually differs.

## Acceptance Criteria

- [ ] `applyGitCodes` is not re-run on idle ticks when git status is unchanged.
- [ ] Status changes still propagate to row styling promptly.
- [ ] `npm run typecheck` and `npm test` are green.
