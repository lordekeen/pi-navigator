# Issue #085: Grammatical Pluralization Error in Unknown Settings Overflow Warning

- **Status**: Resolved
- **Type**: Bug / UI Polish
- **Severity**: Low
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L186-L197)

---

## Description

In [`settings.ts` L186-197](file:///home/jhonny/Sources/pi-navigator/settings.ts#L186-197), [`warnUnknownSettings`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L186) formats a summary line when the number of unknown settings exceeds the warning threshold:

```typescript
    } else {
      warnings.push(`and ${keys.length - emitted} more unknown settings ignored`);
      return;
    }
```

When exactly one extra unknown setting is present (`keys.length - emitted === 1`), the message reads:
```
"and 1 more unknown settings ignored"
```
It should use the singular noun form: `"setting"`.

## Root Cause Analysis

Hardcoded plural `"settings"` without conditional pluralization on count.

## Potential Solution

Pluralize conditionally based on `remaining`:

```typescript
    } else {
      const remaining = keys.length - emitted;
      warnings.push(`and ${remaining} more unknown setting${remaining === 1 ? "" : "s"} ignored`);
      return;
    }
```

## Acceptance Criteria

- [x] When 1 unknown setting overflows the cap, warning says `"and 1 more unknown setting ignored"`.
- [x] When >1 unknown settings overflow the cap, warning says `"and N more unknown settings ignored"`.
- [x] Unit test in [`test/settings.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings.test.ts) verifies single overflow message.

## Resolution

Updated unknown settings warning in `settings.ts` to properly handle singular vs plural phrasing when reporting omitted unknown keys ("and 1 more unknown setting ignored" vs "and N more unknown settings ignored"). Verified with automated tests in `test/settings.test.ts`.
