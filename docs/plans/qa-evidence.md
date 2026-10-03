# pi-navigator — QA evidence log

Companion to section 13 of [`pi-navigator-implementation-plan.md`](pi-navigator-implementation-plan.md).

Two passes are logged below: the **executed** pass (Linux, Node 26, real git —
this machine) and the original **static** pass (Windows 11, no Node).

## Executed pass (Linux, CachyOS, Node v26.7.0, npm 12, git 2.55, pi 0.85.1)

Tooling from plan section 11 is now enabled (`tsconfig.json`, `vitest`, the two pi
packages pinned to 0.85.1 as devDependencies). The suites and their evidence:

| Section 13 item | Status | Evidence |
|---|---|---|
| Overlay opens centered at 120x36 / 100x28 / 80x24, no width overflow | **Executed** | `test/render.test.ts` renders every line at 120x36, 100x28, 80x24 and 60 wide and asserts `visibleWidth(line) <= width` for the frame, help modal, filter/search bars, cards and the compact notice. Caught a real footer bug: the pane labels were truncated off at ≤120 columns because hint + labels exceeded the inner width; `joinLeftRight` now guarantees the right side and ellipsizes the hint. |
| Focus cycling reorders styling and footer hints | **Executed** | `test/navigator.test.ts` (focus cycling) drives Tab/shift+tab and asserts the focused pane label renders. |
| Tree: expand, collapse, open, filter, hidden toggle, symlink leaf | **Executed** | `test/navigator.test.ts` (files pane keys) plus `test/tree.test.ts` fixtures. The symlink fixture exposed a real cycle-guard hole: the walk's visited-set never seeded the workspace root, so a link pointing at the root re-walked the whole tree; `collectFsEntries` now seeds it. |
| Git panel correctness, ahead/behind, history | **Executed** | `test/git.test.ts` runs a real scratch repo (`git init -b main`): staged/unstaged split against actual porcelain `-z` output, `git mv` rename record consumption, paths with spaces and embedded newlines, subdirectory prefix translation, history subjects/dates. |
| Git absent: fs walk mode, panel states | **Executed** | `test/git.test.ts` (no-repo degradation) + `test/tree.test.ts` (ignore list, dot entries, broken links). |
| Viewer: gutters align, wrap reflows, h-scroll clamps, search navigates | **Executed** | `test/viewer.test.ts`: real `wrapTextWithAnsi` chunk rows, `sliceStyled` h-scroll clipping, smart-case `searchLines`/`markMatches`, `decodeUtf8Head` on cut 2/3/4-byte sequences; `test/render.test.ts` with wrap on and off. |
| Caps: 1.1 MB truncated, binary card, png card | **Executed** | `test/viewer.test.ts`: 5000-line cap, 1.5 MB byte cap (whole file never read, lineCount undefined), NUL-byte binary card, PNG dimension card. |
| Escape precedence: filter, then search, then close | **Executed** | `test/navigator.test.ts` covers clear-filter, clear-search, close, and notes that `q` is a printable while filtering. |
| No timers leak after close | Source reading | `cleanup()`/`dispose` unchanged; interval only exists while the overlay is open (verified statically as before). A live drive is still the only way to watch the render log settle. |
| Theme change mid-session triggers invalidate and re-render | Source reading | unchanged; still requires a live session. |

Everything in this pass ran with the **real** pi-tui/pi-coding-agent packages
(only `copyToClipboard` is stubbed, per test). `npm run typecheck` and
`npm test` (99 cases) are green on this machine.

Still open (need a live interactive session):

- IME input in the search bar with a CJK input method.
- `ctrl+n` delivery on Windows Terminal / VS Code terminal. On Linux it works,
  with the caveat below.

### Live drive (Linux, tmux 3.7 at 120x36, nested pi 0.85.1)

Drove `/navigator` in a real session against this repository itself:

- Overlay opened centered with a correct frame; title showed the branch
  (`main`), FILES 1/25, tree of the repo (dirs first, expanded top level),
  GIT panel with `Clean` row and the real 6-commit history.
