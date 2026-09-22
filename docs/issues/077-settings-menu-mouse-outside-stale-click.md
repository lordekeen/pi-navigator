# Issue #077: Settings Menu Drops Mouse Events Outside List Bounds, Causing Stale Click State and Dead Scroll Zones

- **Status**: Open
- **Type**: Bug / UI Consistency
- **Severity**: High
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L222-L229)

---

## Description

In [`settings_menu.ts` L222-229](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L222-L229), [`handleMouse`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L222) forwards mouse events to `SettingsList`:

```typescript
  handleMouse(event: PituiMouseEvent): PituiMouseResult | undefined {
    // Mirror pi-tui Container's child dispatch: only rows inside the list
    // receive the event, with y translated past the frame chrome. The
    // SettingsList owns wheel scroll and click selection itself.
    const y = event.y - FRAME_HEADER_ROWS;
    if (y < 0 || y >= this.listHeight) return undefined;
    return this.list.handleMouse?.({ ...event, y, height: this.listHeight });
  }
```

This strict bounding creates two bugs:
1. **Stale `mousePressedIndex`**: When the user presses the mouse button down on a list item (`event.type === "press"`), `SettingsList` records `this.mousePressedIndex = itemIndex`. If the user drags or releases the cursor outside the list area (e.g. over the title, footer, or outside the panel), the release event (`click` or mouseup) is dropped by `y < 0 || y >= this.listHeight`. As a result, `mousePressedIndex` remains stored. The subsequent click inside the list evaluates `this.selectedIndex = this.mousePressedIndex ?? itemIndex`, incorrectly jumping selection to the previously pressed item rather than the newly clicked one.
2. **Dead scroll wheel**: If the user scrolls the mouse wheel while hovering over the frame header (top rule, title row, blank line) or footer (blank line, footer note, bottom rule), the wheel events are dropped.

## Root Cause Analysis

`handleMouse` discards all events outside the list vertical range rather than handling drag/release tracking or routing wheel scroll events to the inner list.

## Potential Solution

1. Route `wheel` events to `this.list` regardless of whether `y` falls in the header or footer chrome (clamping or passing with appropriate `y`).
2. If a click or release occurs outside the list bounds while a press was pending, ensure `SettingsList` receives the release or reset event to clear `mousePressedIndex`.

## Acceptance Criteria

- [ ] Releasing the mouse button outside the list does not corrupt subsequent click selections.
- [ ] Mouse wheel scrolling functions anywhere within the settings menu frame chrome (header and footer).
- [ ] Unit tests in [`test/settings_menu.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings_menu.test.ts) cover mouse press inside followed by release outside, and wheel events on chrome rows.
