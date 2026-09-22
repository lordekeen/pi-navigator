# Issue #078: Unknown Settings Warning Cap Is Per-Section Rather Than Global

- **Status**: Open
- **Type**: Bug / Robustness
- **Severity**: Medium
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L186-L197), [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L295-L320)

---

## Description

In [`settings.ts` L186-197](file:///home/jhonny/Sources/pi-navigator/settings.ts#L186-L197), [`warnUnknownSettings`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L186) intends to cap warnings for unknown settings keys so that malformed files do not flood the user notice channel:

```typescript
function warnUnknownSettings(warnings: string[], keys: readonly string[], prefix: string): void {
  const start = warnings.length;
  for (const key of keys) {
    const emitted = warnings.length - start;
    if (emitted < MAX_UNKNOWN_KEY_WARNINGS) {
      warnings.push(`unknown setting "${prefix}${key}" ignored`);
    } else {
      warnings.push(`and ${keys.length - emitted} more unknown settings ignored`);
      return;
    }
  }
}
```

However, `start` is calculated per invocation (`const start = warnings.length`). [`warnUnknownSettings`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L186) is called independently for each of the 4 sections (`images`, `icons`, `viewer`, `tree`) at [L295](file:///home/jhonny/Sources/pi-navigator/settings.ts#L295) and once for unrecognized top-level sections at [L316](file:///home/jhonny/Sources/pi-navigator/settings.ts#L316).

Consequently, each section gets its own quota of 5 warnings plus 1 summary overflow line. A malformed file can produce up to 30 warning notifications (5 sections × 6 messages), flooding the host notification UI.

## Root Cause Analysis

The warning cap is scoped to each `warnUnknownSettings` call rather than tracking a global count across the entire `normalizeNavigatorSettings` pass.

## Potential Solution

Track a shared warning counter across all sections during normalization:

```typescript
function warnUnknownSettings(
  warnings: string[],
  keys: readonly string[],
  prefix: string,
  state: { emitted: number; cap: number },
): void {
  for (const key of keys) {
    if (state.emitted < state.cap) {
      warnings.push(`unknown setting "${prefix}${key}" ignored`);
      state.emitted++;
    } else {
      warnings.push(`and ${keys.length - (state.emitted - (warnings.length - keys.length))} more unknown settings ignored`);
      return;
    }
  }
}
```

Or collect all unknown keys across all sections first, then run a single capped summary pass.

## Acceptance Criteria

- [ ] The maximum number of unknown key warnings emitted by `normalizeNavigatorSettings` across all sections does not exceed a global cap (e.g. 5 individual + 1 overflow summary).
- [ ] Tests in [`test/settings.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings.test.ts) verify that a file with many unknown keys across multiple sections is bounded globally.