- `j` moved the cursor (4/25 tracked in the header); Enter opened
  `plans/pi-navigator-implementation-plan.md` with `21.7 KB · 368L` in the
  viewer header, gutter line numbers and markdown content.
- Search bar echoed `/Status…` with the live match counter (typing `n` while
  still in search mode correctly appends to the query; n/N cycle after
  commit — both covered by suites).
- The 3 s refresh picked up an on-disk change mid-session: the title changed
  to `main 1 changed` after an edit to `navigator.ts`.
- `q` closed the overlay; `Ctrl+N` reopened it.
- Finding: pi 0.85.1 registers `ctrl+n` itself (`app.session.toggleNamedFilter`),
  so startup prints an `[Extension issues]` conflict banner and binds the
  extension's handler anyway. Works, but the banner is noisy; recorded in the
  README behavior notes. The plan's section 4 conflict audit said `ctrl+n` was
  unbound — that was true for the pi version the plan was written against.

### Chafa image tier live drive (v0.6.0 — Linux, tmux 120x36 ⇄ 80x24, nested pi 0.85.1)

Environment: chafa 1.18.2 on PATH, pi-chafa registered as a local package
(`../../Sources/pi-chafa`), throwaway PNGs at the repo root (removed after the
run). Spec: [`docs/specs/chafa-image-rendering.md`](../specs/chafa-image-rendering.md).

- **Default off**: `/navigator` → open a PNG → metadata card (`75 B · 8x8`) plus
  `optional: enable images.mode=chafa to render images here`; no chafa spawn.
- **Opt-in via `PI_NAV_IMAGES=1`**: the same file rendered as chafa symbol art
  with the `chafa · i card` header badge. A raw `capture-pane -e` of the frame
  contained only SGR escapes (no cursor/OSC/DCS), confirming the §8 sanitizer
  containment end to end.
- **`i`** toggled to the metadata card (badge `i render`) and back to the render
  (badge `chafa · i card`).
- **`/`** on a rendered image showed `search is not available for rendered
  images` and did not enter search mode.
- **Resize**: 80x24 → 120x36 re-rendered after the debounce at the new geometry
  (a 64x64 gradient grew from ~28x14 cells to ~44x23 cells, consistent with the
  pane-bounded 60x24 chafa box); every captured line was exactly the window
  width and the frame stayed valid throughout.

Automated companions in the same tree: `test/settings.test.ts` (42 cases),
`test/images.test.ts` (55), plus the extended viewer/navigator/render suites —
`npm run typecheck` and `npm test` (8 suites, 285 cases) green. A real-chafa
smoke pass (probe → render → sanitize) and a hostile `\x1b[2J` payload rejection
were exercised during implementation.

Not covered by this live pass (unit-tested only): a bogus `CHAFA_BIN` and
`terminal.showImages: false` in a live session; live `r` config-change pickup;
very large images at small pane sizes.

## Earlier static pass (Windows 11, no Node)

Environment for that pass: Windows 11, PowerShell. `node`, `npm` and `git` were **not on PATH**
(the constraint recorded in section 5 of the standards report), and the extension only runs inside
pi's bundled runtime. So nothing in that log was executed: every entry was a **static** verification —
source reading, arithmetic on the layout formulas, and the reference documentation cited inline.
Runtime and manual checks stayed open, and section 13's boxes stayed unchecked until someone ran them
in a terminal.

