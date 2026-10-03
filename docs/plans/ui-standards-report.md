# pi-navigator — UI Standards Report

Status: draft for review.
Scope: findings from the four reference snapshots, the normative UI standards pi-navigator should follow, and the open questions to resolve before design freeze.

---

## 1. What each reference contributes

| Reference | Role | Key takeaways |
|---|---|---|
| [`pi-main`](../references/pi-main) | Ground truth for the pi.dev platform | pi-tui component library, extension API, overlay system, theme tokens, syntax highlighting utilities, packaging conventions |
| [`pi-skill-gate-main`](../references/pi-skill-gate-main) | Overlay UX baseline | Centered bordered overlay, sidebar plus detail columns, modal composition, search mode behavior, footer key hints |
| [`files-widget`](../references/files-widget) | Functional baseline | File tree from git, git status parsing, viewer with line numbers and search, polling refresh, graceful degradation when tools are missing |
| [`plannotator-tui-main`](../references/plannotator-tui-main) | Visual and keyboard language reference | Split pane layout, focus-driven styling, responsive tree, grouped keybindings, status line conventions |

---

## 2. Platform standards from pi-main

### 2.1 Extension shape

- A pi extension is a TypeScript module whose default export is a factory receiving `ExtensionAPI` ([`docs/extensions.md`](../references/pi-main/packages/coding-agent/docs/extensions.md:154)).
- Loaded via jiti, so TypeScript runs without a build step ([`docs/extensions.md`](../references/pi-main/packages/coding-agent/docs/extensions.md:179)).
- Discovered from `~/.pi/agent/extensions/*.ts` or `.../<dir>/index.ts`, and `.pi/extensions/*` for project-local ([`docs/extensions.md`](../references/pi-main/packages/coding-agent/docs/extensions.md:115)).
- No background resources (processes, watchers, timers) from the factory; start them in `session_start` and clean up in `session_shutdown` ([`docs/extensions.md`](../references/pi-main/packages/coding-agent/docs/extensions.md:220)).

### 2.2 UI surfaces

| Surface | Use |
|---|---|
| `ctx.ui.custom(component, { overlay: true, overlayOptions })` | Full interactive component on top of the transcript. This is what pi-navigator uses |
| `ctx.ui.custom(component)` without overlay | Temporarily replaces the editor. files-widget used this for its full-screen viewer |
| `ctx.ui.setWidget(id, lines, { placement })` | Persistent panel above or below the editor. files-widget used this for its tree |
| `ctx.ui.notify`, `setStatus`, `confirm`, `select`, `input`, `editor` | Small interactions. `ctx.hasUI` must guard dialog methods |

Sources: [`docs/extensions.md`](../references/pi-main/packages/coding-agent/docs/extensions.md:2623) for widgets, [`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:124) for overlays.

### 2.3 Component contract

All custom components implement ([`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:14)):

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate(): void;
}
```

Hard rules:

- Every rendered line must not exceed `width`. Use `visibleWidth` and `truncateToWidth` on every composed line ([`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:328)).
- Styles do not carry across lines. Reapply styling per line ([`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:31)).
- Cache rendered lines keyed by width; `invalidate()` clears the cache ([`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:383)).
- Components that contain a text cursor and need IME support implement `Focusable` and emit `CURSOR_MARKER` ([`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:33)).

### 2.4 Overlay standard

`ctx.ui.custom` supports `overlay: true` with `overlayOptions` ([`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:135)):

