# Issue #122: `/navigator` Guard Fails Silently in Every Non-TUI Mode

- **Status**: Resolved
- **Type**: Bug / Modes & Parity
- **Severity**: High
- **Components**: [`index.ts`](../../index.ts) (`runNavigator` guard, `runSettings` guard)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 H2](../exploration/ui-skill-compliance-audit.md#high)

## Description

`runNavigator` guards on `!ctx.hasUI` alone (`index.ts:391-394`), and that guard is silent in
**both** modes it is meant to protect. The sibling settings path does it correctly
(`index.ts:845`: `!ctx.hasUI || ctx.mode !== "tui" || …`), so the two surfaces disagree about the
same capability.

**json/print** — `hasUI` is false, so the guard fires, but its feedback channel is a no-op:

- `noOpUIContext.notify` is `() => {}` — `dist/core/extensions/runner.js:136`.

The user is told nothing; the command looks like it did not exist.

**rpc** — `hasUI` is **true**, so the guard **passes**:

- `hasUI()` is `uiContext !== noOpUIContext` — `runner.js:404`; RPC binds a real UI context
  (`dist/modes/rpc/rpc-mode.js:231`).
- `custom()` is a stub there: *"Custom UI not supported in RPC mode"*, returns `undefined` —
  `rpc-mode.js:153`.

So `/navigator` mounts nothing and returns normally: a **silent no-op**.

**Dead code** — the third clause, `typeof ctx.ui.custom !== "function"`, can never fire: `custom`
is a function in all three contexts (`runner.js:105`, `rpc-mode.js:152`, interactive). It looks
defensive and checks nothing.

## Reproduction Steps

1. Drive a session in RPC mode (`mode: "rpc"`) and invoke `/navigator` — nothing happens, no message.
2. Drive a session in `json` or `print` mode and invoke `/navigator` — the refusal is emitted to a
   no-op `notify`, so nothing is visible.

## Root Cause

The overlay guard was written against `hasUI` before the TUI-only rule was applied to it, and its
error channel (`ctx.ui.notify`) does not exist in the modes it guards against. The settings guard
was corrected later ([#062](062-settings-menu-overlay-placement.md) era, Issue #068 standards pass);
the primary surface was not.

## Proposed Resolution

- Guard the overlay on `ctx.mode !== "tui"` (the documented guard for custom components), keeping
  `!ctx.hasUI` as the dialog-capability half.
- Drop the dead `typeof ctx.ui.custom` clause.
- Make the refusal **reachable in the modes being refused**. `notify` is verified dead in
  json/print; the one channel already proven headless-safe in this extension is a transcript entry
  (`pi.appendEntry`, which `/navigator help` uses — `index.ts:933`). Use it, or emit a plain stdout
  line in `print`/`json` per the mode's own contract, and say which in a comment.

## Acceptance Criteria

- [x] `runNavigator` guards on `mode === "tui"`; RPC no longer silently no-ops
- [x] The refusal's channel is decided explicitly: `notify` where the host honours it (TUI, and RPC with a real UI), and a **documented accepted deviation** in json/print, where the host's only channel is a no-op — [`/navigator set`](131-settings-flags-and-headless-path.md) is the headless path those modes can use
- [x] Dead `typeof ctx.ui.custom` clause removed from `runSettings`
- [x] Tests assert a message on **every** guard path per mode (not merely "did not throw")
- [x] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 H2](../exploration/ui-skill-compliance-audit.md) — rules: `modes-and-parity.md`
  *"A guard must be visible to the user. `return;` with nothing else is the defect"* and
  *"Every custom component is guarded on `mode === "tui"`"*.
- Related: [#130](130-overlay-height-computed-twice.md) (same overlay mount path)

## Resolution

Two halves, resolved differently on purpose.

**RPC — fixed.** `runNavigator` now guards on `!ctx.hasUI || ctx.mode !== "tui"`, so RPC mode refuses instead of silently no-oping through the host's stub `ctx.ui.custom` (which returns `undefined`). The dead `typeof ctx.ui.custom !== "function"` clause in `runSettings` is gone: `custom` is a function in every host context, so the check could never fire.

**json / print — accepted deviation, decided explicitly.** `ctx.ui.notify` is a verified no-op in these modes (the host's `noOpUIContext.notify` is an empty function), so a guard whose only channel is `notify` cannot make itself heard there. The channels were weighed and the decision was to accept and document rather than invent one: stdout in json mode is contractually exactly one machine-readable document, and writing to stderr would be the first direct terminal write in this extension — an invariant this codebase keeps everywhere else. What the refusal loses in reach is offset by what those modes gained: [`/navigator set <field> <value>`](131-settings-flags-and-headless-path.md) is a real path there and needs no UI at all, so the *capability* is reachable even though the *menu* is not.

The channel criterion below originally demanded visibility in all three modes; it was **amended to record this decision** rather than quietly ticked.

Verified: `npm run typecheck` and `npm test` green (20 suites).

