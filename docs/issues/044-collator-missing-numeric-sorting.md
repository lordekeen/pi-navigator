# Issue #044: Tree Sort Collator Lacks `numeric: true` — `file10` Sorts Before `file2`

- **Status**: Resolved
- **Type**: Enhancement
- **Severity**: Low
- **Component**: [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts) · [`sortTree`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L164-L172)

---

## Description

The file tree collator uses base sensitivity but does not enable numeric sorting:

```typescript
const collator = new Intl.Collator(undefined, { sensitivity: "base" });  // line 22
```

This causes lexicographic ordering where `file10.ts` sorts before `file2.ts`. Most file managers and IDEs (VS Code, Finder, Nautilus) use natural numeric sorting.

## Code References

- [`tree.ts:22`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L22) — collator definition

## Potential Solution

Add `numeric: true` to the collator options:

```typescript
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
```

## Acceptance Criteria

- [x] Files with numeric suffixes sort in natural order (file1, file2, file10).
- [x] Non-numeric filenames are unaffected.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Added `numeric: true` to the `Intl.Collator` instance in `tree.ts`. Added test in `test/tree.test.ts`.
