# Issue #148: Frame Split-Brain — Layout Math, Assembly, and One Binding Table

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Medium
- **Component(s)**: `frame.ts` (new `layout.ts`), `help.ts`, `navigator.ts`, `viewer_view.ts`, tests

## Description

The architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #8) found `frame.ts`
serving two consumer sets, frame assembly stranded in `navigator.render()`, and the
footer's key hints maintained as a third key source beside the help table and the input
literals. Re-validated against `main@1ccd37c` (v0.14.11):

1. **`frame.ts` serves two consumer sets** (505 lines, 35 exports): navigator-only layout
  math (`overlayHeight`, `bodyRows`, `useLeftColumn`, `leftColumnWidth`, `paneArea`,
  `filesArea`/`gitArea`/`viewerArea`, `splitRows`, the layout derivations
  `layoutPanes`/`layoutRows`/`visiblePanes`/`initialFocus`/`cycleFocus`, lines 54-184), and
  shared composition (`padTo`, `truncateAndWidth`, `shortPath`, `isImageLine`,
  `leftBudget`, `joinLeftRight`, `FRAME_CORNERS`, `buildTopBorder`) plus chrome and the
  hint tables, imported by all four view modules. Only `navigator.ts` (and
  `render.test.ts` for `leftColumnWidth`) consumes the layout math.
2. **Frame assembly lives in `navigator.render()`**: the compact "terminal too small"
  notice (1368-1378), the top border / title row / `├──┤` separator, the body loop with
  the files↔git separator and the inline scrollbar thumb closure (1406-1438), the
  footer/filter-bar wrapper and the bottom border. Only builders (`buildTopBorder`,
  `buildTitleRow`, `buildFooterRow`) live in `frame.ts`; the joining does not.
3. **Three hand-maintained key sources**: `NAVIGATOR_KEYBINDINGS` (help.ts, 19 rows) →
  `HELP_ROWS` → the `?` modal; `FOCUS_HINTS`/`MODE_HINTS` (frame.ts, short forms like
  `"g G Home/End"`) → the footer and the input-bar placeholders
  (`viewer_view.ts:355,371`); and the input handlers' literals. Only `q Esc close` is
  parity-tested (render.test.ts:1334). The drift class is real history: #003 (phantom `x`),
  #004 (search-mode `n`/`N`), #005 (fallback chain). The two tables' spellings differ by
  design (footer abbreviations vs modal display) and the mode hints carry contextual
  entries (`type to filter`, `Enter apply`) that no binding row owns.

## Frozen Design (2026-10-04, grilling round 1)

**Split navigator-only layout math out of `frame.ts`, move frame assembly beside the
composition primitives, and make the binding table the one source of help display and
footer short forms.**

1. **`layout.ts` — navigator-only geometry.** Move the 15 layout exports (listed in the
  Description) to a new `layout.ts` with their existing docs: it depends only on
  `constants.ts` and `types.ts` (no theme, no `visibleWidth`, no `viewer.ts`). `frame.ts`
  keeps composition + chrome + hints + assembly; `navigator.ts` imports the geometry from
  `./layout` and everything else from `./frame`; the four view modules' import paths are
  unchanged. Geometry tests move to a new `test/layout.test.ts` (the suite count goes
  21 → 22; README/AGENTS updated at closeout) and `render.test.ts` imports
  `leftColumnWidth` from `../layout`.

2. **Frame assembly (`frame.ts`).** New pure `composeFrame(view)` returns the framed lines
  from the top border through the bottom border, given
  `{ theme, innerW, body, leftW, filesH, showSeparator, leftRows: string[] | null,
  rightRows, scrollWindow, title: { cwd, git, home }, footerRow }`; the scrollbar thumb
  math becomes the pure `buildScrollbarBorder(i, scrollWindow, theme)` and the compact
  refusal becomes `buildCompactFrame(width, theme)`. `navigator.render()` keeps the cache
  check, geometry calls, row building, the filter-bar-vs-footer decision, the help
  overlay (`composeHelp` writes into the returned lines) and the reflow trigger. Module
  tests then pin separators, the scrollbar rows, the no-left-column join and the compact
  notice directly.

