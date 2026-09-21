# pi-navigator

Read-only project file navigator for pi. Opens a centered overlay inside a running pi session with a file tree, git state, and a syntax-highlighted viewer. No file editing, no runtime dependencies; images optionally render through a user-installed `chafa` (see [Images](#images-optional)).

![status](https://img.shields.io/badge/status-v0.7.1-green)

## Install

Place the directory in a pi extension location and pi discovers it:

- Global: `~/.pi/agent/extensions/pi-navigator/` (or any directory containing `index.ts`)
- Project: `.pi/extensions/pi-navigator/`

Then start pi and run `/navigator`.

Does pi-navigator fit your setup? [Read more](./AGENTS.md) — [Dev docs](./docs/plans/pi-navigator-implementation-plan.md) — [Open issues](./docs/issues/issues_index.md)

## Configuration

Settings live in `~/.pi/agent/pi-navigator.json`. All fields are optional; missing sections fall back to defaults. The canonical file shape is:

```json
{
  "version": 1,
  "images": { "mode": "off" },
  "icons":  { "enabled": false },
  "viewer": { "wrap": false, "markdown": "code" },
  "tree":   { "showHidden": false }
}
```

| Field | Default | Options | Effect |
| --- | --- | --- | --- |
| `images.mode` | `off` | `off`, `chafa` | Render images as chafa symbol art in the viewer when pi-chafa + chafa are installed; `off` keeps the metadata card |
| `icons.enabled` | `false` | `true`, `false` | Show a Nerd Font filetype icon column in the file tree (requires a Nerd Font terminal) |
| `viewer.wrap` | `false` | `true`, `false` | Start files with word wrap enabled; the `w` key still toggles it per session |
| `viewer.markdown` | `code` | `code`, `rendered` | Open Markdown files as rendered text or plain code; the `m` key still toggles it per session |
| `tree.showHidden` | `false` | `true`, `false` | Start with hidden files visible; the `.` key still toggles it per session |

Environment variables override the file (precedence: defaults ← file ← env):

| Variable | Values |
| --- | --- |
| `PI_NAV_IMAGES` | `1`/`true`/`yes`/`on`/`chafa` enable rendering; `0`/`false`/`no`/`off` disable; anything else warns and the file value stands; empty/whitespace is no override |
| `PI_NAV_ICONS` | `1`/`true`/`yes`/`on` enable the icon column; `0`/`false`/`no`/`off` disable; anything else warns and the file value stands; empty/whitespace is no override |

Edit either the file or the variables in your shell profile (e.g. `export PI_NAV_ICONS=1` in `~/.zshrc`) before launching pi, or pass inline: `PI_NAV_ICONS=1 pi`.

**`/navigator settings`** opens a settings menu (interactive TUI) over the same fields — Enter/Space cycles a row and the change is written atomically; Esc closes without writing. Rows shadowed by an environment variable are annotated (`— overridden by PI_NAV_IMAGES (env wins)`); editing one still writes the file, and the env value stays effective until it is unset. Settings are read once per `/navigator` invocation, so **changes apply the next time /navigator opens** — there is nothing applied live mid-session.

Icons depend on a terminal Nerd Font — without one, glyphs render as placeholder boxes (tofu). The overlay shows a one-time, non-blocking hint when icons are on. The git pane, commit-family view, and viewer follow the active pi theme with no hardcoded colors.

## Usage

```
/navigator              open the overlay
/navigator settings     open the settings menu (interactive TUI)
/navigator help         show this command list
```

`/navigator <anything else>` warns and shows the help list. `settings` requires the interactive TUI; in other modes it warns and does nothing.

Layout: files tree on the left, git panel below it, file viewer on the right, contextual key hints in the footer.

```
┌──────────────────────────────────────────────────────────────────────┐
│ pi-navigator  ~/project   main ↑2 ↓1   4 changed                     │
│─────────────────┬────────────────────────────────────────────────────│
│ FILES      12/86│ src/main.ts                          2.1 KB · 44L   │
│ ▶ src           │   1 │ // comment                                     │
│   main.ts   M   │   2 │ import { loadTree } from "./utils";           │
│   utils.ts  ?   │   3 │                                               │
│─────────────────│                                                     │
│ GIT             │                                                     │
│ Unstaged (4)    │                                                     │
│  src/main.ts M  │                                                     │
│ Staged (2)      │                                                     │
│ History (20)    │                                                     │
│─────────────────┴────────────────────────────────────────────────────│
│ j k move  Enter open  Tab pane  / filter  . hidden  ? help   q close │
└──────────────────────────────────────────────────────────────────────┘
```

## Keys

| Scope | Key | Action |
|---|---|---|
| Global | `Tab` / `Shift+Tab` | Cycle focus: files, git, viewer |
| Global | `t` | Toggle the left column |
| Global | `r` | Refresh tree, git, and the open file |
| Global | `?` | Help modal |
| Global | `q` | Close the overlay |
| Global | `Esc` | Clear filter, then search, then close |
| Global | `y` | Copy the selection: file path, or commit hash in history |
| Files | `j` `k` / arrows | Move |
| Files | `Ctrl+d` `Ctrl+u` | Half page |
| Files | `g` `G` | Top, bottom |
| Files | `Enter` | Open a file (focuses the viewer), or toggle a directory |
| Files | `l` `h` / arrows | Expand, collapse a directory |
| Files | `/` | Incremental fuzzy filter (name matches rank first) |
| Files | `.` | Toggle hidden dot entries |
| Git | `j` `k` / arrows | Move through changed files and history |
| Git | `Enter` | Open the changed file (expands the tree to it); on a commit row, show its diff in the viewer |
| Git | `l` `h` / arrows | Expand, collapse a commit's ancestor family (one level at a time) |
| Git | `g` `G` | Top, bottom |
| Viewer | `j` `k` / arrows | Scroll |
| Viewer | `Ctrl+d` `Ctrl+u`, `g` `G` | Half page, top, bottom |
| Viewer | `/` | Search (smart case, incremental) |
| Viewer | `n` `N` | Next, previous match |
| Viewer | `w` | Toggle word wrap |
| Viewer | `m` | Toggle markdown rendered / code view |
| Viewer | `i` | Toggle image rendering / metadata card (chafa) |
| Viewer | `h` `l` / arrows | Horizontal scroll when wrap is off |

Esc precedence in one line: filter, then search, then close.

## Behavior notes

- Launch mechanism: the extension is launched via the `/navigator` command, avoiding keybinding conflicts with pi's built-in shortcuts (such as `ctrl+n` / `app.session.toggleNamedFilter`).

- Syntax highlighting uses pi's own `highlightCode` and `getLanguageFromPath`, so colors follow the active theme and no tools like `bat` are needed.
- Tree source is hybrid: inside a repository it lists tracked plus untracked non-ignored files; without git, and in a repository with nothing to list yet (a fresh `git init`), it falls back to an async filesystem walk with a static ignore list, dot entries included but hidden by default. `.gitignore` parsing is a v2 candidate.
- Git panel: branch or detached HEAD, ahead and behind counters, unstaged and staged lists, last 20 commits. All git calls are async with a 3 s timeout; the panel shows a single explanation row when git is missing or the cwd is not a repository, and a dim `Clean` row when nothing is staged or unstaged. Status and the tracked listing are read with `-z`, so paths containing spaces, quotes or newlines survive intact.
- Commit rows: `Enter` opens the commit's diff in the viewer (prefix-styled `+`/`-`/`@@` lines, a stat summary notice, and a `commit <hash>` header); `l` expands one level of its ancestor family (`▸`/`▾` markers), `h` collapses and steps out to the anchor. Expanding is capped by `FAMILY_MAX_DEPTH` (a notice tells you when you hit the floor) and `FAMILY_MAX_ROWS` (a dim `… more ancestors` hint marks the cut).
- Refresh runs every 3 s while the overlay is open, plus `r`, with one refresh in flight at a time: a tick that arrives mid-refresh is dropped. Git state is re-read every tick; the tree is re-collected only when a cheap probe changes — the porcelain-derived signature in git mode, the modification times of the expanded directories in fs mode — and rebuilt only when the path set itself changes, with git codes otherwise stamped in place. Expanded and collapsed directories, top-level ones included, are preserved across rebuilds. Repeated failures notify once per distinct message instead of once per tick.
- Hidden dot entries render dim, and the `.` toggle is Files-scoped.
- Caps: files over 1 MB or 5000 lines open truncated with a notice, and never load in full — the loader reads at most 1 MB from the head. The truncated view reports the total line count when the whole file was read and it is under 256 KB. Binary files are detected by a NUL byte and shown as a metadata card; images show a metadata card, or chafa symbol art when the optional image tier is enabled (see [Images](#images-optional)).
- While filtering or searching, the typed query is echoed with a reverse-video cursor, preceded by the hardware cursor marker while the overlay has focus, so IME composition lands over the right cell.
- Never writes to the workspace. The only mutating operations in the whole extension are clipboard copies for `y`.
- Minimum terminal size: the overlay asks for 80 columns; below 72 inner columns the left column hides (toggle `t`); below 40 columns or 8 body rows it renders a compact "terminal too small" notice instead of the frame.

## Images (optional)

Image files show a metadata card (name, size, dimensions) by default. To render
them as chafa symbol art in the viewer you need all three:

1. **chafa ≥ 1.10** — `brew install chafa` (macOS) or `apt install chafa` (Debian/Ubuntu).
2. **The pi-chafa extension** — `pi install npm:pi-chafa` (or a local path).
3. **An explicit opt-in** — `"images": { "mode": "chafa" }` in `~/.pi/agent/pi-navigator.json`, or `PI_NAV_IMAGES=1`.

When enabled, all visual knobs (colors, symbols, dither, cellWidth, maxRows,
timeout, binaryPath) live in `~/.pi/agent/pi-chafa.json` and the `CHAFA_*`
environment variables — read pi-chafa's README for them. The `i` key toggles
between the rendered image and the metadata card. Images are **user-only**:
they are never sent to the model. If chafa, pi-chafa, or the opt-in is missing,
the view degrades to the metadata card — never an error.

The feature is documented in [docs/specs/chafa-image-rendering.md](docs/specs/chafa-image-rendering.md).

## Development

Files: `index.ts` (entry, command routing, async data ownership), `navigator.ts` (overlay component, keymap, rendering), `tree.ts` (tree model, fs walk), `git.ts` (async git access and porcelain parsing), `viewer.ts` (load caps, highlighting, search, display rows), `theme.ts` (token mapping), `types.ts`, `constants.ts`, `settings.ts` (pi-navigator settings terrain), `settings_menu.ts` (`/navigator settings` menu, rendered in the editor area above the input), `help.ts` (`/navigator help` entry layout), `images.ts` (chafa detection, probe, sanitize, geometry).

Planning documents live in `docs/plans/`: `ui-standards-report.md` (platform and reference findings), `pi-navigator-implementation-plan.md` (the original plan — now superseded; see `docs/issues/issues_index.md` for current state), and `qa-evidence.md`. Issues are tracked in `docs/issues/`. The throwaway visual mock is `mockups/navigator.html` — open it in a browser and drive it with the same keymap.

### Tooling (enabled — Linux, Node 26, git 2.55)

Dev-only: `typescript`, `@types/node`, `vitest`, and `@earendil-works/pi-tui` +
`@earendil-works/pi-coding-agent` pinned to the running pi version (0.85.1), so
the suites exercise the real wrap/width/highlighting implementations. No
runtime dependencies, ever — `node_modules` is dev-only.

- `npm run typecheck` — `tsc --noEmit`. `moduleResolution: "bundler"` rather
  than the plan's original "NodeNext" because pi loads extensions through jiti,
  which resolves the code's intentionally extensionless relative imports;
  NodeNext would demand `.js` extensions the runtime does not need.
- `npm test` — ten vitest suites (347 cases): porcelain `-z` parsing plus a
  real-git scratch-repo integration pass, tree building/fs-walk fixtures
  (ignores, dot entries, symlink cycles), viewer caps and UTF-8 head decoding,
  the keymap reducer (escape precedence, focus cycling, copy), settings
  normalization/loading (`PI_NAV_IMAGES` + `PI_NAV_ICONS` truth tables,
  `applyFieldEdit`), the settings-menu builder and real-SettingsList
  integration, the help layout + command-routing suites, pi-chafa
  detection/config/probe/sanitizer/geometry, and render width-safety at
  120x36, 100x28 and 80x24 — plus 60/50-column, settings-menu and chafa
  payload cases — including help/filter/search modes and the compact notice.

Test runs must stay green with `typecheck` and `test`; the suites have already
caught real bugs (a search-highlight crash from inverted theme tokens, a
symlink-to-root walk cycle, and footer focus labels truncated off at narrow
widths), so they are part of the definition of done, not decoration.
