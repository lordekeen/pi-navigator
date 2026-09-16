# pi-navigator — Implementation Plan

Status: awaiting approval.
Companion documents: [`ui-standards-report.md`](ui-standards-report.md) for platform findings and rationale.
Target: zero-runtime-dependency pi extension, read-only file navigator overlay for pi-coding-agent.

---

## 1. Locked decisions from grilling

1. Git history is a static informational list (last 20 commits: short hash, relative date, subject). No commit detail view in v1.
2. Mockup is terminal-accurate HTML with a small JavaScript keyboard demo (j/k, Tab, Enter, /, ?, Esc, w, t).
3. Launch via `/navigator` command and a registered global shortcut `ctrl+n`.
4. v1 scope edges: include hidden-file toggle ('.') and `y` copy path. Exclude agent-modified badges, viewer diff toggle, cross-session persistence.
5. Hybrid tree source: git listing when available, async filesystem walk fallback with a static ignore list. Refresh on open, on `r`, and a 3 s interval while the overlay is open. Async only, never on the render path.
6. Hidden entries hidden by default, '.' toggles, session-only, rendered dim.
7. Caps: full highlighting up to 1 MB or 5000 lines; beyond that plain text plus a notice row. Line counting capped at 256 KB. Binary detection by NUL byte in the first chunk, metadata card instead of content.
8. Viewer defaults: line numbers always on, dim, right-aligned. Wrap off by default with horizontal scroll; `w` toggles. Tabs expand to 4 spaces. Incremental smart-case search with n/N and Esc. Fuzzy incremental tree filter. Search highlighting uses theme search tokens where available.
9. Packaging: flat modules, `package.json` with `pi.extensions` and peerDependencies, no runtime dependencies.
10. tsconfig and vitest are deferred until Node is available; the plan documents exactly what to add.

---

## 2. Deliverable layout

```
pi-navigator/
├── index.ts          extension entry: /navigator command, ctrl+n shortcut, overlay wiring
├── navigator.ts      overlay component: state machine, render composition, input routing
├── tree.ts           tree model: build from git or fs, flatten, filter, expand, ignore rules, symlink guard
├── git.ts            async git access: repo detect, branch, ahead/behind, status split, log; cache and refresh
├── viewer.ts         file pipeline: caps, binary and image tiers, highlighting, gutter, search, scroll and wrap model
├── theme.ts          NavigatorTheme wrapper over pi theme tokens
├── types.ts          shared types
├── constants.ts      caps, layout numbers, refresh interval, ignore list, keymap tables
├── package.json      pi.extensions entry, peerDependencies, no dependencies
├── README.md         usage, keymap, development notes, deferred tooling
└── mockups/
    └── navigator.html   throwaway terminal-accurate mock with keyboard demo
```

`node_modules` is never required. All imports come from `@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent`, and Node built-ins.

---

## 3. Module contracts

### 3.1 types.ts

```ts
export type GitCode = "M" | "A" | "D" | "R" | "C" | "??" | "!!" | "U" | string;
export type Focus = "files" | "git" | "viewer";
export type InputMode = "normal" | "filter" | "search" | "help";

export interface FileNode {
  name: string;
  path: string;          // absolute
  relPath: string;       // relative to workspace root, posix separators
  isDir: boolean;
  isSymlink: boolean;
  depth: number;
  expanded: boolean;
  gitCode?: GitCode;     // worktree or index status, tree badge only
}

export interface TreeRow { node: FileNode; }   // flattened visible rows

export interface GitCommit { hash: string; shortHash: string; dateRel: string; subject: string; }
export interface GitChangedFile { relPath: string; code: GitCode; }

export interface GitState {
  available: boolean;          // git binary found AND inside a repo
  branch: string | null;       // null = detached
  detached: boolean;
  ahead: number;
  behind: number;
  unstaged: GitChangedFile[];
  staged: GitChangedFile[];
  history: GitCommit[];
  error?: string;              // human-readable state line when unavailable
  refreshedAt: number;
}

export interface ViewerFile {
  kind: "text" | "truncated" | "binary" | "image" | "error";
  relPath: string;
  sizeBytes: number;
  mtimeMs?: number;
  lineCount?: number;
  lines: string[];             // highlighted ANSI lines for text kinds
  raw?: string;                // expanded tab text, kept for search and wrap reflow
  message?: string;            // for error / notice rows
}

export interface SearchState { query: string; matches: number[]; index: number; }
```

