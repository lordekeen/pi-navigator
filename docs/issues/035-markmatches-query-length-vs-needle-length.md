# Issue #035: `markMatches` Uses `query.length` Instead of `needle.length` — Unicode Case-Folding Mismatch

- **Status**: Resolved
- **Type**: Bug
- **Severity**: Medium
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) · [`markMatches`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L107-L135)

---

## Description

`markMatches` finds occurrences by searching `haystack` (possibly lowercased) for `needle` (lowercased query), but extracts the highlighted slice using `query.length`:

```typescript
const slice = styled.slice(idx, idx + query.length);  // line 128
```

`idx` is the position found by `haystack.indexOf(needle, from)`. Certain Unicode characters change byte-length when lowercased (e.g., `ß` → `ss`, some Turkic characters). When `query.length !== needle.length`, the highlighted region is misaligned — it either highlights too few or too many characters, and the `from` advance on line 132 also uses `needle.length`, creating a mismatch between the search stride and the highlight width.

All Latin/ASCII text is unaffected. The bug only manifests with scripts where case-folding changes string length.

## Code References

- [`viewer.ts:128`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L128) — slice uses `query.length`
- [`viewer.ts:132`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L132) — advance uses `needle.length`
- [`viewer.ts:117`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L117) — `needle` computed from `query.toLowerCase()`

## Potential Solution

Use `needle.length` consistently for both the slice width and the advance stride:

```typescript
const slice = styled.slice(idx, idx + needle.length);
```

This is a one-line change with no risk to existing behavior for ASCII inputs.

## Acceptance Criteria

- [x] `markMatches` uses `needle.length` for the highlighted slice extraction.
- [x] A test verifies correct highlighting with a query whose lowercased form has a different length.
- [x] Existing search highlight tests continue to pass.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Changed `query.length` to `needle.length` in `viewer.ts` line 128 when slicing `styled`, aligning slice extraction with the search stride. Added test verifying Turkish dotted capital I (`\u0130` -> `\u0069\u0307`).
