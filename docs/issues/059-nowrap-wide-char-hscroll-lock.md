# Issue #059: Nowrap Viewer Hscroll Locked at 0 on Wide-Char Lines (Line Tail Unreachable)

- **Status**: Resolved (v0.6.1)
- **Type**: Bug
- **Severity**: High
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) / [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts)

---

## Description

In the non-wrapping viewer mode, lines longer than the pane can be scrolled horizontally with `h`/`l` via `maxH = max(0, maxLineWidth - contentW)`. But `maxLineWidth`'s width model is wrong for East-Asian / emoji text:

- `viewer.ts:66` `visibleTextWidth` counts **code points** (each char = one cell — a documented and tested approximation for narrow chars).
- Terminals (and pi-tui's `visibleWidth`) count **cells**: a CJK char occupies 2 columns.
- `navigator.ts:1726` clamps `maxH` with this undercount.

Reproduced: a line of 60 CJK characters is 120 cells wide in the terminal. `padTo`/`sliceStyled` hard-cuts it to the pane (68 cells), but `maxLineWidth` returns ~60, so `contentW (61) >= maxLineWidth (60)` → `maxH = 0` → **hscroll is pinned at 0 and the right half of the line is unreachable**. Wrap mode is unaffected (pi-tui wraps by cells). The per-char approximation is documented/tested for truncation, but this lock-out consequence is not.

## Reproduction Steps

1. Create a file containing a single line of ~60 CJK characters (120 terminal cells).
2. Open it in the viewer with wrap mode off (`w`).
3. Observe the line hard-cut at the pane edge; press `l` — hscroll does not move; the tail is unreachable.

## Root Cause

Code-point width vs terminal-cell width divergence at `maxLineWidth` → `maxH` clamp.

## Potential Solution

Make `maxLineWidth`/`visibleTextWidth` count terminal cells — e.g. use pi-tui's `visibleWidth` (grapheme + East-Asian aware), or extend the local width helper to return 2 cells for East-Asian Wide ranges. Verify `sliceStyled`/`padTo` treat those chars as 2 cells consistently (they already consume per-terminal-cell via pi-tui on the render path, so fixing the measurement restores the lock).

## Acceptance Criteria

- [x] A 120-cell CJK line in a 68-cell pane yields `maxH > 0`; `h`/`l` reach the line tail.
- [x] Existing nowrap truncation behavior for narrow (1-cell) characters is unchanged.
- [x] Wrap mode unaffected.
- [x] New test: nowrap viewer with wide-char line — hscroll bounds and row width safety at 120×36 / 100×28 / 80×24.
- [x] `npm run typecheck` and `npm test` green.
