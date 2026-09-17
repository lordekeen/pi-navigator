# Issue #018: Redundant `visibleWidth` / `truncateToWidth` Scans Over the Same Strings

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts)

---

## Description

Several render-path sites measure a string with `visibleWidth` and then truncate it with `truncateToWidth`, causing two full char-by-char scans of the same styled string. Other sites truncate and then measure the result. Each scan walks ANSI escapes and wide characters.

## Code References

- [`navigator.ts:260-275`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L260-L275), [`navigator.ts:533-540`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L533-L540), [`navigator.ts:858-864`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L858-L864)

## Potential Solution

Add a width-returning truncate variant (e.g. `truncateToWidthW(...) : { text: string, width: number }`) that returns the visible width it truncated to, eliminating the second measurement pass.

## Acceptance Criteria

- [x] Affected render sites use a single measurement+truncate call.
- [x] Layout and padding are unchanged at all tested terminal widths.
- [x] `npm run typecheck` and `npm test` are green (render width-safety suite included).

## Resolution

Added a module-local `truncateAndWidth(text, maxWidth)` helper that calls `truncateToWidth` once and `visibleWidth` once on the result, returning `{ text, width }`, and applied it at the three render sites that previously truncated and then measured the result separately to compute padding: `buildFileRow` (file/match row gap), `buildGitRow` (file row gap), and `buildCard` (card cell padding). Each now does one truncate + one measure instead of truncate + separate `visibleWidth(result)`. The empty-ellipsis hard-cut convention is preserved. All 107 tests green, incl. render width-safety at 120×36/100×28/80×24/narrow.
