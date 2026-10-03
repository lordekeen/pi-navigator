---
name: pi-navigator
description: Read-only project file navigator overlay for the pi coding agent. A centered TUI overlay with a file tree, git panel, and syntax-highlighted viewer.
colors:
  # Semantic colors are delegated to the host pi theme; these are the named
  # pi Theme tokens the overlay consumes (see theme.ts makeNavigatorTheme).
  # Values below are illustrative defaults — the live values come from the
  # user's active pi theme at runtime. Agents rendering previews may use these.
  primary: "#C0CAF5"
  accent: "#7AA2F7"
  muted: "#6C7278"
  dim: "#6C7278"
  success: "#9ECE6A"
  warning: "#E0AF68"
  error: "#F7768E"
  text: "#C0CAF5"
  # Frame borders follow the host's `borderMuted` role (Issue #135 L6); the hex
  # below is the neutral equivalent, for preview rendering only.
  frame: "#6C7278"
  # Selection / search surfaces (background-driven).
  selected-bg: "#2A2E3A"
  search-match-bg: "#3B3F51"
  search-match-text: "#C0CAF5"
typography:
  body:
    fontFamily: monospace
    fontSize: 1rem
    lineHeight: 1.2
  label-caps:
    fontFamily: monospace
    fontSize: 0.75rem
    fontWeight: 700
    letterSpacing: 0.05em
rounded:
  none: 0px
spacing:
  xs: 1px
  sm: 2px
  md: 4px
components:
  overlay-frame:
    textColor: "{colors.frame}"
    rounded: "{rounded.none}"
  pane-header:
    textColor: "{colors.accent}"
    typography:
      fontFamily: monospace
      fontSize: 0.75rem
      fontWeight: 700
  pane-header-muted:
    textColor: "{colors.muted}"
  file-row-cursor:
    backgroundColor: "{colors.selected-bg}"
  file-row-default:
    textColor: "{colors.text}"
  file-row-modified:
    textColor: "{colors.warning}"
  file-row-hidden:
    textColor: "{colors.dim}"
  git-row-selected:
    textColor: "{colors.text}"
  # Group rows (section labels, `Clean`, git-unavailable) follow the tone
  # stack: warning / success / dim / muted — see buildGitRow (Issue #026).
  git-group-warning:
    textColor: "{colors.warning}"
  git-group-success:
    textColor: "{colors.success}"
  git-group-dim:
    textColor: "{colors.dim}"
  git-group-muted:
    textColor: "{colors.muted}"
  git-badge-modified:
    textColor: "{colors.warning}"
  git-badge-added:
    textColor: "{colors.success}"
  git-badge-deleted:
    textColor: "{colors.error}"
  # Commit family tree (Issue #030, v3 keys): indented ancestor rows under an
  # expanded commit; `l` expands one level, `h` collapses and steps out to the
  # anchor. Rows carry the same ▸/▾ marker idiom as dirs.
  git-family-row:
    textColor: "{colors.text}"
  # Commit diff view (v3, #034): diff lines styled by prefix in the loader.
  # Added, removed and context lines take the host's dedicated diff roles
  # (toolDiffAdded / toolDiffRemoved / toolDiffContext, Issue #135 L7) so a
  # theme that styles diffs specifically reaches this view instead of the
  # generic success/error/text tokens, which mean other things elsewhere in the
  # overlay. @@ → accent (the host has no hunk role); diff/index/+++/---/new
  # file/deleted file/Binary files meta → muted. The diff summary notice
  # (“commit abc1234 · N files · +I −D”) uses dim, not warning. The hex values in
  # the diff-line-* rows are equivalent defaults for preview rendering only.
  diff-line-add:
    textColor: "{colors.success}"
  diff-line-del:
    textColor: "{colors.error}"
  diff-line-hunk:
    textColor: "{colors.accent}"
  diff-line-meta:
    textColor: "{colors.muted}"
  diff-line-context:
    textColor: "{colors.text}"
  diff-notice:
    textColor: "{colors.dim}"
  # Nerd Font filetype icon column (Issue #028) — one cell between the cursor
  # arrow and the label; the glyph inherits the row name color, no color here.
  file-row-icon:
    textColor: "{colors.text}"
  viewer-gutter:
    textColor: "{colors.dim}"
  viewer-notice:
    textColor: "{colors.warning}"
  search-match:
    backgroundColor: "{colors.search-match-bg}"
    textColor: "{colors.search-match-text}"
  search-current:
    backgroundColor: "{colors.search-match-bg}"
    textColor: "{colors.search-match-text}"
    typography:
      fontFamily: monospace
      fontSize: 1rem
      fontWeight: 400
  help-modal-title:
    textColor: "{colors.accent}"
    typography:
      fontFamily: monospace
      fontSize: 1rem
      fontWeight: 700
  help-modal-keys:
    textColor: "{colors.accent}"
  help-modal-desc:
    textColor: "{colors.muted}"
  card-title-binary:
    textColor: "{colors.warning}"
  card-title-error:
    textColor: "{colors.error}"
  card-title-image:
    textColor: "{colors.accent}"
  card-body:
    textColor: "{colors.muted}"
