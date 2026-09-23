# Issue #119: Overlay Has a Single Layout; No Files-Only or Git-Only Modes

- **Status**: Resolved
- **Type**: Feature
- **Severity**: Medium
- **Components**: [`types.ts`](file:///home/jhonny/Sources/pi-navigator/types.ts) / [`frame.ts`](file:///home/jhonny/Sources/pi-navigator/frame.ts) (layout model), [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) (state + render), [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts) / [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts), [`help.ts`](file:///home/jhonny/Sources/pi-navigator/help.ts) / [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) (commands)
- **Spec**: [`docs/specs/overlay-layout-modes.md`](../specs/overlay-layout-modes.md)
- **Requested by**: repo owner, 2026-09-23

## Description

The overlay has exactly one layout: the left column splits into the files pane (top, ~55%) and the git panel (bottom). Working a git history or a large tree still costs the other pane's share of the column, and the only "one pane" option (`t`, hide the left column) removes both.

Add two optional layouts plus the selection surface:

| Layout | Command | Left column |
| :--- | :--- | :--- |
| `files-git-viewer` | `/navigator all` | files pane + git panel (today) |
| `files-viewer` | `/navigator files` | files pane, full body height |
| `git-viewer` | `/navigator git` | git panel, full body height |

Bare `/navigator` opens the layout stored in a new `layout.default` setting (menu-editable, `PI_NAV_LAYOUT` override, env wins). The direct commands are one-open selections and never write settings. The viewer pane, its keys, the pane contents, and the data-collection pipeline are unchanged; the layout is presentation-only.

## Resolution

Implemented in v0.12.0 per the spec's §13 commit slicing (all commits verified with `npm run typecheck` + `npm test` green):

1. `feat(frame)` 069390b — `NAVIGATOR_LAYOUTS`/`NavigatorLayout` in types.ts (D1); pure derivations `layoutPanes`/`layoutRows`/`visiblePanes`/`initialFocus`/`cycleFocus` in frame.ts (D2); `filesArea(termRows, layout)` explicit layout parameter (D5); `FooterView.layout` so footer pane labels drop absent panes.
2. `feat(navigator)` 78d3455 — `initialLayout` ctor option (D6); layout state fixes the pane set, initial focus and geometry for the overlay's lifetime; render/`buildLeftRows` branch on `layoutPanes`, the horizontal separator renders only in `files-git-viewer`; `showTree` → `showLeftColumn` rename (D7); Tab cycles via `cycleFocus` (D8); help wording updated.
3. `feat(settings)` 222f480 — `layout.default` registry row appended last (D10; registry-driven defaults/normalizer/serializer/menu/`applyFieldEdit` with no special-casing); `parseLayoutMode` + `PI_NAV_LAYOUT` env override (D11, case-sensitive, no legacy boolean tokens); `runNavigator` passes the env through, `runSettings` annotates the menu row.
4. `feat(commands)` 40bb4e1 — `all`/`files`/`git` rows in `NAVIGATOR_SUBCOMMANDS` carrying their `layout` (D12); `parseNavigatorArgs` resolves kinds via table lookup and returns `{ kind: "layout", layout }`; `runNavigator(pi, ctx, layoutOverride)` — one-open selections never write settings.

The default layout is byte-identical to the pre-#119 render (regression-pinned in the render suite); data collection is unchanged in every layout (D9).

## Acceptance Criteria

Mirrored from the spec §11; the spec is the source of truth.

- [x] The three commands open their layouts; the viewer keeps today's column split. (`render`/`index` suites)
- [x] Bare `/navigator` opens `layout.default`; the setting is menu-editable; the direct commands never persist. (`settings`/`settings_menu`/`index` suites)
- [x] `PI_NAV_LAYOUT` overrides the file value; invalid values warn once and the file value stands; empty is no override. (`settings` suite, `parseLayoutMode` truth table)
- [x] `files-viewer` / `git-viewer` render only their pane at full body height (`body − 1` content rows) with no separator row. (`render` suite, left-cell accounting)
- [x] Tab/Shift+Tab cycle only visible panes; initial focus is the pane the layout opens with. (`frame`/`navigator` suites)
- [x] The default layout is byte-identical to today when `initialLayout` omitted. (render regression pins + all pre-existing render cases)
- [x] Both new layouts are width-safe at the render suite's sizes, including left-column-hidden and a `git-viewer` opened outside a repo. (`render` suite at 120/100/80/74/60)
- [x] `/navigator help` and the completions list all five subcommands. (`help`/`index` suites)
- [x] No new runtime dependency; the component still reads no env and no filesystem. (peer deps unchanged; ctor options only)

## Evidence

`test/frame.test.ts` — layout derivations (panes, rows incl. minimum body, visible order, initial focus, cycle wrap/reverse/recovery), `filesArea` per layout, footer labels per layout (+9 cases).
`test/render.test.ts` — default-layout structural regression, files-viewer/git-viewer full-height single panes with no separator, no-repo git-viewer, `t` per layout, width safety at 120/100/80/74/60 (+5 cases).
`test/navigator.test.ts` — initial focus per layout, cycle orders, `/` filter unreachable in git-viewer while viewer search works, `t` in every layout, git-pane Enter opening a file without a files pane (+7 cases).
`test/settings.test.ts` — `parseLayoutMode` truth table, layout.default normalization/serialization/`applyFieldEdit`, 6-field registry guard, env precedence (+9 cases).
`test/settings_menu.test.ts` — `Default layout` row, env-shadow annotation, partial-settings fallback (+3 updated/new assertions).
`test/help.test.ts` / `test/index.test.ts` — 6-row command inventory, completions order, `{ kind: "layout" }` routing, help-entry renderer lists all five (+6 cases).
