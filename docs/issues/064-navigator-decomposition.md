# Issue #064: `navigator.ts` Holds Six Responsibilities; Tree-Cache Counters Are Unsynchronized by Convention

- **Status**: Resolved (v0.7.2)
- **Type**: Technical Debt / Architecture
- **Severity**: Medium
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts)

---

## Description

Two structural findings from the repo-wide health sweep (run with Issue #062). Both are latent-risk items rather than live bugs — the suite is green — but they are the two largest structural liabilities in the codebase.

## Finding 1 — one class, six components (2,060 lines, 122 private fields, 74 methods)

`NavigatorOverlay` (`navigator.ts:155`) is the whole UI in a single class. The seams are already visible in its own method grouping:

| Responsibility | Members | Rows |
| :--- | :--- | :--- |
| Files pane | `filesRows` (`:497`), `buildFilesHeader` (`:1457`), `buildFileRow` (`:1466`), `ensureFilesCursorVisible*` (`:1437`–`:1443`) | ~1 |
| Git pane | `gitRows` (`:512`), `gitNavRows` (`:622`), `toggleCommitFamily` (`:638`), `buildGitRow` (`:1556`) | ~1 |
| Viewer pane | `buildRightRows` (`:1612`), `buildViewerHeader` (`:1768`), 5 viewer caches (`:214`–`:219`) | ~1 |
| Help modal | `HELP_ROWS` (`:123`), `composeHelp` (`:1985`) | ~1 |
| Frame / geometry | `overlayHeight` (`:1142`), `splitRows` (`:1242`) | ~1 |
| Input routing | `handleInput` (`:647`) dispatching to 6 mode/pane handlers | ~1 |

The row builders already take narrow inputs (`FilesRow`, `GitRow`, `leftW`), so extracting per-pane **view-model** modules is mechanical: the class keeps mutable state and input routing, each pane's render + memoization logic moves out and becomes independently testable. Expect roughly a halving of the file without touching the `setTree` / `setGitState` / `openRelPath` data contract documented in `AGENTS.md`.

Risk of staying as-is: every pane change re-opens the largest, highest-context file in the repo, and the render/width-safety surface is all-or-nothing in review.

## Finding 2 — cache invalidation rests on manually-bumped counters

Three counters gate memoization: `treeVersion` (`navigator.ts:229`), `gitTreeVersion` (`:233`), `searchVersion` (`:206`). `filesRowsCache` validity depends on `version === this.treeVersion` (`:502`, `:508`) — so the invariant *"every in-place tree mutation bumps `treeVersion`"* is load-bearing and enforced only by discipline: `treeVersion++` appears at `:811`, `:819`, `:824`, `:859` alongside 24 separate `this.touch()` calls.

A future expand/collapse path that mutates the tree and calls `touch()` without bumping the counter renders a stale files pane — silently, with no test failure if that path lacks coverage. That is exactly the class of bug Issue #022 fixed on the data side (`lastStampedProbe`); the UI side has no equivalent guard.

**Fix:** funnel mutations through two private methods — `toggleDir(node)` / `expandTo(node)` — that bump `treeVersion` internally (and `touch()`), then delete the raw `this.treeVersion++` sites. The counter becomes an implementation detail of the only two mutation entry points, and a new call site cannot forget it. Add a regression test that mutates through each entry point and asserts `filesRows` changes.

## Acceptance Criteria

- [x] Pane view-models extracted from `NavigatorOverlay` (files / git / viewer at minimum) with the data contract unchanged.
- [x] `navigator.ts` materially smaller; render width-safety suite still passes at 120×36 / 100×28 / 80×24 and narrow widths.
- [x] `treeVersion` is bumped only inside `toggleDir` / `expandTo` / `collapse`-style entry points; raw `this.treeVersion++` sites removed.
- [x] Regression test: a mutation through each entry point invalidates `filesRows`.
- [x] `npm run typecheck` and `npm test` green.

## Resolution

**Finding 1 — decomposition.** Five pure view-model modules now own the pane logic, each a function of a plain record with no state and no `this`:

| Module | Exports |
| :--- | :--- |
| `frame.ts` | `overlayHeight`, `bodyRows`, `splitRows`, `leftColumnWidth`, `useLeftColumn`, `filesArea`, `viewerArea`, `padTo`, `joinLeftRight`, `shortPath`, `truncateAndWidth`, `FOCUS_HINTS`, `MODE_HINTS`, `getFooterHint`, `buildTitleRow`, `buildFooterRow` |
| `files_view.ts` | `buildFilesRows`, `buildFilesHeader`, `buildFileRow`, `FilesViewContext` |
| `git_view.ts` | `buildGitRows`, `buildGitNavRows`, `buildGitHeader`, `buildGitRow`, `commitMarker`, `codeText` |
| `viewer_view.ts` | `renderViewerPane`, `buildViewerHeader`, `buildInputBar`, `buildSearchBar`, `buildFilterBar`, `buildCard`, `imageCardHints`, `canRenderMarkdown`, `paneContentWidth`, `paneContentArea`, `ViewerPaneView` |
| `help_view.ts` | `helpVisibleRows`, `helpMaxScroll`, `composeHelp` |

`navigator.ts` went **2,060 → 1,469 lines (−591, −28.7%)** and keeps every mutable field, cache, timer, `touch()`, input handler and the render-path side-effect steps (`getRenderedMarkdownLines`, `recomputeSearchIfNeeded`, `markSearch`, `cachedMaxLineWidth`, `cachedComputeRows`, `markRenderedLineMatches`, `maybeScheduleResizeReflow`, `scheduleReflow`, `currentImageGeometry`) executing in their original order; only already-computed data (marked rows, wrapped `display`, pre-styled `mdContent`, clamped offsets) crosses the seam. The public surface is unchanged, `HELP_ROWS` is re-exported from `navigator.ts`, and all five modules were registered in `package.json` `files` + `tsconfig.json` `include` (Issue #037 class of bug).

Equivalence was proven, not assumed: a temporary harness rendered 28 fixture states across 120/100/80/60-column widths, twice pre-refactor to confirm determinism, then compared post-refactor — **byte-identical**; the harness was deleted after use. Two deliberate deviations from the seam map: `FilesViewContext` gained `filesCursor` (the header's `n/N` counter needs it), and the footer's `mode === "filter"` dispatch stayed in `render()` (choosing `buildFilterBar` vs `buildFooterRow` there avoids a `frame`↔`viewer_view` import cycle) with identical output.

Five direct suites were added — `frame` (18), `files_view` (13), `git_view` (14), `viewer_view` (14), `help_view` (4) — which is the point of the extraction: the row builders and geometry are now testable without an overlay.

**Finding 2 — `treeVersion`.** Fixed alongside the #063 work: `toggleDir(node, expanded?)` and `expandTo(node)` are the only in-place tree mutation entry points and bump `treeVersion` internally (the field now documents that), with the four raw `this.treeVersion++` sites deleted. Three regression tests drive each entry point through `handleInput` in a **render → mutate → render** shape, so a missing bump would return the cached rows and fail the assertion; the git-pane case uses a signal that only appears in the files pane so a stale cache cannot pass by accident.

**Follow-up found while preserving behavior:** the viewer header's `col N` badge is built before the body's `hscroll` clamp, so it can show a requested offset the body refused — pinned by an existing test and recorded as [#065](065-viewer-header-hscroll-badge-stale-clamp.md) rather than silently changed in a refactor commit.

Final: `npm run typecheck` clean, 19 suites / 496 cases green (from 10 / 347). version 0.7.2.

## References

- Data-side precedent: [`docs/issues/022-applygitcodes-walk-every-tick.md`](022-applygitcodes-walk-every-tick.md)
- Contract to preserve: `AGENTS.md` ("Data contract" paragraph in Code layout)
- Width-safety rule: [`docs/issues/038-buildcard-width-overflow-narrow-panes.md`](038-buildcard-width-overflow-narrow-panes.md)
