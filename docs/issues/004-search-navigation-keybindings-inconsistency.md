# Issue #004: Ambiguous Key Hints for Search Navigation (`n`/`N`) Between Input Modes

- **Status**: Resolved
- **Type**: Enhancement / UX
- **Severity**: Low
- **Component**: [`NavigatorOverlay`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`handleSearchInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L335-L361) / [`handleViewerInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L516-L519)

---

## Description

In normal mode with the viewer focused, `HINTS.viewer` advertises `n N` for navigating search matches. However, while in active search mode (`mode === "search"`), pressing `n` or `N` types the literal character into the search query instead of jumping between matches. In active search mode, match cycling is performed via the `up` and `down` arrow keys.

Users entering search mode may expect `n` or `N` to cycle matches as it does in standard Unix utilities (like `less` or Vim), leading to accidental query alteration.

---

## Code References

- [`navigator.ts:57-59`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L57-L59):
  ```typescript
  viewer: "j k scroll  Ctrl+d/u  h l x  w wrap  / search  n N  Tab  ? help  q close",
  search: "type to search  up/down match  Enter apply  Esc clear",
  ```
- [`handleSearchInput` (navigator.ts:335-361)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L335-L361):
  - `Key.down`: `cycleSearch(1)`
  - `Key.up`: `cycleSearch(-1)`
  - Printable characters (including `n`, `N`): appended to `searchQuery`.
- [`handleViewerInput` (navigator.ts:516-519)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L516-L519):
  - `n`: `cycleSearch(1)`
  - `N`: `cycleSearch(-1)`

---

## Potential Solution

1. **Clarify Mode-Specific Hints**:
   Ensure help modal rows in `HELP_ROWS` and documentation explicitly distinguish match cycling controls:
   - During active search input: use `↑` / `↓`.
   - In normal viewer mode: use `n` / `N`.
2. **Alternative Keybinding Support**:
   Optionally support `Ctrl+n` / `Ctrl+p` inside [`handleSearchInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L335-L361) to cycle matches without having to reach for the arrow keys while typing.

---

## Acceptance Criteria

- [x] Clear distinction in help documentation between query input mode controls and viewer navigation mode controls.
- [x] No regression in incremental search typing.