### 3.2 git.ts (async, cached)

Functions, all via `node:child_process.execFile` with `{ cwd, timeout: 3000, windowsHide: true }`, wrapped in try/catch returning typed fallbacks:

- `detectRepo(cwd)` -> `{ available, prefix }` using `git rev-parse --show-prefix`; empty output on failure.
- `readGitState(cwd)` -> `GitState`:
  - branch: `git branch --show-current`; detached when empty.
  - ahead/behind: `git rev-list --left-right --count @{u}...HEAD`; zeros when no upstream.
  - status: `git status --porcelain -uall -z` parsed into staged and unstaged lists; rename and copy entries consume the following path record; paths translated repo-root to cwd via the `--show-prefix` value.
  - history: `git log -n 20 --date=relative --pretty=format:%h%x1f%ad%x1f%s` split on the unit separator.
- `refresh()` re-runs `readGitState` and swaps a cached object; the UI reads only the cache.

No synchronous exec anywhere. Timeouts and failures degrade to `available: false` with a message.

### 3.3 tree.ts

- `buildFromGit(cwd, prefix)`: `git ls-files -z` plus untracked entries from porcelain; assemble nodes through a directory map.
- `buildFromFs(cwd, { showHidden })`: async `fs.promises.readdir` with `withFileTypes`, recursive with a depth cap (6); applies ignore list; dot-entry filtering; sorts directories first then locale compare.
- Ignore list constant: `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.cache`, `.turbo`, `venv`, `.venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.DS_Store`.
- Symlink handling: `lstat`, resolve only directories through `realpath`, refuse recursion when a realpath already appears among ancestors.
- `flatten(tree, filterQuery)` produces visible rows: expanded directories walk children; fuzzy filter switches to a flat match list with ancestor chains preserved (matching rows shown with dimmed parents).
- `moveCursor(rows, index, delta)`, `pageJump(rows, index, delta, height)` helpers keep scroll math out of the component.
- Expand and collapse mutate `node.expanded` only; the flattened list regenerates cheaply.

Per-file line counts and diff stats are deliberately out of the tree in v1. Tree rows carry only the git status code; the viewer computes the open file's line count.

### 3.4 viewer.ts

`loadFile(path, opts)` pipeline, async:

1. `stat` -> size, mtime. Missing or unreadable -> `{ kind: "error", message }`.
2. Binary check: read the first 4 KB, look for a NUL byte -> `kind: "binary"` metadata card.
3. Image extension set (png, jpg, jpeg, gif, webp, bmp, ico, avif) -> image tier resolution (Section 8).
4. Size gate: size > 1 MB -> `kind: "truncated"` showing head capped to 5000 lines plus notice row.
5. Read utf8 (capped), expand tabs to 4 spaces.
6. Highlight: `getLanguageFromPath(relPath)` + `highlightCode(text, lang)`; fall back to raw lines when the language is unknown or highlighting throws.
7. Count lines when the first read is at or below 256 KB.

Search and scroll:

- `search(raw, query)`: smart-case (case-insensitive unless the query has an uppercase character), incremental as the query types; matches stored as line indexes; render marks all matches, current match uses `searchMatchBg` and `searchMatchText` through `theme.bg` when available, else inverse.
- `reflow(lines, width, wrap)`: wrap via `wrapTextWithAnsi` when wrap is on; otherwise clip with horizontal offset; gutter width from total line count digits.
- Vertical scroll clamped to `max(0, contentRows - paneHeight)`; horizontal offset clamped per line; `g`/`G` jump; half page uses `ceil(paneHeight / 2)`.

### 3.5 theme.ts

`makeNavigatorTheme(piTheme)` returns semantic tokens used by the component:

| Token | Source token |
|---|---|
| frame | dim |
| title | accent + bold |
| pathLabel | muted |
| branch | accent |
| staged | success |
| unstaged | warning |
| untracked | dim |
| deleted | error |
| dirNormal | muted |
| dirChanged | warning |
| fileSelectedBg | selectedBg background |
| cursorArrow | accent |
| gutter | dim |
| notice | warning |
| error | error |

### 3.6 navigator.ts

