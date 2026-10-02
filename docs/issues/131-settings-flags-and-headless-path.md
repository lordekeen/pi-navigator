# Issue #131: Settings Live Only in a File — Three Env Vars, No `registerFlag`, No Headless Path

- **Status**: Resolved
- **Type**: Technical Debt / Platform Contract
- **Severity**: Medium
- **Components**: [`constants.ts`](../../constants.ts) (`NAVIGATOR_*_ENV`), [`index.ts`](../../index.ts) (`parseNavigatorArgs`, `runSettings`), [`settings.ts`](../../settings.ts) (precedence)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M8](../exploration/ui-skill-compliance-audit.md#medium)

## Description

Two related gaps, both about a setting being reachable outside the settings dialog.

**1. Env vars where the host offers flags.** `PI_NAV_IMAGES`, `PI_NAV_ICONS` and `PI_NAV_LAYOUT`
(`constants.ts:79-99`) are the only startup override, and `pi.registerFlag` / `pi.getFlag` are never
used — though both exist in the host (verified on 0.85.1 **and** 0.99.2:
`pi-coding-agent/dist/core/extensions/types.d.ts:1190-1205`) and the standard's substitution table
names them as the mechanism for a launch-time option:

> *"Want a value configurable at startup? `pi.registerFlag(name, { description, type, default })`, read
> with `pi.getFlag(name)`."* — `modes-and-parity.md`

Registrations surface in `pi --help`; env vars do not, so the three overrides are undiscoverable unless
the user reads the README or the settings menu's annotations.

**2. No headless path to any setting.** `parseNavigatorArgs` accepts exactly one token
(`index.ts:217-229`) and there is no value form, so `images.mode`, `icons.enabled`, `viewer.wrap`,
`tree.*` and `layout.default` cannot be set from a plain command. The standard's parity test —

> *"every capability reachable by interacting with your UI must also be reachable by a plain command.
> If a setting can only be changed through a dialog, the extension is unusable in `print` mode."*

— passes for **layout** (`/navigator all|files|git` are real subcommands) and fails for every other
field. In `print`/`json` mode the menu cannot open at all ([#122](122-nav-guard-silent-non-tui-modes.md)),
so those settings are entirely unreachable there.

**Honest mitigation, which is why this is Medium and not High:** the env-var choice is namespaced,
documented, precedence-tested (`env > file > default`) and surfaced in the menu as per-row annotations
naming the overriding variable (`index.ts:865-870`). This is a reasoned deviation, filed so the trade is
visible rather than silent — and because discoverability in `pi --help` is a real gain.

## Reproduction Steps

1. Run `pi --help` — no pi-navigator flags are listed.
2. In `print`/`json` mode, try to change any setting: the menu cannot mount and no subcommand accepts a value.
3. The only routes left are hand-editing `~/.pi/agent/pi-navigator.json` and exporting `PI_NAV_*`.

## Root Cause

Settings were built file-first with a menu on top; the command surface was never extended past
subcommand routing, and the startup channel chose env vars without weighing `registerFlag`'s
discoverability.

## Proposed Resolution

- **Startup:** register the three options with `pi.registerFlag` (keeping the env vars as the override, or
  choosing one and retiring the other), and document the resulting precedence in one table in the README.
- **Headless:** add a value form — e.g. `/navigator set <field> <value>` — reusing
  `NAVIGATOR_CONFIG_FIELDS` and `applyFieldEdit` so the command and the menu cannot drift into two
  validators, and print the resolved value with its scope on success.

## Acceptance Criteria

- [ ] Either `registerFlag` is adopted, or env-var-only is recorded as deliberate with the reason
- [ ] Every menu-editable field is reachable without mounting the dialog (or is explicitly documented as not)
- [ ] The value form shares the registry and validator with the menu — no second parser
- [ ] Bare and unknown-argument forms print a one-line usage
- [ ] README documents the precedence and the setting surface
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M8](../exploration/ui-skill-compliance-audit.md) — rules: `contract.md` §11 (`registerFlag`
  / `getFlag`), `modes-and-parity.md` §Parity matrix and §Scripting instead of inventing a CLI,
  `anti-patterns.md` §6
- Related: [#067](067-typed-config-registry-paths.md) (config registry), [#061](061-navigator-settings-command.md)
  (the settings command), [#122](122-nav-guard-silent-non-tui-modes.md) (headless refusal)

## Resolution

Both mechanisms, as chosen:

**Flags.** `--navigator-images`, `--navigator-icons` and `--navigator-layout` are registered with `pi.registerFlag`, so they are discoverable in `pi --help` (verified on the running host — env vars never appear there). Precedence is now defaults ← file ← env ← flag, applied inside `loadNavigatorSettings`; each flag that actually overrides contributes its name to `sources`, and an invalid flag value names the flag rather than the env var it beats. The flags register **without a default** on purpose: the host stores a declared default into the flag's value, so `getFlag` would return it even when the user passed nothing — absent must stay `undefined` for the layers to be distinguishable.

**Headless writes.** `/navigator set <field> <value>` writes any registry field with no UI mounted, in any mode. It calls the same pure `applyFieldEdit` the settings menu calls on every edit (`settings_menu.ts`), so there is no second parser, plus the same atomic writer. Failures warn with a one-line usage and write nothing; a field that a flag or env var will shadow is written with a notice saying so, because writing a value the running session ignores is worse than saying it.

Discovered by the wiring tests rather than the units: the settings load happens *inside* the `ctx.ui.custom` factory, so a test whose mock never invokes the factory asserts nothing — the failure class [#114](114-untested-cache-warn-wiring.md) recorded. The new wiring test drives the real factory and asserts the flag value reached the loader.

Verified: `npm run typecheck` and `npm test` green (760+ tests, 20 suites).

