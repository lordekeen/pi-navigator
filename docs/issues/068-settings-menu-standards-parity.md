# Issue #068: Settings Menu Standards Parity (host theme roles, mouse forwarding, host framing)

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Low
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts), [`test/settings_menu.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings_menu.test.ts), [`test/render.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/render.test.ts)
- **Found by**: audit of `/navigator settings` against the settings menus installed in `~/.pi/agent`

---

## Description

Issue #062 fixed the menu's *placement* (editor dock, non-overlay `ctx.ui.custom`), but the panel's
internals still diverged from the settings menus every other pi surface renders. The audit compared
navigator against the standard set:

- pi core `/settings` — `dist/modes/interactive/components/settings-selector.js` (`SettingsList` +
  `getSettingsListTheme()` + `DynamicBorder` top/bottom, `enableSearch`, `enableSearch: true`,
  maxVisible 10, immediate apply, Esc → cancel).
- pi-overseer `src/ui.ts` — same theme mapping, `SettingsList` framed by `BorderLine` top/bottom.
- `@aliou/pi-utils-settings` `src/theme.ts` — reuses `getSettingsListTheme()` verbatim.
- pi-tasks `src/ui/settings-menu.ts`, pi-usage `src/usage-settings-ui.ts` — title row (accent bold) +
  list, same roles.

## Findings fixed

1. **Theme roles were inverted.** `settings_menu.ts` built its `SettingsListTheme` as
   `label: selected ? accent : muted` and `value: selected ? accent : plain` — the opposite of the host
   mapping (`label: selected ? accent : plain`, `value: selected ? accent : muted`). Every other
   settings list in the agent renders bright labels with muted values; navigator rendered gray labels
   with bright values. The roles now live in an exported pure `buildSettingsMenuTheme(theme)`
   (`getSettingsListTheme` semantics, injected pi `Theme` tokens, no hardcoded colors), unit-tested.
2. **Mouse was dead.** `SettingsMenuFrame` implemented `render`/`handleInput`/`invalidate` but not
   `handleMouse`, so `SettingsList`'s wheel scroll and click selection never fired. The frame now
   forwards mouse events with `y` translated past its three header rows (rule, title, blank) and
   `height` set to the list's rendered height — the pi-tui `Container` child-dispatch semantics — and
   ignores events on its own chrome rows. `ComponentLike`/`SettingsListLike` carry
   `handleMouse?(event: PituiMouseEvent): PituiMouseResult | undefined` using the file's existing
   lazy structural pi-tui mirrors, so no `unknown`-typed boundary remains.
3. **No host-style framing.** pi's own `/settings` frames the list between `DynamicBorder` rules and
   pi-overseer between `BorderLine` rules, both in the `border` token. The frame now renders a full-width
   `─` rule above and below (title row and the `changes apply the next time /navigator opens` footer
   note kept inside), and truncates it with the repo's empty-ellipsis convention so width-safety holds
   at every suite size.

## Assessed, deliberately not changed

- **Flat registry rows.** The registry carries `section` metadata, but `docs/specs/navigator-settings-menu.md`
  §2.1 defers a grouped UI and pi core's own selector is flat; five rows stay flat.
- **Immediate commit.** Navigator writes on every cycle (pi core / pi-overseer / pi-tasks standard).
  The `@aliou/pi-utils-settings` draft model (Ctrl+S save, Esc discard, dirty markers) was considered and
  not adopted: it changes the persistence contract, not the menu's standard compliance.
- **Global-only scope.** `docs/specs/chafa-image-rendering.md` D12 keeps `~/.pi/agent/pi-navigator.json`
  user-level; no Global/Local scope tabs.
- **No `getSettingsListTheme()` import.** The host function reads the module-global theme; navigator
  keeps building the identical roles from the `ctx.ui.custom` injected theme, per its "no hardcoded
  colors, theme is injected" rule.

## Acceptance Criteria

- [x] `buildSettingsMenuTheme` matches the host `getSettingsListTheme` roles and is unit-tested.
- [x] Frame forwards mouse events with the header offset; chrome rows are not forwarded.
- [x] Frame renders full-width `border`-token rules top and bottom at every suite width.
- [x] Existing cycle/commit/revert/Esc behavior unchanged; no option object passed to `ctx.ui.custom`.
- [x] `npm run typecheck` and `npm test` green (19 suites / 501 cases).

## References

- [#062](062-settings-menu-overlay-placement.md) (placement fix this completes)
- [#061](061-navigator-settings-command.md) (the command, registry and menu this refines)
- pi-overseer `src/ui.ts`, `docs/research/settings-menu-ui-patterns.md`
