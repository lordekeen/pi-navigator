# Issue #036: `readCommitDiff` Line Cap Not Enforced — Only Byte Cap Applied

- **Status**: Resolved
- **Type**: Bug
- **Severity**: Medium
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) · [`readCommitDiff`](file:///home/jhonny/Sources/pi-navigator/git.ts#L307-L380)

---

## Description

The truncation guard at lines 353–356 checks both byte and line limits but always applies the byte-slice remedy:

```typescript
if (body.length > MAX_HIGHLIGHT_BYTES || body.split("\n").length > MAX_HIGHLIGHT_LINES) {
  body = body.slice(0, MAX_HIGHLIGHT_BYTES);  // always byte-slices
  truncated = true;
}
```

When a diff exceeds `MAX_HIGHLIGHT_LINES` (5000) but stays under `MAX_HIGHLIGHT_BYTES` (1 MB) — e.g., thousands of very short diff lines — the guard fires but the byte-slice is a no-op (the body is already under the byte limit). The subsequent `body.split("\n")` on line 364 produces an array larger than the cap, violating the system's memory constraints.

Additionally, `body.split("\n")` on line 353 allocates a full array just to check `.length`, then discards it — a wasteful allocation for large diffs.

## Code References

- [`git.ts:353-356`](file:///home/jhonny/Sources/pi-navigator/git.ts#L353-L356) — truncation guard
- [`git.ts:364`](file:///home/jhonny/Sources/pi-navigator/git.ts#L364) — final split that can exceed the cap
- [`constants.ts:23`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L23) — `MAX_HIGHLIGHT_LINES = 5000`

## Potential Solution

Split once and branch on which cap was hit:

```typescript
const bodyLines = body.split("\n");
if (body.length > MAX_HIGHLIGHT_BYTES) {
  body = body.slice(0, MAX_HIGHLIGHT_BYTES);
  truncated = true;
} else if (bodyLines.length > MAX_HIGHLIGHT_LINES) {
  body = bodyLines.slice(0, MAX_HIGHLIGHT_LINES).join("\n");
  truncated = true;
}
```

This enforces both caps correctly and eliminates the redundant split.

## Acceptance Criteria

- [x] A diff with >5000 short lines is correctly truncated to 5000 lines.
- [x] A diff exceeding MAX_HIGHLIGHT_BYTES is still byte-truncated.
- [x] The `notice` field reflects the truncation.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Enforced `MAX_HIGHLIGHT_LINES` capping on the split line array in `git.ts:readCommitDiff`, byte-slicing when `MAX_HIGHLIGHT_BYTES` is exceeded and slicing lines to `MAX_HIGHLIGHT_LINES` when line count is exceeded. Added test with 5050 lines.
