# Issue #025: Search Current-Match Highlight Targets the Wrong Occurrence on Multi-Hit Lines

- **Status**: Resolved
- **Type**: Bug
- **Severity**: Medium
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`markSearch`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1217) / [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) / [`markMatches`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L112)

---

## Description

[`markSearch`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1217) decides which occurrence to style as the *current* match from the line number only:

```ts
const currentLine = this.searchMatches[Math.min(this.searchIndex, this.searchMatches.length - 1)]?.line;
// ...
return markMatches(line, this.searchQuery, T.searchMatch, T.searchCurrent, index === currentLine);
```

That boolean is passed through to [`markMatches`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L112) as `currentIsFirst`, which styles only the **first** occurrence on the line as current:

```ts
const useCurrent = currentIsFirst && occurrence === 0;
```

When a single line contains two or more matches and `searchIndex` points at the 2nd (or 3rd, …) occurrence, the **first** occurrence is underlined/highlighted as current while the true current match is drawn as a plain match. The scroll-to-match path uses `searchMatches[searchIndex].line` and is correct; only the per-line highlight is wrong. Single-occurrence lines are unaffected.

## Code References

- [`navigator.ts:1224-1230` (`markSearch`)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1224-L1230)
- [`viewer.ts:112-131` (`markMatches`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L112-L131)
- [`viewer.ts:351` (`searchLines`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L351) — returns ordered `{ line, start, end }`, so the exact occurrence is already known at match time.

## Potential Solution

Thread the exact current occurrence to `markMatches`: compute the per-line occurrence index of `searchMatches[searchIndex]` (count earlier matches on the same line) and pass it instead of a line-only boolean, e.g. `markMatches(line, query, styleMatch, styleCurrent, currentOccurrence)` where the current match is `occurrence === currentOccurrence`. Alternatively pass the `start`/`end` of the current match and switch on the matched slice.

## Acceptance Criteria

- [x] When the current match is the Nth occurrence on its line, the Nth occurrence is the one styled as current.
- [x] Lines with a single match still highlight correctly.
- [x] A test seeds a two-match line and asserts the correct occurrence is styled (search-related suites currently have no multi-hit-per-line coverage).
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Changed `markMatches`'s `currentIsFirst: boolean` parameter to `currentOccurrence: number` (the 0-based occurrence index on the line that should be styled as current, or −1 for none). `markSearch` in `navigator.ts` now computes the per-line occurrence index by counting earlier matches on the same line with `start < currentMatch.start` and passes that to `markMatches` instead of the line-only boolean. The existing single-match lines are unaffected (occurrence 0 = first match); the new test covers the two-match-on-one-line case explicitly.
