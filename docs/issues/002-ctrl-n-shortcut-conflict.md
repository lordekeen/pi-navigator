# Issue #002: Global `ctrl+n` Shortcut Conflicts with Pi Built-in Keybinding

- **Status**: Resolved
- **Type**: Bug / Compatibility
- **Severity**: Medium
- **Component**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L216-L221) / Key Registration

---

## Description

The extension registers `ctrl+n` as a global application shortcut to launch `pi-navigator`. On Pi version 0.85.1 and newer, `ctrl+n` is bound by default to `app.session.toggleNamedFilter`. This causes Pi to emit an `[Extension issues]` conflict warning banner in the terminal at agent startup.

While the extension's handler currently takes precedence and overrides the built-in binding, the startup warning is noisy and cross-version behavior is not guaranteed.

## References

- [`index.ts:216-221`](file:///home/jhonny/Sources/pi-navigator/index.ts#L216-L221)
- [`index.ts:5`](file:///home/jhonny/Sources/pi-navigator/index.ts#L5)
- [`README.md:20`](file:///home/jhonny/Sources/pi-navigator/README.md#L20) and [`README.md:75`](file:///home/jhonny/Sources/pi-navigator/README.md#L75)
- [`plans/qa-evidence.md:52-56`](file:///home/jhonny/Sources/pi-navigator/plans/qa-evidence.md#L52-L56)
- [`plans/pi-navigator-implementation-plan.md:225`](file:///home/jhonny/Sources/pi-navigator/plans/pi-navigator-implementation-plan.md#L225)

---

## Current Behavior

```typescript
pi.registerShortcut("ctrl+n", {
  description: "Open pi-navigator",
  handler: async (ctx) => {
    await runNavigator(ctx);
  },
});
```
At startup, Pi prints:
```
[Extension issues] Shortcut "ctrl+n" registered by extension conflicts with built-in action "app.session.toggleNamedFilter".
```

---

## Potential Solution

### Option A: Remove Global Shortcut (Recommended)
Remove the `pi.registerShortcut("ctrl+n", ...)` call entirely. Users launch the tool via the stable `/navigator` command.

```typescript
export default function (pi: ExtensionAPI): void {
  pi.registerCommand("navigator", {
    description: "Open the read-only project navigator (file tree, git state, viewer)",
    handler: async (_args, ctx) => {
      await runNavigator(ctx);
    },
  });
}
```

### Option B: Remap to an Unoccupied Combination
Bind to an alternate shortcut that does not conflict with Pi defaults, such as `ctrl+shift+n` or `ctrl+alt+n`.

```typescript
pi.registerShortcut("ctrl+shift+n", {
  description: "Open pi-navigator",
  handler: async (ctx) => {
    await runNavigator(ctx);
  },
});
```

*Note*: Whichever option is chosen, update documentation in [`README.md`](file:///home/jhonny/Sources/pi-navigator/README.md#L20) and [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L5).

---

## Acceptance Criteria

- [x] Pi boots without displaying an `[Extension issues]` shortcut conflict banner.
- [x] `/navigator` remains functional.
- [x] Documentation and comments accurately reflect supported launch mechanisms.
