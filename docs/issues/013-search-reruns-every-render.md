# Issue #013: In-File Search Re-Scans Every Render With O(lines×matches) Marking

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: High
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts)

---

## Description

With an active in-file query, [`searchLines`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L347) reruns each render and [`markMatches`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L103) is applied per line. In the render path at [`navigator.ts:1127`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1127), `this.searchMatches.some((match) => match.line === index)` runs per rendered line — O(lines × matches). Typing in the search box re-derives the whole result set per keystroke and then re-walks it during row build.

## Code References

- [`navigator.ts:555`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L555) — `this.searchMatches = searchLines(lines, this.searchQuery);`
- [`navigator.ts:1123-1128`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1123-L1128) — per-line `.some()` match check + `markMatches`.
- [`viewer.ts:347` (`searchLines`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L347), [`viewer.ts:103` (`markMatches`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L103)

## Potential Solution

- Dirty-flag the search result: recompute `searchMatches` only when the query, file content, or width changes — not on every render.
- Store a `Map<lineIndex, Match[]>` (or a `Set<number>` of matching line indices) so the per-line membership test is O(1) instead of `Array.some`.

## Acceptance Criteria

- [x] `searchLines` does not rerun on every render when the query is unchanged.
- [x] Per-line match membership is O(1).
- [x] Search highlight and current-match jumping behave exactly as before.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

`recomputeSearchIfNeeded` now reruns `searchLines` only when `searchDirty` is set (the open file's content changed under an active query), not on every render; query-changing keystrokes call `recomputeSearch` directly and clear the dirty flag. `markSearch` uses a `Set<number>` (`searchMatchLines`) for O(1) per-line membership instead of `Array.some` over all matches. A `searchVersion` counter invalidates the `marked`/`rows` caches when matches or the current-match index change. Covered by the existing search suite (type, cycle via n/N and Ctrl+n/p, escape clear).
