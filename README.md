# pi-navigator

Read-only project file navigator for pi. Opens a centered overlay inside a running pi session with a file tree, git state, and a syntax-highlighted viewer. No file editing, no external binaries, no runtime dependencies.

![status](https://img.shields.io/badge/status-v0.3.0-green)

## Install

Place the directory in a pi extension location and pi discovers it:

- Global: `~/.pi/agent/extensions/pi-navigator/` (or any directory containing `index.ts`)
- Project: `.pi/extensions/pi-navigator/`

Then start pi and run `/navigator`.

Does pi-navigator fit your setup? [Read more](./AGENTS.md) — [Dev docs](./docs/plans/pi-navigator-implementation-plan.md) — [Open issues](./docs/issues/issues_index.md)

## Config

Nerd Font filetype icons are opt-in via an environment variable (the default is plain-text glyphs):

| Variable | Effect |
| --- | --- |
| `PI_NAV_ICONS=1` | Render a Nerd Font filetype icon column in the file tree (`1`/`true`/`yes`/`on` all enable) |

Set it in your shell profile (e.g. `export PI_NAV_ICONS=1` in `~/.zshrc`) before launching pi, or pass it inline: `PI_NAV_ICONS=1 pi`.

Icons depend on a terminal Nerd Font — without one, glyphs render as placeholder boxes (tofu). The overlay shows a one-time, non-blocking hint when icons are on. No other configuration: the git pane, commit-family view, and viewer follow the active pi theme with no hardcoded colors.

## Usage

```
/navigator      open the overlay
```

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
| Git | `Enter` | Open the file (expands the tree to it); on a commit row, expand/collapse its ancestor family |
| Viewer | `j` `k` / arrows | Scroll |
| Viewer | `Ctrl+d` `Ctrl+u`, `g` `G` | Half page, top, bottom |
| Viewer | `/` | Search (smart case, incremental) |
| Viewer | `n` `N` | Next, previous match |
| Viewer | `w` | Toggle word wrap |
| Viewer | `h` `l` / arrows | Horizontal scroll when wrap is off |

Esc precedence in one line: filter, then search, then close.

## Behavior notes

- Launch mechanism: the extension is launched via the `/navigator` command, avoiding keybinding conflicts with pi's built-in shortcuts (such as `ctrl+n` / `app.session.toggleNamedFilter`).

- Syntax highlighting uses pi's own `highlightCode` and `getLanguageFromPath`, so colors follow the active theme and no tools like `bat` are needed.
- Tree source is hybrid: inside a repository it lists tracked plus untracked non-ignored files; without git, and in a repository with nothing to list yet (a fresh `git init`), it falls back to an async filesystem walk with a static ignore list, dot entries included but hidden by default. `.gitignore` parsing is a v2 candidate.
- Git panel: branch or detached HEAD, ahead and behind counters, unstaged and staged lists, last 20 commits. All git calls are async with a 3 s timeout; the panel shows a single explanation row when git is missing or the cwd is not a repository, and a dim `Clean` row when nothing is staged or unstaged. Status and the tracked listing are read with `-z`, so paths containing spaces, quotes or newlines survive intact.
- Refresh runs every 3 s while the overlay is open, plus `r`, with one refresh in flight at a time: a tick that arrives mid-refresh is dropped. Git state is re-read every tick; the tree is re-collected only when a cheap probe changes — the porcelain-derived signature in git mode, the modification times of the expanded directories in fs mode — and rebuilt only when the path set itself changes, with git codes otherwise stamped in place. Expanded and collapsed directories, top-level ones included, are preserved across rebuilds. Repeated failures notify once per distinct message instead of once per tick.
- Hidden dot entries render dim, and the `.` toggle is Files-scoped.
- Caps: files over 1 MB or 5000 lines open truncated with a notice, and never load in full — the loader reads at most 1 MB from the head. The truncated view reports the total line count when the whole file was read and it is under 256 KB. Binary files are detected by a NUL byte and shown as a metadata card; images show a metadata card in v1.
- While filtering or searching, the typed query is echoed with a reverse-video cursor, preceded by the hardware cursor marker while the overlay has focus, so IME composition lands over the right cell.
- Never writes to the workspace. The only mutating operations in the whole extension are clipboard copies for `y`.
- Minimum terminal size: the overlay asks for 80 columns; below 72 inner columns the left column hides (toggle `t`); below 40 columns or 8 body rows it renders a compact "terminal too small" notice instead of the frame.

## Images (spike pending)

v1 always shows a metadata card (name, size, and PNG/GIF dimensions when cheaply readable). Implementation plan section 8 lists the verification spike: native terminal protocols through pi-tui's `Image` component inside the overlay, and a `chafa` fallback when available. Results will be recorded here.

## Development

Files: `index.ts` (entry, async data ownership), `navigator.ts` (overlay component, keymap, rendering), `tree.ts` (tree model, fs walk), `git.ts` (async git access and porcelain parsing), `viewer.ts` (load caps, highlighting, search, display rows), `theme.ts` (token mapping), `types.ts`, `constants.ts`.

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
- `npm test` — five vitest suites (108 cases): porcelain `-z` parsing plus a
  real-git scratch-repo integration pass, tree building/fs-walk fixtures
  (ignores, dot entries, symlink cycles), viewer caps and UTF-8 head decoding,
  the keymap reducer (escape precedence, focus cycling, copy), and render
  width-safety at 120x36, 100x28 and 80x24 including help/filter/search modes
  and the compact notice.

Test runs must stay green with `typecheck` and `test`; the suites have already
caught real bugs (a search-highlight crash from inverted theme tokens, a
symlink-to-root walk cycle, and footer focus labels truncated off at narrow
widths), so they are part of the definition of done, not decoration.
