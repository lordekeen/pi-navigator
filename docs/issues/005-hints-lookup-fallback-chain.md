# Issue #005: Fragile Fallback Chain in Footer Hint Resolution

- **Status**: Resolved
- **Type**: Technical Debt / Code Quality
- **Severity**: Low
- **Component**: [`NavigatorOverlay`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`buildFooterRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L734-L758)

---

## Description

In [`buildFooterRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L741), hint text resolution uses an implicit fallback chain combining `this.mode` and `this.focus`:

```typescript
const hint = (this.mode === "help" ? HINTS.help : HINTS[this.mode] ?? HINTS[this.focus]) ?? "";
```

This logic relies on the fact that `HINTS` contains keys for both input modes (`"filter"`, `"search"`, `"help"`) and pane foci (`"files"`, `"git"`, `"viewer"`). 

Additionally, `HINTS.search` is simultaneously used as the input placeholder string for the search header in [`buildSearchBar`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1053) and as the footer hint row in [`buildFooterRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L741).

If a future mode is introduced without a corresponding key in `HINTS`, it will silently fall back to `HINTS[this.focus]`, which may present incorrect key hints to the user.

---

## Code References

- [`navigator.ts:51-61`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L51-L61)
- [`buildFooterRow` (navigator.ts:741)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L741)
- [`buildSearchBar` (navigator.ts:1053)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1053)

---

## Potential Solution

Extract hint resolution into an explicit helper method that checks `this.mode` and handles each mode exhaustively before consulting `this.focus`:

```typescript
private getFooterHint(): string {
  switch (this.mode) {
    case "help":
      return HINTS.help ?? "";
    case "filter":
      return HINTS.filter ?? "";
    case "search":
      return HINTS.search ?? "";
    case "normal":
      return HINTS[this.focus] ?? "";
  }
}
```

Separating mode hints from focus hints in distinct typed dictionaries (`MODE_HINTS: Record<InputMode, string>` and `FOCUS_HINTS: Record<Focus, string>`) guarantees type-safety and prevents unintended fallbacks.

---

## Acceptance Criteria

- [x] Footer hint selection is explicit and type-checked against `InputMode` and `Focus`.
- [x] No regression in footer rendering across any input mode or pane focus.
