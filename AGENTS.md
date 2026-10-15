# AGENTS.md

AGENTS.md is the entry point for any coding agent working in this repository. It is a README for agents: a predictable place for context, environment, testing, and contribution instructions.

---

## Project overview

`pi-navigator` is a read-only project file navigator **overlay** for [pi](https://github.com/earendil-works/pi-coding-agent) — the AI coding agent harness. It is a pi **extension** (a `pi-package` / `pi-extension`), not a standalone app.

Opened via the `/navigator` command, it renders a centered overlay with three panes:

- **Files pane** — a file tree (tracked + untracked git files when git is available, with untracked `?? dir/` subtrees filled by a bounded fs walk; a filesystem walk when git is unavailable or the repo is empty) with hidden-file toggle and fuzzy filter. Ignored untracked paths are hidden by default and shown with a dim `!` badge under `tree.respectGitignore: false` (a no-op without a repository; Issue #158).
- **Git panel** — branch, ahead/behind counters, unstaged/staged groups, and recent commit history.
- **Viewer pane** — syntax-highlighted, read-only file viewing with caps, tab expansion, word wrap, horizontal scroll, in-file search, and an optional **minimap column** (`viewer.minimap`, toggled with `v`; Issue #165).

Three overlay layouts (Issue #119) choose which left-column panes render beside the viewer: `files-git-viewer` (files + git, the default), `files-viewer` (files only), and `git-viewer` (git only). Bare `/navigator` opens the overlay with the layout named by the `layout.default` setting; `/navigator all|files|git` open their layout for one session; `PI_NAV_LAYOUT` overrides the setting (env wins). Layout is presentation-only — data collection is identical in all three.

The overlay is a pure TUI component; it never touches the filesystem or git directly. All async/data work lives in `session.ts` (Issue #140); `index.ts` loads settings/env, dispatches commands, and wires the session to the overlay. The component (`navigator.ts`) owns UI state only.

---

## Dev environment tips

- **Runtime:** Node ≥ 22, ESM (`"type": "module"`). TypeScript strict mode with bundler resolution (`tsconfig.json`).
- **Peer dependencies:** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are peer deps — they are provided by the host pi install, not bundled. Don't add them as regular dependencies.
- **Keep the devDependencies in step with the host pi version.** The two peers are `*` in `peerDependencies` (correct — the host supplies them), but the `devDependencies` copy is what `tsc --noEmit` and Vitest resolve against, so it must track the pi the extension actually loads into. This has drifted three times: `^0.85.1` while the host ran 0.99.2; `^0.99.2` (a caret on a `0.x` version pins the minor, so 1.0.3 was never resolved) while the host ran 1.0.3; and `^1.0.3` (lockfile-held) while the host ran 1.2.0. The last was hiding a real failure — pi-tui 1.2.0's `Input` wraps its caret cell in fake-cursor markers (`\x1b_pi:fc\x07` … `\x1b_pi:/fc\x07`) that the settings-menu render test rejected until they were whitelisted as host-owned (Issues #157, #163). Raised to `^1.2.0`, tracking host pi 1.2.0; typecheck and the full suite are green there. Re-check on every host upgrade; do **not** jump the dev pin ahead of the host either (typechecking against 1.2.1 while running 1.2.0 is the same mistake pointing the other way).
- **No external runtime deps.** The viewer uses pi-native `highlightCode` + `getLanguageFromPath` for syntax highlighting. The viewer never shells out to external binaries and pulls no npm highlighter deps — the exec sites are `git.ts` (git) and `images.ts` (chafa). Keep it that way — with one carve-out: **chafa** is an optional, user-installed renderer, used when the mode is `chafa` or `auto` (set directly or via `PI_NAV_IMAGES`) and the pi-chafa extension is installed; when pi-chafa is present the binary is version-probed at overlay open even in mode `off`. It is never required, never bundled, and never invoked for any other purpose. The native image tier (`images.mode: "native"`/`"auto"`) is opt-in too and reuses the peer pi-tui kitty/iTerm2 encoders (`renderImage`) — no runtime dependency; our own code only probes kitty support (the one-shot `a=q` query, Issues #101/#116) and applies `NATIVE_PROTOCOL_RULES`.
- **Local install for dogfooding:** this extension is registered as a local path in pi settings. To (re)install from this checkout:
  ```bash
  pi install .            # global (~/.pi/agent/settings.json)
  pi install . -l         # project-local (.pi/settings.json)
  pi list                 # confirm it appears
  ```
  A path install reads `package.json` live from this directory, so the version pi reports is whatever `package.json` declares — the release PR owns that bump (see Publishing), so don't hand-edit it.
- **Entry point:** `index.ts` is the `pi` extension entry (`package.json` `pi.extensions`). It registers the `navigator` command and wires `ctx.ui.custom` with the overlay component.
- **Layout constants** (caps, ratios, timeouts, extension whitelists) live in `constants.ts`; the overlay height ratio has exactly one source there (`OVERLAY_HEIGHT_RATIO`, with `OVERLAY_MARGIN_ROWS` for the reserved vertical margin), because `OVERLAY_OPTIONS.maxHeight` — which the host resolves — and `layout.overlayHeight()` — which the component draws with — must not drift (Issue #130). Geometry math (heights, body rows, column split, panes) lives in `layout.ts` geometry helpers (split out of `frame.ts`, Issue #148) — change numbers in one place.

---

## Building & testing

- **Typecheck:**
  ```bash
  npm run typecheck      # tsc --noEmit, strict
  ```
- **Tests:** Vitest, 23 suites (`viewer`, `tree`, `git`, `navigator`, `render`, `icons`, `settings`, `settings_menu`, `help`, `images`, `diff`, `theme`, `env`, `index`, `session`, `frame`, `layout`, `files_view`, `git_view`, `viewer_view`, `help_view`, `minimap_view`, `docs`).
  ```bash
  npm test               # vitest run — full suite
  npx vitest run -t "CRLF"   # focus one test by name
  // Run the whole suite (23 files) with `npm test`.
  ```
- **Before claiming work is done**, both `npm run typecheck` and `npm test` must be green. The render suite enforces width-safety at multiple terminal sizes (120×36, 100×28, 80×24, and narrow widths) — keep it that way when adding UI.
- **Add or update tests for the code you change, even if nobody asked.** Width-safety regressions and ANSI/escape-sequence bugs are exactly the class this suite exists to catch.

---

## Code layout

| File | Owns |
|---|---|
| `index.ts` | Extension entry; registers `/navigator` (subcommands `all` / `files` / `git` / `settings` / `set <field> <value>` / `help`, argument completions, the help entry renderer) and the three `--navigator-*` startup flags (`registerFlag` without a default, so an absent flag stays distinguishable from a set one — Issue #131); wires the session to the overlay through the sink and the load/commit/reflow callbacks (Issues #140/#144). |
| `session.ts` | The overlay's data lifecycle (Issue #140): poll timer + backoff, tree collection and stamping (incl. the ignored-path skip predicate `makeIgnoredSkip`, Issue #158), the git read, the viewer cache, the one image pipeline binding (Issue #144; `viewer.ts` `loadFile` consumes the typed `RenderOutcome`), the reflow clock, image-support resolution, and refresh-error dedupe. |
| `navigator.ts` | `NavigatorOverlay` — the TUI component: state (incl. the `initialLayout` choice, Issue #119), input routing and render orchestration, delegating each pane's view-model to the modules below (Issue #064) and the viewer's derived state to `viewer_model.ts` (Issue #169). UI state only; no fs/git. Exports `HELP_ROWS` (projected from `help.ts`'s `NAVIGATOR_KEYBINDINGS`). |
| `frame.ts` | Overlay frame composition + chrome: the one `composeFrame` assembly (borders, title, separators, body join, scrollbar border, footer wrapper; Issue #148), `buildTopBorder`/`buildTitleRow`/`buildFooterRow`, the compact-notice and scrollbar-border builders, `padTo`/`joinLeftRight`/`leftBudget`/`truncateAndWidth`, `shortPath`, and the footer hint rendering (`getFooterHint`/`fitHint`). Pure. |
| `layout.ts` | Navigator-only overlay geometry (split out of `frame.ts`, Issue #148): overlay/body heights, the left-column gates and width, the pane-area arithmetic (`paneArea` + the area helpers), the files↔git split and the layout derivations (`layoutPanes`/`layoutRows`/`visiblePanes`/`initialFocus`/`cycleFocus`). Pure — constants + types only. |
| `files_view.ts` | Files pane view-model: `buildFilesRows`, files header + file row. Pure functions of a small `FilesViewContext`. |
| `git_view.ts` | Git pane view-model: `buildGitRows`/`buildGitNavRows` (incl. the commit-family DFS and the `?? dir/` display slash), git header + row, `commitMarker`, `codeText`. Pure. |
| `minimap_view.ts` | The viewer minimap engine (Issue #165), pure: `buildMinimap` folds the pane's display rows into Bresenham blocks (`floor(k·n/H)`) and encodes each as one braille (2×4 dot grid, `U+2800` blank cells) or positioned-bars row; `renderMinimap` paints the viewport band from the clamped scroll window and, per render, any search marks (`MinimapMarks`: one flag per map row plus the current match's row — outside the sketch cache, and painted so the band's background stays readable under the mark's foreground, Issue #166). The interface is two calls and plain records (`texts`, `area`, `width`, `encoding`, `palette`, `diff`, `theme` in; `blocks`, `rows`, `area` out) — the pane composes it after a one-column frame-tone divider, and while a map shows the overlay suppresses the border's proportional thumb so the band is the viewer's only position cue. The module never sees a `ViewerFile`, a `DisplayRow` or a pane, and the colours it emits come from `NavigatorTheme` (the one exception is `theme.syntax`, which re-emits a code captured from the theme's own syntax tokens). |
| `viewer_view.ts` | Viewer pane view-model: `renderViewerPane` (one switch over the `ViewerContent` slot — image rows / card / rendered markdown / display rows / none; Issue #149), `viewerWindow` (the one viewer scroll/hscroll clamp the body, badge, readout and scrollbar consume, Issue #147), header (incl. the `~N tok` estimate, Issue #160), input/search/filter bars, image card + `imageCardHints`, `canRenderMarkdown`, pane content geometry, and the minimap column's composition (`content row + frame-tone divider + band-painted map row`, carved as `viewer.minimapWidth + MINIMAP_DIVIDER_WIDTH`, Issue #165). Pure — the class precomputes rows, marked files, clamped offsets and the sketch. |
| `viewer_model.ts` | The viewer's derived-state owner (Issue #169): `ViewerModel` holds every render cache (plain wrap, max line width, minimap texts/sketch, rendered markdown + its renderer) and the search derivation (query/matches/index/jump/dirty/occurrence) behind `render(input)` / `invalidate(scope)` / `setSource` / `setQuery` / `cycle` / `getState`. The overlay routes input, owns scroll/focus/settings and applies the returned window through one `applyWindow` writer. `invalidate` scopes: `theme`, `markdown` (`m`), `content` (a fresh load), `minimap` (`v`). |
| `help_view.ts` | `?` modal layout: `composeHelp` plus the help viewport math (`helpVisibleRows`, `helpMaxScroll`). Pure. |
| `tree.ts` | Tree building from entries, cursor movement, filter, flatten, expansion memory (`setExpanded` is the one expansion mutation door and `expandAncestors(root, relPath)` is root-anchored; Issue #150 — test-only helpers live in `test/tree_fixtures.ts`). Pure graph helpers plus the bounded fs-entry collection the session's tree ticks use (`collectDirEntries` / `collectFsEntries` / `collectFsProbe`). |
| `git.ts` | git binary detection, `readGitState` (porcelain; the `?? dir/` slash normalized to `GitChangedFile.isDir`), history, `readCommitDiff` (v3 commit-diff), the one cwd-relative tree entry `readGitTree` (`ls-files --full-name -z`, tracked + untracked, tree-ready) plus the ignored listing `readIgnoredEntries` (`ls-files --others --ignored --exclude-standard --directory`, merged behind `tree.respectGitignore`, Issue #158), availability cache. |
| `viewer.ts` | `loadFile` pipeline: stat (or the session's handed-off record), binary sniff, one image-outcome mapping, size caps, tab expansion, CR normalization, highlighting, search, display rows, and the header's `~N tok` estimate (`estimateTokens`, pi's chars/4 context-budget heuristic, Issue #160); the shared open-target helpers (`targetOf`/`targetPath`/`sameTarget`); `sliceStyled` and `hardTruncate` (the empty-ellipsis hard cut, Issue #010), and `inkRuns` (styled text split into visible runs tagged with their SGR foreground, the minimap's colour source; Issue #165). |
| `diff.ts` | v3 diff-line prefix styler (`styleDiffLines`) — theme-driven `+`/`-`/`@@`/meta coloring; runs in the loader, git.ts stays theme-free. |
| `icons.ts` | Nerd Font glyph map + `parseIconMode` (a thin projection onto `env.ts`); icons are explicitly opt-in via `icons.enabled` or `PI_NAV_ICONS` (env wins) and never auto-detected. |
| `env.ts` | Shared env truth-table parser (`parseTruthyEnv`) behind `PI_NAV_ICONS` / `PI_NAV_IMAGES`. Pure, dependency-free (imported by the component module graph via `images.ts`, and directly by `settings.ts` and `icons.ts`). |
| `theme.ts` | `makeNavigatorTheme` — maps semantic tokens (accent/muted/dim/…) onto pi `Theme` tokens. No hardcoded colors. |
| `types.ts` | Shared structural types (FileNode — 13 fields, no parent back-pointer, Issue #150; GitState, ViewerFile with `kind: "diff"` and the `ImageVerdict` union, rows, the `NAVIGATOR_LAYOUTS` union). |
| `constants.ts` | All tuning constants (caps, ratios, timeouts, ignored names, image extensions). |
| `settings.ts` | pi-navigator settings schema/normalizer/loader/writer (`~/.pi/agent/pi-navigator.json`, `PI_NAV_IMAGES` / `PI_NAV_ICONS` / `PI_NAV_LAYOUT`), the `NAVIGATOR_CONFIG_FIELDS` registry (one per-kind rule table + per-field env/flag override sources, Issue #145) covering all ten fields — `images.mode`, `icons.enabled`, `viewer.wrap`, `viewer.markdown`, `viewer.minimap`, `viewer.minimapColors`, `viewer.minimapWidth` (Issue #165), `tree.showHidden`, `tree.respectGitignore` (Issue #158), `layout.default` — the loader's truthful `origins`, and the one `commitNavigatorSettings` both writers use. |
| `settings_menu.ts` | `/navigator settings` editor-dock menu: pure `buildSettingItems` + the exported pure `buildSettingsMenuTheme` (host `getSettingsListTheme` roles: plain labels, muted values) + a thin pi-tui `SettingsList` wrapper (Ctrl+S commits / Esc cancels, env-override + capability annotations, Issue #118). Every edit goes through `settings.ts`'s `applyFieldEdit`, the same validator `/navigator set` uses, so the two paths cannot disagree (Issue #131). Rendered via a plain `ctx.ui.custom` (no overlay) so it docks above the message input, per the pi settings-UI standard; framed by top/bottom full-width `border`-token rules like pi's own `/settings` and pi-overseer, with mouse events forwarded to the list past the frame chrome. No fs access; settings fs stays in `settings.ts` (`index.ts` has no fs imports). |
| `help.ts` | Single source for the key vocabulary and the help surfaces: `KEY_BINDINGS` (the one key declaration — modal display + short footer form + context refs, Issue #148), the derived `NAVIGATOR_KEYBINDINGS` and hint tables, `NAVIGATOR_SUBCOMMANDS` (incl. the layout openers' `layout` field, Issue #119), the derived `NAVIGATOR_COMMANDS`, and the `/navigator help` durable entry layout (`buildHelpLines`, qdrant-memory parity). Pure. |
| `images.ts` | pi-chafa detection, config mirror, chafa probe/render/sanitize, geometry, the native (kitty/iTerm2) capability ladder + `NATIVE_PROTOCOL_RULES`, the bounded pi-tui native renderer, the per-load attempt plan (`planImageLoad` / `isNativelyRenderable`), and the one render pipeline (`makeImagePipeline` + typed `RenderOutcome`). |

**View-model rule (Issue #064):** the pane modules (`frame.ts`, `files_view.ts`, `git_view.ts`, `viewer_view.ts`, `help_view.ts`) are pure functions of plain records — they hold no state, touch no cache and never read `this`. The class (through its viewer model, Issue #169) computes data (marked rows, wrapped `display`, rendered markdown, clamped offsets), then passes it in. Keep new pane logic on the module side of that seam so it stays directly testable.

**Data contract:** `setTree` / `setGitState` / `setImageSupport` / `openRelPath` are the ways data enters the component, and settings land via the ctor options (`enableIcons`, `initialShowHidden`, `initialWrap`, `initialRenderMarkdown` — Issue #061; `initialLayout` — Issue #119, default `"files-git-viewer"`, fixed for the overlay's lifetime; `initialMinimap`, `initialMinimapColors`, `initialMinimapWidth` — Issue #165, seeded once so `v` never has to write them back). Keep the render path pure. v3 adds `openCommit` + the optional `NavigatorOptions.loadCommit` injection (parallel to `loadFile`): when present, Enter on a commit opens its diff as a `ViewerFile` with `kind: "diff"` whose `relPath` is `commit:<hash>`; diffs skip the mtime poll in `session.ts` (`target.kind === "commit"` on the typed `OpenTarget`, Issue #142). When `loadCommit` is absent, Enter falls back to toggling the commit's family.

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
- **Key handling is narrowed, not literal.** Host-owned action ids go through the injected `KeybindingsManager` so user remaps apply — `tui.select.cancel` (default keys Esc and Ctrl+C) is the single funnel, `NavigatorOverlay.matchesCancel`, consulted at every level of the Esc stack; `index.ts` threads the manager it receives from `ctx.ui.custom` into the overlay. Overlay-local letters (j/k, h/l, g/G, `/`, `?`, …) stay literal: they have no host binding ids and are this extension's own key language. The no-manager fallback exists for harnesses only and matches Esc alone, so it is never a substitute for the real wiring — a test must drive the production path, not just construct the overlay with a manager (Issue #114 recorded that failure class, Issue #126 fixed this one).
- **Screenshots live in `assets/`** at the repo root, named by what they show: the three layouts as `files-git-viewer.png` / `files-viewer.png` / `git-viewer.png`, feature shots by feature (`settings-menu.png`, `image-preview.png`, `viewer-minimap.png`). That is the naming convention, not an inventory — today only the hero (`files-git-viewer.png`) exists, and README carries an HTML-comment placeholder where `viewer-minimap.png` goes until the owner captures it (a broken image link is worse than no image). The README hero and the pi.dev gallery preview (`pi.image` in `package.json`) are the same file, `assets/files-git-viewer.png`; `pi.image` must stay an absolute raw-GitHub URL on `main` — the gallery cannot resolve repo-relative paths.
- **Issues are tracked on GitHub** — [`lordekeen/pi-navigator/issues`](https://github.com/lordekeen/pi-navigator/issues); the former local `docs/issues/` tracker was migrated there (and archived locally as `docs/issues-archive-2026-10-12.tar.gz`). New bug → open a GitHub issue labelled with a type (`bug`, `enhancement`, `feature`, `technical-debt`, `performance`, `documentation`, `test-quality`, `accessibility`) and a severity (`high`, `medium`, `low`); resolved → close it as completed. `docs/` and `mockups/` remain gitignored development trees — they never ship; a fresh clone has neither.

---

## PR / commit instructions

- **Commit message format:** `<type>(<scope>): <subject> (#NNN)`
  - `type`: `fix`, `feat`, `refactor`, `test`, `docs`, `chore`
  - `scope`: `viewer`, `help`, `navigator`, `tree`, `git`, `theme`, etc.
  - `(#NNN)`: the GitHub issue number when applicable.
  - Examples: `fix(viewer): normalize CRLF line endings … (#009)`, `fix(help): stop bright ellipsis leaking … (#010)`.
- **Always run `npm run typecheck` and `npm test` before committing.** Both must be green.
- **Reference the issue** in the commit body when one exists; open a GitHub issue first if the change is non-trivial.
- **Keep diffs minimal.** Prefer one-line ellipsis-argument fixes over refactors when the root cause is localized. Don't refactor unrelated hotspots mid-bugfix.
- **Version:** `release-please` owns the version — don't bump `package.json` by hand; a `feat`/`fix` commit on `main` produces the release PR (see Publishing). No reinstall is needed for a source change: a path install reads `package.json` live.

---

## Publishing

The package is published to npm as `@lordekeen/pi-navigator`. Two workflows in `.github/workflows/`: `release-please.yml` (automatic) and `publish-manual.yml` (on demand). Publishing is **staged**: CI submits the version without 2FA, a maintainer approves with 2FA, and only then is it live.

1. `release-please` maintains a release PR from conventional commits (version bump + `CHANGELOG.md`).
2. Merging that PR creates the GitHub release and tag — **the merge alone does not publish to npm**; nothing is live yet.
3. Creating the release triggers the `publish` job, which stages the new version with `npm stage publish` (no 2FA in CI).
4. A maintainer approves with 2FA — `npm stage approve <stage-id>`, or npmjs.com -> Staged Packages tab -> Approve — and only then is it live.

- The **first-ever publish (v0.16.0) was direct and manual** (`npm publish --access public`): a package that does not exist on the registry yet cannot be staged. Staging takes over from the next version.
- `NPM_TOKEN` (repo secret) is a **staging-capable granular token** — correct and intentional. Do not "fix" it into a direct-publish token; staging is the intended flow, not a workaround.
- The publish jobs must run on **Node 24**: `npm stage publish` needs npm CLI >= 11.15.0, and Node 22 bundles npm 10.x (Node 24 bundles npm 11.x).
- `manual-publish` (`gh workflow run manual-publish`) stages the current `main` version on demand.
- Before claiming a release shipped: `npm view @lordekeen/pi-navigator version` must show the new version. A successful staging run is not a publish.
- The npmjs.com README renders asynchronously and is only refreshed by a **new version publish** — editing `README.md` alone never updates the package page, so README changes must ride a version bump.
- General mechanics (staged publishing, version floors, GitHub Actions failures): the `npm-release-automation` skill.
