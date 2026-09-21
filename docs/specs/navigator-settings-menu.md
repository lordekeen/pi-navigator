# pi-navigator Settings Menu & Slash-Command Help

**Status**: Approved (Issue #061) · **Target version**: 0.7.0 · **Module owner**: `settings_menu.ts` (new), `help.ts` (new)

References studied for this design:

- **Menu**: `/home/jhonny/Sources/pi-overseer` — `src/ui.ts` (`openConfigModal`, pure `buildSettingItems` + thin pi-tui wrapper, `SettingsList`, Esc writes nothing), `src/config-fields.ts` (field registry, `applyFieldEdit` validates by re-normalizing), `src/config-loader.ts` (`writeUserConfig` tmp+rename), `src/index.ts` (`parseOverseerArgs`, verbs, TUI guard, commit = write → reload → notify warnings).
- **Help layout**: `/home/jhonny/Sources/pi-qdrant-memory` — `src/handlers.ts` (`COMMAND_ROWS`, `helpHandler`) and `src/out.ts` (`helpLines`: branded header, `commands` title, column padded to longest cmd + 2, dim descriptions; host truncates, the extension never picks a truncating width). Delivery is a durable custom entry via `appendEntry` + `registerEntryRenderer`, never `ctx.ui.notify`.
- **Predecessor**: `docs/specs/chafa-image-rendering.md` §5 (settings terrain; the field registry and atomic writer were built for exactly this UI).

---

## 1. Command grammar & routing

`/navigator` receives everything after the first space as a raw args string. The grammar is a single optional subcommand: the **first whitespace-delimited token** decides; trailing tokens are ignored.

| Invocation | Action |
| :--- | :--- |
| `/navigator` | `runNavigator` overlay — **unchanged** (backward compatible). |
| `/navigator settings` | Open the settings menu. Guard: `ctx.hasUI && ctx.mode === "tui"`; otherwise `ctx.ui.notify("pi-navigator settings requires the interactive TUI", "warning")`. |
| `/navigator help` | Append the durable help entry (§6). |
| `/navigator <other>` | `ctx.ui.notify('pi-navigator: unknown subcommand "…"', "warning")` then append the help entry. |

Argument completions (`getArgumentCompletions`) return `settings` / `help`, filtered by prefix; `null` when nothing matches.

A pure, exported `parseNavigatorArgs(args: string): { kind: "overlay" | "settings" | "help" | "unknown"; raw?: string }` lives in `index.ts` and is unit-tested. Matching is case-sensitive lowercase (a `Settings` token is unknown → help).

## 2. Settings schema (version 1, additive)

`NavigatorSettings` grows from 1 to 4 sections. `version` stays `1`: the additions are backward compatible — an existing file with only `images` loads with defaults for the rest, and a newer-file (`version > 1`) still substitutes defaults with a warning.

```json
{
  "version": 1,
  "images": { "mode": "off" },
  "icons":  { "enabled": false },
  "viewer": { "wrap": false, "markdown": "code" },
  "tree":   { "showHidden": false }
}
```

```ts
export interface NavigatorSettings {
  readonly version: number;
  readonly images: NavigatorImageSettings;   // { mode: "off" | "chafa" }
  readonly icons: NavigatorIconSettings;     // { enabled: boolean }
  readonly viewer: NavigatorViewerSettings;  // { wrap: boolean; markdown: "code" | "rendered" }
  readonly tree: NavigatorTreeSettings;      // { showHidden: boolean }
}
```

Normalizer rules (each invalid value → one short warning + that field's default; unknown keys per section → the existing capped per-key warnings; `MAX_UNKNOWN_KEY_WARNINGS` unchanged):

- `images.mode`: `off` | `chafa`; anything else warns and falls back to `off`.
- `icons.enabled`: boolean only.
- `viewer.wrap`: boolean only.
- `viewer.markdown`: `code` | `rendered`.
- `tree.showHidden`: boolean only.
- A section present but not an object warns and defaults, mirroring `images` today.

`serializeNavigatorSettings` emits all four sections in canonical order; the round-trip `normalize(serialize(s)) === s` must hold.

### 2.1 Field registry (`NAVIGATOR_CONFIG_FIELDS`)

Five fields, in this order (the menu renders them flat, in registry order; `section` is metadata for a future grouped UI):

| id | path | kind | options | section | label | description (one line) | live |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `images.mode` | `["images","mode"]` | enum | `off`, `chafa` | Images | Image rendering | Render image files as chafa symbol art in the viewer pane; off keeps the metadata card. | false |
| `icons.enabled` | `["icons","enabled"]` | boolean | — | Icons | Nerd Font icons | Show a Nerd Font filetype icon column in the file tree (requires a Nerd Font terminal). | false |
| `viewer.wrap` | `["viewer","wrap"]` | boolean | — | Viewer | Word wrap | Start files with word wrap enabled; the `w` key still toggles it per session. | false |
| `viewer.markdown` | `["viewer","markdown"]` | enum | `code`, `rendered` | Viewer | Markdown view | Open Markdown files as rendered text or plain code; the `m` key still toggles it per session. | false |
| `tree.showHidden` | `["tree","showHidden"]` | boolean | — | Tree | Hidden files | Start with hidden files visible; the `.` key still toggles it per session. | false |

The registry interface gains optional `min` / `max` (number fields, future use), matching the pi-overseer `ConfigField` shape where it matters.

### 2.2 `applyFieldEdit` (pure)

```ts
export function applyFieldEdit(
  settings: NavigatorSettings,
  fieldId: string,
  rawValue: string,
): { ok: true; settings: NavigatorSettings } | { ok: false; error: string };
```

- unknown field id → `{ ok: false, error: 'unknown setting "…"' }`.
- `boolean`: `"on"` → true, `"off"` → false, anything else → error.
- `enum`: must be in `field.options` → error otherwise.
- `number`: parse a number, clamp into `[min, max]` when defined, reject `NaN`.
- Returns a fresh settings object (never mutates the input).

Validation is deliberately the same rule set as the normalizer — no second source of truth for accepted values.

## 3. Precedence & environment

Unchanged direction, extended to icons: **defaults ← user file ← env**.

| Env var | Field | Values |
| :--- | :--- | :--- |
| `PI_NAV_IMAGES` | `images.mode` | enable `1/true/yes/on/chafa`; disable `0/false/no/off`; anything else warns, file value stands; empty/whitespace = no override (existing `parseImageMode`). |
| `PI_NAV_ICONS` | `icons.enabled` | enable `1/true/yes/on`; disable `0/false/no/off`; anything else warns, file value stands; empty/whitespace = no override (**new** `parseIconMode`, mirroring `parseImageMode`). |

`loadNavigatorSettings` accepts `env?: { images?: string; icons?: string }` and resolves both. `parseEnableIcons` stays exported as a compatibility wrapper over `parseIconMode` (`enabled ?? false`), so existing behavior for the documented enable values is unchanged.

**Menu vs effective value:** the settings menu edits the *file* value (loader called without `env`) and annotates any env-shadowed row with `— overridden by PI_NAV_IMAGES (env wins)`. Editing an overridden row still writes the file; the env value remains effective until it is unset. This is the navigator equivalent of pi-overseer's "project" annotation.

**Apply timing:** every field is `live: false`. Settings are read once per `/navigator` invocation, so the menu footer carries a single note — `changes apply the next time /navigator opens` — instead of per-row annotations.

## 4. Settings menu UI (`settings_menu.ts`)

### 4.1 Pure builder

```ts
export interface SettingItemData {
  id: string;
  label: string;
  description: string;   // field.description + env-override note when shadowed
  currentValue: string;  // "on"/"off" for booleans, raw value for enums
  values: string[];      // ["on","off"] for booleans, field.options for enums
}

export function buildSettingItems(
  settings: NavigatorSettings,
  overrides: Readonly<Record<string, string>>, // fieldId → env var name
): readonly SettingItemData[];
```

`currentValue` is read from `settings` by walking `field.path`. `values` drives pi-tui's Enter/Space cycling. Pi-free: no imports beyond types.

### 4.2 TUI layer

```ts
export interface SettingsMenuDeps {
  settings: NavigatorSettings;
  overrides: Readonly<Record<string, string>>;
  commit: (next: NavigatorSettings) =>
    | { ok: true; settings: NavigatorSettings }
    | { ok: false; error: string };
  onWarning: (message: string) => void;
}

export async function openSettingsMenu(ui: SettingsMenuUi, deps: SettingsMenuDeps): Promise<void>;
```

- Uses pi-tui's `SettingsList` (`new SettingsList(items, 10, theme, onChange, onCancel, { enableSearch: true })`) — pi-tui owns navigation (up/down), Enter/Space cycling, search typing, and Esc-cancel. No key handling is written by hand.
- `ctx.ui.custom<void>((tui, theme, _keybindings, done) => component)` with **no overlay options** — the menu docks in the editor area on/above the message textbox, the pi standard for extension settings UI (pi's own `/settings` selector replaces the editor container; `/home/jhonny/Sources/pi-overseer` `src/ui.ts` and `@aliou/pi-utils-settings` both call `ctx.ui.custom` without `overlay`). The transcript stays visible instead of being covered by a centered modal. Esc → `onCancel` → `done()` (writes nothing).
- Guarded dynamic/shape check like the navigator overlay: `ctx.ui.custom` is assumed present in TUI mode.
- The wrapper component (`SettingsMenuOverlay`) renders the navigator's visual language: a titled frame (`pi-navigator · settings`), the list, and a dim footer note `changes apply the next time /navigator opens`. It delegates `handleInput` to the `SettingsList`. Every line it produces itself is width-safe with `visibleWidth` / `truncateToWidth(…, "")`; the `SettingsList` truncates its own lines. The component renders into whatever width the editor area has, so width safety is asserted the same way as the navigator overlay.
- Theme: a `SettingsListTheme` built from the injected pi `Theme`/`makeNavigatorTheme` tokens (label accent/muted, value default/accent, description dim, cursor accent, hint dim). **No hardcoded colors.**
- `onChange(id, rawValue)`: `applyFieldEdit(current, id, raw)`; on `!ok` → `onWarning` + restore the item's previous display value via `list.updateValue`. On ok → `commit(next)`; on `{ok:false}` → warning + restore; on success → replace `current` from the returned settings and refresh every row (`updateValue`), because normalization may canonicalize more than the edited field.

### 4.3 Index wiring (fs owner)

- `runSettings(ctx)`:
  1. `const fileLoaded = loadNavigatorSettings({ userPath })` (no env) → notify `fileLoaded.warnings` once per distinct message (existing dedup set).
  2. Build `overrides` from raw env presence: non-empty `process.env[NAVIGATOR_IMAGES_ENV]` → `images.mode`, non-empty `process.env[ICONS_ENV]` → `icons.enabled`.
  3. `await openSettingsMenu(ctx.ui, { settings, overrides, commit, onWarning })`.
  4. `commit(next)`: `writeNavigatorSettings(userPath, next)` → `const reloaded = loadNavigatorSettings({ userPath })` → notify its warnings → `{ ok: true, settings: reloaded.settings }`. Any throw → `{ ok: false, error }` (bounded message), no notification from `commit` itself (the menu calls `onWarning`).
- `runNavigator` loads with env (`images` + `icons`) and passes the resolved initial state into the overlay ctor.

## 5. Wiring into the overlay (`navigator.ts`)

New optional ctor options (all default to today's behavior):

```ts
initialShowHidden?: boolean;     // default false
initialWrap?: boolean;           // default false
initialRenderMarkdown?: boolean; // default false
```

`enableIcons` already exists; `index.ts` now derives it from `loaded.settings.icons.enabled` (env-resolved). The component still never reads env or files; keys (`.`, `w`, `m`, `i`) keep working as session overrides.

## 6. Help entry (`help.ts` + `index.ts`)

- Entry type: `HELP_ENTRY_TYPE = "navigator-help"`; data `{ cwd: string }`.
- `index.ts` registers the renderer once in the extension factory and appends `{ cwd: ctx.cwd }` on `/navigator help` (works in every mode; no TUI guard).
- Pure builder, tested:

```ts
export const NAVIGATOR_COMMANDS: readonly { cmd: string; desc: string }[] = [
  { cmd: "/navigator",          desc: "open the read-only project navigator overlay" },
  { cmd: "/navigator settings", desc: "configure images, icons, viewer, and tree behavior" },
  { cmd: "/navigator help",     desc: "show this command list" },
];

export function buildHelpLines(data: { cwd: string }): string[]; // unthemed, aligned
```

Layout (qdrant-memory parity), rendered with `makeNavigatorTheme(theme)`:

```text
pi-navigator — /home/jhonny/Sources/pi-navigator     ← accent; cwd dim
commands                                             ← bold
/navigator            open the read-only project navigator overlay
/navigator settings   configure images, icons, viewer, and tree behavior
/navigator help       show this command list
                                                        ← blank
inside the overlay: press ? for keys, q to close     ← dim
```

- Command column width = longest command length + 2. Descriptions dim. The host handles terminal-edge truncation (no width math in the builder) — matching the reference's explicit rule.
- Renderer returns `new Text(lines.join("\n"))` wrapped in the theme; `entry.data?.cwd ?? ""` guards restored sessions.

## 7. Error handling

| Case | Behavior |
| :--- | :--- |
| Non-TUI `/navigator settings` | Warning notice, no UI. |
| Corrupt/unreadable settings file | Loader warning(s) notified before the menu opens; menu shows defaults. |
| Commit write/reload failure | `{ok:false, error}` → warning notice, row display reverts, nothing partially applied. |
| Env-shadowed field | Row annotated; edit still persists to the file. |
| `version > 1` file | Existing behavior (defaults + warning), also surfaced when the menu loads the file view. |
| `entry.data` missing (old/restored entry) | Renderer falls back to `cwd: ""`. |

## 8. Tests

| Suite | New coverage |
| :--- | :--- |
| `test/settings.test.ts` | Expanded defaults; per-section normalizer accept/reject/unknown-key; serializer round-trip; `applyFieldEdit` (ok, unknown id, bad enum, bad boolean, number clamp); registry guard: 5 fields, unique ids/paths, every path resolvable in defaults, kinds/options valid. |
| `test/icons.test.ts` | `parseIconMode` truth table (enable/disable/invalid/empty); `parseEnableIcons` compatibility. |
| `test/settings_menu.test.ts` (new) | `buildSettingItems` values + override annotations; menu integration with the real `SettingsList`: cycle persists via `commit`, failed `commit` reverts + warns, Esc closes with zero commits. |
| `test/help.test.ts` (new) | `buildHelpLines` header/order/alignment (longest + 2)/dim row shape; `parseNavigatorArgs` routing (empty, settings, help, unknown, extra tokens, case). |
| `test/render.test.ts` | Settings menu renders within width at 120×36, 100×28, 80×24 and a narrow width; no width overflow, no stray escapes. |

## 9. Docs, packaging & release

- `README.md`: Usage block gains `settings` / `help`; new/updated Configuration section: file shape, env table incl. `PI_NAV_ICONS` disable/invalid values, the menu, "applies on next open"; module map gains `settings_menu.ts` and `help.ts`.
- `AGENTS.md`: code-layout table rows for both new modules; icons convention updated to "explicit opt-in via `icons.enabled` or `PI_NAV_ICONS` (env wins); still no auto-detection"; entry-point bullet mentions subcommands; settings data-enters-via-ctor contract; test suite/case counts refreshed.
- `package.json`: `files` gains `settings_menu.ts`, `help.ts`; `version` → `0.7.0`; then `pi install .` per the dogfooding rule.
- `docs/issues/061-navigator-settings-command.md` + `issues_index.md` status/resolution.
