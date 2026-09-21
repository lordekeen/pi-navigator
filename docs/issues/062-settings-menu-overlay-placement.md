# Issue #062: Settings Menu Opened as a Centered Overlay Instead of Docking Above the Message Input

- **Status**: Resolved (v0.7.1)
- **Type**: Bug / UI Consistency
- **Severity**: Medium
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts) / [`constants.ts`](file:///home/jhonny/Sources/pi-navigator/constants.ts) / [`docs/specs/navigator-settings-menu.md`](file:///home/jhonny/Sources/pi-navigator/docs/specs/navigator-settings-menu.md)

---

## Description

`/navigator settings` opened its `SettingsList` through

```ts
ctx.ui.custom<void>(factory, { overlay: true, overlayOptions: SETTINGS_OVERLAY_OPTIONS })
// SETTINGS_OVERLAY_OPTIONS = { width: "64%", minWidth: 40, maxHeight: "80%", anchor: "center", margin: 1 }
```

which floats a modal in the **middle of the window**, covering the transcript. The pi standard for a settings surface is the opposite: a plain (non-overlay) `ctx.ui.custom` component, which the host docks in the **editor area on/above the message textbox**, leaving the session visible.

Evidence for the standard:

- pi core's own `/settings` selector: `showSettingsSelector()` → `showSelector()` clears `editorContainer` and adds the component there (`dist/modes/interactive/interactive-mode.js`) — no overlay involved. Every pi selector (model, theme, tree, session, trust) follows this path.
- [`docs/plans/ui-standards-report.md`](file:///home/jhonny/Sources/pi-navigator/docs/plans/ui-standards-report.md) §2.1 already documents both modes side by side: overlay = "full interactive component on top of the transcript. This is what pi-navigator uses" (the *navigator* overlay), whereas `ctx.ui.custom(component)` without overlay "temporarily replaces the editor".
- The spec's own reference implementation, pi-overseer, does **not** use an overlay for its menu — `src/ui.ts:351` is `await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {...})`, and its design notes call the surface the editor dock: "The configure menu docks directly in the input area above the footer, keeping the session transcript visible rather than obscuring it with an elevated overlay" (`DESIGN.md`).
- `@aliou/pi-utils-settings` (the shared settings-UI package for pi extensions) likewise calls `ctx.ui.custom` with no overlay options (`src/settings-command.ts:255`).

Root cause: `docs/specs/navigator-settings-menu.md` §4.2 (the #061 spec) misread its own reference and mandated the overlay call; the implementation faithfully followed it. The spec is therefore amended as part of this fix, not just the code.

## Reproduction Steps

1. In an interactive pi session, run `/navigator settings`.
2. Observe a bordered settings modal centered vertically in the window, with the transcript hidden behind it.

## Root Cause

Spec-mandated `{ overlay: true, anchor: "center" }` for a surface that belongs in the editor dock.

## Potential Solution

Drop the overlay options from the `ctx.ui.custom` call (the menu becomes an editor-dock component), delete the now-unused `SETTINGS_OVERLAY_OPTIONS` constant, narrow the `SettingsMenuUi` shape (no options parameter), amend the spec, and lock the contract with a test asserting `custom` is invoked with exactly one argument.

## Acceptance Criteria

- [x] `/navigator settings` renders in the editor area above the input; the transcript stays visible.
- [x] No overlay options reach `ctx.ui.custom`; `SETTINGS_OVERLAY_OPTIONS` is gone (no dead export).
- [x] `SettingsMenuUi.custom` no longer advertises an options parameter.
- [x] Spec §4.2 and §8 amended; README/AGENTS.md module descriptions updated.
- [x] Regression test: `openSettingsMenu` calls `ctx.ui.custom` with exactly one argument (no options object).
- [x] Width-safety render tests still pass (the component now renders at editor width).
- [x] `npm run typecheck` and `npm test` green.

## Resolution

`settings_menu.ts` now calls `ui.custom<void>(factory)` with no options object; the module and function docstrings describe the editor-dock placement and cite the references. `SETTINGS_OVERLAY_OPTIONS` removed from `constants.ts`; `SettingsMenuUi.custom` narrowed to the factory parameter only. `docs/specs/navigator-settings-menu.md` §4.2 now states the non-overlay requirement (with the amendment evidence), §8 test row reworded; `README.md` module map and `AGENTS.md` layout table updated. `test/settings_menu.test.ts` gains the one-argument contract test (347 cases total). version 0.7.1.

## References

- Spec: [`docs/specs/navigator-settings-menu.md`](../specs/navigator-settings-menu.md) §4.2
- Standards: [`docs/plans/ui-standards-report.md`](../plans/ui-standards-report.md) §2.1, §2.4
- Predecessor: [`docs/issues/061-navigator-settings-command.md`](061-navigator-settings-command.md)
- Menu reference: `/home/jhonny/Sources/pi-overseer` (`src/ui.ts`, `DESIGN.md` "Settings menu"), `@aliou/pi-utils-settings` (`src/settings-command.ts`)
