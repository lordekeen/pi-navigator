# Issue #054: Redundant `getRenderedMarkdownLines` Invocation in `buildRightRows`

- **Status**: Resolved
- **Type**: Performance / Code Hygiene
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) · [`buildRightRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1448-L1492)

---

## Description

In [`NavigatorOverlay.buildRightRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1448-L1492), when rendering markdown in rendered mode (`useRendered && file`), [`getRenderedMarkdownLines`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L894-L914) is called twice in the same render pass:

1. At line 1448, to recompute search matches if needed:
```typescript
// navigator.ts:1447-1450
if (useRendered && file) {
  const mdLines = this.getRenderedMarkdownLines(file, contentW);
  this.recomputeSearchIfNeeded(mdLines);
}
```

2. Later at line 1492, to populate visible viewport rows:
```typescript
// navigator.ts:1491-1493
if (useRendered) {
  const mdLines = this.getRenderedMarkdownLines(file, contentW);
```

While [`getRenderedMarkdownLines`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L896-L898) caches the rendered lines in `this.mdCache`, calling the method twice in the same function creates redundant method calls, cache condition checks, and duplicate variable bindings.

## Code References

- [`navigator.ts:1447-1452`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1447-L1452) — first call site in `buildRightRows`
- [`navigator.ts:1491-1493`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1491-L1493) — second call site in `buildRightRows`
- [`navigator.ts:894-914`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L894-L914) — `getRenderedMarkdownLines` implementation

## Potential Solution

Derive and store `mdLines` once at the beginning of `buildRightRows` when `useRendered && file`:

```typescript
const mdLines = useRendered && file ? this.getRenderedMarkdownLines(file, contentW) : null;
if (mdLines) {
  this.recomputeSearchIfNeeded(mdLines);
} else {
  this.recomputeSearchIfNeeded();
}

// ... later in buildRightRows:
if (useRendered && mdLines) {
  // Use existing mdLines reference directly
```

## Acceptance Criteria

- [x] `getRenderedMarkdownLines` is called at most once per render pass in `buildRightRows`.
- [x] `npm run typecheck` and `npm test` remain green.

## Resolution

Derived `mdLines` once at the start of `buildRightRows` via `const mdLines = useRendered && file ? this.getRenderedMarkdownLines(file, contentW) : null;`. Both `recomputeSearchIfNeeded(mdLines)` and viewport row generation now reuse the single `mdLines` array reference, eliminating duplicate invocations and cache checks. Added test in `test/navigator.test.ts`.
