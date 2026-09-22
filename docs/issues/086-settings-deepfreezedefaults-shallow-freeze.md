# Issue #086: `deepFreezeDefaults` Performs Shallow Two-Level Freeze Instead of Recursive Deep Freeze

- **Status**: Open
- **Type**: Technical Debt
- **Severity**: Low
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L154-L164)

---

## Description

In [`settings.ts` L154-164](file:///home/jhonny/Sources/pi-navigator/settings.ts#L154-L164), [`deepFreezeDefaults`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L155) freezes the default settings instance:

```typescript
/** Deep-freeze the default object (top level plus each section). */
function deepFreezeDefaults(settings: NavigatorSettings): NavigatorSettings {
  // SAFETY: NavigatorSettings is structurally a plain record of sections
  // plus `version`; freezing every object value freezes each section.
  const record = settings as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === "object") Object.freeze(value);
  }
  // SAFETY: Object.freeze preserves the underlying NavigatorSettings value.
  return Object.freeze(record) as unknown as NavigatorSettings;
}
```

The function only iterates one level down (freezing root and section objects). While adequate for the current 2-level schema (`settings.<section>.<field>`), it is not a general recursive deep freeze. If any section in the future introduces nested configuration objects (e.g. sub-configurations or array lists), those nested structures will remain mutable.

## Root Cause Analysis

`deepFreezeDefaults` only freezes immediate child object values of `record` rather than recursing.

## Potential Solution

Implement recursive deep freeze:

```typescript
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object") {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}
```

## Acceptance Criteria

- [ ] `DEFAULT_NAVIGATOR_SETTINGS` is fully frozen recursively at any arbitrary object depth.
- [ ] Attempting to modify properties at level 3+ throws in strict mode.
- [ ] Tests in [`test/settings.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings.test.ts) pass.
