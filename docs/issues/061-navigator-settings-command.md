# Issue #061: Slash-Command Settings Menu and Help (`/navigator settings` / `/navigator help`)

- **Status**: Resolved (v0.7.0)
- **Type**: Feature
- **Severity**: Medium
- **Component**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) / [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts) / new `settings_menu.ts` / new `help.ts` / [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`icons.ts`](file:///home/jhonny/Sources/pi-navigator/icons.ts)

---

## Description

pi-navigator is configured only by editing `~/.pi/agent/pi-navigator.json` or setting environment variables; there is no in-pi surface. Feature #057 landed the settings terrain deliberately *ahead* of a UI: `normalizeNavigatorSettings`, `serializeNavigatorSettings`, the atomic `writeNavigatorSettings`, and the ordered `NAVIGATOR_CONFIG_FIELDS` registry are implemented and tested but unused ("the `/navigator configure` modal is future work", spec §5.2). This issue builds that UI, plus a help surface for the extension's slash commands.

Design references (approved): **pi-overseer** `src/ui.ts` + `src/config-fields.ts` for the settings menu (pi-tui `SettingsList` in an overlay, cycle-to-edit, validate-by-re-normalizing, atomic write → reload → notify); **pi-qdrant-memory** `src/handlers.ts` (`COMMAND_ROWS`) + `src/out.ts` (`helpLines`) for the help message layout (branded header, `commands` section, command column padded to longest + 2, dim descriptions, delivered as a durable transcript entry, not a toast).

## Command grammar

| Invocation | Behavior |
| :--- | :--- |
| `/navigator` | Open the overlay (unchanged, backward compatible). |
| `/navigator settings` | Open the settings menu (TUI only; non-TUI sessions get a warning notice). |
| `/navigator help` | Append a durable help entry to the transcript. |
| `/navigator <anything else>` | Warning notice + help entry. |

Plus `getArgumentCompletions` for `settings` / `help`.

## Settings surface (v1)

Fields added to the versioned schema (all `live: false` — settings are read once per `/navigator` invocation, so every change applies on the next open):

| Field | Kind | Default | Options |
| :--- | :--- | :--- | :--- |
| `images.mode` | enum | `off` | `off`, `chafa` |
| `icons.enabled` | boolean | `false` | — |
| `viewer.wrap` | boolean | `false` | — |
| `viewer.markdown` | enum | `code` | `code`, `rendered` |
| `tree.showHidden` | boolean | `false` | — |

`git.historyCount`, `viewer.tabWidth`, refresh/layout/highlight constants, and pi-chafa knobs are deliberately **not** settings (see spec rationale). Env still wins over the file: `PI_NAV_IMAGES` and `PI_NAV_ICONS`; overridden rows are annotated in the menu. `PI_NAV_ICONS` gains the same enable/disable/invalid truth table `PI_NAV_IMAGES` already has.

## Acceptance Criteria

- [x] `/navigator` with no args opens the overlay exactly as before.
- [x] `/navigator settings` opens a pi-tui `SettingsList` **in the editor dock** (see [#062](062-settings-menu-overlay-placement.md) — the original overlay placement deviated from the pi settings-UI standard and was corrected in v0.7.1); Enter/Space cycles a row and persists immediately through the atomic writer; Esc closes without writing.
- [x] Every registry field round-trips: menu change → file content → effective behavior on the next `/navigator` open (`icons.enabled`, `viewer.wrap`, `viewer.markdown`, `tree.showHidden`, `images.mode`).
- [x] Env-overridden rows are annotated; `PI_NAV_ICONS` invalid values warn and fall back to the file value.
- [x] `/navigator help` renders the qdrant-memory layout (header, `commands` section, aligned rows) as a durable transcript entry; unknown subcommands warn then show it.
- [x] Argument completions offered for `settings` / `help`.
- [x] Width-safety render tests for the settings overlay; pure-builder and routing tests added.
- [x] README + AGENTS.md updated (commands, configuration terrain, module map, suite count).
- [x] `npm run typecheck` and `npm test` green; version bumped to `0.7.0` and `pi install .` re-run.

## Resolution

Implemented in v0.7.0 (spec: [`docs/specs/navigator-settings-menu.md`](../specs/navigator-settings-menu.md)). `settings.ts` gained the four-section schema (`icons`/`viewer`/`tree`), the pure `applyFieldEdit`, and the five-field registry; `icons.ts` gained `parseIconMode` (with `parseEnableIcons` kept as a compatibility wrapper); new `settings_menu.ts` implements the pure builder plus the pi-tui `SettingsList` menu with commit/revert and env-override annotations (originally rendered as a centered overlay — corrected to the editor-dock placement in v0.7.1, see [#062](062-settings-menu-overlay-placement.md)); new `help.ts` holds the qdrant-memory-parity layout. `index.ts` routes `settings`/`help`/unknown, registers the durable entry renderer, exposes argument completions, and wires env-resolved settings into the overlay; `navigator.ts` gained `initialShowHidden` / `initialWrap` / `initialRenderMarkdown` (defaults preserve prior behavior). Reference studies: pi-overseer (`src/ui.ts`, `src/config-fields.ts`) and pi-qdrant-memory (`src/handlers.ts`, `src/out.ts`). Ten suites / 346 cases green; `tsc --noEmit` clean.

## References

- Spec: [`docs/specs/navigator-settings-menu.md`](../specs/navigator-settings-menu.md)
- Predecessor: [`docs/specs/chafa-image-rendering.md`](../specs/chafa-image-rendering.md) §5 (settings terrain, D12 user-level only)
- Menu reference: `/home/jhonny/Sources/pi-overseer` (`src/ui.ts`, `src/config-fields.ts`)
- Help layout reference: `/home/jhonny/Sources/pi-qdrant-memory` (`src/handlers.ts`, `src/out.ts`)
