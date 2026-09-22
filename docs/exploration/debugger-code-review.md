# pi-navigator — Debugger Code Review (v0.6.0, commit 3ba73d3)

Full-codebase review: all 12 source modules read in full, 8 test suites skimmed for coverage,
docs/issues checked (only #020 remains open, known-blocked). Every finding below was
**reproduced and verified** against the actual code (jiti-driven repro scripts); no speculative
findings are included.

## Baseline verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | **exit 0, clean** |
| `npm test` | **8 suites, 285/285 pass** (1.7s) |
| Working tree | clean at 3ba73d3 (v0.6.0) |

## Findings

| # | Severity | Location | Category | Description | Suggested fix |
| --- | --- | --- | --- | --- | --- |
| 1 | **Major** | `index.ts` entriesFromPaths path + `git.ts` parsePorcelain (`-unormal`) + `tree.ts:200` insert | Correctness / UX (untested regression from #024) | Untracked directories arrive as `?? newdir/` (trailing slash) and are built as **file leaves**. Enter (tree or git pane) → `stat` → `!isFile()` → error card "not a regular file"; contents of new folders are unreachable in git mode. Verified end-to-end with real `git status --porcelain -unormal -z` output. | Strip trailing `/`, stat-based `isDir` at entry build; on expand of such a dir, fill children via a bounded fs walk (reuse `collectFsEntries` machinery). |
| 2 | **Major** | `viewer.ts:66-67` (`visibleTextWidth` = code points) vs `navigator.ts:1726` (`maxH` clamp) | Width-safety / content loss | In nowrap viewer, CJK/wide-char lines are hard-cut by `padTo` while `maxLineWidth` undercounts (code points, not cells), so `maxH = max(0, mw - contentW) = 0` → **hscroll locked at 0; line tail unreachable**. Verified: 60 CJK chars (120 cells), contentW=61 → sliceStyled emits 120 cells into a 68-cell pane, hscroll pinned to 0. Wrap mode is fine (pi-tui model). The per-char "one cell" approximation is documented/tested, but this lock-out consequence is not. | Make `maxLineWidth`/`visibleTextWidth` use pi-tui's `visibleWidth` (grapheme + East-Asian aware); or special-case wide chars in `sliceStyled`. |
| 3 | Minor | `navigator.ts:2039-2040` `shortPath` | Correctness (display) | `path.startsWith(home)` lacks a `/` boundary. Repro: home `/home/jhonny`, cwd `/home/jhonnyfoo/project` → title renders **`~foo/project`** — a nonexistent path. | `path === home \|\| path.startsWith(home + "/")`. |
| 4 | Minor | `viewer.ts:119/125` (`markMatches`), `viewer.ts:451` (`searchLines`) | Correctness (search offsets) | Haystack fold length drift: `styled.toLowerCase()` changes length for `İ` (U+0130 → i+combining dot); `indexOf` offsets from the folded string are applied to the unfolded one. Verified: `markMatches("İabc","abc",cur=0)` → `İa<c>bc>` (highlight on "bc"). #035 fixed the needle side only. | Detect fold-length-changing chars and fall back to a manual case-insensitive scan with offset mapping. |
| 5 | Minor | `tree.ts:393-394` `filterRows` | Behavioral inconsistency | Filter walks hidden dirs unconditionally (only files' own `hidden` flag checked). With showHidden=false, a query surfaces `.github/workflows/ci.yml` while `flattenVisible` hides the whole subtree — and this is the *common* case (tracked files under `.github`). Verified. | Skip hidden dirs in `filterRows` when `!showHidden` (mirrors `flattenVisible`). |
| 6 | Minor | `git.ts:8-11` module docstring | Doc drift | Says status is read as `--porcelain -uall -z`; code uses `-unormal -z` (changed in #024). | Update docstring. |
| 7 | Minor | `git.ts:376` `readCommitDiff` | Robustness / contract | Caps on `body.length` (UTF-16 units), not bytes as the comment claims; `slice` can split a surrogate pair (no `decodeUtf8Head` equivalent). Memory stays bounded by the 4 MB maxBuffer, so impact is small. | Cap on bytes, or reuse `decodeUtf8Head` semantics after slicing. |
| 8 | Minor | `navigator.ts` `buildFileRow` (icon accounting) | Cosmetic | `icon()` emits glyph+space (2 cells) but `iconW=1` is reserved in `room`/`gap`; body already contains the icon → rows are 1 cell narrower with icons on (safe, but names truncate 1 cell early and the badge column shifts). | Reserve 2 cells (`iconW = 2`) or exclude the icon from `body`. |
| 9 | Nit | `navigator.ts` `render()` (icons hint) | Render-path purity | First render with icons enabled calls `showNotice()` → mutates `this.notice`, starts a timer, calls `requestRender()` during render. One-time guarded, but a user-visible render-path side effect (cf. #053). | Move the hint to the constructor / first `setTree`. |
| 10 | Nit | `AGENTS.md:44,48` | Doc drift | "Six suites / ~169 cases" — actual: **8 suites / 285 cases** (settings + images added in #057 without the doc update). | Update counts. |

### Verified-sound areas (investigated, no defect)
- **Races**: `loadSeq`/`viewTargetRelPath` guards in `openRelPath`/`openCommit` correctly discard stale loads; mtime poll re-checks `getOpenRelPath()` after `await` (#040 intact); `commit:` poll skip; `inFlight` refresh serialization; `scheduleNextPoll` clear-then-set keeps a single timer chain; chafa abort controller per render + dispose.
- **Width safety**: `padTo`/`truncateToWidth`/`joinLeftRight`/`buildCard`/`composeHelp` math checked cell-by-cell — all rows fit; `Math.max(10,…)` floors are guarded by `MIN_OVERLAY_WIDTH`; ellipsis hygiene (#009/#010) consistent.
- **Purity/architecture**: navigator.ts has no fs/git/env/homedir access; no hardcoded colors; data enters only via the declared setters; `setImageSupport` follows the contract; settings schema (settings.ts ↔ images.ts ↔ index.ts) consistent.
- **Type safety**: zero `any`, zero `@ts-ignore`; the few non-null assertions (`styled[i]!`, `parts[i]!`) are bounds-checked with comments.
- **git.ts**: `-z` rename record handling, overflow surfacing (#024), availability cache (#047 intent), never-throws contracts all hold.
- **images.ts (#057)**: SGR-only whitelist sanitizer (colon-form SGR would reject → safe fallback), argv-only path (no shell), timeout clamps, 8 MiB buffer cap, abort/timeout classification, geometry clamps, deferred upgrade flow all sound; pi API surface used (`getAllTools`, `getCommands`, `SourceInfo`) verified against pi 0.85.1 types.

## Test-coverage gaps
1. **Untracked-directory entry** (finding 1): git tests cover `-z` plumbing but no test builds a tree from `?? dir/` output.
2. **Nowrap + wide chars** (finding 2): render suite tests CJK truncation in the *chafa* path only; the text viewer nowrap hscroll path is untested for wide chars.
3. **shortPath boundary** (finding 3): only the exact-prefix case is tested.
4. **filterRows hidden-dir ancestry** (finding 5): only the file's *own* hidden flag is tested.
5. **Haystack fold drift** (finding 4): needle-side folding tested (#035), content-side not.

## Overall assessment
Mature, disciplined codebase: the issue-tracker history shows a rigorous root-cause culture, and the two prior audit waves cleared the perf hotspots. The #057 image feature is well-engineered (seams, sanitizer, degradation ladder) and well-tested. The five real defects are concentrated in **integration seams between modules** (git porcelain output → tree build; code-point vs cell width models; fold-length invariants) — exactly the seams the unit suites don't cross. Findings 1 and 2 deserve issues (#058, #059); the rest are quick fixes.
