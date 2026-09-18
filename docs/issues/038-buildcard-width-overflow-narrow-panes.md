# Issue #038: `buildCard` Width Overflow at Narrow Panes

- **Status**: Resolved
- **Type**: Enhancement
- **Severity**: Medium
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) · [`buildCard`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1526-L1564)

---

## Description

`buildCard` (used for binary/image/error viewer states) forces `contentWidth` to a minimum of 24, making `boxW` at least 26. If `rightW < 26` — possible when the left column is visible and the terminal is near the 80-column minimum — the `blank()` helper produces rows wider than the pane.

```typescript
const contentWidth = Math.max(24, Math.min(rightW - 6, ...));  // line 1537
```

Unlike all other render paths, `buildCard` output is not passed through `this.padTo()`, which is the overlay's width-safety backstop. The convention from AGENTS.md is: "Every rendered row must fit its pane width."

## Code References

- [`navigator.ts:1537`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1537) — `contentWidth` floor of 24
- [`navigator.ts:1544`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1544) — `blank()` helper without width clamp

## Potential Solution

Wrap each row in `this.padTo(..., rightW)` before pushing to `out`, or clamp `contentWidth` to `Math.min(rightW - 2, ...)` instead of a fixed floor of 24.

## Acceptance Criteria

- [x] `buildCard` output rows never exceed `rightW` visible columns.
- [x] The render test suite passes at all terminal sizes (120×36, 100×28, 80×24, narrow).
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Clamped `contentWidth` to `rightW - 6` at narrow widths and mapped all `buildCard` output rows through `this.padTo(row, rightW)`. Added multi-width assertions in `test/render.test.ts`.