Class `NavigatorOverlay` with fields: rows, cursor, scroll, focus, inputMode, filterQuery, gitState, gitCursor, viewer, search, help scroll, showHidden, showTree, lastRenderWidth, cached lines. Methods: `render(width)`, `handleInput(data)`, `invalidate()`, `setGitState`, `setViewerFile`, `setFilterQuery`.

Render composition order (all width-safe, all rows padded to inner width):

1. Top border `┌ + ─ + ┐`, dim.
2. Title row: `pi-navigator` accent bold, workspace path muted, branch and counters, change counters, inner padding.
3. Separator `├` style row via `│ + ─ + │`.
4. Body: left column (files over git) and right column (viewer), single `│` divider column owned by the left column rows. Left column hidden when inner width < 72; files over git split at `max(6, floor(leftColumn * 0.55))` rows for files, rest for git, git clipped with a dim `…` marker when short.
5. Footer: context key hints per focus and mode, dim labels with accent keys.
6. Overlays composed after body: help modal (centered box), filter bar drawn in the footer row area, search bar drawn in the viewer header line.

`handleInput` routing: help mode > filter/search input mode > normal mode by focus. Escape precedence: clear filter, then clear search, then close. All keys via `matchesKey`; printable capture via `decodeKittyPrintable`.

### 3.7 index.ts

- `pi.registerCommand("navigator", { description, handler })` -> guards `ctx.hasUI`, then opens `ctx.ui.custom((tui, theme, kb, done) => { ... }, { overlay: true, overlayOptions: { width: "90%", minWidth: 80, maxHeight: "85%", anchor: "center", margin: 1 } })`.
- `pi.registerShortcut("ctrl+n", { description: "Open pi-navigator", handler })` -> same open routine.
- Inside the overlay factory: create the overlay class, start the 3 s refresh interval (async git and tree refresh, then `tui.requestRender()`), clear the interval when `done()` is called. No resources started before `session_start`; no timers outside an open overlay.

---

## 4. Keymap specification

Modes: normal, filter (tree), search (viewer), help. Focus: files, git, viewer.

| Scope | Key | Action |
|---|---|---|
| Global normal | Tab / shift+tab | Cycle focus files > git > viewer |
| Global normal | t | Toggle left column |
| Global normal | r | Refresh tree and git now |
| Global normal | ? | Help modal |
| Global normal | q | Close overlay |
| Global normal | Esc | Clear filter, else clear search, else close |
| Global normal | y | Copy context: tree row or open file relative path; history row short hash |
| Files | j k, up down | Move cursor |
| Files | ctrl+d ctrl+u | Half page |
| Files | g G | Top, bottom |
| Files | Enter | Open file in viewer and focus viewer; toggle directory |
| Files | l right / h left | Expand / collapse directory |
| Files | / | Filter mode |
| Files | . | Toggle hidden entries |
| Git | j k, up down | Move through changed files then history rows |
| Git | Enter | Changed file: select in tree and open. History row: no-op |
| Git | g G | Top, bottom |
| Viewer | j k, up down | Scroll one row |
| Viewer | ctrl+d ctrl+u | Half page |
| Viewer | g G | Top, bottom |
| Viewer | / | Search mode |
| Viewer | n N | Next, previous match |
| Viewer | Esc | Clear search |
| Viewer | w | Toggle wrap |
| Viewer | h l, left right | Horizontal scroll when wrap is off |
| Filter / search mode | printable | Append to query, live apply |
| Filter / search mode | backspace | Delete character |
| Filter / search mode | up down | Move within results |
| Filter / search mode | Enter | Commit and return to normal |
| Filter / search mode | Esc | Clear query, return to normal |
| Help | j k, q, Esc, ? | Scroll, close |

Launch keys: `/navigator`, `ctrl+n`. Conflict audit against pi defaults: `ctrl+n` is unbound at app level (only scoped inside the session picker as toggle-named-filter); `ctrl+e` and `ctrl+g` are avoided. Re-verify on target terminals during QA.

---

## 5. Git panel composition

Rows, top to bottom within the left column section:

