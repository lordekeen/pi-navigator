# AGENTS.md

AGENTS.md is the entry point for any coding agent working in this repository. It is a README for agents: a predictable place for context, environment, testing, and contribution instructions.

---

## Project overview

`pi-navigator` is a read-only project file navigator **overlay** for [pi](https://github.com/earendil-works/pi-coding-agent) — the AI coding agent harness. It is a pi **extension** (a `pi-package` / `pi-extension`), not a standalone app.

Opened via the `/navigator` command, it renders a centered overlay with three panes:

- **Files pane** — a file tree (git-tracked files when inside a repo, filesystem walk otherwise) with hidden-file toggle and fuzzy filter.
- **Git panel** — branch, ahead/behind counters, unstaged/staged groups, and recent commit history.
- **Viewer pane** — syntax-highlighted, read-only file viewing with caps, tab expansion, word wrap, horizontal scroll, and in-file search.

The overlay is a pure TUI component; it never touches the filesystem or git directly. All async/data work lives in `index.ts`; the component (`navigator.ts`) owns UI state only.

---

## Dev environment tips

- **Runtime:** Node ≥ 22, ESM (`"type": "module"`). TypeScript strict mode with bundler resolution (`tsconfig.json`).
- **Peer dependencies:** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are peer deps — they are provided by the host pi install, not bundled. Don't add them as regular dependencies.
- **No external runtime deps.** The viewer uses pi-native `highlightCode` + `getLanguageFromPath` for syntax highlighting. No shelling out to external binaries, no npm highlighter deps. Keep it that way — with one carve-out: **chafa** is an optional, user-installed renderer, used only when the user opts in (`images.mode: "chafa"` / `PI_NAV_IMAGES=1`) and the pi-chafa extension is installed; it is never required, never bundled, and never invoked for any other purpose. The native image tier (`images.mode: "native"`/`"auto"`) is opt-in too and reuses the peer pi-tui kitty/iTerm2 encoders — no runtime dependency and no protocol code of our own.
- **Local install for dogfooding:** this extension is registered as a local path in pi settings. To (re)install from this checkout:
  ```bash
  pi install .            # global (~/.pi/agent/settings.json)
  pi install . -l         # project-local (.pi/settings.json)
  pi list                 # confirm it appears
  ```
  A path install reads `package.json` live from this directory, so the version pi reports is whatever `package.json` declares — bump it when shipping fixes.
- **Entry point:** `index.ts` is the `pi` extension entry (`package.json` `pi.extensions`). It registers the `navigator` command and wires `ctx.ui.custom` with the overlay component.
- **Layout constants** (caps, ratios, timeouts, extension whitelists) live in `constants.ts`. Geometry math (overlay height, body rows, column split) lives in `navigator.ts` geometry helpers — change numbers in one place.

---

## Building & testing

- **Typecheck:**
  ```bash
  npm run typecheck      # tsc --noEmit, strict
  ```
- **Tests:** Vitest, 20 suites (`viewer`, `tree`, `git`, `navigator`, `render`, `icons`, `settings`, `settings_menu`, `help`, `images`, `diff`, `theme`, `env`, `index`, `frame`, `files_view`, `git_view`, `viewer_view`, `help_view`, `docs`).
  ```bash
  npm test               # vitest run — full suite
  npx vitest run -t "CRLF"   # focus one test by name
  // Run the whole suite (20 files) with `npm test`.
  ```
- **Before claiming work is done**, both `npm run typecheck` and `npm test` must be green. The render suite enforces width-safety at multiple terminal sizes (120×36, 100×28, 80×24, and narrow widths) — keep it that way when adding UI.
- **Add or update tests for the code you change, even if nobody asked.** Width-safety regressions and ANSI/escape-sequence bugs are exactly the class this suite exists to catch.

---

## Code layout

| File | Owns |
|---|---|
| `index.ts` | Extension entry; registers `/navigator` (subcommands `settings` / `help`, argument completions, the help entry renderer); owns all async work (git, tree collection, file stat) and pushes results into the overlay via setters. |
| `navigator.ts` | `NavigatorOverlay` — the TUI component: state, caches, input routing and render orchestration, delegating each pane's view-model to the modules below (Issue #064). UI state only; no fs/git. Re-exports `HELP_ROWS`. |
| `frame.ts` | Overlay geometry + chrome: heights/areas, the files↔git split, column width, `padTo`/`joinLeftRight`/`truncateAndWidth`, `shortPath`, title/footer rows, the focus/mode hint tables. Pure. |
| `files_view.ts` | Files pane view-model: `buildFilesRows`, files header + file row. Pure functions of a small `FilesViewContext`. |
| `git_view.ts` | Git pane view-model: `buildGitRows`/`buildGitNavRows` (incl. the commit-family DFS), git header + row, `commitMarker`, `codeText`. Pure. |
| `viewer_view.ts` | Viewer pane view-model: `renderViewerPane`, header, input/search/filter bars, image card + `imageCardHints`, `canRenderMarkdown`, pane content geometry. Pure — the class precomputes rows, marked files and clamped offsets. |
| `help_view.ts` | `?` modal layout: `composeHelp` plus the help viewport math (`helpVisibleRows`, `helpMaxScroll`). Pure. |
| `tree.ts` | Tree building from entries, cursor movement, filter, flatten, expansion memory. |
| `git.ts` | git binary detection, `readGitState` (porcelain), history, `readCommitDiff` (v3 commit-diff), tracked-file listing, availability cache. |
| `viewer.ts` | `loadFile` pipeline: stat, binary sniff, image tier, size caps, tab expansion, CR normalization, highlighting, search, display rows; `sliceStyled` and `hardTruncate` (the empty-ellipsis hard cut, Issue #010). |
| `diff.ts` | v3 diff-line prefix styler (`styleDiffLines`) — theme-driven `+`/`-`/`@@`/meta coloring; runs in the loader, git.ts stays theme-free. |
| `icons.ts` | Nerd Font glyph map + `parseIconMode` (a thin projection onto `env.ts`; `parseEnableIcons` is its compatibility wrapper); icons are explicitly opt-in via `icons.enabled` or `PI_NAV_ICONS` (env wins) and never auto-detected. |
| `env.ts` | Shared env truth-table parser (`parseTruthyEnv`) behind `PI_NAV_ICONS` / `PI_NAV_IMAGES`. Pure, dependency-free (imported by the component module graph via `icons.ts`). |
| `theme.ts` | `makeNavigatorTheme` — maps semantic tokens (accent/muted/dim/…) onto pi `Theme` tokens. No hardcoded colors. |
| `types.ts` | Shared structural types (FileNode, GitState, ViewerFile with `kind: "diff"`, rows). |
| `constants.ts` | All tuning constants (caps, ratios, timeouts, ignored names, image extensions). |
| `settings.ts` | pi-navigator settings schema/normalizer/loader/writer (`~/.pi/agent/pi-navigator.json`, `PI_NAV_IMAGES` / `PI_NAV_ICONS`), the `NAVIGATOR_CONFIG_FIELDS` registry, and pure `applyFieldEdit`. |
| `settings_menu.ts` | `/navigator settings` editor-dock menu: pure `buildSettingItems` + the exported pure `buildSettingsMenuTheme` (host `getSettingsListTheme` roles: plain labels, muted values) + a thin pi-tui `SettingsList` wrapper (commit/revert, env-override + capability annotations, Issue #118). Rendered via a plain `ctx.ui.custom` (no overlay) so it docks above the message input, per the pi settings-UI standard; framed by top/bottom full-width `border`-token rules like pi's own `/settings` and pi-overseer, with mouse events forwarded to the list past the frame chrome. No fs access; fs stays in `index.ts`/`settings.ts`. |
| `help.ts` | Single source for the help surfaces: `NAVIGATOR_SUBCOMMANDS` + `NAVIGATOR_KEYBINDINGS`, the derived `NAVIGATOR_COMMANDS`, and the `/navigator help` durable entry layout (`buildHelpLines`, qdrant-memory parity). Pure. |
| `images.ts` | pi-chafa detection, config mirror, chafa probe/render/sanitize, geometry, the native (kitty/iTerm2) capability ladder, and the bounded pi-tui native renderer. |

**View-model rule (Issue #064):** the pane modules (`frame.ts`, `files_view.ts`, `git_view.ts`, `viewer_view.ts`, `help_view.ts`) are pure functions of plain records — they hold no state, touch no cache and never read `this`. The class computes data (marked rows, wrapped `display`, rendered markdown, clamped offsets), then passes it in. Keep new pane logic on the module side of that seam so it stays directly testable.

**Data contract:** `setTree` / `setGitState` / `openRelPath` are the only ways data enters the component, and settings land via the ctor options (`enableIcons`, `initialShowHidden`, `initialWrap`, `initialRenderMarkdown` — Issue #061). Keep the render path pure. v3 adds `openCommit` + the optional `NavigatorOptions.loadCommit` injection (parallel to `loadFile`): when present, Enter on a commit opens its diff as a `ViewerFile` with `kind: "diff"` whose `relPath` is `commit:<hash>`; diffs skip the mtime poll in index.ts (`startsWith("commit:")` guard). When `loadCommit` is absent, Enter falls back to toggling the commit's family.

---

## Conventions

- **Single-writer for source edits.** Routine localized edits → small, targeted changes. Cross-module refactors stay coherent.
- **No hardcoded colors.** All styling goes through `NavigatorTheme` (`theme.ts`), which delegates to the user's active pi theme. Never inline ANSI color codes in component code — the theme is the only source of color.
- **ANSI / escape sequences are load-bearing.** The viewer composes styled strings that are sliced, wrapped, truncated, and padded. Before changing any truncation, wrapping, or padding code, read these two facts that have already caused shipped bugs:
  - **Carriage returns break layout.** Normalize `\r\n` and lone `\r` to `\n` in `loadFile` before highlighting/splitting. A stray `\r` resets the terminal cursor to column 0 and the row's padding overwrites the gutter/border (Issue #009).
  - **`truncateToWidth`'s default `"..."` ellipsis is wrapped in `\x1b[0m` resets.** It closes any open style and renders the ellipsis in bright default. Truncate styled strings with an **empty** ellipsis (`""`) for a clean hard-cut; for plain text you want to re-style, truncate with `""`, strip the injected reset, and append your own styled ellipsis before wrapping (Issue #010).
- **Width-safety is mandatory.** Every rendered row must fit its pane width. Use `visibleWidth`/`truncateToWidth` for measurement; never assume a string's `.length` equals its visible width (ANSI escapes, wide chars).
- **Memory stays bounded by the caps** (`MAX_HIGHLIGHT_BYTES`, `MAX_HIGHLIGHT_LINES`), not by the file. Oversized files read a capped head, not the whole file.
- **Icons are explicitly opt-in, not auto-detected.** `icons.enabled` in the settings file or `PI_NAV_ICONS` opts into the Nerd Font column (env wins); index.ts reads the env-resolved setting once and passes `enableIcons` into the ctor. The component never touches `process.env`, and there is no capability probe (pi-tui has none for fonts). Keep it that way — a user who didn't opt in keeps plain glyphs always.
- **Issues are tracked** in `docs/issues/` with a central `issues_index.md`. New bug → create `NNN-<slug>.md`, add to the Pending table; resolved → move to Resolved and update the overview counts. Follow the lifecycle in the index.

---

## PR / commit instructions

- **Commit message format:** `<type>(<scope>): <subject> (#NNN)`
  - `type`: `fix`, `feat`, `refactor`, `test`, `docs`, `chore`
  - `scope`: `viewer`, `help`, `navigator`, `tree`, `git`, `theme`, etc.
  - `(#NNN)`: the issue number from `docs/issues/` when applicable.
  - Examples: `fix(viewer): normalize CRLF line endings … (#009)`, `fix(help): stop bright ellipsis leaking … (#010)`.
- **Always run `npm run typecheck` and `npm test` before committing.** Both must be green.
- **Reference the issue** in the commit body when one exists; create an issue doc first if the change is non-trivial.
- **Keep diffs minimal.** Prefer one-line ellipsis-argument fixes over refactors when the root cause is localized. Don't refactor unrelated hotspots mid-bugfix.
- **Version:** bump `package.json` `version` (patch for bugfixes, minor for features) and re-run `pi install .` so the local registration reflects it.
