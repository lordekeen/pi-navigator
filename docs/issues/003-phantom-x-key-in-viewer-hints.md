# Issue #003: Phantom `x` Key Hint in Viewer Footer

- **Status**: Resolved
- **Type**: Bug / UI Polish
- **Severity**: Low
- **Component**: [`NavigatorOverlay`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`HINTS`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L51-L61)

---

## Description

The viewer pane key hints string defined in `HINTS.viewer` includes `x` alongside `h` and `l` (`h l x`). However, there is no corresponding handler for the `x` key in [`handleViewerInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L496-L531). Pressing `x` in viewer focus does nothing.

---

## Code References

- [`navigator.ts:57`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L57):
  ```typescript
  viewer: "j k scroll  Ctrl+d/u  h l x  w wrap  / search  n N  Tab  ? help  q close",
  ```
- [`handleViewerInput` (navigator.ts:496-531)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L496-L531):
  Handles arrows, `j`, `k`, `Ctrl+d`, `Ctrl+u`, `g`, `G`, `/`, `n`, `N`, `w`, `h`, `l`. Key `x` is unhandled and falls through to `return`.

---

## Potential Solution

Remove `x` from the `HINTS.viewer` template string in [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L57):

```typescript
const HINTS: Record<string, string> = {
  ...
  viewer: "j k scroll  Ctrl+d/u  h l  w wrap  / search  n N  Tab  ? help  q close",
  ...
};
```

Removing `x` also saves two character columns in the footer budget (enforced in `test/render.test.ts`), providing more safety on narrow terminal widths.

---

## Acceptance Criteria

- [x] `HINTS.viewer` no longer advertises the non-functional `x` key.
- [x] `render.test.ts` width tests pass across 80, 100, and 120 column viewports.
