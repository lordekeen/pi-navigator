# Issue #073: `parseNumberField` Accepts Empty String as Zero and Accepts `Infinity`

- **Status**: Resolved
- **Type**: Bug
- **Severity**: High
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L431-L442)

---

## Description

In [`settings.ts` L431-442](file:///home/jhonny/Sources/pi-navigator/settings.ts#L431-L442), [`parseNumberField`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L431) parses string values for numeric settings:

```typescript
export function parseNumberField(
  rawValue: string,
  min?: number,
  max?: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = Number(rawValue);
  if (Number.isNaN(parsed)) return { ok: false, error: `invalid number "${rawValue}"` };
  let value = parsed;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return { ok: true, value };
}
```

In JavaScript, `Number("")` and `Number("  ")` return `0`, not `NaN`. As a result, empty or whitespace-only inputs are silently accepted as valid number `0`.

Additionally, `Number("Infinity")` evaluates to `Infinity`, which passes `!Number.isNaN(parsed)` and returns `{ ok: true, value: Infinity }`.

## Root Cause Analysis

[`parseNumberField`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L431) does not check for empty/whitespace string input before conversion, and uses `Number.isNaN()` instead of `Number.isFinite()`.

## Potential Solution

Guard against empty strings and verify that the converted number is finite:

```typescript
export function parseNumberField(
  rawValue: string,
  min?: number,
  max?: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = rawValue.trim();
  if (trimmed === "") return { ok: false, error: `invalid number "${rawValue}"` };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, error: `invalid number "${rawValue}"` };
  let value = parsed;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return { ok: true, value };
}
```

## Acceptance Criteria

- [x] `parseNumberField("")` and whitespace strings return `{ ok: false, error: ... }`.
- [x] `parseNumberField("Infinity")` and `parseNumberField("-Infinity")` return `{ ok: false, error: ... }`.
- [x] Valid numeric strings continue to parse and clamp correctly.
- [x] Unit tests in [`test/settings.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings.test.ts) cover empty strings, whitespace, and Infinity.

## Resolution

Updated `parseNumberField` in `settings.ts` to check `trimmed.length > 0` before parsing and verified that `Number.isFinite(parsed)` holds. Empty or whitespace-only strings now trigger a validation warning and fall back to the default value. Verified with automated tests in `test/settings.test.ts`.
