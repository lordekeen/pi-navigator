# Issue #079: Shallow `readonly` on `NavigatorSettings` Leaves Nested Section Properties Mutable

- **Status**: Open
- **Type**: Technical Debt / Type Safety
- **Severity**: Medium
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L22-L46)

---

## Description

In [`settings.ts` L22-46](file:///home/jhonny/Sources/pi-navigator/settings.ts#L22-L46), `NavigatorSettings` marks its top-level section properties as `readonly`, but the section interfaces themselves declare their fields as mutable:

```typescript
export interface NavigatorViewerSettings {
  wrap: boolean;
  markdown: "code" | "rendered";
}

export interface NavigatorTreeSettings {
  showHidden: boolean;
}

export interface NavigatorSettings {
  readonly version: number;
  readonly images: NavigatorImageSettings;
  readonly icons: NavigatorIconSettings;
  readonly viewer: NavigatorViewerSettings;
  readonly tree: NavigatorTreeSettings;
}
```

Because the properties within `NavigatorViewerSettings`, `NavigatorTreeSettings`, `NavigatorImageSettings`, and `NavigatorIconSettings` lack `readonly` modifiers, TypeScript allows direct mutations such as:
```typescript
settings.images.mode = "chafa";
settings.viewer.wrap = true;
```

This violates the immutability guarantees of the settings model. Specifically, [`applyFieldEdit`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L449) and [`setField`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L488) rely on structural sharing where unedited sections share references with previous settings objects. In-place mutations will contaminate other snapshots or default objects.

## Root Cause Analysis

Missing `readonly` modifiers on the properties of section interfaces in `settings.ts`.

## Potential Solution

Mark all properties in the nested section interfaces as `readonly`:

```typescript
export interface NavigatorImageSettings {
  readonly mode: NavigatorImageMode;
}

export interface NavigatorIconSettings {
  readonly enabled: boolean;
}

export interface NavigatorViewerSettings {
  readonly wrap: boolean;
  readonly markdown: "code" | "rendered";
}

export interface NavigatorTreeSettings {
  readonly showHidden: boolean;
}
```

## Acceptance Criteria

- [ ] All properties in `NavigatorImageSettings`, `NavigatorIconSettings`, `NavigatorViewerSettings`, and `NavigatorTreeSettings` are declared `readonly`.
- [ ] Attempting to mutate nested properties results in a TypeScript compile-time error.
- [ ] `npm run typecheck` and `npm test` pass.
