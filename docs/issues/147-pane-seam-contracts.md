# Issue #147: Pane Seam Contracts — One Composer Budget, One Pane Window, One Clamped Offset

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Medium
- **Component(s)**: `frame.ts`, `git_view.ts`, `navigator.ts`, `viewer_view.ts`, tests

## Description

The architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #7) found pane-layout
arithmetic mirrored by callers and two order-dependent seams. Re-validated against
`main@35680cb` (v0.14.10, after Issues #140–#146):

1. **The composer's budget is copied, not queried.** `joinLeftRight` (frame.ts) reserves one
  gap cell via `maxLeft = Math.max(0, width - rightW - 1)`. Two callers clone that
  accounting instead of asking for it: `buildFooterRow`'s `fitHint` budget is
  `innerW - visibleWidth(right) - 2` (right + gap + its own leading space), and
  `buildGitHeader`'s counter guard is `visibleWidth(label) + visibleWidth(info) +
  visibleWidth(counter) + 1 <= leftW` — the `+ 1` explained by #138's comment. The other six
  `joinLeftRight` call sites are pass-through. #113 and #138 were the same off-by-one fixed
  caller-side, twice.
2. **Pane-area arithmetic exists twice with different floors.** Input
  (`handleFilesInput` / `handleGitInput` / `handleViewerInput` paging and
  `ensureFilesCursorVisible`) reads `filesArea` / `gitArea` / `viewerArea`, floored at 2;
  render computes `Math.max(1, heights.filesH - 1)` / `Math.max(1, heights.gitH - 1)` /
  `Math.max(1, body - 1)`, floored at 1. The audit's "benign only while body ≥ 4" refines
  to the verified fact: the two floors produce different values only at group height 2, and
  that zone is **unreachable in render** — `MIN_OVERLAY_HEIGHT` 13 forces `body ≥ 8`, where
  every group height is ≥ 4 — so the divergence is latent rather than observable (input
  still computes areas while the compact notice is shown). It is the same class as the
  crashes-fixed-twice pattern: two expressions that must agree by convention, benign until a
  guard moves. `filesArea(…, "git-viewer")` additionally returns 2 for a pane the layout
  does not render.
3. **The #065 clamp-order invariant is prose.** The text branch clamps `this.viewHscroll`
  (navigator.ts:1710) and only then does the `ViewerPaneView` record (navigator.ts:1762)
  read the field — body rows (`viewer_view.ts:208`) and the `col N` badge (`:249`) agree by
  position, with a comment warning not to move the record. Vertical scroll repeats the
  pattern: `viewerScrollWindow` feeds both the record's position readout and `render()`'s
  right-border scrollbar. Both are pinned only through `NavigatorOverlay` (the #065 suite);
  no pure seam exists.

## Frozen Design (2026-10-04, grilling round 1)

**One composer budget query, one pane-area primitive feeding render and input, and one
clamped viewer window every consumer reads.**

1. **The composer exposes its budget (`frame.ts`).** New
  `leftBudget(width: number, right: string): number` returning exactly today's
  `Math.max(0, width - visibleWidth(right) - 1)` — the widest the left segment may be while
  the right segment survives with its gap cell. `joinLeftRight` uses it for `maxLeft`;
  `buildFooterRow` computes its `fitHint` budget as `Math.max(0, leftBudget(innerW, right) -
  1)` (the `-1` is the hint's own leading space, not composer accounting);
  `buildGitHeader`'s guard becomes
  `visibleWidth(label) + visibleWidth(counter) <= leftBudget(leftW, info)`. Changing the
  composer's gap accounting then moves every caller at once.

2. **One pane-area primitive (`frame.ts`).** New
  `paneArea(groupHeight: number): number` = `Math.max(1, groupHeight - 1)` — the data rows a
  pane group of that height draws (its header takes one). `filesArea` / `gitArea` /
  `viewerArea` keep their `(termRows, layout)` signatures but delegate to it
  (`paneArea(layoutRows(body, layout).filesH / .gitH)` and `paneArea(bodyRows(overlayHeight(
  termRows)))`), and `buildLeftRows` / `buildRightRows` call `paneArea` directly on the
  heights they already hold (`heights.filesH`, `heights.gitH`, `body`). Render and input then
  share one floor (1 — the render ceiling) and one expression. This is a structural
  unification: no user-visible frame changes (the divergent zone is unreachable in render),
  and the only helper-value change is the hidden-pane `filesArea(…, "git-viewer")` dropping
  from 2 to 1.

3. **One viewer window (`viewer_view.ts`).** New pure
  `viewerWindow(input: ViewerWindowInput): ViewerWindow` where
  `ViewerWindowInput = { requestedScroll; requestedHscroll; total?; count?; maxHscroll?;
  rowOffset? }` and `ViewerWindow = { viewScroll; hscroll; scrollWindow: { rowOffset; count;
  scroll; total } | null }`. It clamps `viewScroll` into `[0, max(0, total - count)]` when
  `total`/`count` are given (passthrough otherwise), clamps `hscroll` into `[0, maxHscroll]`
  when `maxHscroll` is given (passthrough otherwise), and produces `scrollWindow` only when
  `rowOffset` is given and `total > count` (the #137 §3/§4 overflow window). Every
  `buildRightRows` branch assigns a hoisted `let window: ViewerWindow` — chafa image:
  `total = verdict.lines.length, count = area`, no `rowOffset` (images carry no scrollbar);
  native image: `requestedScroll: 0` plus the same totals (its pin stays exact); rendered
  markdown: `total = mdLines.length, count = contentArea, rowOffset = 1 + noticeRows`;
  text: additionally `maxHscroll = maxLineWidth - contentW`; card / no file: passthrough.
  The class writes `this.viewScroll` / `this.viewHscroll` / `this.viewerScrollWindow` back
  from the window (the top-of-method reset is deleted — the assignment is the single
  writer), builds `mdContent` from `window.viewScroll`, and the `ViewerPaneView` record
  consumes `window.viewScroll`, `window.hscroll` and a `scrollInfo` derived from
  `window.scrollWindow`. Because strict TypeScript enforces definite assignment, moving the
  record above the branch that produces the window becomes a compile error — the #065
  invariant is structural, not remembered. `render()`'s scrollbar keeps reading
  `this.viewerScrollWindow` (now the window's assignment).

4. **Tests.** Strict equivalence: `frame.test.ts` gains `leftBudget` and `paneArea` cases and
  re-vocabularizes the area floor pins (2 → 1; the pinned 12/24 values are unchanged, the
  hidden-pane `git-viewer` cases become 1); `viewer_view.test.ts` gains a pure `viewerWindow`
  suite (overshoot clamp, passthrough, hscroll clamp vs passthrough, window only on
  overflow, native's 0 pin); `navigator.test.ts` gains one small-terminal case pinning
  render/input agreement at the floor; the #065 suite and every render width-safety pin
  (120/100/80) stay byte-identical; `git_view.test.ts`'s #138 31/32 boundary pin stays green
  with the guard now querying `leftBudget`.

5. **Scope fences.** Out: candidate #8's items (moving frame assembly/separator/scrollbar
  math out of `navigator.render()`, deriving footer hint keys from the keybinding table,
  splitting `frame.ts`), a richer composer API beyond the budget query, and all UI behavior.
  No new dependencies; no hardcoded colors.

## Acceptance Criteria

- [x] `leftBudget` is the only expression of `joinLeftRight`'s gap accounting; the footer's
  `fitHint` budget and the git header's counter guard query it, and no caller adds the gap
  cell by hand.
- [x] `paneArea` is the only pane-area expression; `filesArea` / `gitArea` / `viewerArea`
  delegate, `buildLeftRows` / `buildRightRows` call it directly, and no render/input floor
  can disagree.
- [x] `viewerWindow` is the one clamp for viewer scroll and hscroll; each render branch
  assigns one window; the record, the header badge/readout and the frame scrollbar read the
  window's values, and moving the record above its branch fails to compile (verified: a
  probe consuming it above the branches fails `tsc` with TS2454).
- [x] The `viewerScrollWindow` reset at the top of `buildRightRows` is gone (assignment is
  the single writer).
- [x] `#065`'s observable contract is unchanged; the existing suite passes.
- [x] Render output is byte-identical at 120/100/80 columns and in the #138 / #135 L4 pin
  tests (differential proof: HEAD's unmodified suite over the new sources fails only the
  mandated floor pin).
- [x] No non-null assertions; `npm run typecheck` and `npm test` green (903 cases).
- [x] No rendered frame changes. Helper values move 2 → 1 only in the compact
  "terminal too small" regime and for panes the layout does not render; the one input-path
  change lives in that same invisible regime (the compact-regime git paging step), so
  nothing user-visible distinguishes the build at any size that draws a frame.

## Resolution

Implemented as designed (2026-10-04), version 0.14.11:

- `frame.ts` — `leftBudget(width, right)` is the composer's one gap-accounting query:
  `joinLeftRight` uses it for `maxLeft`, `buildFooterRow`'s `fitHint` budget is
  `Math.max(0, leftBudget(innerW, right) - 1)` (the `-1` is the hint's own leading space),
  and `buildGitHeader`'s guard is `visibleWidth(label) + visibleWidth(counter) <=
  leftBudget(leftW, info)` — the hand-added gap cell is gone. `paneArea(groupHeight) =
  Math.max(1, groupHeight - 1)` is the one pane-area expression: `filesArea` / `gitArea` /
  `viewerArea` delegate to it and `buildLeftRows` / `buildRightRows` call it directly on the
  heights they hold.
- `viewer_view.ts` — the pure `viewerWindow(input)` clamps the viewer's vertical offset
  into `[0, total - count]`, the horizontal offset into `[0, maxHscroll]`, and produces the
  scrollbar window only on overflow; omitted clamps are pass-throughs.
- `navigator.ts` — `viewerScrollWindow` is typed `ViewerScrollWindow | null`; the
  top-of-method reset is deleted; every `buildRightRows` branch (image, rendered markdown,
  text, card, no file) assigns one hoisted `viewerWin` and writes the three scroll fields
  back from it; the markdown content rows are built from `viewerWin.viewScroll`; the
  `ViewerPaneView` record reads the window's `viewScroll` / `hscroll` / `scrollWindow`, and
  `render()`'s border scrollbar reads the field assigned from the same window. Moving the
  record above the branches is a compile error (definite assignment).

Verification: `npm run typecheck` clean; `npm test` **21 suites / 903 cases** (893
baseline, +10: `paneArea`, `gitArea`, two `leftBudget`, six `viewerWindow`). The worker's
differential proof — HEAD's unmodified suite over a tree with only the four new source
files — passed 892/893, the sole failure being the mandated `filesArea(36, "git-viewer")`
2 → 1 pin; every 120/100/80 width pin, the #138 31/32 pin, the #135 L4 pins and the #065
suite pass unchanged. No navigator-level observable pin exists: at every size that draws a
frame the old floors never differed, so `frame.test.ts` carries the floor pin instead of an
invented case.

One honest scope note recorded against criterion 8: the only input-path change (hidden-pane
and compact-regime `gitArea` 2 → 1) lives where `render()` draws no pane; input is still
routed there, so the compact-regime git paging step changes while remaining invisible until
a resize. No rendered frame changes at any size.

## References

- Architecture review of 2026-10-03, candidate #7:
  [`docs/audits/architecture-review-2026-10-03.html`](../audits/architecture-review-2026-10-03.html)
- [#065](065-viewer-header-hscroll-badge-stale-clamp.md) — the `col N` badge/clamp contract
  this makes structural
- [#113](113-git-group-row-ignores-leftw.md) / [#138](138-git-header-label-truncated.md) —
  the same off-by-one fixed caller-side, twice
- [#137](137-e-style-chrome-migration.md) — the scrollbar window and the footer/input-bar
  hint tables this preserves
- [#135](135-ui-audit-polish-batch.md) — the `fitHint` whole-pair budget
- [#119](119-overlay-layout-modes.md) — the layout rows the pane areas derive from
