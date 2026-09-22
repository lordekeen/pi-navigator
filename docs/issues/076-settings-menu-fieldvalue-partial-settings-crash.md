# Issue #076: `fieldValue` Throws `TypeError` on Partial Settings or Missing Sections

- **Status**: Open
- **Type**: Bug / Robustness
- **Severity**: High
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L29-L35)

---

## Description

In [`settings_menu.ts` L29-35](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L29-L35), [`fieldValue`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L29) walks the settings object along `field.path`:

```typescript
function fieldValue(settings: NavigatorSettings, path: readonly string[]): string | number | boolean {
  let current: unknown = settings;
  for (const segment of path) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current as string | number | boolean;
}
```

If `settings` is partial or contains an undefined/null section (such as if a section was omitted, malformed, or wiped in memory), `current` becomes `undefined` or `null`. On the subsequent segment iteration, indexing `current[segment]` throws an unhandled `TypeError`:
```
TypeError: Cannot read properties of undefined (reading 'mode')
```

This prevents the settings menu from opening at all, blocking the user from viewing or correcting their configuration.

## Root Cause Analysis

[`fieldValue`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L29) assumes every path segment exists without checking whether `current` is a non-null object at each step.

## Potential Solution

Add a null/object check at each step of path traversal, and fall back to the field's default value or `undefined`:

```typescript
function fieldValue(
  settings: NavigatorSettings,
  path: readonly string[],
  fallback?: string | number | boolean,
): string | number | boolean {
  let current: unknown = settings;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      return fallback ?? "";
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return (current ?? fallback) as string | number | boolean;
}
```

## Acceptance Criteria

- [ ] `fieldValue` safely resolves defaults without throwing `TypeError` when an intermediate section is undefined or null.
- [ ] The settings menu opens successfully even if passed a partial settings object.
- [ ] Unit test in [`test/settings_menu.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings_menu.test.ts) covers partial/empty settings objects.
