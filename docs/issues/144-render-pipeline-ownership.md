# Issue #144: The Render Seam Owns the Ladder, the Abort and the Load Policy (Typed Supersession, One Pipeline, Session-Owned Reflow)

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Medium
- **Component(s)**: `images.ts`, `session.ts`, `viewer.ts`, `navigator.ts`, `index.ts`, tests

## Description

The architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #4) named the render seam
as the last place where correctness depends on three modules agreeing. Re-validated against
`main@38ce95d` (post-#143):

1. **Supersession is one magic string across three modules.** `IMAGE_ABORT_REASON` is
   produced in `images.ts` at four sites (chafa pre-spawn, chafa abort catch, native entry,
   native post-transcode), compared in `viewer.ts` (`out.reason === IMAGE_ABORT_REASON` →
   break), and owned by the session's per-load abort controller. #143 deliberately deferred
   typing it here.
2. **The seam is two functions and a third-party executor.** `makeImageSeams` builds
   `renderImage`/`renderNativeImage`; `planImageLoad` orders names; the session binds names to
   functions; `viewer.ts` owns the execute/fallback/stop loop.
3. **Invocation policy is split three ways.** The overlay owns all reflow policy
   (`scheduleReflow`'s debounce and re-arm-while-loading, the geometry-mismatch detection, the
   `setImageSupport` upgrade arming), the session owns the abort controller, and the loader
   owns nothing — even though the reflow decision needs the image load state the session has.
4. **Every image load stats the file twice** (session for the cache key, viewer for the file
   facts) plus a 64-byte dimensions head and the renderer's own read.
5. **Protocol branching is inline**: four `protocol === "kitty"` clauses in `runNativeRender`
   (probe, transcode, image id, row layout) plus `isCacheableRender`'s kitty clause.

Corrections to the audit sketch: ladder order no longer lives in `viewer.ts` (moved to
`planImageLoad` by #143), and the #117 fall-through is now test-pinned, so the "delete it and
the suite stays green" claim is stale. "Tests stop mutating pi-tui globals" is only partly
reachable: the ladder's `capabilities` input is already injectable, but pi-tui's real
encoders read pi-tui's own capability cache, so the two tests that pin real protocol bytes
necessarily use `setCapabilities` (save/restore); the new pipeline tests will not.

## Frozen Design (2026-10-04, grilling rounds 1–2)

**One pipeline runs the plan and returns a typed outcome; the session owns when reflows
happen; the loader consumes results, never strings.**

1. **Typed supersession (`images.ts`):**

   ```ts
   export type RenderOutcome =
     | { kind: "ok"; renderer: ImageAttemptRenderer; lines: string[]; cols: number; rows: number }
     | { kind: "failed"; renderer: ImageAttemptRenderer; reason: string }
     | { kind: "aborted" };
   ```

   Chafa's pre-spawn check and AbortError/ABORT_ERR/signal catch, and `runNativeRender`'s
   entry and post-transcode checks return `{ kind: "aborted" }`; every other failure is
   `failed`. `IMAGE_ABORT_REASON` and the `viewer.ts` comparison are deleted — `viewer.ts`
   stops importing anything abort-related from `images.ts`.

2. **One pipeline (`images.ts`):**

   ```ts
   export interface ImagePipelineContext {
     probeDecode: () => Promise<KittyProbeVerdict>;
     signal: AbortSignal;
     exec?: ExecFn;              // chafa child
     convertToPng?: …;           // native transcode
     renderImage?: …;            // pi-tui encoder override (pipeline tests)
   }

   export function makeImagePipeline(
     support: ImageSupport,
     geometry: { cols: number; rows: number },
     ctx: ImagePipelineContext,
   ): { attempts: ImageAttemptRenderer[]; render: (absPath: string) => Promise<RenderOutcome> };
   ```

   - `attempts = planImageLoad(support, geometry)` — the session reads it for the cache
     variant/`isCacheableRender`, so the factory exposes it (no recomputation).
   - `render` owns the whole executor contract in one place: iterate attempts in order; per
     attempt wrap the call in try/catch (a throw is `failed` from *that* renderer and stops
     the list); `aborted` stops and is returned immediately; `failed` is remembered and the
     list continues; after the list return the last failure. `render` never throws.
   - The chafa availability check (`support.chafa.state !== "ok"`) and the native protocol
     guard move inside; the renderers are called with the captured geometry, and `ok` carries
     `cols`/`rows` = that geometry (both renderers record the requested geometry today).
   - `makeImageSeams` (session) is deleted; `ImageAttempt` (viewer) is deleted.

3. **Loader contract (`viewer.ts`).** `LoadFileOptions` drops `attempts` for one seam:
   `imageRenderer?: (absPath: string) => Promise<RenderOutcome>` (plus the existing `image`
   geometry hint and `styleKey`). Mapping: `ok` → the file's `ImageVerdict.rendered` with the
   outcome's renderer/lines/cols/rows; `failed` → card with
   `failed: { renderer, detail: boundImageError(reason) }`; `aborted` → card with **no
   `failed`** (the load is discarded by `loadSeq` anyway). The loop, the abort string and the
   seam-type imports leave `viewer.ts`; a defensive try/catch around the single call remains
   (the pipeline is no-throw by contract; the impossible branch stamps a failure-free card).

4. **Session.** `loadFileCached` builds `makeImagePipeline(s, image, { probeDecode, signal })`
   when an image geometry is present (otherwise `null`), uses `pipeline.attempts` for the
   variant/`isCacheableRender`/over-cap carve-out exactly as today, and passes
   `pipeline.render` as `imageRenderer`. The abort controller stays session-owned (it
   supersedes across text and commit loads too — tests pin that).

5. **Protocol table (`images.ts`).** `NATIVE_PROTOCOL_RULES: Record<NativeProtocol, {
   decodeProbe; requiresPng; freshImageId; layout: "sequence-first" | "cursor-up-tail";
   cacheable }>` drives `runNativeRender`'s four kitty clauses and `isCacheableRender`
   (`kitty.cacheable = false`, per #112; iTerm2 stays cacheable). A future protocol becomes a
   table entry.

6. **Reflow moves to the session; the port grows by one read and one command.**

   - `OverlaySink` gains `getImageView(): { rendered: boolean; asCard: boolean } | null`
     (null = nothing displayed or not `kind: "image"`) and `reflowOpenImage(): void` (the
     overlay re-opens its **displayed** file target through the normal `openTarget` path with
     `keepScroll`; targetless per the round-2 decision).
   - The session owns the debounce timer (`IMAGE_RESIZE_DEBOUNCE_MS`), clears it in
     `dispose()`, re-arms while its own load is in flight (today's rule, now beside the
     controller), and validates at fire time: the displayed target is unchanged
     (`getOpenTarget` + `sameTarget`) and the view is still an image (pull) — then calls
     `reflowOpenImage()`.
   - Two arming paths: (a) **support lands** — inside `resolveSupport`, after pushing the
     snapshot, the session compares fingerprints (first push counts as changed, preserving
     the deferred→resolved upgrade), takes the target as its own in-flight image target
     before the displayed one, and arms when the view is not carded and either unrendered or
     the fingerprint changed; (b) **pane geometry drift** — the overlay keeps today's
     detection in `maybeScheduleResizeReflow` (rendered verdict, `!asCard`,
     `tier !== "none"`, geometry mismatch) and calls the new session verb
     `imageViewChanged()`, wired through `NavigatorOptions` like `loadFile`; the session
     debounces and re-validates.
   - `navigator.ts` deletes `scheduleReflow`, `reflowTimer`, `lastSupportFingerprint` and
     `supportFingerprint`; `setImageSupport` becomes a plain install; `i` and `r` stay
     overlay-initiated (user commands, same load primitive). `sameTarget` moves to a shared
     module so the session compares targets without importing the component.

7. **One stat per load.** `LoadFileOptions.stat?: { isFile: boolean; sizeBytes: number;
   mtimeMs: number }`; the session passes the stat it already performs (its failure path
   still defers to the loader's own stat → error card), and `viewer.ts` uses it instead of
   statting again. The 64-byte dimensions head and the renderer's read are unchanged.

8. **Scope fences.** Native is not made abortable mid-flight (pi-tui's render is synchronous;
   entry + post-transcode are the honest contract); `ImageSupport.tier` stays the snapshot
   summary; candidate #7 (pane seam contracts) is not absorbed. Tests: the new pipeline tests
   drive native through the `renderImage` ctx override instead of mutating pi-tui globals;
   the two real-protocol-byte tests keep their save/restore around `setCapabilities`.

## Acceptance Criteria

- [x] `IMAGE_ABORT_REASON` is gone; `viewer.ts` imports no abort vocabulary; abort is a
  `RenderOutcome` kind consumed structurally.
- [x] `makeImagePipeline` is the only render seam; `makeImageSeams`, `ImageAttempt` and the
  two-slot option surface are deleted; the pipeline never throws and returns the last
  failure after the list.
- [x] `viewer.ts` performs no attempt order/fallback policy: one call, one outcome, one
  verdict mapping; `aborted` stamps no failure.
- [x] The session owns the reflow timer, the re-arm-while-loading rule and the
  support-landing arming; the overlay only detects geometry drift and reports it; the sink
  gains exactly `getImageView` + `reflowOpenImage`.
- [x] `NATIVE_PROTOCOL_RULES` drives all five kitty clauses (`runNativeRender` ×4,
  `isCacheableRender` ×1).
- [x] One `stat` per image load (viewer stats only when the session supplied none).
- [x] Tests cover: the pipeline matrix (order, clean-fail fallback, throw-stop, abort-stop,
  last failure), the loader mapping (ok/failed/aborted/no renderer), session reflow (arm on
  support, fire → command, re-arm while loading, target switch no-op, disposal), and the
  overlay's `getImageView`/`reflowOpenImage`; no behavior assertion weakened.
- [x] `npm run typecheck` and `npm test` green.

## Resolution

Implemented as designed (2026-10-04), version 0.14.8:

- `images.ts` — `IMAGE_ABORT_REASON` deleted; `RenderOutcome` (`ok`/`failed`/`aborted`) and
  `RendererFailure` are the producers' vocabulary (chafa pre-spawn + AbortError catch, native
  entry + post-transcode); `NATIVE_PROTOCOL_RULES` drives the four kitty clauses and the
  cache policy; `runNativeRender` gained the optional `renderImage` encoder seam;
  `makeImagePipeline` owns the attempt order, the per-renderer fallback, per-attempt throw
  handling (a throw fails THAT renderer and stops) and the abort stop, and never throws.
- `session.ts` — `makeImageSeams` deleted; one pipeline per load, `pipeline.attempts` drives
  the variant/`isCacheableRender`/over-cap carve-out, `pipeline.render` crosses the seam as
  `imageRenderer`; one-stat handoff; the load controller is released at completion
  (identity-checked), so a non-null controller means exactly "a load is in flight"; the
  reflow clock (`armReflow` / `armReflowOnSupport` / `imageViewChanged`) owns the debounce,
  the re-arm-while-loading rule, the support-landing arming and the fire-time re-validation;
  `dispose()` clears the timer; the support fingerprint moved in.
- `viewer.ts` — the attempt loop and the abort comparison deleted; `LoadFileOptions` is
  `{image?, imageRenderer?, stat?, styleKey?}`; one typed-outcome mapping (`ok` → rendered,
  `failed` → bounded card, `aborted`/throwing override → failure-free card); the session's
  stat record is consumed instead of a second `stat`; `targetOf`/`targetPath`/`sameTarget`
  moved here (shared by session and overlay without importing each other).
- `navigator.ts` — `supportFingerprint`, `reflowTimer`, `lastSupportFingerprint`,
  `scheduleReflow` deleted; `setImageSupport` is a plain install; `maybeScheduleResizeReflow`
  keeps its exact predicate and reports through `onImageViewChanged`; new public
  `getImageView`/`reflowOpenImage`; `dispose()` has no reflow state.
- `index.ts` — the sink gains `getImageView`/`reflowOpenImage`; `NavigatorOptions` gains
  `onImageViewChanged` (wired to `session.imageViewChanged()`); `makeImageSeams` is no longer
  re-exported.

Recorded decisions/deviations:

1. `imageRenderer` is passed only when the plan is non-empty, preserving the empty-plan
   plain card; the pipeline's own empty branch returns a total `failed` ("no image renderer
   is available") for direct callers.
2. One sanctioned behavior change: an aborted load's card carries no `failed` (the overlay's
   sequence guard discards that load, so nothing visible changes). The #117 protection is
   now structural: the pipeline returns `{kind:"aborted"}` and stops.
3. The support fingerprint keeps all ten knobs (incl. `cellWidth`/`maxRows`) so reflow
   triggering is bit-for-bit today's.
4. `sanitizeChafaPayload` keeps its `{ok, reason}` shape (a pure payload validator);
   `runChafaRender` maps it to `RendererFailure` at the boundary.
5. `makeImagePipeline` is not re-exported from `index.ts`; its public home is `images.ts`.

Verification: `npm run typecheck` clean; `npm test` **21 suites / 876 cases** (865 baseline,
+11). No behavior assertion weakened; the session suite drives the real pipeline and
`runChafaRender` end to end (child captured at `node:child_process`), and the #117 real-byte
test drives `makeImagePipeline`.

## References

- Architecture review of 2026-10-03, candidate #4:
  [`docs/audits/architecture-review-2026-10-03.html`](../audits/architecture-review-2026-10-03.html)
- [`docs/GLOSSARY.md`](../GLOSSARY.md) — "image verdict", "image pipeline"
- [#117](117-native-abort-cascade-chafa-fallback.md) — the abort short-circuit this types
- [#143](143-image-verdict.md) — the plan/verdict vocabulary this builds on
- [#069](069-native-image-rendering.md) — the native tier and its QA record
