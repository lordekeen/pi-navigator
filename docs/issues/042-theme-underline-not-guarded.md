# Issue #042: `theme.underline` Called Without a Safety Guard

- **Status**: Resolved
- **Type**: Enhancement / Robustness
- **Severity**: Medium
- **Component**: [`theme.ts`](file:///home/jhonny/Sources/pi-navigator/theme.ts) · [`makeNavigatorTheme`](file:///home/jhonny/Sources/pi-navigator/theme.ts#L29-L47)

---

## Description

`theme.bold` is guarded with a `typeof` check to handle themes that may not implement the method:

```typescript
bold: (t) => (typeof theme.bold === "function" ? theme.bold(t) : t),  // line 38
```

But `theme.underline` on line 44 is called directly without the same guard:

```typescript
searchCurrent: (t) => theme.underline(theme.bg("searchMatchBg", theme.fg("searchMatchText", t))),
```

If a theme implementation doesn't provide `underline`, the search-current highlight crashes with a `TypeError`.

## Code References

- [`theme.ts:38`](file:///home/jhonny/Sources/pi-navigator/theme.ts#L38) — guarded `bold` call
- [`theme.ts:44`](file:///home/jhonny/Sources/pi-navigator/theme.ts#L44) — unguarded `underline` call

## Potential Solution

Apply the same defensive `typeof` check:

```typescript
searchCurrent: (t) => {
  const highlighted = theme.bg("searchMatchBg", theme.fg("searchMatchText", t));
  return typeof theme.underline === "function" ? theme.underline(highlighted) : highlighted;
},
```

## Acceptance Criteria

- [x] `theme.underline` is guarded with `typeof` like `theme.bold`.
- [x] `searchCurrent` degrades gracefully when `underline` is not a function.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Added defensive `typeof theme.underline === "function"` guard to `searchCurrent` in `theme.ts`, returning un-underlined styled match when `underline` is not implemented. Added unit tests in `test/navigator.test.ts`.
