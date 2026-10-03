# Issue #137: E-Style Chrome Migration (Typed Hint Pairs, Title Pill, Rounded Frame, Viewer Scrollbar + Readout)

- **Status**: Resolved
- **Type**: Feature / UI Consistency
- **Severity**: Medium
- **Components**: [`frame.ts`](../../frame.ts), [`navigator.ts`](../../navigator.ts), [`theme.ts`](../../theme.ts), [`viewer_view.ts`](../../viewer_view.ts), [`help_view.ts`](../../help_view.ts), [`README.md`](../../README.md), [`docs/plans/ui-standards-report.md`](../plans/ui-standards-report.md)
- **Found by**: UI review against the `mock/` reference prototype's variant **E** (`C + pi-main hints & title pill`, `mock/render.js:304`) — the variant that folds in pi-main's `keyHint()` hint pairs, a title pill, and an explicit position/overflow line

## Description

The overlay's chrome predates the E-variant mock that the UI review selected as the target
look. Five transfers, each small and independent, plus the documentation that describes them:

1. **Typed hint pairs.** The footer tables (`FOCUS_HINTS`, `MODE_HINTS`) were `"  "`-separated
   strings; pairs that carry no action word (`g G Home/End`, bare `Tab`) had no label at all,
   and the input-bar placeholders re-stated the same items as separate literals, so the two
   surfaces could — and at one point did — drift. The tables become `HintPair[]`
   (`{ keys, label }`), the footer renders `dim(keys) + muted(" " + label)` joined by a dim
   ` · ` (pi-main's own `keyHint()` shape), and `plainHint()` flattens the same pairs for the
   placeholders.
2. **Title pill.** The product name moves out of the title row into the top border:
   `╭── pi-navigator ──…╮`. The row below becomes a subtitle (path + branch/counters) and no
   longer repeats the name. Row count and geometry are unchanged.
3. **Rounded corners.** Every bordered surface uses `╭ ╮ ╰ ╯` for corners; strokes and the
   junction tees stay `─`/`│`/`├ ┤ ┼` (there are no curved tees). Surfaces: the outer frame's
   top/bottom borders, the too-small refusal notice, the `?` help modal, and the viewer's
   metadata card.
4. **Viewer position readout.** An overflowing viewer states its window in the header meta,
   as the last item: `showing 1–24 of 100` (en dash, plain numbers).
5. **Viewer scrollbar.** The frame's right border column doubles as the scrollbar while the
   text-like content overflows: track `│` (`scrollbarTrack`), proportional thumb `█`
   (`scrollbarThumb`). Display-only — no timers, no fade, no mouse handling.
6. **Esc in the footer.** The close hint advertises `q Esc` — the default cancel
   binding, matching `help.ts` and the host's own "Esc" chrome language. Input
   still goes through `matchesCancel`, so a remap of `tui.select.cancel` still
   closes even though the hint is fixed.

## Decisions

- **View-model types live in `frame.ts`** (`HintPair` alongside `TitleRowView`/`FooterView`);
  `frame.ts` stays pure and pi-coding-agent-import-free (#064). The close pair hardcodes `q Esc`
  (the default cancel binding); the host `keyText` seam was removed after the host's canonical
  form (`escape/ctrl+c`) proved to contradict `help.ts`'s `q Esc` and cost footer width —
  remaps still work because input goes through `matchesCancel`.
- **Hint content is preserved item-for-item**; the three label-less items gained minimal labels:
  files `g G Home/End` → `jump`, files bare `Tab` → `pane`, viewer `Ctrl+d/u PgUp/PgDn` → `page`.
  Other items split leading token(s) as keys and the remainder as the label
  (`j k move`, `Enter open/diff`, `type to search`).
- **Issue #135 L1 is preserved exactly**: the `m mode` pair is removed for files that cannot
  render as markdown, now as a whole pair rather than a string slice.
- **`fitHint` drops whole trailing pairs** against a budget measured on the plain
  `keys + " " + label` text; it returns `[]` when not even the first pair fits (the row is then
  padded back to width) — the existing contract, pair-shaped.
- **Degradation rule for the pill**: when the fill would be `< 1`
  (`fill = innerW - 2 - visibleWidth(" title ")`), the top border degrades to a plain rounded
  border and the title is dropped whole. In production this branch is unreachable — the frame
  floor (`MIN_OVERLAY_WIDTH = 40`) leaves `innerW ≥ 38`, far above the 16 cells a pill needs —
  so the name is never lost in a real overlay; the guard exists so `buildTopBorder` is
  width-safe for any caller.
- **Readout and scrollbar are overflow-only**: `scrollInfo` is `null` unless
  `total > contentArea` in a text-like branch, and the scrollbar additionally hides while the
  help modal is open. Card/loading/empty/image-card branches never get either.
- **The scrollbar window is render-local state**: `buildRightRows` records the clamped window
  (`rowOffset`, `count`, `scroll`, `total`) it already computed, and the frame assembly reads it
  in the same pass, so the thumb cannot drift from the clamp. It is not a cache and
  `invalidate()` has nothing to clear for it.
- **Reader numbers come from the clamp**: `start = viewScroll + 1`,
  `end = min(viewScroll + contentArea, total)`.

## Derived rules (derived from the mock, held as requirements)

- Pill geometry: `fill = innerW - 2 - visibleWidth(titleWithSpaces)` so the top border's total
  visible width is `innerW + 2`; measured with `visibleWidth`, never `.length`.
- Scrollbar geometry: `thumbH = max(1, round(count * count / total))`,
  `thumbStart = round(scroll / max(1, total - count) * (count - thumbH))` where `count` is the
  viewer's content-row height — the mock's formulas (`mock/render.js:568-569`).
- No hardcoded colors and no hand-written `\x1b[`: every style goes through `NavigatorTheme`.
- No new rows: `overlayHeight`/`bodyRows`/`OVERLAY_HEIGHT_RATIO` and the #130 single-source
  geometry are untouched.

## Out of scope (explicitly not part of this migration)

- The §4.2 focus border-segment (accenting a focused pane's border segment).
- Scrollbars for the files or git panes.
- Restyling the settings panel.
- Mouse interaction with the scrollbar (no click/drag handling is added).
- Multi-line hint wrapping — the footer stays one row.
- The mock's `❯` title glyph before the product name.
- Severity-coloured modal borders.

## Acceptance Criteria

- [x] Footer hints are typed pairs; the three label-less items have labels; item content unchanged
- [x] `getFooterHint` returns pairs and #135 L1 still drops `m mode` for non-markdown files
- [x] `fitHint` is pair-aware and returns an empty result when nothing fits
- [x] `plainHint` is the input-bar placeholder source (no drift between footer and placeholders)
- [x] `buildTopBorder` draws the pill with total width `innerW + 2` and degrades below fill 1
- [x] `buildTitleRow` no longer carries the product name; row count unchanged
- [x] All four bordered surfaces use rounded corners; strokes and tees unchanged
- [x] Viewer readout appears only on overflow, with the clamped start/end and the total
- [x] Scrollbar track/thumb render on the viewer's content rows only, overflow-only, help-suppressed
- [x] Scrollbar styles map to `scrollbarTrack`/`scrollbarThumb` (no hardcoded colors)
- [x] The footer's close pair hardcodes `q Esc` (the default cancel binding)
- [x] Docs, index, and README updated; `package.json` 0.13.0 → 0.14.0
- [x] `npm run typecheck` and `npm test` green

## References

- Mock reference: `mock/render.js` variant E (`profileFor("E")`, `pillTop`, `hintPairTokens`,
  the scrollbar formulas) — foreign reference material, never imported by the extension.
- Precedent: [#135](135-ui-audit-polish-batch.md) (L1 hint applicability, L4 whole-item fitting),
  [#064](064-navigator-decomposition.md) (pure pane view-models).

## Resolution

Landed as specified, over six source modules and four suites; no row count, geometry constant,
or unrelated behavior changed.

- **`frame.ts`** — `FRAME_CORNERS`, `buildTopBorder`, `HintPair`, `plainHint`; `FOCUS_HINTS`/
  `MODE_HINTS` are pair tables; `getFooterHint` returns pairs (whole-pair removal for #135 L1);
  `fitHint` drops whole trailing pairs; `buildFooterRow` composes `dim(keys) + muted(" label")`
  joined by `dim(" · ")` (the close pair advertises `q Esc`, the default cancel key);
  `buildTitleRow`'s left segment is the path only.
- **`navigator.ts`** — render() draws `buildTopBorder`, rounded frame corners, the refusal
  notice corners, and the right-border scrollbar cells; `buildRightRows` records
  `viewerScrollWindow` and builds `scrollInfo` from the clamp.
- **`theme.ts`** — `scrollbarTrack`/`scrollbarThumb` delegate to the host tokens (both are
  optional tokens the host Theme backfills from `muted`/`text`, so no theme can throw here).
- **`viewer_view.ts`** — `scrollInfo` on `ViewerPaneView`, the readout as the header's last
  meta item, rounded card corners, placeholders via `plainHint`.
- **`help_view.ts`** — rounded modal corners.
- **Docs** — this issue, the index, `ui-standards-report.md` §3.1/§4.1 (including the stale
  "border characters styled `dim`" note, which is `borderMuted` in code), and README.md's
  overlay diagram + chrome sentences.

Verified: `npm run typecheck` green; `npm test` green (20 suites / 801 cases).
