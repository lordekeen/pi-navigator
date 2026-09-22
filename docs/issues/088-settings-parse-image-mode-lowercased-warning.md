# Issue #088: `parseImageMode` Warning Uses Lowercased Input Contrary to `parseIconMode`

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Low
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L334-L345), [`icons.ts`](file:///home/jhonny/Sources/pi-navigator/icons.ts#L119-L123), [`env.ts`](file:///home/jhonny/Sources/pi-navigator/env.ts#L32-L46)

---

## Description

In [`settings.ts` L334-345](file:///home/jhonny/Sources/pi-navigator/settings.ts#L334-L345), [`parseImageMode`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L334) normalizes the input to lowercase before calling [`parseTruthyEnv`](file:///home/jhonny/Sources/pi-navigator/env.ts):

```typescript
export function parseImageMode(value: string | undefined): { mode: NavigatorImageMode | undefined; warning?: string } {
  if (value === undefined) return { mode: undefined };
  const trimmed = value.trim();
  if (trimmed === "") return { mode: undefined };
  const normalized = trimmed.toLowerCase();
  if (normalized === "chafa") return { mode: "chafa" };
  if (normalized === "native") return { mode: "native" };
  if (normalized === "auto") return { mode: "auto" };
  const parsed = parseTruthyEnv(normalized, NAVIGATOR_IMAGES_ENV);
  if (parsed.warning !== undefined) return { mode: undefined, warning: parsed.warning };
  return { mode: parsed.value ? "chafa" : "off" };
}
```

Because `parseTruthyEnv` embeds the provided raw string into its warning (`${trimmed} is not a valid ${envName} value; using the file/default setting`), passing `normalized` alters the user's original casing in warning messages.

For example:
- `PI_NAV_IMAGES="SIXEL"` generates: `sixel is not a valid PI_NAV_IMAGES value; using the file/default setting`
- Conversely, `parseIconMode("SIXEL")` passes the original casing and generates: `SIXEL is not a valid PI_NAV_ICONS value; using the file/default setting`

This inconsistency degrades user feedback clarity when reporting invalid environment variables.

## Root Cause Analysis

`parseImageMode` passes lowercased `normalized` to `parseTruthyEnv` instead of the original trimmed string. `parseTruthyEnv` already lowercases internally when evaluating boolean values.

## Potential Solution

Pass `trimmed` directly to `parseTruthyEnv`:

```typescript
  const parsed = parseTruthyEnv(trimmed, NAVIGATOR_IMAGES_ENV);
```

## Acceptance Criteria

- [x] Warnings for invalid `PI_NAV_IMAGES` values preserve the user's original casing.
- [x] Warning formatting matches `PI_NAV_ICONS` / `parseIconMode`.
- [x] Tests in [`test/settings.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings.test.ts) updated and passing.

## Resolution

Updated `parseImageMode` in `settings.ts` to pass the original `trimmed` value to `parseTruthyEnv` so casing is preserved in unrecognized value warnings, matching `parseIconMode`. Verified with automated tests in `test/settings.test.ts`.