1. Header: `GIT` if focused accent bold else dim, plus branch on the right: `main` accent, dim `↑n ↓n` counters when nonzero.
2. Unstaged group: dim label row `Unstaged (n)` warning when n > 0, then up to 4 rows `relPath` with code colored (M warning, D error, ?? dim).
3. Staged group: same shape with success accent.
4. History group: dim label `History`, then commit rows `a1b2c3d  subject` dim with hash muted; date omitted in the row, kept in the model for later.
5. Empty states: `No git repository` or `git not found` single dim row when available is false; `Clean` dim row when both lists are empty; groups collapse to their label rows.

Cursor navigation walks every rendered git row in order; `Enter` acts only on changed-file rows.

---

## 6. Layout numbers

- Overlay: width 90 percent, minWidth 80, maxHeight 85 percent, anchor center, margin 1.
- Left column: `floor(innerWidth * 0.30)` clamped to 24..44; hidden when innerWidth < 72 (viewer takes full width, footer shows `t` hint).
- Body height: terminal rows minus chrome: top border (1), title (1), separator (1), footer (1), bottom border (1), margin allowance; minimum body 8 rows; below that the overlay renders the compact notice `terminal too small`.
- Files section: `max(6, floor(body * 0.55))` rows minus its header; git section: remainder, minimum 4 rows.
- Viewer header: file relative path accent, dim right-aligned `size` and `nL`; search bar replaces it while searching.
- Gutter: `digits(lineCount) + 1` columns, dim, right-aligned, `│` separator dim.
- Footer hints: `j k move  Enter open  Tab pane  / filter  ? help  q close`, substitutions per focus (viewer: `n N match  w wrap  h l scroll`; git: `Enter open`).

---

## 7. Tree and git behaviors

- Source selection is computed once per refresh: `detectRepo` success -> git listing; failure -> fs walk. A dim state line in the GIT section explains which mode is active.
- `.gitignore` parsing is not implemented in v1; the fs fallback uses the static ignore list. Documented as a v2 candidate.
- Hidden entries: dot-prefixed names skipped unless `showHidden`; the toggle does not re-scan the disk, it refilters the existing tree because fs walk always collects dot entries except ignored ones (cost is bounded by depth cap).
- Refresh: interval only while the overlay is open; each tick refreshes git state, and refreshes the tree only when a change is detected by a cheap probe (git mode: porcelain output string comparison; fs mode: directory mtime comparison of expanded directories only).
- File viewer reload: on open and on `r`; if the open file changed on disk (mtime), a dim `file changed on disk - press r` notice row appears above the content.

---

## 8. Image handling tiers (verification spike)

Default tier is the metadata card: name, relative path, size, mtime, and dimensions when cheaply derivable.

Spike tasks, in order:

