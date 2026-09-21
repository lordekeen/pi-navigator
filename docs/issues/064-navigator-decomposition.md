# Issue #064: `navigator.ts` Holds Six Responsibilities; Tree-Cache Counters Are Unsynchronized by Convention

- **Status**: Open (Pending)
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

- [ ] Pane view-models extracted from `NavigatorOverlay` (files / git / viewer at minimum) with the data contract unchanged.
- [ ] `navigator.ts` materially smaller; render width-safety suite still passes at 120×36 / 100×28 / 80×24 and narrow widths.
- [ ] `treeVersion` is bumped only inside `toggleDir` / `expandTo` / `collapse`-style entry points; raw `this.treeVersion++` sites removed.
- [ ] Regression test: a mutation through each entry point invalidates `filesRows`.
- [ ] `npm run typecheck` and `npm test` green.

## References

- Data-side precedent: [`docs/issues/022-applygitcodes-walk-every-tick.md`](022-applygitcodes-walk-every-tick.md)
- Contract to preserve: `AGENTS.md` ("Data contract" paragraph in Code layout)
- Width-safety rule: [`docs/issues/038-buildcard-width-overflow-narrow-panes.md`](038-buildcard-width-overflow-narrow-panes.md)