| Section 13 item | Static status | Evidence |
|---|---|---|
| Overlay opens centered at 120x36 and 100x28, no width overflow | Layout arithmetic | At 120x36: `overlayHeight = min(floor(36*0.85), 34) = 30`, `body = 25`, frame rows `3 + 25 + 2 = 30`, each line `width` columns wide. At 100x28: `min(floor(28*0.85), 26) = 23`, `body = 18`, `3 + 18 + 2 = 23`. Inner width at 120: 106 → left column 31, right 74; at 100: 88 → left 26, right 61. |
| Focus cycling reorders styling and hints | Source reading | [`handleNormalInput()`](../navigator.ts:361) cycles `files → git → viewer`; accent styling and footer hints both key off `this.focus`. |
| Tree: expand, collapse, open, filter, hidden toggle, symlink leaf | Source reading | [`handleFilesInput()`](../navigator.ts:425) covers Enter/l/h/filter; `.` is now Files-scoped; symlinks are refused recursion by the realpath visited-set in [`walk()`](../tree.ts:58). |
| Git panel correctness, ahead/behind, history | Source reading | [`readGitState()`](../git.ts:126) maps `rev-list --left-right --count @{u}...HEAD` left→behind, right→ahead; history is `log -n20` split on `%x1f`. Behaviour on a scratch repo still needs a machine with git. |
| Git absent: fs walk mode, panel states | Source reading | [`refreshData()`](../index.ts:110) probes with `collectFsProbe` and walks with `collectFsEntries` when `git.available` is false. |
| Viewer: gutters align, wrap reflows, h-scroll clamps, search navigates | Source reading + arithmetic | Gutter width is `digits(lineCount) + 1`; [`computeRows()`](../viewer.ts:310) reflows per width; h-scroll clamps to `maxLineWidth - contentW`. |
| Caps: 1.1 MB truncated, binary card, png card | Source reading + arithmetic | 1.1 MB > `MAX_HIGHLIGHT_BYTES` → capped head read of 1 MB, `kind: "truncated"`; NUL sniff over the first 4 KB; PNG/GIF dimension probe reads 64 bytes. |
| Escape precedence: filter, then search, then close | Source reading | [`navigator.ts:380`](../navigator.ts:380). |
| No timers leak after close | Source reading | `cleanup()` clears the interval and is reached from both the overlay's own `close()` and the component's `dispose()` hook, which the framework calls when it closes the overlay itself ([`interactive-mode.ts:2773`](../references/pi-main/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2773)). |
| Theme change triggers invalidate and re-render | Source reading | `invalidate()` clears the render cache; `theme` is captured per overlay factory call. |

Notes that only a terminal can settle:

- The **width** half of the "terminal too small" guard remains defensive: the overlay requests
  `minWidth: 80`, so the host may clamp the allocated width to 80 even on a narrower terminal. The
  **height** half is the reachable one and is the half that was fixed (it now fires below 8 body rows).
- `ctrl+n` delivery on Windows Terminal and VS Code terminal is an open item in section 14 and needs
  a real session.

## Review findings and their fixes

Standards axis:

1. Synchronous `statSync` on the async walk → [`walk()`](../tree.ts:76) now awaits `stat` from `node:fs/promises`.
2. Card title row one column wider than its own borders → title padding is `contentWidth - width(title) - 3` ([`buildCard()`](../navigator.ts:1100)); interior is now exactly `contentWidth`, matching `boxW = contentWidth + 2`.
3. Duplicated code → one `printableChar()` helper, one `walkTree()` traversal used by `collectExpanded`/`reapplyExpansion`/`findNode`/`applyGitCodes`, one `moveCursor()`/`pageJump()` pair, and the double expansion bookkeeping in `setData` is gone.
4. Feature Envy → `applyGitCodes` moved to [`tree.ts`](../tree.ts:232).
5. Inconsistent search case handling → [`markMatches()`](../viewer.ts:98) is smart-case like [`searchLines()`](../viewer.ts:288).
6. Two scroll-clamp formulas for help → `helpVisibleRows()`/`helpMaxScroll()` are the single source for both the input clamp and the renderer.
7. Refresh pile-up → `inFlight` guard; `detectRepo` runs once per tick and is passed into `readGitState`.
8. Lifecycle races → `closed` is checked before every post-await write and before every render request; failures notify once per distinct message.
9. Dead/contradictory geometry → `overlayHeight()` no longer floors at `MIN_OVERLAY_HEIGHT` (the height guard is reachable), and the no-op `overlayWidth()` is gone. `MIN_OVERLAY_HEIGHT` is 13 = 8 body rows + 5 chrome rows, matching plan section 6.
10. IME → the class implements `Focusable` and emits `CURSOR_MARKER` before the fake cursor while focused ([`buildInputBar()`](../navigator.ts:1029)).
11. Injected keybindings manager unused → resolved by decision, not code: overlay-local keys are hardcoded by the convention the standards report records in section 2.5, and the parameter now documents that.

