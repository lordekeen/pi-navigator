# pi-navigator Issues Index

Central tracking index for all bugs, enhancements, technical debt, and performance findings in `pi-navigator`.

---

## 📊 Overview

| Status | High | Medium | Low | Total |
| :--- | :---: | :---: | :---: | :---: |
| **Pending / Open** | 0 | 0 | 0 | **0** |
| **Resolved** | 1 | 1 | 6 | **8** |
| **Total** | **1** | **1** | **6** | **8** |

---

## 🟡 Pending Issues

*There are currently no open or pending issues.*

| ID | Title | Type | Severity | Component | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| — | — | — | — | — | — |

---

## 🟢 Resolved Issues

| ID | Title | Type | Severity | Resolution Summary | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
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
- [#001: UI Renders Stale Content and Inconsistent State When Opening a File](001-stale-content-race-when-opening-file.md)
- [#002: Global `ctrl+n` Shortcut Conflicts with Pi Built-in Keybinding](002-ctrl-n-shortcut-conflict.md)
- [#003: Phantom `x` Key Hint in Viewer Footer](003-phantom-x-key-in-viewer-hints.md)

### Performance & Resource Optimization
- [#006: Redundant Child Iteration in `findNode` Tree Search](006-findnode-redundant-tree-traversal.md)
- [#008: Periodic 3-Second Polling May Cause Overhead in Large Repositories](008-fs-polling-overhead.md)

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
