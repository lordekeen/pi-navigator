# Issue #084: Horizontal Scroll Recomputes and Slices Entire File in `computeRows`

- **Status**: Open
- **Type**: Performance
- **Severity**: Low
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L584-L598), [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts)

---

## Description

In [`viewer.ts` L584-598](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L584-L598), [`computeRows`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L584) derives display rows for the viewer pane:

```typescript
export function computeRows(file: ViewerFile, width: number, wrap: boolean, hscroll: number): DisplayRow[] {
  const rows: DisplayRow[] = [];
  if (width <= 0) return rows;
  for (let i = 0; i < file.lines.length; i++) {
    const line = file.lines[i];
    if (line === undefined) continue;
    if (wrap) {
      const chunks = wrapTextWithAnsi(line, width);
      chunks.forEach((chunk: string, index: number) => rows.push({ line: index === 0 ? i : null, text: chunk }));
    } else {
      rows.push({ line: i, text: sliceStyled(line, hscroll, hscroll + width) });
    }
  }
  return rows;
}
```

In `wrap: false` mode, `computeRows` runs [`sliceStyled`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L81) across every line in `file.lines` (up to `MAX_HIGHLIGHT_LINES`, e.g. 5,000 lines).

Because the cache key in `cachedComputeRows` includes `hscroll`, every horizontal scroll keystroke (`h`, `l`, arrow keys) misses the cache and triggers a full-file re-slice of 5,000 lines, even though the terminal viewport only displays 20–30 visible rows.

While vertical scroll benefits from the cache, horizontal scroll suffers O(file_length) work per keystroke.

## Root Cause Analysis

`computeRows` slices all lines eagerly for horizontal scrolling instead of deferring horizontal slicing to the viewport windowing pass.

## Potential Solution

In nowrap mode:
1. Return rows referencing un-sliced lines in `computeRows` (keyed only on `width` and `wrap`).
2. Apply `sliceStyled(line, hscroll, hscroll + width)` lazily only to the subset of lines visible in the active viewport (`viewTop` to `viewTop + bodyRows`).

## Acceptance Criteria

- [ ] Horizontal scroll does not re-slice unrendered lines outside the viewport.
- [ ] Rendered visual output and width-safety remain byte-identical across all test widths.
- [ ] Existing viewer tests and render suites pass.