Spec axis:

1. Capped read → `readCappedHead()` + `decodeUtf8Head()`; oversized files are never read in full.
2. Empty repository → falls back to the fs walk when the git listing is empty.
3. Cheap refresh probe → `gitTreeProbe()` / `collectFsProbe()`; `ls-files` and the walk only run when the probe changes.
4. Top-level collapse → `reapplyExpansion(root, expanded, defaultDepth)` defaults the top level only on the first build.
5. `-z` parsing → `parsePorcelain` consumes the trailing source record of a rename/copy; `ls-files -z` for the tracked list.
6. Truncated total line count → set when the whole file was read and it is under `MAX_LINE_COUNT_BYTES`.
7. Hidden entries dim → Files rows and directory rows.
8. `Clean` row and the dim `…` clip marker → both in [`gitRows()`](../navigator.ts:253) and [`buildLeftRows()`](../navigator.ts:789).
9. `moveCursor`/`pageJump` → extracted and used by the files and git cursors.
10. Gutter digits → from `lineCount` when known.
11. Interval leak → `dispose` hook on the returned component.
12. Compact notice height path → reachable after the geometry fix.
13. Filter query echo → the filter bar now draws `/query█` in the footer row area.
14. Setter names → `setTree` / `setGitState` per the section 3.6 contract.
15. This log.

Scope creep items: `.` moved to Files scope; the commit-row notice was kept because the README
already documents history rows as informational in v1; the stray `$null` PowerShell artifact was
deleted from the working tree.

## What is still required before the section 13 boxes can be ticked

Done in the executed pass above: tooling from plan section 11, the vitest
suites, and the typecheck. Still open, and only a live interactive session can
settle them:

1. Drive `/navigator` in a real session at 120x36, 100x28, 80x24 and a 20-row
   terminal, confirming no line exceeds the pane width and that the compact
   notice appears on the short one (geometry half is covered by
   `test/render.test.ts`; terminal delivery is not).
2. Verify IME input in the search bar with a CJK input method, and `ctrl+n` in
   Windows Terminal and the VS Code terminal.

## Native terminal images (#069) — live QA checklist (spec §14 step 7)

Automated evidence is green: `npm run typecheck` clean and the full `npm test` suite
green — including the native encoders (`runNativeRender` under
`setCapabilities`), the loader fallback logic, view-model byte-identity, and
width-safety with the kitty sequence at 120×36 / 100×28 / 80×24 / 60 / 50.
What follows needs a real terminal and a human eye; record results below.

