# Issue #012: Full-File `computeRows` Re-Derived Every Render

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: High
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) / `computeRows`

---

## Description

On every render (scroll, cursor move, filter keystroke) the viewer re-wraps and re-slices the **entire** file — up to `MAX_HIGHLIGHT_LINES` (5000) lines — via [`computeRows`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L380-L395), called from the render path at [`navigator.ts:1034`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1034). Cost scales with total file size, not the visible viewport size.

## Code References

- [`navigator.ts:1031-1034`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1031-L1034):
  ```typescript
  const maxH = Math.max(0, maxLineWidth(marked) - contentW);
  const display = computeRows(marked, contentW, this.viewWrap, this.viewHscroll);
  ```
- [`viewer.ts:380-395` (`computeRows`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L380-L395)

## Potential Solution

Cache display rows keyed on `(relPath, mtime, width, wrapMode, hScroll)`. On scroll/keystroke, slice only the visible window from the cached wrapped rows; recompute only when the key changes (file content via mtime, resize, wrap toggle, or horizontal scroll shift in non-wrap mode).

## Acceptance Criteria

- [x] `computeRows` is not re-run for the full file on every keystroke when nothing affecting the rows changed.
- [x] Scroll/cursor/filter/wrap-toggle all render correctly at 120×36, 100×28, 80×24, and narrow widths.
- [x] `npm run typecheck` and `npm test` are green (render width-safety suite included).

## Resolution

Added `rowsCache` keyed on `(marked ref, width, wrap, hscroll)`. `marked` is itself cached (`markedCache` keyed on `(viewFile, searchVersion)`) so its reference is stable across renders that don't change content/search. Vertical scrolling and cursor moves now reuse the cached wrapped rows instead of re-wrapping the whole file each keystroke; the cache misses only when the file, search results, current match, width, wrap mode, or horizontal scroll actually change. All 107 tests green (incl. render width-safety at 120×36/100×28/80×24/narrow).
