# Performance Audit — pi-navigator

Two parallel deep-dives (render/UI hot paths + async/data pipeline), top claims
spot-checked against source. Findings ranked by `frequency × cost`. No code changed.

---

## HIGH

### R1. `sliceStyled` is O(n²) in horizontal-scroll mode — `viewer.ts:80`
`const rest = styled.slice(i)` runs **inside the character loop**, allocating a copy
of the remaining string on every iteration. Over a long styled line this is quadratic,
and every visible line is sliced on **every render** while horizontal scroll is active.

**Fix:** index-based scan with a sticky regex (`/\x1b\[[0-9;?]*[ -/]*[@-~]/y`) and
`exec` on the full string — no suffix allocation. Preserves escape handling exactly.

### R2. Full-file `computeRows` re-run every render — `navigator.ts:752`, `viewer.ts:365–381`
The entire file (up to `MAX_HIGHLIGHT_LINES` = 5000) is re-wrapped / re-sliced on
**every keystroke** (scroll, cursor move, filter type). Cost scales with file size,
not viewport size.

**Fix:** cache display rows keyed on `(relPath, mtime, width, wrapMode, hScroll)`;
re-derive only the visible window on scroll. Invalidate on file change / resize.

### R3. Search re-scans every render + O(lines×matches) marking — `navigator.ts:741,793–806`, `viewer.ts:339–357`
With an active in-file query, `searchLines` reruns each render and `markSearch` does a
`.some()` over matches per line. Typing in the search box re-derives the whole result set
per keystroke and then re-walks it during row build.

**Fix:** dirty-flag the search result (recompute only when query/content/width changes);
store a `Map<lineIndex, Match[]>` so `markSearch` is O(1) per line.

### A1. Serial git subprocess spawns per poll tick — `git.ts:151–170`
`readGitState` awaits `branch --show-current`, `rev-list --left-right --count`,
`status --porcelain -z`, and `log -n20` **strictly sequentially**. Four independent
fork+execs (each up to a 3s timeout) on **every 3s refresh tick** while the overlay is
open. Worst-case serial ≈ 4× parallel.

**Fix:** `Promise.all([branch, revList, status, log])` — 4 rounds → 1 round. Also merge
`detectRepo`'s two rev-parses (`git.ts:73–79`) into one `git rev-parse --show-toplevel
--show-prefix`; `detectRepo` is called every tick (`index.ts:114`), not just on open.

### A2. No per-file viewer cache; highlight blocks the main thread — `viewer.ts:280–337,180–189`
Every file open re-runs stat → sniff → read → CR-normalize → `expandTabs` →
`highlightCode`. Nothing is memoized by path/mtime, so toggling between two files
(or re-opening) redoes the whole pipeline. `highlightCode` is synchronous despite the
`await`, so a near-cap file (1 MB / 5000 lines) can stall the TUI event loop for
hundreds of ms.

**Fix:** small `Map<relPath, {mtimeMs, size, ViewerFile}>` cache, invalidated by the
existing mtime poll (`index.ts:170–180`). Eliminates repeat cost without an async
highlighter. Optionally yield between line chunks for a fresh 1 MB highlight.

---

## MEDIUM

### R4. `maxLineWidth` recomputed per render — `viewer.ts:395–401`, `navigator.ts:746`
`stripAnsi` + `Array.from` allocations × every line (up to 5000) every keystroke, just
to size the horizontal scrollbar.

**Fix:** cache per marked-file version (same key as R2).

### R5. `filesRows` / `gitRows` rebuilt 2–3× per render — `navigator.ts:214–253,398–400,610`
`gitNavRows()` re-invokes `gitRows()`; the flatten/filter arrays are built multiple
times per render pass.

**Fix:** memoize per `(tree, gitState, hidden, filter, cursor)` state key.

### R6. `filterRows` lowercases every path per keystroke — `tree.ts:342–380`
~2 string allocations per file per filter keystroke.

**Fix:** precompute `lowerPath` on the `FileNode` at build time.

### A3. Git availability cache defeated on every manual refresh — `index.ts:108`
The overlay's `refresh` handler calls `resetGitAvailabilityCache()`, so each `r` key /
state-change re-spawns `git --version` (`git.ts:56–60`). The binary doesn't vanish
mid-session.

**Fix:** drop the reset (or only reset after an ENOENT failure).

---

## LOW

### R7. `hasChanges` recursive scan per dir row per render — `navigator.ts:506`, `tree.ts:300–303`
**Fix:** precompute change flags on `setTree` / `applyGitCodes`.

### R8. Redundant `visibleWidth` / `truncateToWidth` scans — `navigator.ts:260–275,533–540,858–864`
**Fix:** a width-returning truncate variant to avoid a second pass.

### A4. Full-tree `applyGitCodes` walk every 3s even when status unchanged — `index.ts:164–172`
**Fix:** skip when `gitTreeProbe` equals the previous probe.

### A5. Filesystem walk is a serial DFS — `tree.ts:65–110`
Bounded by `MAX_TREE_DEPTH=6` and `IGNORED_NAMES`; the probe design means it only
re-walks on actual change (not on idle/hidden/filter). **Fix if needed:** `Promise.all`
over child directories per level.

### A6. Unbounded git boundary — `git.ts:38`
`maxBuffer: 4MB`; `status -uall` lists every untracked file with no cap. Acceptable for
v1; consider `-unormal` and a documented entry cap.

---

## Clean (no action)
- `makeNavigatorTheme` built once (`theme.ts:26`); geometry helpers; cursor-movement math.
- Tab expansion + CR normalization are O(n) only on open and correctly capped.
- Open-file mtime stat is a single stat/tick; probe/signature gating avoids full walks /
  `ls-files` on idle ticks — well designed.

---

## Suggested fix order (impact / effort)
1. **A1** — `Promise.all` the git spawns + merge rev-parses. Large win, ~10 lines.
2. **R2 + R3 + R4** — one display-row + search-result cache keyed on
   `(path, mtime, width, wrap, hScroll)`. Fixes the three biggest render costs together.
3. **R1** — sticky-regex `sliceStyled`. Small, self-contained, removes a quadratic.
4. **A2** — per-file viewer cache. Removes repeat highlight cost.
5. **R5 / R6 / A3** — memoize row rebuilds, precompute `lowerPath`, drop the cache reset.
