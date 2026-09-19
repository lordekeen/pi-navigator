# Issue #052: `searchIndex` Out of Bounds When Toggling Markdown Rendered Mode (`m`)

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Medium
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) · [`recomputeSearchOnLines`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L935-L941) · [`buildSearchBar`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1604-L1613)

---

## Description

When in-file search is active and the user toggles between Code View and Rendered View via the `m` key, [`NavigatorOverlay.handleViewerInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L854-L868) marks the search dirty and resets `this.searchMatches`:

```typescript
// navigator.ts:862-866
this.searchDirty = true;
this.searchMatches = [];
this.searchMatchLines.clear();
this.searchVersion++;
```

However, `this.searchIndex` is not reset or clamped.

During the next render pass, [`recomputeSearchOnLines`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L935-L941) recalculates matches for the newly rendered line set:

```typescript
// navigator.ts:935-941
private recomputeSearchOnLines(lines: string[]): void {
  this.searchMatches = searchLines(lines, this.searchQuery);
  this.searchMatchLines = new Set(this.searchMatches.map((m) => m.line));
  if (this.searchMatches.length === 0) this.searchIndex = 0;
  this.searchVersion++;
  this.searchDirty = false;
}
```

Notice that `this.searchIndex` is only reset to `0` when `this.searchMatches.length === 0`. If the original code view had 6 matches and `this.searchIndex` was 5, and the rendered view produces fewer matches (e.g. 2 matches), `this.searchIndex` remains `5`.

While [`buildRightRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1504) contains a local defensive guard `Math.min(this.searchIndex, this.searchMatches.length - 1)` to select the highlighted occurrence, [`buildSearchBar`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1609) evaluates the unclamped index:

```typescript
// navigator.ts:1608-1610
this.searchQuery
  ? `${this.searchMatches.length === 0 ? 0 : this.searchIndex + 1}/${this.searchMatches.length} matches`
  : null,
```

This causes the search bar to display out-of-bounds match counters such as `"6/2 matches"` until the user presses `n`/`N` to cycle the search.

## Code References

- [`navigator.ts:854-868`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L854-L868) — `handleViewerInput` `m` toggle
- [`navigator.ts:935-941`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L935-L941) — `recomputeSearchOnLines`
- [`navigator.ts:1503-1505`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1503-L1505) — defensive clamp in `buildRightRows`
- [`navigator.ts:1604-1613`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1604-L1613) — `buildSearchBar` counter display

## Potential Solution

Clamp `this.searchIndex` inside `recomputeSearchOnLines` whenever `searchMatches` is recomputed:

```typescript
private recomputeSearchOnLines(lines: string[]): void {
  this.searchMatches = searchLines(lines, this.searchQuery);
  this.searchMatchLines = new Set(this.searchMatches.map((m) => m.line));
  if (this.searchIndex >= this.searchMatches.length) {
    this.searchIndex = Math.max(0, this.searchMatches.length - 1);
  }
  this.searchVersion++;
  this.searchDirty = false;
}
```

## Acceptance Criteria

- [x] Toggling `m` when `searchIndex` exceeds the match count of the new view clamps `searchIndex` to `< searchMatches.length`.
- [x] `buildSearchBar` never displays an index greater than the total count (no `"6/2 matches"`).
- [x] Unit test added in `test/navigator.test.ts`.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Updated `recomputeSearchOnLines` in `navigator.ts` to clamp `this.searchIndex` to `Math.max(0, this.searchMatches.length - 1)` whenever `this.searchIndex >= this.searchMatches.length`. When toggling into rendered view via `m` under an active search query, `searchIndex` is clamped immediately upon line re-computation, preventing `buildSearchBar` from displaying out-of-bounds counters such as `"6/2 matches"`. Added unit test in `test/navigator.test.ts`.
