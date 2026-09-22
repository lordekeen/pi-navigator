# Issue #080: Duplicate Field ID in Settings Menu Warning Notifications

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Medium
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L289), [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L462-L475)

---

## Description

In [`settings_menu.ts` L289](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L289), when an edit fails validation, the menu formats the warning message as:

```typescript
deps.onWarning(`pi-navigator: ${id}: ${edited.error}`);
```

However, [`applyFieldEdit`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L449) in [`settings.ts` L462-475](file:///home/jhonny/Sources/pi-navigator/settings.ts#L462-L475) already includes the field ID in `edited.error`:
- Boolean: `invalid value "${rawValue}" for "${fieldId}"; expected on or off`
- Enum: `invalid value "${rawValue}" for "${fieldId}"; expected one of ${options.join(", ")}`
- Number: `${parsed.error} for "${fieldId}"`

This results in duplicated field identifiers in user-facing warnings:
```
pi-navigator: images.mode: invalid value "foo" for "images.mode"; expected one of off, chafa, native, auto
```

## Root Cause Analysis

`applyFieldEdit` includes `for "${fieldId}"` in its error message while `settings_menu.ts` also prepends `${id}: `.

## Potential Solution

Choose one consistent pattern:
1. Strip `for "${fieldId}"` from `applyFieldEdit` error strings so errors describe the validation failure neutrally (e.g. `invalid value "foo"; expected one of ...`), allowing callers like `settings_menu.ts` to contextualize with `${id}: `.
2. Or change `settings_menu.ts` to `deps.onWarning(\`pi-navigator: \${edited.error}\`);`.

## Acceptance Criteria

- [x] Validation failure warnings display the field ID exactly once.
- [x] Warning formats are aligned between `settings.ts` and `settings_menu.ts`.
- [x] Unit tests in [`test/settings_menu.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings_menu.test.ts) and [`test/settings.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings.test.ts) pass.

## Resolution

Updated `onChange` in `settings_menu.ts` to format warning messages as `pi-navigator: ${edited.error}` without prefixing with duplicate field ID, as `validateFieldValue` already includes the field path in error strings. Verified with automated tests in `test/settings_menu.test.ts`.