- Size: `width` number or percent, `minWidth`, `maxHeight`.
- Position: `anchor` (9 positions, default `center`), `offsetX/Y`, or `row`/`col`.
- `margin` number or per-side object, `visible(termWidth, termHeight)` for responsive hiding.
- `onHandle` exposes `focus()`, `unfocus()`, `setHidden()`.
- Overlay instances are disposed on close. Never keep a stale reference; re-call `ctx.ui.custom` to show again ([`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:181)).

The concrete values skill-gate uses ([`index.ts`](../references/pi-skill-gate-main/index.ts:463)):

```ts
{ overlay: true, overlayOptions: { width: "80%", minWidth: 45, maxHeight: "80%", anchor: "center", margin: 2 } }
```

### 2.5 Keyboard standards

- Detect keys with `matchesKey(data, Key.up)` and the `Key` helpers; never parse raw escape sequences ([`docs/tui.md`](../references/pi-main/packages/coding-agent/docs/tui.md:288)).
- Printable-character capture for filter and search input uses `decodeKittyPrintable(data)` plus a `>= " "` guard ([`overlay.ts`](../references/pi-skill-gate-main/overlay.ts:262)).
- `ctx.ui.custom` components receive an injected `keybindings: KeybindingsManager` and must use it instead of the global manager ([`docs/extensions.md`](../references/pi-main/packages/coding-agent/docs/extensions.md:2351)) — **for host-owned action ids**, so a user remap takes effect. `tui.select.cancel` (default keys Esc and Ctrl+C) is the funnel in `NavigatorOverlay.matchesCancel`, consulted at each level of the Esc stack; the manager is threaded in from `ctx.ui.custom` in `index.ts`.
- Global pi actions live in `keybindings.json` with namespaced ids; extensions register global hotkeys with `pi.registerShortcut("ctrl+x", { description, handler })` ([`docs/extensions.md`](../references/pi-main/packages/coding-agent/docs/extensions.md:1643)).
- The rule "never hardcode key checks" applies to pi core. Overlay-local keys (j/k, /, ?) are hardcoded in extensions by convention, as skill-gate does — the narrowed policy above is where that stops: no-manager fallbacks are for harnesses, never a shipping substitute ([#126](../issues/126-keybindings-manager-ignored.md)).

### 2.6 Theme and color standards

- Components receive `theme` with `fg(token, text)`, `bg(token, text)`, `bold()`. Extension theme wrappers follow the pattern in [`types.ts`](../references/pi-skill-gate-main/types.ts:43) and [`index.ts`](../references/pi-skill-gate-main/index.ts:251).
- Core UI tokens: `accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `selectedBg`, `scrollbarTrack`, `scrollbarThumb` ([`docs/themes.md`](../references/pi-main/packages/coding-agent/docs/themes.md:172)).
- Markdown tokens: `mdHeading`, `mdCode`, `mdCodeBlock`, `mdQuote`, `mdListBullet`, etc. ([`docs/themes.md`](../references/pi-main/packages/coding-agent/docs/themes.md:208)).
- Diff tokens: `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext` ([`docs/themes.md`](../references/pi-main/packages/coding-agent/docs/themes.md:223)).
- Syntax tokens: `syntaxComment`, `syntaxKeyword`, `syntaxFunction`, `syntaxVariable`, `syntaxString`, `syntaxNumber`, `syntaxType`, `syntaxOperator`, `syntaxPunctuation` ([`docs/themes.md`](../references/pi-main/packages/coding-agent/docs/themes.md:231)).
- Search highlight tokens: `searchMatchBg`, `searchMatchText` ([`docs/themes.md`](../references/pi-main/packages/coding-agent/docs/themes.md:190)).

### 2.7 Syntax highlighting is already solved

`@earendil-works/pi-coding-agent` exports `highlightCode(code, lang)`, `getLanguageFromPath(path)`, and `getMarkdownTheme()` ([`src/index.ts`](../references/pi-main/packages/coding-agent/src/index.ts:409)). `highlightCode` is cli-highlight based, theme-aware, and is what pi's own `read` and `write` tool renderers use to display file contents ([`read.ts`](../references/pi-main/packages/coding-agent/src/core/tools/renderers/read.ts:126)). The Markdown component also accepts a `highlightCode` hook through `MarkdownTheme` ([`markdown.ts`](../references/pi-main/packages/tui/src/components/markdown.ts:214)).

Conclusion: pi-navigator does not need `bat`, `shiki`, or any npm dependency for highlighting. This removes files-widget's biggest portability problem.

### 2.8 Reusable components

Exported from `@earendil-works/pi-tui` ([`src/index.ts`](../references/pi-main/packages/tui/src/index.ts:13)): `Box`, `Text`, `Container`, `VStack`, `HStack`, `Spacer`, `ScrollView`, `SelectList`, `SettingsList`, `Markdown`, `TruncatedText`, `Input`, `Editor`, `Image`, `MouseRegion`, `CancellableLoader`, `Loader`.

Utilities: `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `fuzzyMatch`, `fuzzyFilter`, `matchesKey`, `Key`, `decodeKittyPrintable`, `getNativeClipboard`.

Note: skill-gate does not use these containers for its overlay; it composes raw ANSI line arrays manually. That is the established pattern for bordered overlays with precise column control, and it is what pi-navigator should follow for the frame and gutter math.

### 2.9 Packaging standards

From [`package.json`](../references/pi-skill-gate-main/package.json:38): `"pi": { "extensions": ["./index.ts"] }`, `peerDependencies` on `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` with `*`, keywords including `pi-package` and `pi-extension`, `files` listing the shipped sources. No build step. Runtime deps must be real `dependencies` for package installs.

---

## 3. Reference project standards

### 3.1 pi-skill-gate — the overlay composition standard

This is the baseline UX for pi-navigator. Extracted patterns:

Frame ([`overlay.ts`](../references/pi-skill-gate-main/overlay.ts:761)):

- Outer box drawn manually: `┌` + `─` repeated innerW + `┐`, body lines as `│` + content padded to innerW + `│`, closing `└─┘`. Border characters styled `dim` in the reference; pi-navigator draws its frame with the host's `borderMuted` role instead (Issue #135 L6). The E-style chrome (Issue [#137](../issues/137-e-style-chrome-migration.md)) rounds every bordered surface's corners (`╭ ╮ ╰ ╯`; strokes and tees unchanged) and moves the product name into a top-border pill: `╭── pi-navigator ──…╮`.
- Title row: accent bold product name, dim project label, dim counts summary in the reference; pi-navigator's row is a subtitle carrying the path and the git branch/counters only — the product name lives in the pill (Issue [#137](../issues/137-e-style-chrome-migration.md) §2).
- Horizontal separator rows built with `│` + `─`.repeat(innerW) + `│`.
- Column split: `detailW = innerW - sidebarW - 1`, vertical divider owned by the sidebar rows.
- Sidebar width: natural width from longest row plus a 4 column offset, capped at `max(14, 30% of terminal width)` ([`overlay.ts`](../references/pi-skill-gate-main/overlay.ts:471)).
- Selected row: `▶` accent arrow plus padded name; auto-scroll keeps selection centered (`selPos - floor(area/2)`) ([`overlay.ts`](../references/pi-skill-gate-main/overlay.ts:496)).
- Viewport scroll fraction 0.75 of page height for `j`/`k` jump scrolling ([`overlay.ts`](../references/pi-skill-gate-main/overlay.ts:23)).
- Modals (help on `?`, confirmations) are composed on top of the already rendered lines, centered horizontally and vertically, with the underlying lines excluded ([`overlay.ts`](../references/pi-skill-gate-main/overlay.ts:809)].

Interaction model:

- Escape precedence: clear active filter first, then close ([`overlay.ts`](../references/pi-skill-gate-main/overlay.ts:323)).
- Search mode is modal: printable characters append to the query, Enter commits the filter but keeps it, Escape clears it ([`overlay.ts`](../references/pi-skill-gate-main/overlay.ts:217)).
- Footer shows contextual key hints; help is a full modal listing all keys. pi-navigator renders the hints as typed key/label pairs — `dim(keys) + muted(" label")` joined by a dim ` · `, the pi-main `keyHint()` shape — advertising both `q` and the cancel key on the close pair (`q Esc close`), with pairs dropped whole when the width runs short (Issues [#137](../issues/137-e-style-chrome-migration.md) §1/§5, [#135](../issues/135-ui-audit-polish-batch.md) L4).
- State lives in a plain class with `invalidate()` and `render(width)`; the extension wires `handleInput` to call the class method and then `tui.requestRender()` ([`index.ts`](../references/pi-skill-gate-main/index.ts:455)).

### 3.2 files-widget — functional baseline and UX deficits

What to keep:

- Tree source: `git ls-files -z` plus `git status --porcelain -uall -z`, with cwd to repo-root prefix translation via `git rev-parse --show-prefix` ([`git.ts`](../references/files-widget/git.ts:20)). Handles renames and copies in porcelain output ([`git.ts`](../references/files-widget/git.ts:66)).
- Ignored-name fallback list (`node_modules`, `.git`, caches, `dist`, `venv`, ...) ([`file-tree.ts`](../references/files-widget/file-tree.ts:240)).
- Tree building from path list with directory map, symlink resolution, cycle guard via ancestor realpath compare, sorting dirs first, depth cap 6 ([`file-tree.ts`](../references/files-widget/file-tree.ts:111), [`constants.ts`](../references/files-widget/constants.ts:1)).
- Per-file git codes, per-node aggregated additions and deletions, line counts, agent-modified marker via `pi.on("tool_result")` ([`index.ts`](../references/files-widget/index.ts:110)).
- Safety mode: refuse deep auto-expansion when the root is home or filesystem root ([`browser.ts`](../references/files-widget/browser.ts:161)).

UX deficits that pi-navigator must fix:

1. External binary dependencies (`bat`, `delta`, `glow`, `fd`) block the whole extension when missing, even on Windows where they are rarely installed ([`index.ts`](../references/files-widget/index.ts:41)).
2. Story is split across a widget (tree) and a full-screen viewer, so reading a file removes the agent context and the tree at once.
3. No git history, no branch display, no staged versus unstaged split.
4. No help overlay, no persistent filter, no fuzzy matching ([`TODO.md`](../references/files-widget/TODO.md:28)).
5. Polling redraws every 3 s ([`constants.ts`](../references/files-widget/constants.ts:2)); viewer reloads synchronously on each render pass, and file reads are synchronous (`readFileSync` in [`viewer.ts`](../references/files-widget/viewer.ts:158)).
6. Comment workflow (selection, comment dialog, steering message) expands scope and input modes beyond reading.

### 3.3 plannotator-tui — visual and keyboard language

- Frame split: `header / body / footer`, body split into `tree / gutter / doc / rail` with `Layout::vertical` and `Layout::horizontal` constraints ([`draw.rs`](../references/plannotator-tui-main/crates/plannotator-tui/src/app/draw.rs:51)).
- Responsive rules: tree width fixed 28, hidden below 120 columns total unless toggled; rail dropped below 80 columns ([`draw.rs`](../references/plannotator-tui-main/crates/plannotator-tui/src/app/draw.rs:16)).
- Focus is shown through border color: cyan border when focused, dark gray otherwise ([`draw.rs`](../references/plannotator-tui-main/crates/plannotator-tui/src/app/draw.rs:106)).
- Tree rows: directories dim with a disclosure triangle, the currently open file bold cyan, cursor row highlighted with a background block ([`draw.rs`](../references/plannotator-tui-main/crates/plannotator-tui/src/app/draw.rs:114)).
- Key language: `Tab` cycles panes, `j`/`k` move, `Enter` opens, single letter actions per pane, footer lists only the currently relevant keys ([`README.md`](../references/plannotator-tui-main/README.md:75)).

Adopted: focus-driven styling, pane cycling with Tab, disclosure markers, footer that changes with focus, responsive hiding of the left column on narrow terminals.

Rejected: emoji inside rows, annotation rail complexity, modal compose boxes.

---

## 4. Normative proposal for pi-navigator

### 4.1 Frame and regions

```
╭── pi-navigator ──────────────────────────────────────────────────────╮
│ ~/project   branch: main +2 -0   M:4  S:2  U:3                       │
│─────────────────┬────────────────────────────────────────────────────│
│ FILES           │ src/index.ts  2.1 KB · 120L · showing 1–24 of 120  │
│ ▼ src           │   1 │ import { foo } from "./bar";                 │
│   index.ts  M   │   2 │                                             │
│   util.ts   ??  │   3 │ export function main() {                     │
│─────────────────│                                                     │
│ GIT             │                                                     │
│ Unstaged  M 3   │                                                     │
│  index.ts       │                                                     │
│ Staged    A 1   │                                                     │
│ History         │                                                     │
│  a1b2c3d  msg   │                                                     │
│─────────────────┴────────────────────────────────────────────────────│
│ j k move · Enter open · Tab pane · / filter · ? help · q Esc close   │
╰──────────────────────────────────────────────────────────────────────╯
```

- Overlay: `width: "90%"`, `minWidth: 80`, `maxHeight: "85%"`, `anchor: "center"`, `margin: 1`.
- Left column: 30 percent of inner width, clamped to 24 to 44 columns; contains FILES (flex) and GIT (fixed share of the column, minimum 6 rows); hidden entirely when the terminal is narrower than the responsive threshold, mirroring plannotator.
- Right pane: opened file, line-number gutter right-aligned and dim, `│` separator, code with pi-highlighted lines. Gutter stays fixed during horizontal scroll; tabs expanded to spaces before highlighting, matching pi's own `read` renderer. The header's meta block (size · line count · mode flags) ends with a `showing X–Y of Z` position readout whenever the content overflows the pane (Issue [#137](../issues/137-e-style-chrome-migration.md) §3).
- Viewer scrollbar: the frame's right border column doubles as the scrollbar over the viewer's content rows only — track `│` in the `scrollbarTrack` role, proportional thumb `█` in `scrollbarThumb`, sized `thumbH = max(1, round(count²/total))` and positioned `thumbStart = round(scroll / max(1, total − count) · (count − thumbH))`. Display-only: no timers, no fade, no mouse handling; hidden while the help modal is open (Issue [#137](../issues/137-e-style-chrome-migration.md) §4).
- Title bar (top border + subtitle row): rounded corners with the product name in an accent-bold pill, `╭── pi-navigator ──…╮`; the row below is the subtitle — cwd dim, branch accent, ahead/behind counters (success/warning), changed counter (dim) (Issue [#137](../issues/137-e-style-chrome-migration.md) §2).
- Footer: focus-dependent key hints, same pattern as skill-gate and plannotator — typed key/label pairs rendered `dim(keys) + muted(" label")` and joined by a dim ` · `, the close pair advertising the cancel key (`q Esc close`), pairs dropped whole to fit the width (Issue [#137](../issues/137-e-style-chrome-migration.md) §1/§5).

### 4.2 Focus and keyboard model

Focus cycles with `Tab` and `Shift+Tab` across three regions: FILES, GIT, VIEWER. The focused region gets accent styling on its title and border segment.

| Scope | Key | Action |
|---|---|---|
| Global | `Tab` / `Shift+Tab` | Cycle focus |
| Global | `?` | Help modal |
| Global | `q` | Close overlay |
| Global | `Esc` | Close active filter or search, otherwise close overlay |
| Global | `r` | Refresh tree and git state |
| Global | `t` | Toggle left column |
| FILES | `j` `k` or arrows | Move selection |
| FILES | `Ctrl+d` `Ctrl+u` | Half-page jump |
| FILES | `g` `G` | Top and bottom |
| FILES | `Enter` | Open file, or toggle directory |
| FILES | `l` `h` or left right | Expand and collapse directories |
| FILES | `/` | Incremental filter |
| GIT | `j` `k` | Move through unstaged, staged, and history entries |
| GIT | `Enter` | On a changed file: reveal and open it. On a commit: show commit detail |
| VIEWER | `j` `k`, `Ctrl+d` `Ctrl+u`, `g` `G` | Scroll |
| VIEWER | `/` and `n` `N` | Search file, jump matches |
| VIEWER | `w` | Toggle word wrap |
| VIEWER | `h` `l` | Horizontal scroll when wrap is off |

Launch: `/navigator` command plus an optional registered shortcut. Command is mandatory; shortcut choice is an open question below.

### 4.3 Git panel content

- Branch name or detached HEAD, ahead and behind counts from `git rev-list --left-right --count`.
- Unstaged list from `git status --porcelain` where the worktree status differs, staged list where the index differs.
- History: recent commits, format and depth to be fixed by the open questions.
- All git access via `execFile` with timeouts, async, cached; refresh on open, on `r`, and on a low-frequency interval only while the overlay is open. No synchronous exec on the render path.
- When `git` is missing or the cwd is not a repository: panel renders a dim one-line explanation, the tree falls back to a filesystem walk with the ignore list, and nothing else breaks. This state is the current machine's reality and must be first-class.

### 4.4 Robustness rules

- File size and line caps before highlighting; oversized files render with a truncated marker and a notice. Suggested caps: 1 MB or 5000 lines for full highlighting, 256 KB for line counting, matching files-widget's counting cap.
- Binary detection by NUL byte in the first chunk; binary and image files show a metadata summary instead of content.
- Symlink cycles guarded by realpath ancestor checks.
- Never block the event loop: async fs and execFile only. Render from cached state.
- Read-only guarantee: the extension performs no writes except its own optional state file, never mutates the workspace.

### 4.5 Compliance checklist for implementation review

- [ ] Overlay opened through `ctx.ui.custom` with `overlay: true` and documented options.
- [ ] Every render line width-safe via `visibleWidth` and `truncateToWidth`.
- [ ] Per-line style reset respected; no cross-line style assumptions.
- [ ] All colors from theme tokens; no hardcoded ANSI colors.
- [ ] Highlighting via `highlightCode` and `getLanguageFromPath`; no external binaries.
- [ ] Keys via `matchesKey` and `Key`, printable capture via `decodeKittyPrintable`.
- [ ] Zoomed-out design works at 80 columns; degrades by hiding the left column.
- [ ] Missing git, missing file, unreadable file, and binary file each have a defined rendering.
- [ ] No background resources started before `session_start`.
- [ ] `invalidate()` honored on theme change.

---

## 5. Environment constraints

- This machine currently has no `git`, `npm`, or `node`; it has Python and PowerShell. That is temporary.
- Consequences: the extension must be zero-dependency and rely only on pi's bundled runtime, `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` imports, and Node built-ins. No build step, no package install to run it.
- The no-git state doubles as the required graceful-degradation test case.
- Automated tests (vitest) cannot run until Node is available. Pure-logic modules should still be structured to be testable, and a manual QA checklist drives verification meanwhile.

---

## 6. Open questions

1. Git history depth and interactivity: static list of N commits, or selectable commits with a detail view, or commit browsing with stats.
2. Mockup fidelity: terminal-accurate HTML rendering versus a polished web interpretation, and whether it includes live keyboard navigation.
3. Launch naming: command name and whether a global shortcut is registered, and if so which key avoids pi's existing bindings.
4. Version 1 scope edges: agent-modified badges, diff toggle in the viewer, copying content, session persistence, hidden-file toggle.
5. Tree source policy: git-based listing only, filesystem walk only, or hybrid with a defined ordering.
6. Hidden and ignored files: which to show by default, which toggle.
7. Large file and binary handling: accept the proposed caps and metadata-only fallback.
8. Viewer defaults: line numbers always on, wrap off with horizontal scroll, tabs expanded.
9. Search semantics in the viewer: smart-case, incremental, match highlighting via theme search tokens.
10. Packaging: single directory extension with `index.ts` and helpers like files-widget, or a package with `src/` layout and vitest config like skill-gate.
