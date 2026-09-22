# Issue #089: Lazy Dynamic Import of `pi-tui` in Settings Menu Is Defeated by Static Import in `index.ts`

- **Status**: Resolved
- **Type**: Technical Debt / Code Hygiene
- **Severity**: Low
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L245-L256), [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L29)

---

## Description

In [`settings_menu.ts` L245-256](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L245-L256), the module lazily loads `@earendil-works/pi-tui` via dynamic `import()`:

```typescript
  let pitui: PituiModule;
  try {
    pitui = (await import("@earendil-works/pi-tui")) as PituiModule;
  } catch (error) {
    deps.onWarning(`pi-navigator: settings menu unavailable: ${(error as Error).message}`);
    return;
  }
```

To support this without compile-time imports, `settings_menu.ts` defines ~40 lines of structural interface mirrors (`PituiModule`, `SettingsListLike`, `ComponentLike`, `PituiMouseEvent`, `PituiMouseResult`).

However, [`index.ts` L29](file:///home/jhonny/Sources/pi-navigator/index.ts#L29) statically imports `@earendil-works/pi-tui` at the root entry point:

```typescript
import { getCapabilities, Text } from "@earendil-works/pi-tui";
```

Because `index.ts` is the extension entry point loaded when pi launches, the `@earendil-works/pi-tui` package is already loaded and evaluated in the Node.js module registry immediately on startup. The dynamic import in `settings_menu.ts` provides zero runtime performance or isolation benefit while introducing extensive boilerplate and type casting.

## Root Cause Analysis

Inconsistent modularization strategy: `settings_menu.ts` was designed for lazy evaluation without coordinating with the static dependencies in `index.ts`.

## Potential Solution

1. If lazy loading of `pi-tui` is required: remove static imports in `index.ts` (e.g. dynamic import of `getCapabilities` and `Text`).
2. Alternatively (and simpler): switch `settings_menu.ts` to static TypeScript imports from `@earendil-works/pi-tui`, eliminating the redundant `SettingsListLike` and `PituiModule` boilerplate.

## Acceptance Criteria

- [x] Architectural consistency established between `index.ts` and `settings_menu.ts`.
- [x] If static import is adopted, redundant interface mirrors in `settings_menu.ts` are eliminated.
- [x] `npm run typecheck` and `npm test` pass.

## Resolution

Replaced the dynamic `import("@earendil-works/pi-tui")` in `settings_menu.ts` with static top-level imports and removed redundant duplicate interface declarations, aligning with the project-wide peer dependency model. Verified with automated tests in `test/settings_menu.test.ts`.
