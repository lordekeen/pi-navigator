# pi-navigator Overlay Layout Modes (`files-git-viewer` / `files-viewer` / `git-viewer`)

**Status**: Draft — awaiting owner review · **Target version**: 0.12.0 · **Issue**: [#119](../issues/119-overlay-layout-modes.md) · **Module owners**: `types.ts` (layout union), `frame.ts` (pure derivations), `navigator.ts` (state + render), `settings.ts` (schema + env), `help.ts` / `index.ts` (commands)

References studied for this design:

- `docs/specs/navigator-settings-menu.md` — registry-driven settings schema, env-precedence contract, settings-menu wiring, and the one-table-drives-help/completions/parser pattern (Issue #063 finding 5).
- The render seam in `navigator.ts` — `render()` (left/right split + separator row), `buildLeftRows` (files group, separator placeholder, git group), `buildRightRows`.
- `frame.ts` geometry helpers and `test/frame.test.ts` / `test/render.test.ts` — the width-safety contract at 120×36, 100×28, 80×24, 74×24, and left-column-hidden at 60.

---

## 1. Purpose

The overlay has exactly one layout today: the left column splits vertically into the files pane (top, ~55%) and the git panel (bottom), the viewer sits on the right. Users who are working a git history or a large tree still pay the other pane's ~45% of the column. This spec adds two optional layouts and the command/settings surface to choose them.

| Layout | Slash command | Left column | Right |
| :--- | :--- | :--- | :--- |
| `files-git-viewer` | `/navigator all` | files pane (top) + git panel (bottom), today's split | viewer |
| `files-viewer` | `/navigator files` | files pane, full body height | viewer |
| `git-viewer` | `/navigator git` | git panel, full body height | viewer |

- Bare `/navigator` opens the layout named by the new setting `layout.default` (default `files-git-viewer`).
- The three direct commands are one-open selections: they never write settings.
- `PI_NAV_LAYOUT` overrides the settings default (`env wins`, the existing icons/images contract).

Nothing else about the overlay changes: the viewer pane, its keys, the git panel's contents, the file tree, and the data-collection pipeline are untouched.

## 2. Non-goals

- **No runtime layout switching.** No cycle key, no live reload. A layout is chosen when the overlay opens and is fixed for its lifetime. (`initialLayout` keeps the option name family from Issue #061 open for a later `setLayout` if ever wanted.)
- **No per-layout keybinding tables.** `?` keeps the single 19-row table; only the Tab and `t` descriptions change (§7).
- **No layout label in the chrome.** The title row, footer hint, and pane labels keep their current shapes; the footer's pane labels only drop absent panes.
- **No changes to data collection.** `setTree` and `setGitState` are pushed in every layout (§3, D9).
- **No change to left-column visibility rules** or to `t` semantics, including the pre-existing quirk that focus can remain on a previously visible pane after `t` hides the column (recorded in §10, not fixed here).
- **No new npm dependencies and no new test suite** — tests extend the existing suites.

## 3. Decisions

| ID | Decision | Rationale |
| :--- | :--- | :--- |
| D1 | Layout identity is the closed union `NavigatorLayout` derived from one `as const` array (`NAVIGATOR_LAYOUTS`), in `types.ts`. | One source for the type, the settings options, and router validation — the drift class Issue #063 fixed for commands. |
| D2 | All layout derivations are **pure functions in `frame.ts`** (`layoutPanes`, `layoutRows`, `visiblePanes`, `initialFocus`, `cycleFocus`). | Keeps the Issue #064 view-model seam: no layout logic in the component's render path beyond calling these. |
| D3 | Single-pane geometry: the surviving group's height is `body` (header + `body − 1` rows) and **no separator row is drawn**; the default layout is unchanged. | Makes a single pane exactly as tall as the viewer pane (`viewerArea`), which is what "full height" means to the user. |
| D4 | `useLeftColumn(innerW, body, showTree)` is **unchanged** — visibility depends on the terminal width and `t`, not on which panes the column holds. | Corrects the design-review wording that listed it among helpers taking a layout parameter; the parameter would be unused. |
| D5 | `filesArea(termRows)` becomes `filesArea(termRows, layout)` (explicit parameter, no default). `gitArea` stays render-local math derived from `layoutRows`. | The two out-of-render call sites (cursor visibility) must use the layout's files height; a default argument would hide a missed call site. |
| D6 | New ctor option `initialLayout?: NavigatorLayout` on `NavigatorOptions`, default `"files-git-viewer"`. `index.ts` resolves and injects it. | Matches the `initialShowHidden` / `initialWrap` / `initialRenderMarkdown` family (Issue #061) and the rule that the component never reads env or fs (#028/#039). |
| D7 | `t` keeps its actual behavior — hide/show the whole left column — in every layout; help wording changes from "toggle the file tree" to "hide or show the left column". Rename the private `showTree` field to `showLeftColumn` in the same commit (no test references it; grep-verified), since "tree" is no longer what it controls. | The current behavior is already "hide the left column"; the old wording was inaccurate, and layouts make it more visible. |
| D8 | `Focus` stays the three-value union. Tab/Shift+Tab cycle only visible panes; initial focus is `files` (`files-git-viewer`, `files-viewer`) or `git` (`git-viewer`). | Unreachable panes need no handler guards — focus is the gate. |
| D9 | Collection unchanged: index.ts still pushes both tree and git state in every layout. | Git state powers the title row's branch/ahead/behind/counters in `files-viewer`; the tree powers the git header's source label in `git-viewer`. Layout is presentation-only. |
| D10 | Settings gain `layout: { default: NavigatorLayout }`, appended **last** in registry/canonical order. Registry row `layout.default` (enum, options = `NAVIGATOR_LAYOUTS`) drives defaults, normalization, serialization, the menu row, and `applyFieldEdit`. `SETTINGS_VERSION` stays `1`. | The schema/validator/serializer/menu are registry-driven (verified in `settings.ts`), so the addition needs no special-casing; appending keeps the canonical order stable. |
| D11 | `PI_NAV_LAYOUT` (constant `NAVIGATOR_LAYOUT_ENV` in `constants.ts`, beside `NAVIGATOR_IMAGES_ENV`) overrides `layout.default`. Accepted values: exactly the three layout names — unlike `PI_NAV_IMAGES` there are no legacy boolean-ish tokens (`1`/`true`/`on`/…), because this env var is new. Empty/whitespace = no override; anything else = one warning and the file value stands. | Mirrors the `parseIconMode` / `parseImageMode` contract from the settings spec §3 (env wins; invalid warns, file stands) without inheriting the legacy flag grammar. |
| D12 | The three openers are rows in `NAVIGATOR_SUBCOMMANDS` carrying their target layout; `parseNavigatorArgs` returns `{ kind: "layout"; layout }` for them. Bare `/navigator` keeps `{ kind: "overlay" }` and resolves the default in `runNavigator`. | Preserves the one-table-drives-help/completions/parser invariant (#063) while keeping "overlay" the settings-resolved case. |
| D13 | Outside a git repository, `/navigator git` (and a `git-viewer` default) renders the git panel's existing unavailable/`no git` state at full height. No notify, no fallback layout. | The pane already owns that state; a layout switch is not an error condition. |

## 4. Layout model and API

```ts
// types.ts
export const NAVIGATOR_LAYOUTS = ["files-git-viewer", "files-viewer", "git-viewer"] as const;
export type NavigatorLayout = (typeof NAVIGATOR_LAYOUTS)[number];

// frame.ts — pure; no state, no cache, no `this` (Issue #064 seam)
export interface LayoutPanes {
  readonly files: boolean;
  readonly git: boolean;
}
export function layoutPanes(layout: NavigatorLayout): LayoutPanes;
export function layoutRows(body: number, layout: NavigatorLayout): { filesH: number; gitH: number };
export function visiblePanes(layout: NavigatorLayout): readonly Focus[];
export function initialFocus(layout: NavigatorLayout): Focus;
export function cycleFocus(focus: Focus, direction: 1 | -1, layout: NavigatorLayout): Focus;
export function filesArea(termRows: number, layout: NavigatorLayout): number;
```

- `layoutRows` for the default layout delegates to `splitRows(body)` (unchanged), and returns the full height to the surviving pane otherwise:

  | layout | `filesH` | `gitH` |
  | :--- | :--- | :--- |
  | `files-git-viewer` | `splitRows(body).filesH` | `splitRows(body).gitH` |
  | `files-viewer` | `body` | `0` |
  | `git-viewer` | `0` | `body` |

- Render/builder code branches on **`layoutPanes(layout)`**, never on a zero height (a zero height is a geometry fact, not the pane-presence source of truth).
- `filesArea(termRows, layout) = max(2, layoutRows(bodyRows(overlayHeight(termRows)), layout).filesH − 1)`.
- `visiblePanes` returns `[files, git, viewer]`, `[files, viewer]`, or `[git, viewer]` in that order; `cycleFocus` wraps within it (`direction` `1` for Tab, `-1` for Shift+Tab), preserving the current pane when it is visible.

## 5. Geometry and row accounting

`body = bodyRows(overlayHeight(termRows))` as today. A pane group is always **1 header row + its area**.

**Default layout (unchanged):** `filesH + gitH = body − 1`; the one remaining row is the horizontal separator drawn at body index `filesH`. Files area = `filesH − 1`, git area = `gitH − 1`. `splitRows` keeps its `GIT_MIN_ROWS = 4` adjustment.

**Single-pane layouts:** the group height is `body`, there is no separator, and the area is `body − 1` — byte-for-byte the same height the viewer pane gets from `viewerArea` (`bodyRows − 1`). `buildLeftRows` therefore emits, in `files-viewer`, the files header plus `body − 1` file rows; in `git-viewer`, the git header plus `body − 1` git rows (including the existing trailing-`…` marker and cursor-visibility logic, which already take their area as a parameter).

**Left column visibility (D4, unchanged):**

```text
useLeftColumn = showTree && body >= 8
                && innerW >= LEFT_COLUMN_HIDE_BELOW (72)
                && innerW − leftColumnWidth(innerW) − 1 >= 30
leftColumnWidth = clamp(floor(innerW * 0.3), 24, 44)     // LEFT_COLUMN_RATIO / MIN / MAX
```

When it is false the left column — and with it every pane it would hold — is absent in all three layouts and the viewer takes the full inner width. Narrow behavior therefore needs no per-layout rule.

**Worked example (120×36):** `overlayHeight = min(30, 34) = 30`, `body = 25`, `innerW = 118`, `leftW = 35` (clamped from `floor(118 · 0.3)`), `rightW = 118 − 35 − 1 = 82`.

| layout | files | separator | git |
| :--- | :--- | :--- | :--- |
| `files-git-viewer` | header + 12 rows (`filesH = 13`) | 1 row | header + 10 rows (`gitH = 11`) |
| `files-viewer` | header + 24 rows | — | — |
| `git-viewer` | — | — | header + 24 rows |

## 6. Focus and input

- **Initial focus** (D8): `initialFocus("git-viewer") = "git"`, otherwise `"files"`. Passed through the ctor with the layout.
- **Cycling:** the Tab branch in `handleNormalInput` (today the literal `["files", "git", "viewer"]` array) becomes `cycleFocus(this.focus, direction, this.layout)`. Orders: default `files → git → viewer` (unchanged); `files-viewer` `files ↔ viewer`; `git-viewer` `git ↔ viewer`.
- **Unreachable panes:** files-only keys (`.` hidden toggle, `/` filter, `Enter` open file, `y` copy path) are unreachable in `git-viewer`; git-only keys (family expansion, `g G` within the git pane) are unreachable in `files-viewer`. No handler guards are added — `focus` cannot hold an absent pane, and the existing per-focus dispatch is the gate. Global keys (`Tab`, `?`, `q`, `r`, `t`, `j k`) are unaffected.
- **Filter/search:** filter mode is entered with `/` from files focus and is therefore unavailable in `git-viewer`; viewer search (`/` from viewer focus) works in every layout. The footer filter bar and `buildFilterBar` are unchanged.
- **`t` (D7):** unchanged in all layouts — hides/shows the left column. Focus is not repaired when the column hides (pre-existing behavior, see §10).
- **Help modal `?`:** unchanged; it lists every keybinding regardless of layout (accepted trade-off, §2).

## 7. Rendering and chrome

- `buildLeftRows(leftW, heights, body)` receives `layoutRows`' result as `{ filesH, gitH }` rather than today's single `filesH` — today the git area is derived as `body − filesH − 2`, which is meaningless for a 0-height group — and emits per `layoutPanes`: the files group only, the git group only, or both with the separator placeholder. The placeholder row (`padTo("", leftW)`) is emitted **only** in the default layout, so the git group starts at index `filesH + 1` exactly as today.
- `render()` draws the horizontal separator row only in the default layout (`i === filesH` branch).
- `buildFooterRow`'s view gains `layout: NavigatorLayout`; the pane-label list becomes `visiblePanes(layout).map(...)`, so `files-viewer` shows `files viewer` and `git-viewer` shows `git viewer`. The hint text (`getFooterHint`) and `FOCUS_HINTS` / `MODE_HINTS` tables are unchanged — the keys that remain relevant are per-focus, not per-layout. Label filtering is **layout-driven only**: when `t` (or a narrow terminal) hides the left column, the label list keeps today's behavior — it reflects the layout's panes, not the hide state.
- `buildTitleRow` is unchanged: branch, ahead/behind counters, changed count, and the `no git` fallback all still render from `this.git` in every layout (D9).
- The viewer pane (`buildRightRows`) is untouched.

## 8. Command routing

| Invocation | Result |
| :--- | :--- |
| `/navigator` | `{ kind: "overlay" }` → `runNavigator(pi, ctx)` → `initialLayout = PI_NAV_LAYOUT ?? settings.layout.default` |
| `/navigator all` | `{ kind: "layout"; layout: "files-git-viewer" }` → `runNavigator(pi, ctx, "files-git-viewer")` |
| `/navigator files` | `{ kind: "layout"; layout: "files-viewer" }` |
| `/navigator git` | `{ kind: "layout"; layout: "git-viewer" }` |
| `/navigator settings` / `help` | unchanged |
| `/navigator <other>` | unchanged: warning + help entry |

- `NAVIGATOR_SUBCOMMANDS` (help.ts) gains three rows, listed **before** `settings`/`help`, each carrying an optional `layout: NavigatorLayout` field; `desc` and `completionLabel` are written like the existing rows. `/navigator help` rows, argument completions, and the parser all project from this one table (D12).
- `parseNavigatorArgs` returns the new `{ kind: "layout"; layout }` variant by reading that field — the existing `token as "settings" | "help"` cast is replaced by a table lookup, so an unknown token can never be cast to the wrong kind.
- First-token-wins grammar, case-sensitivity, and the trailing-token behavior are unchanged.
- `runNavigator(pi, ctx, layoutOverride?)` passes `initialLayout: layoutOverride ?? loaded.settings.layout.default` into the overlay options.

## 9. Settings and environment

**Shape** (additive; `version` stays `1`; canonical order appends `layout` last):

```json
{
  "version": 1,
  "images": { "mode": "off" },
  "icons":  { "enabled": false },
  "viewer": { "wrap": false, "markdown": "code" },
  "tree":   { "showHidden": false },
  "layout": { "default": "files-git-viewer" }
}
```

**Registry row** (one entry in `NAVIGATOR_CONFIG_FIELDS`):

| field | value |
| :--- | :--- |
| `id` / `path` | `layout.default` / `["layout", "default"]` |
| `kind` / `options` | `enum` / `NAVIGATOR_LAYOUTS` |
| `section` / `label` | `Layout` / `Default layout` |
| `description` | Layout opened by bare `/navigator`; `/navigator all`, `/navigator files`, and `/navigator git` always open their own layout for one session. |
| `default` / `live` | `"files-git-viewer"` / `false` |

**Registry-driven machinery (verified, no special-casing needed):** `buildDefaultSettings`, `serializeNavigatorSettings`, `validateFieldValue` (the normalizer's per-field validator), and `applyFieldEdit`/`setField` all walk `NAVIGATOR_CONFIG_FIELDS`. An invalid or hand-edited `layout.default` therefore normalizes to the default with the standard `layout.default "x" is invalid; using "files-git-viewer"` warning, and the serializer emits the section automatically. The registry sync-guard tests extend from 5 to 6 fields.

**Environment precedence** (defaults ← user file ← env — unchanged direction):

- `PI_NAV_LAYOUT` ↔ `layout.default`, parsed by a new `parseLayoutMode(value)` in `settings.ts` mirroring `parseImageMode`'s contract: `undefined`/empty/whitespace → no override; one of `NAVIGATOR_LAYOUTS` → that layout; anything else → one warning, the file value stands.
- `loadNavigatorSettings(paths)` gains `env.layout`; `runNavigator` passes `layout: process.env[NAVIGATOR_LAYOUT_ENV]`; `runSettings` adds `layout.default → NAVIGATOR_LAYOUT_ENV` to its overrides map so the row is annotated `— overridden by PI_NAV_LAYOUT (env wins)` when set (the #118 note mechanism is unaffected).
- `loadNavigatorSettings`'s file-only call in `runSettings` (no env) keeps editing the file value, unchanged.

## 10. Edge cases

| Case | Behavior |
| :--- | :--- |
| Not a git repository | `git-viewer` renders the panel's existing unavailable state (header + `no git` title) at full height; no notify, no fallback (D13). Files pane and viewer unaffected. |
| `body` at its minimum | `bodyRows` floors at 4, so a single-pane area is `≥ 3`; the default layout keeps `splitRows`' clamps (`filesH ≥ 6`, `gitH ≥ GIT_MIN_ROWS`, then `filesH ≥ 3`, `gitH ≥ 2`). No new arithmetic can underflow. |
| Narrow terminal / `t` hidden | Left column absent in every layout (unchanged rules); viewer full width. |
| Focus on a pane while `t` hides the column | Pre-existing quirk: focus is not repaired. Unchanged by this spec (and no worse in the new layouts, where `t` hides the only pane). |
| `PI_NAV_LAYOUT` invalid | One warning; the settings value stands. |
| Hand-edited invalid `layout.default` | Normalizer warning + default. |
| `/navigator git` with extra tokens | First token wins (existing grammar). |
| Image rendering (native/chafa) | Unaffected: the pane's width and the right-pane render path do not change with the layout. |
| Viewer content during a layout with no files pane | `openRelPath`/`openCommit` targets still come from index.ts; only the pane that *initiated* them is absent. |
| Commit diffs (`kind: "diff"`) | Unchanged; reachable only from git focus, i.e. default and `git-viewer`. |

## 11. Acceptance criteria

- [ ] `/navigator all`, `/navigator files`, `/navigator git` each open their layout; the viewer stays on the right at the same column split as today.
- [ ] Bare `/navigator` opens `layout.default`; editing the setting changes what the next bare open shows; the three direct commands never write settings.
- [ ] `PI_NAV_LAYOUT` overrides the file value; invalid values warn once and the file value stands; empty/whitespace is no override.
- [ ] `files-viewer`: files header + `body − 1` rows, no git header/rows/separator; initial focus files; Tab order files ↔ viewer.
- [ ] `git-viewer`: git header + `body − 1` rows, no files header/rows/separator; initial focus git; Tab order git ↔ viewer.
- [ ] The default layout renders byte-identically to today when `initialLayout` is omitted (no-call-site-change regression).
- [ ] `/navigator settings` shows the "Default layout" row with the three values, persists it, and annotates it when `PI_NAV_LAYOUT` is set.
- [ ] `/navigator help` and the argument completions list all five subcommands.
- [ ] Both new layouts are width-safe at the render suite's sizes (120×36, 100×28, 80×24, 74×24, 60), including left-column-hidden and a `git-viewer` opened outside a repo.
- [ ] No new runtime dependency; the component still reads no env and no filesystem; `npm run typecheck` and `npm test` are green.

## 12. Test matrix

| Criterion | Suite | New/changed cases |
| :--- | :--- | :--- |
| Layout derivations (`layoutPanes`, `layoutRows` incl. `body` minimum, `visiblePanes`, `initialFocus`, `cycleFocus` wrap/reverse) | `test/frame.test.ts` | new |
| Footer pane labels per layout; default-layout footer unchanged | `test/frame.test.ts` | new |
| `files-viewer` / `git-viewer` pane presence, heights, width safety at all suite sizes, no-repo git pane | `test/render.test.ts` | new |
| Default layout byte-identical when `initialLayout` omitted | `test/render.test.ts` / `test/navigator.test.ts` | regression |
| Tab/Shift+Tab orders per layout; initial focus; `/` filter unreachable in `git-viewer`; `t` per layout | `test/navigator.test.ts` | new |
| Parser returns `{ kind: "layout" }` for all/files/git; completions include the three; router opens the requested layout; bare resolves the settings default | `test/index.test.ts` | new |
| Settings round-trip + invalid-value normalization + registry sync (6 fields) + `parseLayoutMode` contract | `test/settings.test.ts` | changed |
| Menu row present with the three values; env-shadow annotation | `test/settings_menu.test.ts` | new |
| `/navigator help` rows include the three commands; keybinding wording (Tab, `t`) | `test/help.test.ts` | changed |
| README lists the subcommands/setting/env var; tracker arithmetic for #119 | `test/docs.test.ts` | changed |

## 13. Documentation, tracker, and release

- **README.md**: a short Layouts subsection (the §1 table), the three rows in the subcommand list, the new settings row, and `PI_NAV_LAYOUT` in the environment documentation. Its line-63 layout summary ("files tree on the left, git panel below it, file viewer on the right") becomes the layout-aware description; the line-89 `t` row already reads "Toggle the left column" and stays.
- **AGENTS.md**: update the module rows for `types.ts` (layout union), `frame.ts` (layout derivations), `navigator.ts` (layout state/initial option), `settings.ts` (new field + env), `help.ts`/`index.ts` (layout subcommands), **and** the overview paragraph (line 11, "renders a centered overlay with three panes") with layout-aware wording. No new test suite, so the suite count and test inventory are unchanged.
- **Historical artifacts stay as-is**: `docs/plans/ui-standards-report.md` (a findings report) and the explicitly superseded `docs/plans/pi-navigator-implementation-plan.md`. During the sweep, re-check `docs/specs/native-image-rendering.md`'s left-column references in case any states the pane layout as fixed.
- **Issues**: #119 is filed as `Pending` with this spec and moved to `Resolved` in the final docs commit, with the tracker arithmetic refreshed (the `test/docs.test.ts` guards enforce both).
- **Version**: `0.12.0` (minor — new feature); `pi install .` re-registers the local path after the bump.
- **Commit slicing** (each commit leaves `npm run typecheck` and `npm test` green):
  1. `feat(frame)`: `NavigatorLayout` + pure derivations + `filesArea`/`buildFooterRow` signature updates with hardcoded-default call sites + `frame` tests.
  2. `feat(navigator)`: `initialLayout` option, per-layout render/`buildLeftRows`, Tab via `cycleFocus`, `t`/help wording, navigator + render tests.
  3. `feat(settings)`: `layout` section + registry row + normalizer/env (`parseLayoutMode`, `PI_NAV_LAYOUT`) + menu annotation, settings/settings-menu tests.
  4. `feat(commands)`: `help.ts` subcommand rows + parser kind + router + `runNavigator` override, index/help tests; docs-guard updates.
  5. `docs`: README + AGENTS.md + #119 resolved + tracker update.
  6. `chore(release)`: version bump + `pi install .`.
