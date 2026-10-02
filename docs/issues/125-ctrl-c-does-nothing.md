# Issue #125: `Ctrl+C` Does Nothing While the Overlay Is Open

- **Status**: Resolved
- **Type**: Bug / Keyboard Navigation
- **Severity**: Medium
- **Components**: [`navigator.ts`](../../navigator.ts) (`handleInput` dispatch and every mode handler)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M2](../exploration/ui-skill-compliance-audit.md#medium)

## Description

There is no `ctrl+c` branch anywhere in `navigator.ts` — the only Ctrl bindings are `Ctrl+N`/`Ctrl+P`
(search cycling) and `Ctrl+D`/`Ctrl+U` (half-page). While the overlay is mounted it owns the
keyboard, and pi-tui hands the key to it explicitly:

```js
// pi-tui/dist/tui.js:718 — "Pass input to focused component (including Ctrl+C)"
// The focused component can decide how to handle Ctrl+C
this.focusedComponent.handleInput(data);
```

The host's own keybinding table treats `Ctrl+C` and `Esc` as the **same** cancel:

```js
// pi-tui/dist/keybindings.js:87
"tui.select.cancel": { defaultKeys: ["escape", "ctrl+c"], description: "Cancel selection" }
```

This overlay implements the `Esc` half and swallows the other: pressing `Ctrl+C` with the navigator
open does nothing at all. It is not passed on to the editor either — the focused component consumes
the input path.

## Reproduction Steps

1. Run `/navigator` to open the overlay.
2. Press `Ctrl+C` — nothing happens.
3. Press `Esc` (or `q`) — the overlay closes, as expected.

## Root Cause

`Esc` was bound explicitly in each mode handler, and `Ctrl+C` was never bound because the component
does not consult the injected `KeybindingsManager` — the mechanism that already maps both keys to one
action. This shares a root cause with [#126](126-keybindings-manager-ignored.md).

## Proposed Resolution

Prefer the manager, which covers the key, its alias, **and** user remapping in one call:

```ts
keybindings.matches(data, "tui.select.cancel")   // matches escape, ctrl+c, and any user remap
```

Wire it to the same level of the Esc stack that `Esc` occupies today (mode-scoped inside the help
modal, clearing a query in filter/search, otherwise closing the overlay). A minimal hardcoded
`matchesKey(data, Key.ctrl("c"))` would fix the symptom but leave [#126](126-keybindings-manager-ignored.md)
open — not recommended.

## Acceptance Criteria

- [ ] `Ctrl+C` closes the overlay from normal mode
- [ ] `Ctrl+C` inside the help modal dismisses the modal only (matching `Esc`)
- [ ] `Ctrl+C` in filter/search leaves the field before closing (matching the Esc stack)
- [ ] Behaviour stays identical for `Esc`; no regression in the Esc-stack tests
- [ ] Tests assert `Ctrl+C` at each level of the stack
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M2](../exploration/ui-skill-compliance-audit.md) — rule: `navigation-and-focus.md`
  *"Two more cancellation paths that must behave the same: `Ctrl+C` inside a component cancels the
  whole thing."*
- Related: [#126](126-keybindings-manager-ignored.md) (same root cause, recommended fix)

## Resolution

`Ctrl+C` cancels at every level of the Esc stack — normal mode closes, the help modal dismisses only itself, filter and search leave the field first — because the cancel check is a single funnel (`matchesCancel`) consulted by each mode handler.

Verified end-to-end through the production wiring rather than a harness: the test registers the real extension, takes the component from the `ctx.ui.custom` factory with an injected manager, feeds the raw `\x03` byte and asserts the overlay closed.

Verified: `npm run typecheck` and `npm test` green (20 suites).

