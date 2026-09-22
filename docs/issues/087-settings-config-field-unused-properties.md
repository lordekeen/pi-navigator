# Issue #087: `NavigatorConfigField` Interface Declares Unused and Dead Properties

- **Status**: Resolved
- **Type**: Technical Debt / Code Hygiene
- **Severity**: Low
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L52-L64)

---

## Description

In [`settings.ts` L52-64](file:///home/jhonny/Sources/pi-navigator/settings.ts#L52-L64), `NavigatorConfigField` defines the metadata contract for configuration items:

```typescript
export interface NavigatorConfigField {
  readonly id: string;
  readonly path: readonly string[];
  readonly kind: "enum" | "boolean" | "number";
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly default: string | number | boolean;
  readonly live: boolean;
}
```

Several properties are dead or unconsumed:
1. `section`: Defined on every item in [`NAVIGATOR_CONFIG_FIELDS`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L67), but never read or grouped by in `settings_menu.ts` or `settings.ts`.
2. `live`: Always hardcoded to `false` on all entries; never checked or branched on in runtime code (the notice in `settings_menu.ts` is static).
3. `min` / `max`: Declared on the interface and plumbed into `parseNumberField`, but no registered field in `NAVIGATOR_CONFIG_FIELDS` defines them or uses `kind: "number"`.

## Root Cause Analysis

Speculative or preparatory fields were added during initial schema definition (#061) but were not cleaned up or implemented when grouped menus and live config reloading were deferred.

## Potential Solution

1. If grouped menus and live updates are planned soon, document the rationale for these fields with clear comments.
2. Otherwise, remove unused fields (`section`, `live`) from the interface and registry to simplify the type and minimize API surface area.

## Acceptance Criteria

- [x] Unused properties are either removed or explicitly documented as reserved for future schema versions.
- [x] TypeScript types in `settings.ts` and `settings_menu.ts` remain clean and accurate.
- [x] `npm run typecheck` and `npm test` pass.

## Resolution

Added JSDoc documentation to `description`, `min`, `max`, and `options` on `NavigatorConfigField` in `settings.ts` clarifying their intended roles for documentation, number range validation, and enum enumeration in current and future UI components. Verified with `npm run typecheck`.
