# Issue #119: Overlay Has a Single Layout; No Files-Only or Git-Only Modes

- **Status**: Pending
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

Not implemented yet — the design is approved and written up in the spec (link above). Implementation follows the spec's §13 commit slicing; this issue moves to `Resolved` with the tracker arithmetic update in the final docs commit.

## Acceptance Criteria

Mirrored from the spec §11; the spec is the source of truth.

- [ ] The three commands open their layouts; the viewer keeps today's column split.
- [ ] Bare `/navigator` opens `layout.default`; the setting is menu-editable; the direct commands never persist.
- [ ] `PI_NAV_LAYOUT` overrides the file value; invalid values warn once and the file value stands; empty is no override.
- [ ] `files-viewer` / `git-viewer` render only their pane at full body height (`body − 1` content rows) with no separator row.
- [ ] Tab/Shift+Tab cycle only visible panes; initial focus is the pane the layout opens with.
- [ ] The default layout is byte-identical to today when `initialLayout` is omitted.
- [ ] Both new layouts are width-safe at the render suite's sizes, including left-column-hidden and a `git-viewer` opened outside a repo.
- [ ] `/navigator help` and the completions list all five subcommands.
- [ ] No new runtime dependency; the component still reads no env and no filesystem.

## Evidence

Pending implementation. Planned proof per the spec §12 test matrix: `frame` (derivations), `render` (pane presence + width safety + default regression), `navigator` (focus/`t`/filter reachability), `index` (routing + settings default), `settings`/`settings_menu` (schema, env, menu row), `help`/`docs` (command inventory and tracker guards).
