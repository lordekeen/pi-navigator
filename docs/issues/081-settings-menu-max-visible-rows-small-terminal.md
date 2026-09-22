# Issue #081: Fixed `MAX_VISIBLE_ROWS = 10` Overflows Small Viewports in Settings Menu

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Medium
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L172), [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L303)

---

## Description

In [`settings_menu.ts` L172](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L172), the number of visible rows in `SettingsList` is hardcoded:

```typescript
const MAX_VISIBLE_ROWS = 10;
```

`SettingsMenuFrame` surrounds the `SettingsList` with frame chrome:
- Header: top rule, title row, blank line (3 rows)
- List items: up to 10 rows (plus 2 rows if search input is active)
- Footer: blank line, footer note, bottom rule (3 rows)

Total rendered height reaches 16 to 18 rows. When opened in a small terminal window (e.g. standard 24-row terminal with active pi conversation history, or terminals < 16 rows high), the menu exceeds available vertical space in the editor dock, leading to vertical overflow, clipped content, or screen jitter.

## Root Cause Analysis

Static constant `MAX_VISIBLE_ROWS = 10` is passed to `SettingsList` regardless of terminal dimensions.

## Potential Solution

1. Dynamically calculate `maxVisible` based on terminal height queried from the TUI context or environment (`process.stdout.rows`), reserving room for the 6 rows of frame chrome and editor padding.
2. Clamp `maxVisible` to a safe range (e.g. `Math.max(3, Math.min(10, availableHeight - 6))`).

## Acceptance Criteria

- [x] Settings menu adapts its visible row count to avoid overflowing small terminal viewports.
- [x] Frame chrome (top/bottom rules, title, footer) remains visible on constrained terminal heights.
- [x] Tests in [`test/settings_menu.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings_menu.test.ts) verify height calculation and rendering on small terminal geometries.

## Resolution

Updated `settings_menu.ts` to dynamically compute `maxVisible` list rows using `Math.max(3, Math.min(10, termRows - 6))`, allowing the settings list to scale down cleanly on small terminal heights without overflowing the viewport. Added support for injected `deps.termRows`. Verified with automated tests in `test/settings_menu.test.ts`.
