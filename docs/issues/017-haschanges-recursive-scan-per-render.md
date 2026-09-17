# Issue #017: `hasChanges` Recursive Scan Per Directory Row Per Render

- **Status**: Open
- **Type**: Enhancement / Performance
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts)

---

## Description

Each directory row is styled via [`hasChanges(row.node)`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L906), which recursively scans the subtree ([`tree.ts:328` (`hasChanges`)](file:///home/jhonny/Sources/pi-navigator/tree.ts#L328)) to decide whether any descendant has a git status code. This recursion runs per directory row, per render.

## Code References

- [`navigator.ts:906`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L906) — `hasChanges(row.node) ? T.warning : ...`
- [`tree.ts:328-336` (`hasChanges`)](file:///home/jhonny/Sources/pi-navigator/tree.ts#L328-L336)

## Potential Solution

Precompute a `hasChanges` boolean flag on each directory node once — when the tree is built or when [`applyGitCodes`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L248) applies status codes — by propagating child flags upward. The render path then reads a field instead of recursing.

## Acceptance Criteria

- [ ] Directory change styling is read from a precomputed flag, not recomputed per render.
- [ ] Styling remains correct after git status updates and tree rebuilds.
- [ ] `npm run typecheck` and `npm test` are green.
