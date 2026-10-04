# Issue #149: Viewer Pane Content — One Content Slot

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Low
- **Component(s)**: `viewer_view.ts`, `navigator.ts`, tests

## Description

The architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #10) found the viewer
pane's body carried as four exclusive channels. Re-validated against `main@31f3838`
(v0.14.12, after Issues #140–#148):

1. **`ViewerPaneView` is exactly 26 fields**, of which `mdContent`, `display`,
   `imageLines` and `imageAsCard` are the body channels and `renderedMode` is a second
   flag consumed by the same decision.
2. **The class chooses one channel by `if/else`; the module re-derives the same choice at
   four points.** `navigator.render()` builds `mdContent` / `display` / `imageLines` in
   mutually exclusive branches (locals initialized `null` — the audit's "the class nulls
   `imageLines` for cards" is prose, not an assignment); `renderViewerPane` then
   re-decides: `imageLines && length > 0` (line 205), `file.kind === binary|error|image`
   (line 231), `renderedMode && mdContent` (line 249), `display` (line 254). Case analysis
   confirms the two derivations agree today — by control-flow coordination, not by shape.
3. **`renderedMode` is read by exactly one module line** (249 — the branch it duplicates),
   and `imageAsCard`'s module read is only the header badge decision (296). Both fold
   into the channel choice.
4. **New finding — the two derivations already disagree in one reachable edge.** A
   rendered verdict with zero lines (the state #103 and #144's `lines.length > 0` checks
   treat as "not rendered"): the body shows the metadata card and `i` re-requests a render
   (the handler keys on `lines.length > 0`), while the header keys on `!imageAsCard` and
   advertises the renderer badge plus `i card`. One decision, two answers — exactly the
   class the audit names.

## Frozen Design (2026-10-04, validated then frozen by the user)

1. **One `ViewerContent` union in `viewer_view.ts`** — the pane's exclusive body payload:

   ```ts
   export type ViewerContent =
     | { kind: "image-lines"; lines: string[] }        // rendered image rows (non-empty by construction)
     | { kind: "card" }                                 // binary / error / image shown as a card
     | { kind: "markdown"; rows: Array<string | null> } // pre-styled rendered markdown
     | { kind: "display"; rows: DisplayRow[] }          // text-like wrapped rows (incl. diffs)
     | { kind: "none" };                                // no body drawn (null file / loading)
   ```

   `ViewerPaneView` drops `mdContent`, `display`, `imageLines`, `imageAsCard` and
   `renderedMode` for one `content` field: **26 → 22 fields**.

2. **The class fills the slot once.** `navigator.render()` replaces the three locals with
   `let content: ViewerContent = { kind: "none" }` and assigns in the existing branches.
   The #147 `viewerWindow` calls, the write-backs, the search-jump bookkeeping and the
   markdown marking loop are untouched — the window contract is not in scope.

3. **The module switches once.** `renderViewerPane` branches on `content.kind`:
   `image-lines` renders `content.lines`, `card` calls `buildCard` (which never read
   `imageAsCard`), the notices stay, and the text-like path selects
   `content.kind === "markdown" ? content.rows : content.kind === "display" ? content.rows : …`.
   No `file.kind === binary|error|image` re-derivation, no `length > 0` re-check, no
   `renderedMode` / `imageAsCard` field read remains anywhere in the module.

4. **One documented behavior delta.** The header's image badge becomes
   `content.kind === "image-lines"`; for the zero-line rendered verdict the meta therefore
   reads `i render` (matching the body and the `i` handler) instead of `chafa|native` +
   `i card`. Every other rendered byte is identical, and the delta is pinned by a new
   navigator test.

5. **Test posture.** `test/viewer_view.test.ts`'s `paneView` fixture and its ~14
   overrides are re-expressed in the union vocabulary; the module case "rendered image
   with an empty row list → card" folds into the neighboring card case (the producer now
   guarantees non-empty `image-lines`, and the zero-line → card decision stays pinned by
   the #103 navigator test, which must stay green); one navigator case pins the header
   delta. Suite count stays 22; no non-null assertions.

## Acceptance Criteria

- [x] `ViewerContent` is the only body-payload shape and `renderViewerPane` is its single
  consumer; `ViewerPaneView` has exactly 22 fields.
- [x] `mdContent`, `display`, `imageLines`, `imageAsCard` and `renderedMode` no longer
  exist as record fields — the exclusivity invariant is carried by the union.
- [x] No body-branch decision is re-derived: the card branch is `kind === "card"`, the
  image branch is `kind === "image-lines"`, and nothing re-checks line counts or
  `file.kind` to choose a channel. (The header's renderer-name expression keeps
  `verdict?.kind === "rendered" &&` purely to narrow `verdict.renderer` — the badge branch
  itself is `kind === "image-lines"`.)
- [x] Every rendered byte is identical except the zero-line rendered verdict header meta
  (`i render`), which is pinned by a test.
- [x] The #147 viewer-window contract is untouched: same `viewerWindow` calls, same
  write-backs, and all #065/#147 pins stay green byte-identically.
- [x] `npm run typecheck` and `npm test` green (22 suites, 927 cases); no non-null
  assertions.

## Resolution

Implemented as designed (2026-10-04), version 0.14.13:

- **`viewer_view.ts`** — the exported `ViewerContent` union
  (`image-lines`/`card`/`markdown`/`display`/`none`) is now the one body payload;
  `ViewerPaneView` is **22 fields** (down from 26). `renderViewerPane` branches on
  `content.kind` once: the image branch reads `content.lines` (the `length > 0` re-check is
  gone), the card branch is `kind === "card"` (no `file.kind` re-derivation), and the
  text-like path selects `markdown` vs `display` rows off the same value. `buildViewerHeader`
  keys its image badge on `kind === "image-lines"`. No file outside `viewer_view.ts` and
  `navigator.ts` reads `content`.
- **`navigator.ts`** — `buildRightRows` fills one `content` slot in its existing branches;
  every `viewerWindow` call, input and field write-back is untouched, so the #147 window
  contract and the #065 offset agreement are structurally unchanged.
- **The one behavior delta** — a rendered verdict with zero lines now shows `i render` in
  the header (was `<renderer> · i card`), matching the card body and the `i` handler; new
  navigator test `badges a zero-line rendered verdict as i render, not i card…`, red-green
  verified (restoring the old condition fails it). Every other byte is unchanged; the full
  suite's render/width/#065/#147 pins pass untouched.
- **Tests** — the `paneView` fixture and all override sites speak the union vocabulary; the
  old null-rows and empty-rows module cases fold into one card case (the producer cannot
  emit an empty `image-lines`; the zero-line → card decision stays pinned by the #103
  navigator test, untouched and green).

Verification: `npm run typecheck` clean; `npm test` **22 suites / 927 cases** (net 0 — one
folded case, one delta case).

## References

- [Architecture review 2026-10-03](../audits/architecture-review-2026-10-03.html) — candidate #10
  ("Viewer pane's four channels → one content slot").
- #103 — the zero-line rendered verdict must show the metadata card, never the text gutter
  (the navigator-level pin this issue keeps).
- #143 / #144 — the one per-load image verdict; `lines.length > 0` is the "rendered" test
  in `getImageView`, the reflow arming and the `i` handler.
- #147 — the viewer window contract this issue must not disturb.
- #148 — the pane-seam vocabulary cleanup this issue completes.