---

## Overview

Terminal-minimalist, information-dense, monospace-first. pi-navigator is a **TUI overlay**, not a web UI: every element is a fixed-width cell composed from box-drawing characters and ANSI styling. The design goal is "broadsheet density at a glance" — a file tree, git state, and a code preview coexisting in a centered frame without leaving the coding session.

The visual identity follows the host **pi theme** (see `theme.ts`): no colors are hardcoded. What follows describes the *structure* and the semantic roles each token plays, so an agent extending the overlay picks the right role rather than inventing a new color.

## Colors

All color is **semantic and theme-delegated**. The overlay calls `NavigatorTheme` methods (`T.accent`, `T.muted`, `T.dim`, `T.warning`, `T.success`, `T.error`, `T.text`, `T.frame`, `T.diffAdded`, `T.diffRemoved`, `T.diffContext`) which map onto the active pi `Theme`'s `fg`/`bg` tokens — `frame` onto the host's `borderMuted` role, and the diff trio onto its own `toolDiff*` roles (Issue #135 L6/L7). The hex values in the front matter are illustrative defaults for preview rendering only.

- **accent (`#7AA2F7` default)** — primary interaction signal: the open file's row, the pane header for the focused pane, branch name, help-modal title, and the active footer pane label.
- **muted (`#6C7278` default)** — secondary text: non-focused pane labels, card body text, help descriptions, secondary path segments.
- **dim (`#6C7278` default)** — tertiary/de-emphasized: line-number gutter, indentation guides, footer hints, file-row hidden/untracked names. Frame borders are **not** here: they follow the host's `borderMuted` role (Issue #135 L6).
- **success (`#9ECE6A` default)** — git "added" badge, staged file rows.
- **warning (`#E0AF68` default)** — git "modified" badge, unstaged file rows, viewer truncation/disk-change notices, binary-card title, "has changes" file rows.
- **error (`#F7768E` default)** — git "deleted" badge, error-card title. Not a failure signal: the git "behind" counter uses `warning`, because being behind is state, not an error (Issue #135 L8).
- **text (`#C0CAF5` default)** — default file-row label, neutral selected-row text, git commit subjects (the row's primary content, with the short hash staying `muted` as secondary metadata — Issue #135 L5).
- **selected-bg (`#2A2E3A` default)** — cursor row background (reverse-video equivalent).
- **search-match-bg / search-match-text** — in-file search hit highlight; the current match additionally gets underline.

An agent adding a new surface should reuse the closest semantic role (e.g. a new "notice" → `warning`; a new badge → match the existing git badge palette) rather than introducing a new token.

### Image tiers (native / chafa)

Rendered images are the **one sanctioned exception** to "no hardcoded colors": the
bytes that reach the terminal are authored by the user's own tools and terminal,
never by pi-navigator — chafa ANSI SGR colors from the user's
`~/.pi/agent/pi-chafa.json` + `CHAFA_*` configuration, or pi-tui-encoded
kitty/iTerm2 sequences in the native tier (`images.mode: native` / `auto`).
pi-navigator itself hardcodes no colors. Every chafa row is contained by an
enforced trailing `\x1b[0m` reset before padding, so a chafa color can never leak
into the next row, the gutter, or the frame. Native rows are **pass-through**
(spec §8, D9): the sequence row is emitted first and space-filled only on the
right — never truncated or re-anchored, because the terminal anchors the image
where the sequence appears (`frame.isImageLine`), and `joinLeftRight` returns an
image side unchanged rather than width-joining it.

## Typography

There is exactly **one typeface: the terminal's monospace cell.** There are no proportional fonts, no web font loading, no font stacks. All "typography" is expressed through ANSI emphasis (`bold`) and size-invariant emphasis only — the cell size is fixed by the terminal.

- **body** — monospace, 1rem, line-height 1.2. The base for every row: tree rows, viewer lines, footer.
- **label-caps** — monospace, 0.75rem, **bold**, tracked +0.05em. Used for pane headers (`FILES`, `GIT`) and the overlay title `pi-navigator`. The "caps" feel comes from `bold` + uppercase source text, not from a different font.

Agents must never introduce `fontFamily: sans-serif`/`serif`, `fontSize` in `px`/`rem` that implies proportional rendering, or web font imports. Visual hierarchy = bold + color role, nothing else.

## Layout

The overlay is a centered box bounded by `OVERLAY_OPTIONS` (width 90%, min 80, max height 85% — derived from `OVERLAY_HEIGHT_RATIO` in `constants.ts`, anchor center, margin 1 row). `frame.overlayHeight()` uses that same ratio and reserves `OVERLAY_MARGIN_ROWS` top and bottom, so the height the host allocates and the frame the component draws into it cannot drift (Issue #130); it is deliberately free to fall below the frame floor, which is what makes the compact "terminal too small" refusal notice reachable. Inside:

1. **Top border** — `╭─╮` with the product name in an accent-bold pill (`╭── pi-navigator ──…╮`, Issue #137 §2)
2. **Subtitle row** — cwd short path (left) · branch + ahead/behind + changed counters (right); the product name lives in the top-border pill
3. **Separator** — `├─┤`
4. **Body** (`overlayHeight - 5` rows) — split into a left column (files + git, ~30% clamped 24–44) and a right column (viewer). Below `LEFT_COLUMN_HIDE_BELOW` (72 inner cols) the left column is hidden and the viewer takes the full width.
5. **Footer** — context hint (left) as typed key/label pairs (`dim` keys, `muted` labels, ` · `-joined; the close pair advertises the default cancel key, `q Esc close`) · pane labels `files git viewer` with the focused one accented (right) (Issue #137 §1/§5)

**Spacing** is cell-granular: `xs` (1px) for inline glyph separation, `sm` (2px) for the gutter/border gap, `md` (4px) for inter-pane separators. There is no large whitespace padding — density is the point. Below `MIN_OVERLAY_WIDTH` (40) or `MIN_OVERLAY_HEIGHT` (13) a compact "terminal too small" notice replaces the frame.

**Shapes:** box-drawing corners are rounded — `╭ ╮ ╰ ╯` are the only curved cells (Issue #137 §2), the junction tees stay sharp (`├ ┤ ┼`). No other rounding; the terminal cell grid has no sub-cell rounding.

## Elevation & Depth

There is no z-axis shadow or blur in a TUI. "Depth" is expressed through **reverse-video** (the cursor row's `selected-bg` background) and **border containment**: the help modal and binary/image/error cards draw an inset box (`╭ ─ ╮ │ ╰ ─ ╯`) floating over the body grid. The only "elevated" surfaces are:

- **Help modal** — centered inset box over the panes, titled `pi-navigator — keys`.
- **Binary / image / error card** — centered inset box with a styled title and a muted body.

No drop shadows, no gradients, no opacity. If a new surface needs to feel "on top", draw it as an inset bordered box.

## Shapes

Corners are rounded on every bordered surface — `╭ ╮ ╰ ╯`, the only curved box-drawing cells (Issue #137 §2); junction tees stay sharp. Borders are light-box-drawing (`U+2500` series): `╭ ╮ ╰ ╯` for box corners, `├ ┤ ┼` for junctions, `│` for verticals, `─` for horizontals. Tree markers: `▾`/`▸` for expanded/collapsed dirs, `▶` for the cursor arrow, `↗` for symlinks. The viewer gutter separator is `│`.

## Components

- **overlay-frame** — the outer bordered box; text color = `frame`.
- **pane-header** — `FILES` / `GIT` labels; accented when its pane is focused, muted otherwise.
- **file-row-cursor** — the selected tree/git row; `selected-bg` background.
- **file-row-modified / -hidden** — git-modified (warning) and hidden/untracked (dim) file labels.
- **git-badge-* ** — single-letter status badges: M=warning, A=success, D=error.
- **viewer-gutter** — line-number column, dim.
- **viewer-notice** — truncation / changed-on-disk banner, warning.
- **diff-line-*** (v3) — commit-diff lines via the prefix styler (`styleDiffLines` in `diff.ts`): `+` success, `-` error, `@@` accent, meta muted, context text. The diff summary notice above the content is **dim** (informational), not warning.
- **search-match / search-current** — in-file hit highlights; current match adds underline.
- **viewer-scrollbar** — the frame's right border column over the viewer's content rows: track `│` on `scrollbarTrack`, proportional thumb `█` on `scrollbarThumb`; overflow-only, display-only (Issue #137 §4).
- **help-modal-title / -keys / -desc** — accented title, accented key cell (16-col pad), muted description.
- **card-title-binary / -error / -image** — card titles by kind; card-body is muted.

When adding a component, declare it here and reuse an existing color role. Component variants (hover/active/pressed) are not applicable in a TUI — there is no pointer — so express state as `selected-bg` vs. default, or accent vs. dim.

## Do's and Don'ts

### Do
- **Do** route every color through `NavigatorTheme` (`theme.ts`) so it follows the user's active pi theme.
- **Do** keep the render path pure: data enters via `setTree` / `setGitState` / `openRelPath`; `render(width)` returns strings.
- **Do** enforce width-safety on every row (`visibleWidth` / `truncateToWidth`), at every terminal size the render suite covers. Native image rows are the sole exception: their width comes from the sequence's own cell metrics, so they are emitted first and space-filled on the right only.
- **Do** truncate styled strings with an **empty** ellipsis to avoid `truncateToWidth`'s `\x1b[0m`-wrapped `"..."` leaking bright default (Issue #010).
- **Do** normalize `\r\n` / lone `\r` to `\n` before highlighting/splitting (Issue #009).
- **Do** bound memory by `MAX_HIGHLIGHT_BYTES` / `MAX_HIGHLIGHT_LINES`; read a capped head for oversized files.

### Don't
- **Don't** hardcode ANSI color codes in component code — the theme is the only source of color.
- **Don't** introduce proportional fonts, web fonts, or `fontFamily` other than `monospace`.
- **Don't** use rounded corners, shadows, gradients, or opacity — the cell grid forbids them.
- **Don't** touch the filesystem or git from `navigator.ts`; keep async/data work in `index.ts`.
- **Don't** assume `string.length === visibleWidth` — ANSI escapes and wide characters break that.
- **Don't** truncate a plain string with the default ellipsis and then wrap it in a style — the injected reset closes the style early and the ellipsis renders in bright default.
- **Don't** width-process a native image row (`isImageLine`): no truncate, no re-anchor — right-side space fill only, so the sequence keeps its anchor column (spec §8, D9).
