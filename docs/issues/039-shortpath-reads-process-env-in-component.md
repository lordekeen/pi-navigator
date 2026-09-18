# Issue #039: `shortPath` Reads `process.env` Inside the Component

- **Status**: Resolved
- **Type**: Enhancement / Technical Debt
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) · [`shortPath`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1634-L1642)

---

## Description

`shortPath` reads `process.env.HOME` and `process.env.USERPROFILE` directly:

```typescript
const home = process.env.HOME ?? process.env.USERPROFILE ?? "";  // line 1635
```

The AGENTS.md convention states: *"The component never touches `process.env`"*. The icons env (`PI_NAV_ICONS`) is correctly read once in `index.ts` and passed into the constructor. `HOME` should follow the same pattern.

While harmless in practice (env doesn't change mid-process), it breaks the stated contract and makes the component impure.

## Code References

- [`navigator.ts:1635`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1635) — `process.env.HOME` read
- [`navigator.ts:211-221`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L211-L221) — constructor (where it should be stored)

## Potential Solution

Read `HOME` once in the constructor and store it as a private field:

```typescript
constructor(options: NavigatorOptions) {
  // ... existing
  this.home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
}
```

Or pass it through `NavigatorOptions` from `index.ts` so the component stays env-free.

## Acceptance Criteria

- [x] `shortPath` no longer reads `process.env` directly.
- [x] `HOME` is read once at overlay open and stored as a field.
- [x] Tilde shortening still works correctly.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Added optional `home?: string` to `NavigatorOptions`, read once in `index.ts` at overlay startup, stored as `private home` in `NavigatorOverlay`, and removed all `process.env` reads from `navigator.ts`. Added test in `test/navigator.test.ts`.