3. **One binding table (`help.ts`).** `KEY_BINDINGS: readonly KeyBinding[]` with
  `{ id, keys (modal display), description?, help: boolean, footer?: { keys, label } }`:
  the 19 existing rows keep their modal bytes (`help: true`, existing `id`s) and gain the
  footer short forms the contexts advertise; the contextual entries the modal never shows
  (`filter-apply` `Enter apply`, `clear` `Esc clear`, `help-close` `q Esc ?`, …) become
  `help: false` rows. `HintPair` and `plainHint` move to `help.ts` with the pair
  vocabulary. `NAVIGATOR_KEYBINDINGS` becomes the derived `help`-only projection, so
  `HELP_ROWS` and `help.test.ts` are untouched. Contexts are ordered `{ id, label? }`
  lists — `FOCUS_BINDINGS` / `MODE_BINDINGS` — where the row owns the key spelling and the
  context curates its short label (`open` → `"open"` in files, `"open/diff"` in git;
  `move` → `"scroll"` in viewer; `filter-search` → `"filter"`/`"search"`). The resolved
  `FOCUS_HINTS` / `MODE_HINTS` pair tables are derived from those lists at module load,
  byte-identical to today (the placeholders consume the same resolved tables). A pair can
  no longer exist without a binding row; a phantom key now requires editing the row that
  also carries the modal display.

4. **Tests.** `test/layout.test.ts` takes the moved geometry describes; `test/frame.test.ts`
  keeps composition/chrome plus new `composeFrame`/`buildCompactFrame`/`buildScrollbarBorder`
  cases; `test/help.test.ts` gains the table parity (every context ref resolves, every
  advertised pair comes from a row, the derived projections equal today's bytes) and
  `test/navigator.test.ts` gains the dispatch-liveness suite: for every advertised
  normal-mode pair (files/git/viewer) its first key is driven through the real overlay and
  must produce an observable effect — the #003 phantom-key class fails here because a dead
  key renders identically. Existing pins keep their bytes; `q Esc` stays in the render
  test.

5. **Scope fences.** Dispatch stays literal: deriving the handlers from the table needs
  per-context action semantics and is deliberately out of scope (the liveness suite is the
  closure for the advertised keys). Out too: candidates #9/#10, any behavior change — every
  rendered byte, width, and input outcome stays identical. No new runtime dependencies;
  `help.ts` stays pi-free.

## Acceptance Criteria

- [x] `layout.ts` exists with exactly the layout exports; `frame.ts` has no layout math and
  `navigator.ts` is its only production importer; the view modules' imports are unchanged
  (`frame.ts` itself imports `visiblePanes` from `./layout` for the footer pane labels).
- [x] `composeFrame` is the one frame-assembly path; the compact notice and scrollbar
  border builders are pure and module-tested; `render()` no longer joins separators or
  draws the border inline.
- [x] `KEY_BINDINGS` is the one key declaration; footer pairs resolve from binding ids;
  no free key string exists outside a row's `keys`/`footer.keys` (the contextual labels
  are per-context data). `resolveBindings` throws on a ref without a footer row.
- [x] The `?` modal, footer, and input-bar placeholder bytes are identical to today;
  `HELP_ROWS` and `NAVIGATOR_KEYBINDINGS` projections are unchanged (the 19 modal rows
  were mechanically diffed against HEAD, 19/19 byte-identical).
- [x] The dispatch-liveness suite drives the advertised normal-mode keys through the real
  overlay and each produces an observable effect; an injected phantom binding failed the
  suite red before removal.
- [x] No non-null assertions; `npm run typecheck` and `npm test` green (22 suites / 927
  cases).
- [x] README/AGENTS document 22 suites and the new module at closeout.

