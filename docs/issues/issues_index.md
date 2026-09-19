# pi-navigator Issues Index

Central tracking index for all bugs, enhancements, technical debt, and performance findings in `pi-navigator`.

---

## 📊 Overview

| Status | High | Medium | Low | Total |
| :--- | :---: | :---: | :---: | :---: |
| **Pending / Open** | 1 | 0 | 0 | **1** |
| **Resolved** | 8 | 16 | 31 | **55** |
| **Total** | **9** | **16** | **31** | **56** |

---

## 🟡 Pending Issues

| ID | Title | Type | Severity | Component | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [#020](020-no-viewer-cache-blocking-highlight.md) | No Per-File Viewer Cache; Synchronous Highlight Blocks the Main Thread | Bug / Performance | High | `viewer.ts` | Open (partial — cache done; event-loop yielding deferred: blocked by pi's bundled-runtime virtual-module boundary, needs a pi-side API) |

---

## 🟢 Resolved Issues

| ID | Title | Type | Severity | Resolution Summary | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| [#052](052-search-index-out-of-bounds-mode-toggle.md) | `searchIndex` Out of Bounds When Toggling Markdown Rendered Mode (`m`) | Bug / UI Consistency | Medium | Clamped `searchIndex` to `Math.max(0, searchMatches.length - 1)` in `recomputeSearchOnLines` whenever `searchIndex >= searchMatches.length`, preventing out-of-bounds counters in `buildSearchBar`. | **Resolved** |
| [#053](053-horizontal-scroll-rendered-markdown-mutation.md) | Horizontal Scroll Keys Mutate State During Render in Rendered Mode | Bug / UI Polish | Low | Guarded `h`, `l`, `Key.left`, and `Key.right` in `handleViewerInput` when rendered markdown mode is active; removed state-mutating `this.viewHscroll = 0` from `buildRightRows`. | **Resolved** |
| [#054](054-redundant-rendered-markdown-line-call.md) | Redundant `getRenderedMarkdownLines` Invocation in `buildRightRows` | Performance / Code Hygiene | Low | Cached `mdLines` at the start of `buildRightRows` and reused it across search recomputation and viewport rendering, calling `getRenderedMarkdownLines` at most once per pass. | **Resolved** |
| [#055](055-markdown-extensions-whitelist.md) | `isMarkdownPath` Excludes Common Markdown Extensions (`.mdx`, `.mkd`, `.mdown`) | Enhancement | Low | Added `MARKDOWN_EXTENSIONS` set to `constants.ts` and updated `isMarkdownPath` in `viewer.ts` to include `.mdx`, `.mkd`, and `.mdown`. | **Resolved** |
| [#056](056-readme-version-and-markdown-keys.md) | README Keybindings and Version Badge Out of Sync with v0.5.0 | Documentation | Low | Updated status badge in `README.md` to `v0.5.0` and documented `m` key in the Viewer keys table. | **Resolved** |
| [#010](010-help-modal-bright-ellipsis-leak.md) | Help Modal Leaks a Bright Ellipsis Out of the Muted Style at Narrow Widths | Bug | Medium | `truncateToWidth` injects `\x1b[0m` resets around its ellipsis; wrapping a truncated string in `T.muted`/`T.dim` closed the style early and rendered `...` in bright default. `composeHelp` now truncates with an empty ellipsis + manual dim `…`; `padTo` and `joinLeftRight` use an empty ellipsis for a clean hard-cut. | **Resolved** |
| [#011](011-slicestyled-quadratic-suffix-alloc.md) | `sliceStyled` Allocates a String Suffix Per Character (O(n²)) | Bug / Performance | High | Replaced the per-iteration `styled.slice(i)` + `rest.match(/^…/)` with a module-level sticky CSI regex (`/\x1b\[[0-9;?]*[ -/]*[@-~]/y`) whose `lastIndex` is set before each `exec`, scanning the full string in place. Per-line cost O(n²)→O(n); escape handling, wide-char one-cell, and reset-termination unchanged. | **Resolved** |
| [#012](012-computerows-full-file-per-render.md) | Full-File `computeRows` Re-Derived Every Render | Enhancement / Performance | High | Added `rowsCache` keyed on `(marked ref, width, wrap, hscroll)`; vertical scrolling and cursor moves now reuse cached wrapped rows instead of re-wrapping the whole file each keystroke. `marked` itself is cached on `(viewFile, searchVersion)`. | **Resolved** |
| [#013](013-search-reruns-every-render.md) | In-File Search Re-Scans Every Render With O(lines×matches) Marking | Enhancement / Performance | High | `recomputeSearchIfNeeded` now reruns `searchLines` only when `searchDirty` (file content changed under an active query), not every render. `markSearch` uses a `Set<number>` of matching line indices for O(1) membership instead of `Array.some`. | **Resolved** |
| [#014](014-maxlinewidth-per-render.md) | `maxLineWidth` Recomputed Every Render | Enhancement / Performance | Medium | Added `maxLineWidthCache` keyed on the stable `viewFile` reference (visible width is unaffected by search marking), so it is computed once per file until the file changes. | **Resolved** |
| [#019](019-serial-git-spawns-per-tick.md) | Serial Git Subprocess Spawns on Every Poll Tick | Enhancement / Performance | High | `readGitState` now `Promise.all`s the four independent spawns (branch / rev-list / status / log); `detectRepo` merges `--show-toplevel` and `--show-prefix` into one `git rev-parse`. ~6 spawns/tick across 2 rounds instead of 6 sequential. | **Resolved** |
| [#015](015-rows-rebuilt-multiple-times-per-render.md) | `filesRows` / `gitRows` / `gitNavRows` Rebuilt Multiple Times Per Render | Enhancement / Performance | Medium | Each method memoizes on its actual inputs (`filesRows` on root ref + filterQuery + showHidden + `treeVersion`; `gitRows`/`gitNavRows` on `git` ref). A `treeVersion` counter bumps on in-place expansion mutations so the cache invalidates without a root-ref swap. | **Resolved** |
| [#016](016-filterrows-per-keystroke-lowercasing.md) | `filterRows` Lowercases Every Path Per Filter Keystroke | Enhancement / Performance | Medium | Added `lowerName`/`lowerRelPath` to `FileNode`, populated in `makeNode`; `filterRows` matches against the precomputed fields instead of `.toLowerCase()` per node per keystroke. | **Resolved** |
| [#021](021-git-availability-cache-defeated-on-refresh.md) | Git Availability Cache Defeated on Every Manual Refresh | Enhancement / Performance | Medium | Removed the unconditional `resetGitAvailabilityCache()` on `r` refresh; `runGit` now resets the cache only on a spawn `ENOENT` (genuinely missing binary), so self-healing still works. | **Resolved** |
| [#017](017-haschanges-recursive-scan-per-render.md) | `hasChanges` Recursive Scan Per Directory Row Per Render | Enhancement / Performance | Low | Added `subtreeChanged` flag to `FileNode`, recomputed bottom-up in `buildTree` and `applyGitCodes`; `hasChanges` is now an O(1) field read instead of a recursive scan per dir row per render. | **Resolved** |
| [#018](018-redundant-width-scans.md) | Redundant `visibleWidth` / `truncateToWidth` Scans Over the Same Strings | Enhancement / Performance | Low | Added `truncateAndWidth` helper (one truncate + one measure) and applied it at `buildFileRow`/`buildGitRow`/`buildCard` sites that previously truncated then measured the result separately. | **Resolved** |
| [#022](022-applygitcodes-walk-every-tick.md) | Full-Tree `applyGitCodes` Walk Every Tick Even When Status Unchanged | Enhancement / Performance | Low | Added `lastStampedProbe`; both idle-tick `applyGitCodes` call sites are gated on `probe !== lastStampedProbe` (the probe encodes every code+path, so an unchanged probe means unchanged codes). | **Resolved** |
| [#023](023-serial-dfs-filesystem-walk.md) | Filesystem Walk Is a Serial DFS | Enhancement / Performance | Low | `walk` now `Promise.all`s the per-level subdirectory descents; `visited` adds stay synchronous before any descent, so the cycle guard is sound under the fan-out. Depth cap and ignored-name semantics unchanged. | **Resolved** |
| [#024](024-unbounded-git-boundary.md) | Unbounded Inputs at the Git Boundary | Enhancement / Robustness | Low | `runGit` returns a discriminated `GitResult` and surfaces maxBuffer overflow as an unavailable-with-error state; switched `status -uall` to `-unormal` to bound untracked listing. | **Resolved** |
| [#009](009-crlf-line-endings-break-viewer-layout.md) | CRLF Line Endings Break the Viewer Layout (Carriage Return Resets Cursor) | Bug | High | Normalize `\r\n` and lone `\r` to `\n` in `loadFile` right after the read, so carriage returns never reach the terminal and reset the cursor mid-row. Affected every CRLF file, including all `.ts` sources in this repo. | **Resolved** |
| [#001](001-stale-content-race-when-opening-file.md) | UI Renders Stale Content and Inconsistent State When Opening a File | Bug | High | Added load sequence and target path tracking (`loadSeq`, `viewTargetRelPath`). Immediately displays loading placeholder, target path in header, and highlights row while keeping scroll intact on reload. | **Resolved** |
| [#002](002-ctrl-n-shortcut-conflict.md) | Global `ctrl+n` Shortcut Conflicts with Pi Built-in Keybinding | Bug / Compatibility | Medium | Removed global `ctrl+n` shortcut registration from `index.ts` to prevent conflict warning banners with Pi 0.85.1+ built-in `toggleNamedFilter`. Kept `/navigator` command. | **Resolved** |
| [#003](003-phantom-x-key-in-viewer-hints.md) | Phantom `x` Key Hint in Viewer Footer | Bug / UI Polish | Low | Removed non-functional `x` hint from `HINTS.viewer` (`h l x` -> `h l`), saving 2 character columns in narrow viewport footer budget. | **Resolved** |
| [#004](004-search-navigation-keybindings-inconsistency.md) | Ambiguous Key Hints for Search Navigation (`n`/`N`) Between Input Modes | UX / Enhancement | Low | Clarified `n`/`N` (viewer navigation) vs arrow keys (active search typing) in `HELP_ROWS`. Added `Ctrl+n` / `Ctrl+p` match cycling in search mode. | **Resolved** |
| [#005](005-hints-lookup-fallback-chain.md) | Fragile Fallback Chain in Footer Hint Resolution | Technical Debt | Low | Replaced loosely-typed fallback chain with exhaustively typed `FOCUS_HINTS` and `MODE_HINTS` dictionaries and an explicit `getFooterHint()` helper. | **Resolved** |
| [#006](006-findnode-redundant-tree-traversal.md) | Redundant Child Iteration in `findNode` Tree Search | Performance | Low | Simplified `findNode` to inspect visited node directly rather than checking child arrays twice during DFS tree traversal. | **Resolved** |
| [#007](007-git-binary-cache-invalidation.md) | Module-Level `gitBinaryPresent` Cache Cannot Be Invalidated | Reliability | Low | Exported `resetGitAvailabilityCache()` (used by the test lifecycle hook). The manual-`r` reset was later removed by #021, leaving the export with no production caller — see #027. | **Resolved** |
| [#008](008-fs-polling-overhead.md) | Periodic 3-Second Polling May Cause Overhead in Large Repositories | Performance | Low | Implemented Phase 1 dynamic idle backoff (3s up to 10s when idle), resetting immediately to 3s on user keystroke, on-disk changes, or manual `r` refresh. | **Resolved** |
| [#025](025-search-current-match-highlight-off-by-occurrence.md) | Search Current-Match Highlight Targets the Wrong Occurrence on Multi-Hit Lines | Bug | Medium | Changed `markMatches`'s `currentIsFirst: boolean` to `currentOccurrence: number`; `markSearch` now computes the per-line occurrence index so the Nth match on a multi-hit line is styled as current. | **Resolved** |
| [#026](026-git-group-dim-tone-collapses-to-muted.md) | Git Group Rows With `tone: "dim"` Render as `muted` | Bug / UI Polish | Low | Added the missing `"dim" → T.dim` branch to `buildGitRow`'s tone ternary chain so all four `GitRowTone` values map to the correct theme token. | **Resolved** |
| [#027](027-dead-resetgitavailabilitycache-export.md) | Dead `resetGitAvailabilityCache` Export; Stale #007 Resolution Summary | Technical Debt | Low | Removed the dead `resetGitAvailabilityCache()` export and updated the git integration test to exercise the cache-hit path instead. | **Resolved** |
| [#028](028-nerd-font-icons.md) | Nerd Font Filetype Icons, Env-Gated | Feature | Medium | New `icons.ts`; `PI_NAV_ICONS=1` opts into a one-cell Nerd Font icon column in the file tree (default plain glyphs). Env is read once in `index.ts`; width-safe at all sizes; one-time tofu hint when on. | **Resolved** |
| [#029](029-git-pane-dynamic-rows.md) | Git Pane Dynamic Rows + Richer Badges | Feature | Low | `gitRows` skips empty `Unstaged (N)`/`Staged (N)` groups (both empty → `Clean`); `codeText` maps `R→warning`, `C→success`. Header summary always-on. | **Resolved** |
| [#030](030-commit-family-tree.md) | Expandable Commit Family Tree | Feature | Low | `Enter` on a commit expands its ancestor family as indented rows (log `--parents`, `GitCommit.parents?`, `commit-child` kind), capped by `FAMILY_MAX_DEPTH`/`FAMILY_MAX_ROWS`, cache-keyed on `gitTreeVersion`. | **Resolved** |
| [#031](031-nerd-font-icons-fixed-left-column.md) | Nerd Font Icons Float at a Fixed Left Column on Nested Entries | Bug | Low | `buildFileRow` rendered `icon + indent + name`, so the glyph sat at a fixed column and desynchronized from the indented label on nested rows. Reordered to `indent + icon + name` (dir/file branches); the glyph now moves with depth and stays glued to its marker/name. Width accounting unchanged. | **Resolved** |
| [#032](032-commit-family-duplicate-rows.md) | Expanded Commit Family Duplicates Ancestor Rows and Mis-Nests | Bug | Medium | `gitRows` keyed family insertion on each child's own hash, so an ancestor that was both a top-level history row and a family child rendered twice and nested under the wrong anchor. Rebuilt as a per-anchor DFS block emitted once directly under the expanded commit. | **Resolved** |
| [#033](033-solidity-icon-impersonates-typescript.md) | Solidity Icon Impersonates the TypeScript Glyph | Bug | Low | `EXT_ICONS` had `sol: "\ue628"` (the TypeScript codepoint) by copy-paste. Removed so `.sol` falls back to `GENERIC_ICON` like other unmapped languages. | **Resolved** |
| [#034](034-commit-diff-view.md) | Commit Detail/Diff View + v3 Family-Tree Drift Fix | Feature | Medium | Enter on a commit opens its diff in the viewer (`readCommitDiff` + `styleDiffLines` + `ViewerKind "diff"`); family expansion moved to `l`/`h` (one level per expand, `▸`/`▾` markers, actionable `commit-child`, depth/row-cap notices instead of silent truncation). Optional `loadCommit` injection; fallback keeps v2 Enter semantics. version 0.4.0. | **Resolved** |
| [#035](035-markmatches-query-length-vs-needle-length.md) | `markMatches` Uses `query.length` Instead of `needle.length` — Unicode Case-Folding Mismatch | Bug | Medium | Changed `query.length` to `needle.length` in `viewer.ts` slice extraction, aligning with search stride for Unicode characters whose lowercasing changes byte length. | **Resolved** |
| [#036](036-readcommitdiff-line-cap-not-enforced.md) | `readCommitDiff` Line Cap Not Enforced — Only Byte Cap Applied | Bug | Medium | Enforced `MAX_HIGHLIGHT_LINES` capping on diff lines in `git.ts:readCommitDiff`, byte-slicing for byte overflow and line-slicing for line overflow. | **Resolved** |
| [#037](037-diff-icons-missing-from-package-files.md) | `diff.ts` and `icons.ts` Missing From `package.json` `"files"` and `tsconfig.json` `"include"` | Bug | High | Added `diff.ts` and `icons.ts` to `package.json` `"files"` and `tsconfig.json` `"include"`, ensuring npm package builds include both runtime modules. | **Resolved** |
| [#038](038-buildcard-width-overflow-narrow-panes.md) | `buildCard` Width Overflow at Narrow Panes | Enhancement | Medium | Clamped `contentWidth` to `rightW - 6` at narrow widths and mapped all `buildCard` output rows through `this.padTo(row, rightW)`. | **Resolved** |
| [#039](039-shortpath-reads-process-env-in-component.md) | `shortPath` Reads `process.env` Inside the Component | Enhancement / Technical Debt | Low | Added optional `home?: string` to `NavigatorOptions`, read once in `index.ts` at startup, and removed direct `process.env` reads from `navigator.ts`. | **Resolved** |
| [#040](040-mtime-race-in-refreshdata-poll.md) | Mtime Race Condition in `refreshData` Polling | Enhancement / Robustness | Low | Added active path check (`overlay.getOpenRelPath() === openRel`) after async `stat()` in `refreshData` before calling `setDiskChanged`. | **Resolved** |
| [#041](041-collectfsprobe-serial-stat-calls.md) | `collectFsProbe` Serializes Stat Calls | Enhancement / Performance | Low | Converted `collectFsProbe` directory stat loop to `Promise.all` concurrent execution, preserving order and string format. | **Resolved** |
| [#042](042-theme-underline-not-guarded.md) | `theme.underline` Called Without a Safety Guard | Enhancement / Robustness | Medium | Added defensive `typeof theme.underline === "function"` guard to `searchCurrent` in `theme.ts`, degrading gracefully when undefined. | **Resolved** |
| [#043](043-commit-subject-truncation-on-unit-separator.md) | Commit Subject Truncated if Message Contains Unit Separator | Bug | Low | Rejoined split parts with `parts.slice(3).join(UNIT_SEPARATOR)` in `readGitState` log parser so subjects containing `\x1f` are preserved. | **Resolved** |
| [#044](044-collator-missing-numeric-sorting.md) | Tree Sort Collator Lacks `numeric: true` — `file10` Sorts Before `file2` | Enhancement | Low | Added `numeric: true` to `Intl.Collator` in `tree.ts` for natural numeric sorting of file and directory names. | **Resolved** |
| [#045](045-extof-dotfile-returns-name-as-extension.md) | `extOf` Returns Dotfile Name as Extension | Enhancement | Low | Updated `extOf` in `viewer.ts` to return `""` when `dot <= 0`. Added explicit `FILENAME_ICONS` map in `icons.ts` for exact dotfile and filename matching. | **Resolved** |
| [#046](046-walktree-reverse-sibling-order.md) | `walkTree` Visits Siblings in Reverse Order | Enhancement / Technical Debt | Low | Reversed push order in `walkTree` (`node.children.length - 1` down to 0) so LIFO stack pops visit siblings in forward DFS order. | **Resolved** |
| [#047](047-git-binary-negative-cache-permanent.md) | `gitBinaryPresent` Negative Cache Is Permanent for Non-ENOENT Failures | Enhancement / Robustness | Low | Introduced `{ status: "missing" }` on spawn `ENOENT`; `isGitAvailable` caches negative result only for genuine missing binary, leaving transient errors uncached. | **Resolved** |
| [#048](048-reload-open-file-crashes-commit-diff.md) | `reloadOpenFile` Routes Commit Diffs to Filesystem Loader, Crashing the Viewer | Bug | High | Added `keepScroll` parameter to `openCommit`; `reloadOpenFile` routes diff reloads to `openCommit(hash, true)` when `loadCommit` is configured instead of `openRelPath`. | **Resolved** |
| [#049](049-copy-context-raw-commit-scheme.md) | `copyContext` Copies Raw `commit:<hash>` Identity String in Viewer Pane | Bug / UX Consistency | Medium | Updated `copyContext` in `navigator.ts` to extract `file.commitHash` or strip `commit:` prefix when focused on the diff viewer pane. | **Resolved** |
| [#050](050-viewer-header-commit-transition-flicker.md) | Viewer Header Flickers Raw `commit:<hash>` Identity During Commit Transitions | Bug / UI Polish | Low | Formatted `isCommit` as `(file?.kind === "diff" && file.commitHash) || currentPath.startsWith("commit:")`, preventing colon flicker while loading. | **Resolved** |
| [#051](051-redundant-ext-icons-entries.md) | Dead Extension Entries in `EXT_ICONS` Superseded by `FILENAME_ICONS` | Technical Debt / Code Hygiene | Low | Verified redundant entries moved to `FILENAME_ICONS` during #045 refactor; `test/icons.test.ts` covers exact dotfile mapping. | **Resolved** |

---

## 📂 Issues by Category

### Bug Fixes & UI Consistency
- [#010: Help Modal Leaks a Bright Ellipsis Out of the Muted Style at Narrow Widths](010-help-modal-bright-ellipsis-leak.md)
- [#009: CRLF Line Endings Break the Viewer Layout (Carriage Return Resets Cursor)](009-crlf-line-endings-break-viewer-layout.md)
- [#001: UI Renders Stale Content and Inconsistent State When Opening a File](001-stale-content-race-when-opening-file.md)
- [#002: Global `ctrl+n` Shortcut Conflicts with Pi Built-in Keybinding](002-ctrl-n-shortcut-conflict.md)
- [#003: Phantom `x` Key Hint in Viewer Footer](003-phantom-x-key-in-viewer-hints.md)
- [#025: Search Current-Match Highlight Targets the Wrong Occurrence on Multi-Hit Lines](025-search-current-match-highlight-off-by-occurrence.md) *(resolved)*
- [#026: Git Group Rows With `tone: "dim"` Render as `muted`](026-git-group-dim-tone-collapses-to-muted.md) *(resolved)*
- [#028: Nerd Font Filetype Icons, Env-Gated](028-nerd-font-icons.md) *(resolved)*
- [#031: Nerd Font Icons Float at a Fixed Left Column on Nested Entries](031-nerd-font-icons-fixed-left-column.md) *(resolved)*
- [#032: Expanded Commit Family Duplicates Ancestor Rows and Mis-Nests](032-commit-family-duplicate-rows.md) *(resolved)*
- [#033: Solidity Icon Impersonates the TypeScript Glyph](033-solidity-icon-impersonates-typescript.md) *(resolved)*
- [#034: Commit Detail/Diff View + v3 Family-Tree Drift Fix](034-commit-diff-view.md) *(resolved)*
- [#029: Git Pane Dynamic Rows + Richer Badges](029-git-pane-dynamic-rows.md) *(resolved)*
- [#030: Expandable Commit Family Tree](030-commit-family-tree.md) *(resolved, keys superseded by v3 [#034] — `l`/`h` expand/collapse, Enter opens diff)*
- [#035: `markMatches` Uses `query.length` Instead of `needle.length` — Unicode Case-Folding Mismatch](035-markmatches-query-length-vs-needle-length.md) *(resolved)*
- [#036: `readCommitDiff` Line Cap Not Enforced — Only Byte Cap Applied](036-readcommitdiff-line-cap-not-enforced.md) *(resolved)*
- [#037: `diff.ts` and `icons.ts` Missing From `package.json` `"files"` and `tsconfig.json` `"include"`](037-diff-icons-missing-from-package-files.md) *(resolved)*
- [#038: `buildCard` Width Overflow at Narrow Panes](038-buildcard-width-overflow-narrow-panes.md) *(resolved)*
- [#043: Commit Subject Truncated if Message Contains Unit Separator](043-commit-subject-truncation-on-unit-separator.md) *(resolved)*
- [#048: `reloadOpenFile` Routes Commit Diffs to Filesystem Loader, Crashing the Viewer](048-reload-open-file-crashes-commit-diff.md) *(resolved)*
- [#050: Viewer Header Flickers Raw `commit:<hash>` Identity During Commit Transitions](050-viewer-header-commit-transition-flicker.md) *(resolved)*
- [#052: `searchIndex` Out of Bounds When Toggling Markdown Rendered Mode (`m`)](052-search-index-out-of-bounds-mode-toggle.md) *(resolved)*
- [#053: Horizontal Scroll Keys Mutate State During Render in Rendered Mode](053-horizontal-scroll-rendered-markdown-mutation.md) *(resolved)*

### Performance & Resource Optimization
- [#020: No Per-File Viewer Cache; Synchronous Highlight Blocks the Main Thread](020-no-viewer-cache-blocking-highlight.md) *(partial — cache done)*
- [#011: `sliceStyled` Allocates a String Suffix Per Character (O(n²))](011-slicestyled-quadratic-suffix-alloc.md) *(resolved)*
- [#012: Full-File `computeRows` Re-Derived Every Render](012-computerows-full-file-per-render.md) *(resolved)*
- [#013: In-File Search Re-Scans Every Render With O(lines×matches) Marking](013-search-reruns-every-render.md) *(resolved)*
- [#014: `maxLineWidth` Recomputed Every Render](014-maxlinewidth-per-render.md) *(resolved)*
- [#015: `filesRows` / `gitRows` / `gitNavRows` Rebuilt Multiple Times Per Render](015-rows-rebuilt-multiple-times-per-render.md) *(resolved)*
- [#016: `filterRows` Lowercases Every Path Per Filter Keystroke](016-filterrows-per-keystroke-lowercasing.md) *(resolved)*
- [#017: `hasChanges` Recursive Scan Per Directory Row Per Render](017-haschanges-recursive-scan-per-render.md) *(resolved)*
- [#018: Redundant `visibleWidth` / `truncateToWidth` Scans Over the Same Strings](018-redundant-width-scans.md) *(resolved)*
- [#019: Serial Git Subprocess Spawns on Every Poll Tick](019-serial-git-spawns-per-tick.md) *(resolved)*
- [#021: Git Availability Cache Defeated on Every Manual Refresh](021-git-availability-cache-defeated-on-refresh.md) *(resolved)*
- [#022: Full-Tree `applyGitCodes` Walk Every Tick Even When Status Unchanged](022-applygitcodes-walk-every-tick.md) *(resolved)*
- [#023: Filesystem Walk Is a Serial DFS](023-serial-dfs-filesystem-walk.md) *(resolved)*
- [#024: Unbounded Inputs at the Git Boundary](024-unbounded-git-boundary.md) *(resolved)*
- [#006: Redundant Child Iteration in `findNode` Tree Search](006-findnode-redundant-tree-traversal.md) *(resolved)*
- [#008: Periodic 3-Second Polling May Cause Overhead in Large Repositories](008-fs-polling-overhead.md) *(resolved)*
- [#041: `collectFsProbe` Serializes Stat Calls](041-collectfsprobe-serial-stat-calls.md) *(resolved)*
- [#054: Redundant `getRenderedMarkdownLines` Invocation in `buildRightRows`](054-redundant-rendered-markdown-line-call.md) *(resolved)*

### User Experience & Keyboard Navigation
- [#004: Ambiguous Key Hints for Search Navigation (`n`/`N`) Between Input Modes](004-search-navigation-keybindings-inconsistency.md)
- [#044: Tree Sort Collator Lacks `numeric: true` — `file10` Sorts Before `file2`](044-collator-missing-numeric-sorting.md) *(resolved)*
- [#049: `copyContext` Copies Raw `commit:<hash>` Identity String in Viewer Pane](049-copy-context-raw-commit-scheme.md) *(resolved)*
- [#055: `isMarkdownPath` Excludes Common Markdown Extensions (`.mdx`, `.mkd`, `.mdown`)](055-markdown-extensions-whitelist.md) *(resolved)*

### Technical Debt & Code Robustness
- [#005: Fragile Fallback Chain in Footer Hint Resolution](005-hints-lookup-fallback-chain.md)
- [#007: Module-Level `gitBinaryPresent` Cache Cannot Be Invalidated](007-git-binary-cache-invalidation.md)
- [#027: Dead `resetGitAvailabilityCache` Export; Stale #007 Resolution Summary](027-dead-resetgitavailabilitycache-export.md) *(resolved)*
- [#039: `shortPath` Reads `process.env` Inside the Component](039-shortpath-reads-process-env-in-component.md) *(resolved)*
- [#040: Mtime Race Condition in `refreshData` Polling](040-mtime-race-in-refreshdata-poll.md) *(resolved)*
- [#042: `theme.underline` Called Without a Safety Guard](042-theme-underline-not-guarded.md) *(resolved)*
- [#045: `extOf` Returns Dotfile Name as Extension](045-extof-dotfile-returns-name-as-extension.md) *(resolved)*
- [#046: `walkTree` Visits Siblings in Reverse Order](046-walktree-reverse-sibling-order.md) *(resolved)*
- [#047: `gitBinaryPresent` Negative Cache Is Permanent for Non-ENOENT Failures](047-git-binary-negative-cache-permanent.md) *(resolved)*
- [#051: Dead Extension Entries in `EXT_ICONS` Superseded by `FILENAME_ICONS`](051-redundant-ext-icons-entries.md) *(resolved)*
- [#056: README Keybindings and Version Badge Out of Sync with v0.5.0](056-readme-version-and-markdown-keys.md) *(resolved)*

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
