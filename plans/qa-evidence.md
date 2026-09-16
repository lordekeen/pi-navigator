# pi-navigator — QA evidence log

Companion to section 13 of [`pi-navigator-implementation-plan.md`](pi-navigator-implementation-plan.md).

Environment for this pass: Windows 11, PowerShell. `node`, `npm` and `git` are **not on PATH**
(the constraint recorded in section 5 of the standards report), and the extension only runs inside
pi's bundled runtime. So nothing in this log was executed: every entry is a **static** verification —
source reading, arithmetic on the layout formulas, and the reference documentation cited inline.
Runtime and manual checks stay open, and section 13's boxes stay unchecked until someone runs them
in a terminal.

## What was verified statically, and how

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

1. Install Node and run `npm install -D typescript @types/node vitest`, add `tsconfig.json`
   (strict, NodeNext, no emit) and `npx tsc --noEmit`.
2. Write the vitest suites listed in section 11 and run them. The cheapest high-value cases for this
   pass: `parsePorcelain` with a `-z` rename (target record followed by the source record), a `??`
   entry, and prefix translation; `reapplyExpansion` with a collapsed top-level directory;
   `markMatches` with an uppercase query against mixed-case text; `decodeUtf8Head` on a head that
   cuts a 3-byte character; `collectFsProbe` before and after touching a directory.
3. Drive `/navigator` in a real session at 120x36, 100x28, 80x24 and a 20-row terminal, confirming
   no line exceeds the pane width and that the compact notice appears on the short one.
4. Verify IME input in the search bar with a CJK input method, and `ctrl+n` in Windows Terminal and
   the VS Code terminal.
