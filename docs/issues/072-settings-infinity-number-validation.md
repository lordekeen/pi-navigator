# Issue #072: Infinity Accepted as Valid Setting Value in `validateFieldValue`

- **Status**: Open
- **Type**: Bug
- **Severity**: High
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L222-L231)

---

## Description

In [`settings.ts` L222-231](file:///home/jhonny/Sources/pi-navigator/settings.ts#L222-L231), [`validateFieldValue`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L207) validates numeric configuration fields:

```typescript
    case "number": {
      if (typeof rawValue === "number" && !Number.isNaN(rawValue)) {
        let value = rawValue;
        if (field.min !== undefined) value = Math.max(field.min, value);
        if (field.max !== undefined) value = Math.min(field.max, value);
        return { ok: true, value };
      }
      return { ok: false, error: `${field.id} "${String(rawValue)}" is invalid; using ${String(field.default)}` };
    }
```

The validation checks `!Number.isNaN(rawValue)`, but fails to check `Number.isFinite(rawValue)`. As a result, `Infinity` and `-Infinity` pass validation when `min` or `max` are not defined.

When `writeNavigatorSettings` later serializes the configuration via `JSON.stringify()`, JavaScript converts `Infinity` to `null`:
```javascript
JSON.stringify({ value: Infinity }) // '{"value":null}'
```
This corrupts the settings file with an invalid `null` property.

## Root Cause Analysis

Missing `Number.isFinite()` check in the `"number"` branch of [`validateFieldValue`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L207).

## Potential Solution

Change the validation guard from `!Number.isNaN(rawValue)` to `Number.isFinite(rawValue)`:

```typescript
    case "number": {
      if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
        let value = rawValue;
        if (field.min !== undefined) value = Math.max(field.min, value);
        if (field.max !== undefined) value = Math.min(field.max, value);
        return { ok: true, value };
      }
      return { ok: false, error: `${field.id} "${String(rawValue)}" is invalid; using ${String(field.default)}` };
    }
```

## Acceptance Criteria

- [ ] `Infinity` and `-Infinity` are rejected by `validateFieldValue` and trigger fallback to the default value with an appropriate warning.
- [ ] Unit tests in [`test/settings.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings.test.ts) verify rejection of `Infinity` and `-Infinity`.
- [ ] `npm run typecheck` and `npm test` pass.
