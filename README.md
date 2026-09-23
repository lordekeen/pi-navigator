# pi-navigator

Read-only project file navigator for pi. Opens a centered overlay inside a running pi session with a file tree, git state, and a syntax-highlighted viewer. No file editing, no runtime dependencies; images optionally render natively (kitty/iTerm2) or through a user-installed `chafa` (see [Images](#images-optional)).

![status](https://img.shields.io/badge/status-v0.10.7-green)

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
  "tree":   { "showHidden": false },
  "layout": { "default": "files-git-viewer" }
}
```

| Field | Default | Options | Effect |
| --- | --- | --- | --- |
| `images.mode` | `off` | `off`, `chafa`, `native`, `auto` | Image tier: `chafa` symbol art (requires pi-chafa + chafa), `native` kitty/iTerm2 graphics, `auto` (native then chafa), or `off` (metadata card) |
| `icons.enabled` | `false` | `true`, `false` | Show a Nerd Font filetype icon column in the file tree (requires a Nerd Font terminal) |
| `viewer.wrap` | `false` | `true`, `false` | Start files with word wrap enabled; the `w` key still toggles it per session |
| `viewer.markdown` | `code` | `code`, `rendered` | Open Markdown files as rendered text or plain code; the `m` key still toggles it per session |
| `tree.showHidden` | `false` | `true`, `false` | Start with hidden files visible; the `.` key still toggles it per session |
| `layout.default` | `files-git-viewer` | `files-git-viewer`, `files-viewer`, `git-viewer` | Layout opened by bare `/navigator`; `/navigator all`, `/navigator files`, and `/navigator git` always open their own layout for one session |

Environment variables override the file (precedence: defaults ← file ← env):

| Variable | Values |
| --- | --- |
| `PI_NAV_IMAGES` | `chafa`/`native`/`auto` select that mode; `1`/`true`/`yes`/`on` enable chafa; `0`/`false`/`no`/`off` disable; anything else warns and the file value stands; empty/whitespace is no override |
| `PI_NAV_ICONS` | `1`/`true`/`yes`/`on` enable the icon column; `0`/`false`/`no`/`off` disable; anything else warns and the file value stands; empty/whitespace is no override |
| `PI_NAV_LAYOUT` | `files-git-viewer`/`files-viewer`/`git-viewer` select the default layout; anything else warns and the file value stands; empty/whitespace is no override |

Edit either the file or the variables in your shell profile (e.g. `export PI_NAV_ICONS=1` in `~/.zshrc`) before launching pi, or pass inline: `PI_NAV_ICONS=1 pi`.

**`/navigator settings`** opens a settings menu (interactive TUI) over the same fields — Enter/Space cycles a row and the change is written atomically; Esc closes without writing. The menu follows the host settings-panel standard: it docks above the message input, uses the host list roles (bright labels, muted values), and is framed by full-width rules like pi's own `/settings`; mouse wheel and click work in fullscreen mode. Rows shadowed by an environment variable are annotated (`— overridden by PI_NAV_IMAGES (env wins)`); editing one still writes the file, and the env value stays effective until it is unset. Settings are read once per `/navigator` invocation, so **changes apply the next time /navigator opens** — there is nothing applied live mid-session.

Icons depend on a terminal Nerd Font — without one, glyphs render as placeholder boxes (tofu). The overlay shows a one-time, non-blocking hint when icons are on. The git pane, commit-family view, and viewer follow the active pi theme with no hardcoded colors.

## Usage

```
/navigator              open the overlay (layout.default setting)
/navigator all          open the files + git + viewer overlay (default layout)
/navigator files        open the files + viewer overlay
/navigator git          open the git + viewer overlay
/navigator settings     open the settings menu (interactive TUI)
/navigator help         show this command list
```

`/navigator <anything else>` warns and shows the help list. `settings` requires the interactive TUI; in other modes it warns and does nothing.

Layout: the left column holds the files tree and the git panel (`files-git-viewer`, the default), the files tree alone (`files-viewer`), or the git panel alone (`git-viewer`); the file viewer sits on the right in every layout, and contextual key hints live in the footer. A layout is chosen when the overlay opens — by the direct command, or by `layout.default`/`PI_NAV_LAYOUT` for bare `/navigator` — and is fixed for that overlay's lifetime; it never switches mid-session and the direct commands never write settings.

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
| Global | `Tab` / `Shift+Tab` | Cycle focus across the visible panes (files, git, viewer in the default layout; two panes in the single-pane layouts) |
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
| Viewer | `i` | Toggle image rendering / metadata card (native or chafa) |
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
- Caps: files over 1 MB or 5000 lines open truncated with a notice, and never load in full — the loader reads at most 1 MB from the head. The truncated view reports the total line count when the whole file was read and it is under 256 KB. Binary files are detected by a NUL byte and shown as a metadata card; images show a metadata card, native terminal graphics or chafa symbol art when the optional image tier is enabled (see [Images](#images-optional)).
- While filtering or searching, the typed query is echoed with a reverse-video cursor, preceded by the hardware cursor marker while the overlay has focus, so IME composition lands over the right cell.
- Never writes to the workspace. The only mutating operations in the whole extension are clipboard copies for `y`.
- Minimum terminal size: the overlay asks for 80 columns; below 72 inner columns the left column hides (toggle `t`); below 40 columns or 8 body rows it renders a compact "terminal too small" notice instead of the frame.

## Images (optional)

Image files show a metadata card (name, size, dimensions) by default. Set
`"images": { "mode": … }` in `~/.pi/agent/pi-navigator.json` (or `PI_NAV_IMAGES`)
to pick a tier:

| Mode | Behavior |
| :--- | :--- |
| `off` (default) | Metadata card only. |
| `native` | Real terminal graphics when the terminal speaks kitty or iTerm2 and the file is renderable (kitty: PNG, or JPEG/WebP/GIF transcoded to PNG; iTerm2: PNG/JPEG/GIF/WebP); otherwise the card explains why. No chafa or pi-chafa needed. |
| `chafa` | chafa symbol art — requires **chafa ≥ 1.10** plus the **pi-chafa** extension — degrading to the card. |
| `auto` | Native when capable, then chafa, then the card — decided per file (JPEG/WebP/GIF render natively on kitty via PNG transcoding; formats the terminal cannot render fall back to chafa when available). pi-chafa's `preferNative: false` (or `CHAFA_PREFER_NATIVE=0`) makes `auto` choose chafa. |

Native rendering reuses pi-tui's kitty/iTerm2 encoders (pi-navigator emits no
protocol bytes of its own, except a one-shot kitty `a=q` decode query on the
first native render of each `/navigator` open — the terminal's own OK/error reply
decides whether native stays enabled for that invocation; `OK` keeps it, an
explicit error degrades images to chafa or the card, and an unanswered query
keeps the current behavior) and reads at most 4 MiB per image. The
image is bounded by the viewer pane and by pi's `terminal.imageWidthCells`
preference. Fullscreen (`tuiMode: fullscreen`) supports kitty only — pi-tui
disables iTerm2 images there. **tmux/screen** and terminals without image
support (Alacritty, VS Code, Zed, Windows Terminal, JetBrains) keep native
off — not even a forced `terminal.images` or `PI_IMAGE_PROTOCOL` override
re-enables it (issues #070, #100); images degrade to chafa or the card.
Outside of that, tmux must pass the sequences through (kitty graphics need
tmux ≥ 3.3 with `allow-passthrough on` and a kitty-family outer terminal).

chafa knobs (colors, symbols, dither, cellWidth, maxRows, timeout, binaryPath)
live in `~/.pi/agent/pi-chafa.json` and the `CHAFA_*` environment variables —
read pi-chafa's README for them. The `i` key toggles between the rendered image
and the metadata card in every mode. Images are **user-only**: they are never
sent to the model. A missing binary, extension, terminal capability, or opt-in
always degrades to the metadata card — never an error.

The tiers are documented in
[docs/specs/chafa-image-rendering.md](docs/specs/chafa-image-rendering.md) and
[docs/specs/native-image-rendering.md](docs/specs/native-image-rendering.md).

## Development

Files: `index.ts` (entry, command routing, async data ownership), `navigator.ts` (overlay component state, caches, input routing, render orchestration), `frame.ts` / `files_view.ts` / `git_view.ts` / `viewer_view.ts` / `help_view.ts` (extracted pure pane view-models — geometry and chrome, files rows, git rows, viewer pane, `?` modal), `tree.ts` (tree model, fs walk), `git.ts` (async git access and porcelain parsing), `viewer.ts` (load caps, highlighting, search, display rows, `hardTruncate`), `theme.ts` (token mapping), `types.ts`, `constants.ts`, `env.ts` (shared env truth table), `settings.ts` (pi-navigator settings terrain), `settings_menu.ts` (`/navigator settings` menu, rendered in the editor area above the input), `help.ts` (shared help/keybinding tables + `/navigator help` entry layout), `images.ts` (pi-chafa detection, chafa probe/sanitize/geometry, native capability ladder + bounded pi-tui native renderer).

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
- `npm test` — 20 vitest suites: porcelain `-z` parsing plus a
  real-git scratch-repo integration pass, tree building/fs-walk fixtures
  (ignores, dot entries, symlink cycles), viewer caps and UTF-8 head decoding,
  the keymap reducer (escape precedence, focus cycling, copy), settings
  normalization/loading (`PI_NAV_IMAGES` + `PI_NAV_ICONS` truth tables,
  `applyFieldEdit`), the settings-menu builder and real-SettingsList
  integration, the help layout + command-routing + table-drift suites, pi-chafa
  detection/config/probe/sanitizer/geometry, the native capability ladder and
  pi-tui encoder suite, the extracted pane view-models
  (frame geometry, files/git row builders, viewer pane, `?` modal) plus the diff
  styler, theme token map and shared env parser, the notify-once factory, and
  render width-safety at 120x36, 100x28 and 80x24 — plus 60/50-column,
  settings-menu, chafa and native payload cases — including help/filter/search
  modes and the compact notice.

Test runs must stay green with `typecheck` and `test`; the suites have already
caught real bugs (a search-highlight crash from inverted theme tokens, a
symlink-to-root walk cycle, and footer focus labels truncated off at narrow
widths), so they are part of the definition of done, not decoration.
