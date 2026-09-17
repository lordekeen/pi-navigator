# Issue #011: `sliceStyled` Allocates a String Suffix Per Character (O(n²))

- **Status**: Resolved
- **Type**: Bug / Performance
- **Severity**: High
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) / [`sliceStyled`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L72-L90)

---

## Description

[`sliceStyled`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L72-L90) column-slices a styled (ANSI-laden) line for horizontal scrolling. Inside the character loop it calls `styled.slice(i)` on **every iteration**, allocating a fresh copy of the remaining string each time. Over a long line this is quadratic in the line length.

Every visible line is sliced on **every render** while horizontal scroll is active, so the cost compounds across the viewport and scales with `O(lines × lineLength²)`.

## Code References

- [`viewer.ts:72-90` (`sliceStyled`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L72-L90):
  ```typescript
  export function sliceStyled(styled: string, start: number, end: number): string {
    let out = "";
    let column = 0;
    let styledOut = false;
    let i = 0;
    while (i < styled.length) {
      const rest = styled.slice(i);          // <-- O(n) alloc per char => O(n²)
      const esc = rest.match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (esc) { out += esc[0]; styledOut = true; i += esc[0].length; continue; }
      const ch = rest[0];
      if (column >= start && column < end) out += ch;
      column += 1;
      i += 1;
      if (column >= end) break;
    }
    ...
  }
  ```

## Root Cause

`styled.slice(i)` + `rest.match(/^…/)` recreates and re-scans the suffix each character. The escape regex is anchored but applied to a re-sliced string, so the allocation is the dominant cost.

## Potential Solution

Use a sticky regex over the full string with `exec` and an index cursor — no suffix allocation:

```typescript
const ESC_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
export function sliceStyled(styled: string, start: number, end: number): string {
  let out = ""; let column = 0; let styledOut = false; let i = 0;
  ESC_RE.lastIndex = i;
  while (i < styled.length) {
    ESC_RE.lastIndex = i;
    const esc = ESC_RE.exec(styled);
    if (esc) { out += esc[0]; styledOut = true; i += esc[0].length; continue; }
    const ch = styled[i];
    if (column >= start && column < end) out += ch;
    column += 1; i += 1;
    if (column >= end) break;
  }
  if (styledOut && !out.endsWith("\x1b[0m")) out += "\x1b[0m";
  return out;
}
```

Preserves escape-sequence handling and reset-termination exactly.

## Acceptance Criteria

- [x] `sliceStyled` no longer allocates a per-character suffix.
- [x] Escape sequences are preserved and the result is still reset-terminated when styling was included.
- [x] Viewer horizontal-scroll render tests in [`test/viewer.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/viewer.test.ts) pass.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Replaced the per-iteration `styled.slice(i)` + `rest.match(/^…/)` with a module-level sticky CSI regex (`/\x1b\[[0-9;?]*[ -/]*[@-~]/y`) whose `lastIndex` is set to the cursor before each `exec`. This scans the full string in place — no suffix allocation — turning the per-line cost from O(n²) to O(n). Escape handling, column-based slicing, wide-char-as-one-cell semantics, and reset-termination are unchanged. Covered by the existing `sliceStyled` unit tests (CSI preservation, reset termination, wide-char one-cell).
