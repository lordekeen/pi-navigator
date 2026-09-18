# Issue #046: `walkTree` Visits Siblings in Reverse Order

- **Status**: Resolved
- **Type**: Enhancement / Technical Debt
- **Severity**: Low
- **Component**: [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts) · [`walkTree`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L288-L296)

---

## Description

`walkTree` uses a LIFO stack but pushes children in forward order:

```typescript
for (const child of node.children) stack.push(child);  // line 294
```

Children are popped in reverse sibling order. No current consumer is order-sensitive — `findNode` early-returns on a match, `collectExpanded` collects a set, `applyGitCodes` visits every node — but the traversal order is technically backwards for a standard DFS.

## Code References

- [`tree.ts:294`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L294) — forward-order push

## Potential Solution

Iterate backwards when pushing to the stack:

```typescript
for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
```

## Acceptance Criteria

- [x] `walkTree` visits siblings in forward order.
- [x] All existing consumers behave identically.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Reversed push loop order in `walkTree` (`for (let i = node.children.length - 1; i >= 0; i--) stack.push(child)`) so LIFO stack popping visits siblings in standard forward order. Added test in `test/tree.test.ts`.