Prerequisite: a kitty-capable terminal **outside tmux** (kitty, Ghostty,
WezTerm, Warp), `images.mode: "native"` in `~/.pi/agent/pi-navigator.json`
(or `PI_NAV_IMAGES=native`), and a PNG in the workspace. Do one run with
`PI_HARDWARE_CURSOR=1` and one with it off. Optionally repeat in
`tuiMode: "fullscreen"` (kitty only — pi-tui disables iTerm2 there).

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | Open a PNG (`Enter` in Files) | Real image inside the viewer pane; badge `kitty`; no border bleed; not offset by a row/column | |
| 2 | `i` to card, `i` back | Card replaces the image; the placement disappears; toggling back re-anchors at the same spot | |
| 3 | Switch to another file and back | No ghost pixels from the previous placement | |
| 4 | `q` closes the overlay | Terminal is clean; no leftover image | |
| 5 | `r` reload and the refresh poll | No flicker, no re-anchor; the sequence is not re-emitted while the file is unchanged | |
| 6 | Resize the terminal while the image is open | One debounced re-render at the new geometry; no stacking/ghosting; no reflow loop | |
| 7 | Scroll keys `j`/`k`/`g`/`G`/`Ctrl+d`/`Ctrl+u` | Inert on the native image | |
| 8 | JPEG/GIF/WebP under kitty, `mode: native` | Real image (transcoded to PNG); no PNG hint, no corrupt output | |
| 9 | Same files under `mode: auto` | Native as in 8; chafa only for formats the terminal cannot render | |
| 10 | Non-capable terminal + `mode: native` | Card with the unsupported-terminal hint; nothing emitted | |
| 11 | tmux (this machine's default): forced `terminal.images: "kitty"` + `mode: native` | Document actual behavior — expected: sequences forwarded only with tmux `allow-passthrough on` and a kitty-family outer terminal, otherwise a garbage-free no-op | |
| 12 | iTerm2 spot check (macOS, if available) | Same as 1–7 with the `iterm2` badge | |

If any check fails, file the failing behavior on #069 before closing; the spec's
§16.1 fallbacks (image-aware compositing / upstream pi-tui exception) are the
first candidates.

## E-style chrome (#137) — live drive (Linux, tmux 3.7c, pi 1.0.1, 0.14.0 path install)

Environment: extension registered as a path install at **0.14.0** (`pi install .`), revision
`c582b8b`; driven in a detached tmux pane at 120×36, 140×40, 80×24 and 40×13 with
`capture-pane` for evidence, then a second session with `pi --use-theme light`. Both sessions
were killed afterwards; no persisted state changed — `theme` in `~/.pi/agent/settings.json`
stayed `system`.

Verified live (dark theme, 120×36 unless noted):

- **Pill + subtitle**: `╭── pi-navigator ──…╮` in the top border with the accent-bold name; the
  row below is the path/git subtitle; junction tees stay sharp (`├ ┤`).
- **Hints**: pairs render `dim(keys) + muted(label)` joined by ` · `; `m mode` is absent while
  `navigator.ts` is open (non-markdown) — #135 L1 confirmed live.
- **Readout**: `74.3 KB · 1850L · showing 1–24 of 1850`, reflowing with the pane height
  (`1823–1836` at 80×24) and reaching `showing 1823–1850 of 1850` at the bottom.
- **Scrollbar**: thumb `█` in the frame's right border, one cell at
  `thumbH = max(1, round(24²/1850))`, moving to the last content row at the bottom; track rows
  read as `│`.
- **Search interaction**: entering `/` replaces the header with the search bar and the readout
  is gone by design — typing `/theme` in viewer focus searched the file (25 matches), i.e.
  overlay mode isolation holds even for strings that look like host commands.
- **Help modal**: rounded box composited inside the frame; `q Esc  close (…first)` row intact.
- **Filter placeholder** derives from the pair tables: `type to filter · up/down move ·
  Home/End first/last · Enter apply · Esc clear`.
- **80×24**: width-safe; pairs dropped whole (`/ search`, `? help`, `q Esc close` gone) — no
  mid-phrase truncation.
- **40×13**: rounded refusal notice (`terminal too small for pi-navigator`; the remedy text is
  cut by the 38-cell box — pre-existing).
- **`--use-theme light`** (separate session): identical chrome; SGRs are pi's light true-color
  values (e.g. accent `38;2;116;89;180`); the settings file was untouched.

Findings:

1. **Files-focus footer drops `q Esc close` at 120 columns** — design consequence, not a bug:
   the files pair table measures 97 plain cells after the pair/`·` conversion (76 as the old
   single string), so the ~84-cell budget at inner width 106 sheds the trailing pair. It returns
   at ≥121 columns and is unaffected in git/viewer focus. Accepted; the help modal carries the
   binding.
2. **[#138](../issues/138-git-header-label-truncated.md) filed** — at exactly 120 columns the git
   header renders `GI` instead of `GIT`: the counter guard in `buildGitHeader` omits the gap cell
   `joinLeftRight` reserves (31 ≤ 31 passes, `maxLeft` is 3 vs `" GIT"` 4, so `hardTruncate` cuts
   it). Intact at 140 columns; `git_view.ts` is untouched by #137 — pre-existing.

Automated companions at the same revision: `npm run typecheck` clean, `npm test` 20 suites /
801 cases green.

Not covered by this live pass: IME/CJK input, mouse, and the kitty/iTerm2 native image paths
(unchanged by this work — see the #069 checklist above).
