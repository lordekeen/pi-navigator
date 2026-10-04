# Issue #143: One Image Verdict (One Per-Load Decision, One Outcome Vocabulary, No Re-Derived Labels)

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Medium
- **Component(s)**: `images.ts`, `viewer.ts`, `session.ts`, `navigator.ts`, `viewer_view.ts`, `types.ts`, tests

## Description

The image tier is decided once, then re-derived at six sites behind two enums that never
meet. Found by the architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #3), re-validated against
`main@603ba8c` (post-#140/#142; the audit's line numbers moved, the friction did not):

1. **`images.ts` `resolveImageSupport`** computes the snapshot's `tier:
   "native"|"chafa"|"none"` (mode × host settings × pi-chafa presence × probe ×
   `preferNative`).
2. **`session.ts` `loadFileCached`** re-derives the per-load gates (`useNative`, `useChafa`,
   `chafaFallback`) and the cache `variant` from that tier; `makeImageSeams` re-gates
   `renderNativeImage` on `support.tier !== "native" || support.nativeProtocol === null`.
3. **`session.ts` `createViewerCache`** re-derives `file.imageTier === "native"` for the
   over-cap retention carve-out.
4. **`viewer.ts` `loadFile`** owns the fallback order (native → #117 abort short-circuit →
   chafa → metadata card) and stamps `ViewerFile.imageTier: "metadata"|"native"|"chafa"` +
   `imageError`.
5. **`navigator.ts`** repeats the rendered/native predicates at eight sites (key routing,
   the `i` toggle, reflow arming, resize detection, the render branch, the `openTarget`
   load gate).
6. **`viewer_view.ts`** re-derives labels: the header badge from both enums in one
   expression, `imageErrorLabel` reconstructs *which renderer failed* from mode/probe state,
   `nativelyRenderable` re-implements `images.ts`'s mime gate, and `imageCardHints` ladders
   the whole support state.

The two enums never meet: `ImageTier` (support; 11 production reads) vs
`ViewerFile.imageTier` (per-file; 15 reads), with no mapping function. `images.ts` exports 35
symbols; production imports 16 across 5 files, the rest being test-facing pure helpers.

## Frozen Design (2026-10-04, grilling rounds 1–2)

**One decision per load produces one plan; one outcome vocabulary records what happened; the
pane renders the verdict and never re-derives.**

1. **The verdict type (`types.ts`, structurally inlined — this module stays
   dependency-free):**

   ```ts
   export type ImageVerdict =
     | { kind: "rendered"; renderer: "native" | "chafa"; lines: string[]; cols: number; rows: number }
     | { kind: "card"; failed?: { renderer: "native" | "chafa"; detail: string } };
   ```

   `ViewerFile` loses `imageTier`, `imageLines`, `imageCols`, `imageRows` and `imageError`;
   it gains `imageVerdict?: ImageVerdict`. For a native render, `cols`/`rows` are the
   **requested** geometry (pi-tui may aspect-fit the placement; resize detection compares
   pane-derived requests), preserving the existing comment. For chafa they are the
   renderer's returned geometry. `message` stays on `ViewerFile`.

2. **The plan (`images.ts`), pure:**

   ```ts
   export type ImageAttemptRenderer = "native" | "chafa";
   export function planImageLoad(
     support: ImageSupport,
     geometry: { cols: number; rows: number } | null,
   ): ImageAttemptRenderer[];
   ```

   - `geometry === null` → `[]` (pane too small; today's navigator gate moves inside).
   - native iff `support.tier === "native" && support.nativeProtocol !== null`.
   - chafa iff `support.tier === "chafa" || (support.mode === "auto" && support.piChafa.present && support.chafa.state === "ok")`.
   - Order: native, then chafa. This reproduces today's gates byte-for-byte, including
     `preferNative: false` (auto resolves to tier `chafa` → chafa-only) and strict modes
     (chafa deferred under `mode: "native"`).

3. **Session binds, viewer executes.** `session.ts` is the only holder of the snapshot, so it
   calls `planImageLoad` and binds renderer names to its seams; `viewer.ts` receives an
   attempt list and contains no tier vocabulary. `ImageRenderer` stays in `viewer.ts`
   (`images.ts` must not import it):

   ```ts
   // viewer.ts
   export interface ImageAttempt { renderer: ImageAttemptRenderer; render: ImageRenderer }
   export interface LoadFileOptions {
     image?: { cols: number; rows: number };
     attempts?: ImageAttempt[];
     styleKey?: string;
   }
   ```

   `useNative` / `useChafa` / `chafaFallback` and the `renderImage` / `renderNativeImage`
   option slots are deleted. `variant` and `isCacheableRender` read the plan
   (`attempts.includes("native")`), and the over-cap carve-out reads
   `verdict.kind === "rendered" && verdict.renderer === "native"` — all behavior-preserving.
   `makeImageSeams` drops its redundant `tier !== "native"` re-gate (#116 fix 1's
   defense-in-depth is dead once eligibility is decided upstream) but keeps the
   `nativeProtocol === null` structural guard.

4. **Executor contract (today's viewer fallback generalized to the attempt list).** For each
   attempt in order:

   - `ok` → rendered outcome with that renderer.
   - **throw** → card `{ renderer, detail: bounded }`, **stop** (today's hard failure, no
     fallback).
   - `!ok` with `IMAGE_ABORT_REASON` → card with that detail, **stop** (supersession, #117;
     the load is discarded by `loadSeq` anyway).
   - other `!ok` → remember as the last failure, continue.

   After the list: card with the last failure, or a card with no `failed` when nothing was
   attempted. `boundImageError` keeps bounding inside `viewer.ts`.

5. **Labels stay in `viewer_view.ts`**, fed by the verdict + live snapshot: the header badge
   (`i render` / `i card` / renderer name) reads `verdict.kind` and
   `verdict.renderer`; `imageCardHints`' first branch becomes
   `failed ? [`${failedRendererLabel(failed, support)} failed: ${failed.detail}`] : …` with
   `failed.renderer === "native" ? (support.nativeProtocol ?? "native") : "chafa"` — the
   exact strings today's `imageErrorLabel` produces for every *visible* case (the abort case
   that used to mislabel was discarded anyway). The rest of the ladder keeps reading the
   live snapshot, so a support change without a reflow cannot leave a stale hint.
   `imageErrorLabel` and `viewer_view.ts`'s local `nativelyRenderable` die; the mime gate's
   one home becomes an exported `isNativelyRenderable(relPath)` (or equivalent) wrapping
   `images.ts`'s private `mimeOfPath`.

6. **Mechanical consumer rewrites.** `navigator.ts`'s eight predicate sites become verdict
   reads (one private helper if it reads better); the `openTarget` load gate drops its
   `tier !== "none"` check (the plan answers it) and keeps the image-extension + geometry
   checks; `currentImageGeometry` keeps reading `tier` (the snapshot summary, Q5(a)).
   `ViewerPaneView` keeps `imageSupport` + `imageGeometry` (labels are live) and its
   `imageLines` contract.

7. **Scope boundaries.** `ImageSupport.tier` survives as the snapshot's resolved renderer
   (the planner is its only semantic consumer); the abort stays a string check in #3 —
   typing supersession and merging the two seams is candidate #4's win. No export-count
   campaign: only what the verdict makes dead is internalized; test-facing pure helpers keep
   their direct imports. Strict equivalence: no behavior change, no new issues in scope.

## Acceptance Criteria

- [x] `ViewerFile` carries a single `imageVerdict`; `imageTier`, `imageLines`, `imageCols`,
  `imageRows` and `imageError` are gone from `types.ts`.
- [x] `viewer.ts` contains no tier vocabulary and no fallback-order nesting; it executes
  `opts.attempts` per the contract in item 4.
- [x] `session.ts`'s `useNative`/`useChafa`/`chafaFallback` block is gone; cache gating,
  variants and the over-cap carve-out read the plan/verdict and behave identically.
- [x] `navigator.ts`'s repeated predicates are verdict reads; the load gate no longer reads
  `tier`.
- [x] `viewer_view.ts` derives no renderer identity and no mime facts; header badge and card
  hint strings are byte-identical for every visible case except the one recorded native-throw
  relabel (Resolution item 2).
- [x] `planImageLoad` unit tests cover the matrix: native-ok; native clean-fail → chafa
  (auto); native clean-fail without chafa → native card; native throw → native card, no
  chafa attempt; native abort → stop, no chafa attempt; chafa-only ok/fail/throw; empty plan
  (tier none — including a probed-ok chafa on a host-disabled snapshot — geometry null, host
  images off, mode off); `preferNative: false` → chafa only.
- [x] `npm run typecheck` and `npm test` green; no behavior assertion weakened.

## Resolution

Implemented as designed (2026-10-04), version 0.14.7. Six source files, seven test files:

- `types.ts` — the `ImageVerdict` union replaces the five per-file image fields; `ViewerFile`
  carries only `imageVerdict` (dependency-free, structurally inlined).
- `images.ts` — `planImageLoad(support, geometry)` returns the ordered eligible renderers
  (native → chafa); `isNativelyRenderable` becomes the one home of the native mime gate
  (wrapping the private `mimeOfPath`), shared with `runNativeRender` and the card hint.
- `viewer.ts` — `LoadFileOptions.attempts` (renderer names bound to seams) replaces the two
  seam slots; the image branch is the executor loop (clean failure continues, throw/abort
  stop, the last failure lands on the card, no `failed` when nothing ran) and stamps
  `imageVerdict`; `boundImageError` still bounds.
- `session.ts` — the `useNative`/`useChafa`/`chafaFallback` block is gone; the plan drives
  the variant, `isCacheableRender` and the seam binding; `makeImageSeams.renderNativeImage`
  keeps only the structural protocol guard (the tier re-gate is unreachable once the plan
  owns eligibility).
- `navigator.ts` — one `renderedImageVerdict()` helper replaces the repeated predicates at
  the key-routing, `i`, support-install, resize-reflow and render sites; the `openTarget`
  load gate drops its `tier` read (the plan answers it); `currentImageGeometry` keeps its
  `tier` read as the snapshot summary.
- `viewer_view.ts` — badge and hints read the verdict; `imageErrorLabel` and the local
  `nativelyRenderable` are deleted; `failedRendererLabel` names the renderer the verdict
  recorded.

Two deliberate deltas from the letter of the frozen text, both recorded here:

1. `planImageLoad` returns `[]` when `support.tier === "none"`, not only on null geometry.
   Without it, a host-disabled auto snapshot (`terminal.showImages: false`, tier `none`, a
   probe that still succeeded for the hint copy) would plan chafa — and since the navigator
   gate now drops its `tier` check, that would render despite the host setting. Today the
   navigator gate was what prevented it; the guard restores that behavior inside the plan.
2. A native **throw** under auto with a probed-ok chafa now labels the card by the verdict
   (`kitty failed: …`) where the old `imageErrorLabel` reconstruction guessed `chafa failed:
   …`. That reconstruction is the mislabeling Q2(a) set out to kill; the abort variant of the
   same case was already discarded upstream. No other badge or hint string changed.

Verification: `npm run typecheck` clean; `npm test` **21 suites / 865 cases** (851 baseline,
+14 — the `planImageLoad` matrix, `isNativelyRenderable`, the executor's geometry-absent and
abort-stop cases, and the dropped tier re-gate). No behavior assertion was weakened; the
re-vocabularized executor tests strengthened the old ones (native keeps the requested
geometry even when the renderer reports fitted values; the last clean failure wins the card).

## References

- Architecture review of 2026-10-03, candidate #3:
  [`docs/audits/architecture-review-2026-10-03.html`](../audits/architecture-review-2026-10-03.html)
- [`docs/GLOSSARY.md`](../GLOSSARY.md) — "image verdict"
- [#116](116-first-image-chafa-tier-flip.md), [#117](117-native-abort-cascade-chafa-fallback.md)
  — the snapshot-bound seams and abort short-circuit this design preserves
- [#142](142-open-target-protocol.md) — the precedent typed-value deep dive
