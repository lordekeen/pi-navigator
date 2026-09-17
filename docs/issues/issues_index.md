# pi-navigator Issues Index

Central tracking index for all bugs, enhancements, technical debt, and performance findings in `pi-navigator`.

---

## 📊 Overview

| Status | High | Medium | Low | Total |
| :--- | :---: | :---: | :---: | :---: |
| **Pending / Open** | 1 | 0 | 5 | **6** |
| **Resolved** | 6 | 6 | 6 | **18** |
| **Total** | **7** | **6** | **11** | **24** |

---

## 🟡 Pending Issues

| ID | Title | Type | Severity | Component | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [#017](017-haschanges-recursive-scan-per-render.md) | `hasChanges` Recursive Scan Per Directory Row Per Render | Enhancement / Performance | Low | `navigator.ts` / `tree.ts` | Open |
| [#018](018-redundant-width-scans.md) | Redundant `visibleWidth` / `truncateToWidth` Scans Over the Same Strings | Enhancement / Performance | Low | `navigator.ts` | Open |
| [#020](020-no-viewer-cache-blocking-highlight.md) | No Per-File Viewer Cache; Synchronous Highlight Blocks the Main Thread | Bug / Performance | High | `viewer.ts` | Open (partial — cache done; event-loop yielding deferred) |
| [#022](022-applygitcodes-walk-every-tick.md) | Full-Tree `applyGitCodes` Walk Every Tick Even When Status Unchanged | Enhancement / Performance | Low | `index.ts` / `tree.ts` | Open |
| [#023](023-serial-dfs-filesystem-walk.md) | Filesystem Walk Is a Serial DFS | Enhancement / Performance | Low | `tree.ts` | Open |
| [#024](024-unbounded-git-boundary.md) | Unbounded Inputs at the Git Boundary | Enhancement / Robustness | Low | `git.ts` | Open |

---

## 🟢 Resolved Issues

| ID | Title | Type | Severity | Resolution Summary | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| [#010](010-help-modal-bright-ellipsis-leak.md) | Help Modal Leaks a Bright Ellipsis Out of the Muted Style at Narrow Widths | Bug | Medium | `truncateToWidth` injects `\x1b[0m` resets around its ellipsis; wrapping a truncated string in `T.muted`/`T.dim` closed the style early and rendered `...` in bright default. `composeHelp` now truncates with an empty ellipsis + manual dim `…`; `padTo` and `joinLeftRight` use an empty ellipsis for a clean hard-cut. | **Resolved** |
| [#011](011-slicestyled-quadratic-suffix-alloc.md) | `sliceStyled` Allocates a String Suffix Per Character (O(n²)) | Bug / Performance | High | Replaced the per-iteration `styled.slice(i)` + `rest.match(/^…/)` with a module-level sticky CSI regex (`/\x1b\[[0-9;?]*[ -/]*[@-~]/y`) whose `lastIndex` is set before each `exec`, scanning the full string in place. Per-line cost O(n²)→O(n); escape handling, wide-char one-cell, and reset-termination unchanged. | **Resolved** |
| [#012](012-computerows-full-file-per-render.md) | Full-File `computeRows` Re-Derived Every Render | Enhancement / Performance | High | Added `rowsCache` keyed on `(marked ref, width, wrap, hscroll)`; vertical scrolling and cursor moves now reuse cached wrapped rows instead of re-wrapping the whole file each keystroke. `marked` itself is cached on `(viewFile, searchVersion)`. | **Resolved** |
| [#013](013-search-reruns-every-render.md) | In-File Search Re-Scans Every Render With O(lines×matches) Marking | Enhancement / Performance | High | `recomputeSearchIfNeeded` now reruns `searchLines` only when `searchDirty` (file content changed under an active query), not every render. `markSearch` uses a `Set<number>` of matching line indices for O(1) membership instead of `Array.some`. | **Resolved** |
| [#014](014-maxlinewidth-per-render.md) | `maxLineWidth` Recomputed Every Render | Enhancement / Performance | Medium | Added `maxLineWidthCache` keyed on the stable `viewFile` reference (visible width is unaffected by search marking), so it is computed once per file until the file changes. | **Resolved** |
| [#019](019-serial-git-spawns-per-tick.md) | Serial Git Subprocess Spawns on Every Poll Tick | Enhancement / Performance | High | `readGitState` now `Promise.all`s the four independent spawns (branch / rev-list / status / log); `detectRepo` merges `--show-toplevel` and `--show-prefix` into one `git rev-parse`. ~6 spawns/tick across 2 rounds instead of 6 sequential. | **Resolved** |
| [#015](015-rows-rebuilt-multiple-times-per-render.md) | `filesRows` / `gitRows` / `gitNavRows` Rebuilt Multiple Times Per Render | Enhancement / Performance | Medium | Each method memoizes on its actual inputs (`filesRows` on root ref + filterQuery + showHidden + `treeVersion`; `gitRows`/`gitNavRows` on `git` ref). A `treeVersion` counter bumps on in-place expansion mutations so the cache invalidates without a root-ref swap. | **Resolved** |
| [#016](016-filterrows-per-keystroke-lowercasing.md) | `filterRows` Lowercases Every Path Per Filter Keystroke | Enhancement / Performance | Medium | Added `lowerName`/`lowerRelPath` to `FileNode`, populated in `makeNode`; `filterRows` matches against the precomputed fields instead of `.toLowerCase()` per node per keystroke. | **Resolved** |
| [#021](021-git-availability-cache-defeated-on-refresh.md) | Git Availability Cache Defeated on Every Manual Refresh | Enhancement / Performance | Medium | Removed the unconditional `resetGitAvailabilityCache()` on `r` refresh; `runGit` now resets the cache only on a spawn `ENOENT` (genuinely missing binary), so self-healing still works. | **Resolved** |
| [#009](009-crlf-line-endings-break-viewer-layout.md) | CRLF Line Endings Break the Viewer Layout (Carriage Return Resets Cursor) | Bug | High | Normalize `\r\n` and lone `\r` to `\n` in `loadFile` right after the read, so carriage returns never reach the terminal and reset the cursor mid-row. Affected every CRLF file, including all `.ts` sources in this repo. | **Resolved** |
| [#001](001-stale-content-race-when-opening-file.md) | UI Renders Stale Content and Inconsistent State When Opening a File | Bug | High | Added load sequence and target path tracking (`loadSeq`, `viewTargetRelPath`). Immediately displays loading placeholder, target path in header, and highlights row while keeping scroll intact on reload. | **Resolved** |
| [#002](002-ctrl-n-shortcut-conflict.md) | Global `ctrl+n` Shortcut Conflicts with Pi Built-in Keybinding | Bug / Compatibility | Medium | Removed global `ctrl+n` shortcut registration from `index.ts` to prevent conflict warning banners with Pi 0.85.1+ built-in `toggleNamedFilter`. Kept `/navigator` command. | **Resolved** |
| [#003](003-phantom-x-key-in-viewer-hints.md) | Phantom `x` Key Hint in Viewer Footer | Bug / UI Polish | Low | Removed non-functional `x` hint from `HINTS.viewer` (`h l x` -> `h l`), saving 2 character columns in narrow viewport footer budget. | **Resolved** |
| [#004](004-search-navigation-keybindings-inconsistency.md) | Ambiguous Key Hints for Search Navigation (`n`/`N`) Between Input Modes | UX / Enhancement | Low | Clarified `n`/`N` (viewer navigation) vs arrow keys (active search typing) in `HELP_ROWS`. Added `Ctrl+n` / `Ctrl+p` match cycling in search mode. | **Resolved** |
| [#005](005-hints-lookup-fallback-chain.md) | Fragile Fallback Chain in Footer Hint Resolution | Technical Debt | Low | Replaced loosely-typed fallback chain with exhaustively typed `FOCUS_HINTS` and `MODE_HINTS` dictionaries and an explicit `getFooterHint()` helper. | **Resolved** |
| [#006](006-findnode-redundant-tree-traversal.md) | Redundant Child Iteration in `findNode` Tree Search | Performance | Low | Simplified `findNode` to inspect visited node directly rather than checking child arrays twice during DFS tree traversal. | **Resolved** |
| [#007](007-git-binary-cache-invalidation.md) | Module-Level `gitBinaryPresent` Cache Cannot Be Invalidated | Reliability | Low | Exported `resetGitAvailabilityCache()` and wired it to run on manual `r` refresh and in test lifecycle hooks. | **Resolved** |
| [#008](008-fs-polling-overhead.md) | Periodic 3-Second Polling May Cause Overhead in Large Repositories | Performance | Low | Implemented Phase 1 dynamic idle backoff (3s up to 10s when idle), resetting immediately to 3s on user keystroke, on-disk changes, or manual `r` refresh. | **Resolved** |

---

## 📂 Issues by Category

### Bug Fixes & UI Consistency
- [#010: Help Modal Leaks a Bright Ellipsis Out of the Muted Style at Narrow Widths](010-help-modal-bright-ellipsis-leak.md)
- [#009: CRLF Line Endings Break the Viewer Layout (Carriage Return Resets Cursor)](009-crlf-line-endings-break-viewer-layout.md)
- [#001: UI Renders Stale Content and Inconsistent State When Opening a File](001-stale-content-race-when-opening-file.md)
- [#002: Global `ctrl+n` Shortcut Conflicts with Pi Built-in Keybinding](002-ctrl-n-shortcut-conflict.md)
- [#003: Phantom `x` Key Hint in Viewer Footer](003-phantom-x-key-in-viewer-hints.md)

### Performance & Resource Optimization
- [#017: `hasChanges` Recursive Scan Per Directory Row Per Render](017-haschanges-recursive-scan-per-render.md)
- [#018: Redundant `visibleWidth` / `truncateToWidth` Scans Over the Same Strings](018-redundant-width-scans.md)
- [#020: No Per-File Viewer Cache; Synchronous Highlight Blocks the Main Thread](020-no-viewer-cache-blocking-highlight.md) *(partial — cache done)*
- [#022: Full-Tree `applyGitCodes` Walk Every Tick Even When Status Unchanged](022-applygitcodes-walk-every-tick.md)
- [#023: Filesystem Walk Is a Serial DFS](023-serial-dfs-filesystem-walk.md)
- [#024: Unbounded Inputs at the Git Boundary](024-unbounded-git-boundary.md)
- [#011: `sliceStyled` Allocates a String Suffix Per Character (O(n²))](011-slicestyled-quadratic-suffix-alloc.md) *(resolved)*
- [#012: Full-File `computeRows` Re-Derived Every Render](012-computerows-full-file-per-render.md) *(resolved)*
- [#013: In-File Search Re-Scans Every Render With O(lines×matches) Marking](013-search-reruns-every-render.md) *(resolved)*
- [#014: `maxLineWidth` Recomputed Every Render](014-maxlinewidth-per-render.md) *(resolved)*
- [#015: `filesRows` / `gitRows` / `gitNavRows` Rebuilt Multiple Times Per Render](015-rows-rebuilt-multiple-times-per-render.md) *(resolved)*
- [#016: `filterRows` Lowercases Every Path Per Filter Keystroke](016-filterrows-per-keystroke-lowercasing.md) *(resolved)*
- [#019: Serial Git Subprocess Spawns on Every Poll Tick](019-serial-git-spawns-per-tick.md) *(resolved)*
- [#021: Git Availability Cache Defeated on Every Manual Refresh](021-git-availability-cache-defeated-on-refresh.md) *(resolved)*
- [#006: Redundant Child Iteration in `findNode` Tree Search](006-findnode-redundant-tree-traversal.md) *(resolved)*
- [#008: Periodic 3-Second Polling May Cause Overhead in Large Repositories](008-fs-polling-overhead.md) *(resolved)*

### User Experience & Keyboard Navigation
- [#004: Ambiguous Key Hints for Search Navigation (`n`/`N`) Between Input Modes](004-search-navigation-keybindings-inconsistency.md)

### Technical Debt & Code Robustness
- [#005: Fragile Fallback Chain in Footer Hint Resolution](005-hints-lookup-fallback-chain.md)
- [#007: Module-Level `gitBinaryPresent` Cache Cannot Be Invalidated](007-git-binary-cache-invalidation.md)

---

## 📝 Lifecycle & Workflow

1. **Creating an Issue**:
   - Create a file following the naming convention: `NNN-<short-slug>.md` (e.g., `009-some-issue.md`).
   - Fill in Status (`Open`), Type, Severity (`High`, `Medium`, `Low`), Description, Reproduction Steps, Root Cause, Potential Solution, and Acceptance Criteria.
   - Add an entry to the **Pending Issues** table in this index.

2. **Resolving an Issue**:
   - Implement the fix and add automated test cases.
   - Check all items in the issue's Acceptance Criteria checklist.
   - Update the issue file status to `Resolved`.
   - Move the entry from **Pending Issues** to **Resolved Issues** in this index and update the overview metrics.
