# Issue #018: Redundant `visibleWidth` / `truncateToWidth` Scans Over the Same Strings

- **Status**: Open
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

- [ ] Affected render sites use a single measurement+truncate call.
- [ ] Layout and padding are unchanged at all tested terminal widths.
- [ ] `npm run typecheck` and `npm test` are green (render width-safety suite included).