1. Native protocols: pi-tui exports `Image`, `detectCapabilities`, `renderImage`, plus Kitty and iTerm2 encoders ([`tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:273), [`index.ts`](../references/pi-main/packages/tui/src/index.ts:92)). Verify whether a pi-tui Image component renders correctly inside an overlay region (escape pass-through, line width accounting, redraw stability). Record with and without `PI_HARDWARE_CURSOR`.
2. chafa fallback: when native protocols are unsupported and `chafa` exists on PATH (hasCommand check, same utility pattern as files-widget), render `chafa --format symbols --size <cols>x<rows> --colors 256 <file>` and inject the output lines into the viewer pane, clipped to width.
3. If both fail: metadata card stands.
4. Document findings in README and adjust the tier ladder, keeping metadata as the guaranteed baseline.

---

## 9. Degradation matrix

| Condition | Behavior |
|---|---|
| git binary missing | Git panel shows dim `git not found`; tree via fs walk |
| not a repository | dim `No git repository`; tree via fs walk |
| empty repository | Git panel renders groups with zero counts; tree from fs walk fallback order (git listing returns nothing) |
| file unreadable | viewer error card with path and reason |
| binary file | metadata card with size and mtime |
| file over caps | truncated view with notice row and total line count when cheap |
| symlink cycle | node rendered as a leaf with dim `↗ link` marker, no recursion |
| terminal under 80 columns | `terminal too small` compact notice, no panic |
| terminal 80 to 110 columns | left column hidden per inner width rule, `t` hint shown |
| no UI (print or JSON mode) | command notifies `pi-navigator requires the TUI` and returns |

---

## 10. Mockup specification

File: `mockups/navigator.html` (throwaway).

- Terminal-accurate: dark background mapped 1:1 to pi dark theme tokens (accent, border, muted, dim, success, warning, error, selectedBg, searchMatchBg/Text), monospace, box-drawing frame, exact layout math from Section 6 at a simulated 120x36 terminal.
- Fake repository fixture: nested directories, modified, staged, untracked files, a dirty branch with ahead counters, git history rows, one long source file with line numbers and colored tokens.
- Keyboard demo in plain JavaScript over the same keymap: j/k, g/G, Tab, Enter (opens file, toggles directories), /, n/N, w, t, ?, Esc, q, y (copies path to a toast), '.' hidden toggle. Footer reflects focus and mode exactly like the real spec.
- No external assets, no frameworks; single file.

---

## 11. Deferred tooling — DONE (Linux, Node 26, pi 0.85.1)

Enabled in the executed QA pass; see README "Tooling" and the evidence table in
[`qa-evidence.md`](qa-evidence.md). Two notes vs. the original wording:

- `moduleResolution` is `"bundler"` instead of `"NodeNext"`: pi loads extensions
  through jiti, which resolves the code's intentionally extensionless imports.
  NodeNext would demand `.js` extensions the runtime does not need.
- The two pi packages are devDependencies pinned to the running pi version so
  the suites exercise the real wrap/width/highlight implementations (`copyToClipboard`
  is the only stub).

Test suites (99 cases, green): porcelain `-z` parsing + real-git scratch-repo
integration, tree/fs-walk fixtures (ignores, dot entries, symlink cycles), viewer
caps and UTF-8 head decoding, keymap reducers, render width-safety at 120x36 /
100x28 / 80x24 incl. help/filter/search and the compact notice.

Scripts: `"typecheck": "tsc --noEmit"`, `"test": "vitest run"`.

---

## 12. Implementation order

1. Skeleton: package.json, constants.ts, types.ts, theme.ts.
2. Data layer: git.ts and tree.ts with pure parsing isolated for later tests.
3. Viewer: viewer.ts pipeline and reflow.
4. Overlay: navigator.ts frame, panels, footer, help modal.
5. Input routing and degraded states.
6. index.ts command and shortcut wiring.
7. Mockup HTML.
8. README with keymap, degradation, deferred tooling.
9. Image spike and findings.
10. Manual QA pass on this machine in no-git mode plus a git-enabled environment when available.

---

## 13. QA checklist (evidence required)

Evidence log: [`qa-evidence.md`](qa-evidence.md). Boxes ticked by the executed
pass (Linux, Node 26, real git + vitest suites) are marked done; the rest need
a live interactive session.

- [x] Overlay renders width-safe at 120x36 and 100x28 (and 80x24/60), no width overflow — `test/render.test.ts` on every frame/modal/bar line.
- [x] Focus cycling reorders styling and footer hints — navigator suite (Tab/shift+tab, pane label assertion).
- [x] Tree: expand, collapse, open, filter, hidden toggle, symlink cycle files render as leaves — navigator + tree suites (fixtures uncovered and fixed a root-symlink cycle hole).
- [x] Git panel with git present: staged versus unstaged correctness on a scratch repo; ahead and behind counters; history list matches `git log -n 20 --oneline` — real-git integration suite.
- [x] Git absent: fs walk mode with the static ignore list; panel states — integration + tree suites.
- [x] Viewer: line numbers align after 9999 lines; wrap toggle reflows; horizontal scroll clamps; search navigates n/N and clears on Esc — viewer/render suites.
- [x] Caps: 1.1 MB file shows truncated notice; binary shows metadata card; png shows metadata card (protocol render still pending the section 8 spike) — viewer suite.
- [x] Escape precedence: filter, then search, then close — navigator suite.
- [ ] No timers leak after close (interval cleared, no further renders in the log) — needs a live session render-log watch.
- [ ] Theme change mid-session triggers invalidate and re-render with new colors — needs a live session.
- [ ] Live drive at 80x24 and 20 rows incl. the compact notice on a real terminal, IME input, and `ctrl+n` on Windows Terminal / VS Code terminal — needs those environments.

---

## 14. Open verification items

1. pi-tui Image rendering inside an overlay region.
2. chafa output quality and latency at typical pane sizes.
3. `ctrl+n` delivery on Windows Terminal and VS Code terminal.
4. Performance on very large repositories (10k plus files) for the fs walk fallback and flattening.