## Resolution

Implemented as designed (2026-10-04), version 0.14.12:

- **`layout.ts` (new, 164 lines)** — the 15 navigator-only geometry exports moved
  verbatim (docs included); dependencies are `constants.ts` + `types.ts` only, so no theme
  or width measurement can be pulled in by a geometry import. `frame.ts` (383 lines) is
  now composition + chrome + assembly: `buildCompactFrame(width, theme)`,
  `buildScrollbarBorder(i, scrollWindow, theme)` and the pure `composeFrame(view)`
  (top border through bottom border, byte-identical to the old inline assembly);
  `NavigatorOverlay.render()` keeps the cache, geometry calls, row building, the
  filter-bar-vs-footer decision, the help overlay and the reflow trigger.
- **`ViewerScrollWindow` moved to `types.ts`** so `frame.ts` draws the border without
  importing `viewer_view.ts`; `ViewerWindow`/`viewerWindow` stay in `viewer_view.ts`.
- **`help.ts` is the one key declaration.** `KEY_BINDINGS` holds the 19 modal rows
  (identical `id`/`keys`/`description` bytes) plus 11 `help: false` contextual rows; each
  advertised binding carries its short `footer` form. `HintRef` + `FOCUS_BINDINGS` /
  `MODE_BINDINGS` are the ordered contexts (the row owns the key spelling, a ref may
  override only the label), `resolveBindings` throws on a ref with no footer row, and the
  derived `FOCUS_HINTS` / `MODE_HINTS` plus the derived `NAVIGATOR_KEYBINDINGS` projection
  are byte-identical to the pre-split tables (the 19 modal rows were mechanically diffed,
  19/19 identical). `HintPair`/`plainHint` moved here; `getFooterHint` keeps its
  `markdownApplicable` drop, addressed by binding id instead of key spelling.

Tests: new `test/layout.test.ts` takes the six moved geometry describes (18 cases);
`test/frame.test.ts` keeps the composition/chrome pins and gains
`composeFrame`/`buildCompactFrame`/`buildScrollbarBorder`; `test/help.test.ts` gains the
one-table parity (help-only projection equality, every context ref resolving to a footer
row, the explicit pre-change hint bytes); `test/navigator.test.ts` gains the
**dispatch-liveness suite** — for every advertised normal-mode pair in files/git/viewer the
first key is driven through the real overlay and must change the frame or close it, with
per-key fixtures (hidden entry, commit family, 200-line markdown). Injecting a phantom `x`
binding failed the suite (`files: "x" (phantom) rendered identically — dead advertised
key`) before removal, closing the #003 class by effect, not by convention. Suite count
21 → 22; README/AGENTS updated (including the `(22 files)` line the docs guard derives).

Verification: `npm run typecheck` clean; `npm test` **22 suites / 927 cases** (903
baseline). All pre-existing width/byte pins are unchanged and green.

One follow-up caught here and fixed in the same closeout: `package.json`'s `files` array
listed every shipped source file but not the new `layout.ts`, so a publish would have
omitted it — added alongside the version bump.

## References

- Architecture review of 2026-10-03, candidate #8:
  [`docs/audits/architecture-review-2026-10-03.html`](../audits/architecture-review-2026-10-03.html)
- [#003](003-phantom-x-key-in-viewer-hints.md) / [#004](004-search-navigation-keybindings-inconsistency.md) /
  [#005](005-hints-lookup-fallback-chain.md) — the phantom-key drift history this closes
- [#137](137-e-style-chrome-migration.md) — the typed hint pairs and the chrome this keeps
- [#135](135-ui-audit-polish-batch.md) — `fitHint`, `markdownApplicable`, the hint audit
- [#147](147-pane-seam-contracts.md) — `paneArea`/`leftBudget`, the last frame.ts pass
- [#132](132-help-modal-truncated-row.md) / [#064](064-navigator-decomposition.md) — the
  help modal and the view-model extraction this extends
