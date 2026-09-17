# Issue #014: `maxLineWidth` Recomputed Every Render

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: Medium
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) / [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts)

---

## Description

[`maxLineWidth`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L397) runs `stripAnsi` + `Array.from` over every line (up to 5000) on every keystroke, just to size the horizontal scrollbar. Called from [`navigator.ts:1031`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1031) each render.

## Code References

- [`navigator.ts:1031`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1031) — `const maxH = Math.max(0, maxLineWidth(marked) - contentW);`
- [`viewer.ts:397` (`maxLineWidth`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L397)

## Potential Solution

Cache `maxLineWidth` per marked-file version (same cache key as #012: `relPath`/`mtime`/`width`). Invalidate on content or width change.

## Acceptance Criteria

- [x] `maxLineWidth` is not recomputed every keystroke when the file/width is unchanged.
- [x] Horizontal scrollbar sizing remains correct.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Added `maxLineWidthCache` keyed on the stable `viewFile` reference. Visible width is unaffected by search marking (highlighting wraps substrings in ANSI without adding visible characters), so the value is computed once per file and reused until the file is (re)opened. All 107 tests green.
