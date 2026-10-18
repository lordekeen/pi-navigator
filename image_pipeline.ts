/**
 * image_pipeline.ts — the per-load image attempt plan and the one render
 * pipeline (split out of `images.ts`, Issue #223; Issue #144).
 *
 * Owns the ordered attempt plan (`planImageLoad`), the pipeline context and
 * the single `makeImagePipeline` factory that binds one load's abort signal,
 * the one-shot kitty probe and the renderer seams. It composes the two
 * renderer tiers (`chafa.ts`, `native_image.ts`) into the typed
 * `RenderOutcome` that `viewer.ts` consumes — never an abort string.
 *
 * The availability guards that used to live in the session's seams live here,
 * so the pipeline can never disagree with the plan it was built from
 * (#116 fix 1): a `chafa.state !== "ok"` snapshot fails the chafa attempt
 * with "chafa is not available", a null protocol fails the native attempt
 * with "native rendering is not available".
 */

import {
  runChafaRender,
  type ExecFn,
  type RendererFailure,
} from "./chafa";
import {
  runNativeRender,
  type KittyProbeVerdict,
  type NativeRenderCtx,
} from "./native_image";
import type { ImageSupport } from "./images";

/**
 * One renderer the plan may run for an image load (Issue #143). Declared here
 * so the pipeline can name the renderer that spoke while `viewer.ts` stays
 * free of tier vocabulary.
 */
export type ImageAttemptRenderer = "native" | "chafa";

/**
 * The pipeline's per-attempt outcome (Issue #144). `ok` carries the renderer
 * that spoke plus the rows and the captured geometry; `failed` a bounded
 * reason; `aborted` a supersession — the owning load's signal fired, so the
 * remaining attempts must not run (Issue #117) and `viewer.ts` stamps no
 * failure. Consuming the kind structurally is what lets the loader drop the
 * abort string entirely.
 */
export type RenderOutcome =
  | { kind: "ok"; renderer: ImageAttemptRenderer; lines: string[]; cols: number; rows: number }
  | { kind: "failed"; renderer: ImageAttemptRenderer; reason: string }
  | { kind: "aborted" };

/**
 * One decision per load (Issue #143): the ordered renderers eligible under
 * this support snapshot — native first, chafa as auto's per-file fallback.
 * The session binds the names to its seams; `viewer.ts` executes the list.
 * This composes the gates the navigator and the session used to re-derive per
 * load:
 * - a null geometry (nothing laid out / pane too small) plans nothing;
 * - an unresolved tier ("none") plans nothing. That covers every inactive
 *   state in one check: `mode: "off"`, `terminal.showImages: false`, a failed
 *   or missing chafa probe, and strict native without a protocol. It also
 *   keeps the host gate whole: a host-disabled auto snapshot resolves tier
 *   "none" but still carries a probed-ok chafa (the probe runs for the card's
 *   hint copy), and without this the plan would render despite
 *   `terminal.showImages: false`;
 * - native requires the resolved tier AND a protocol (D2/D3);
 * - chafa requires the resolved chafa tier, or auto's per-file fallback:
 *   pi-chafa present and the probe ok (the D5 mime-gate fallback);
 * - strict `mode: "native"` keeps chafa deferred and strict `mode: "chafa"`
 *   leaves the native tier unset, so both resolve to a single attempt.
 */
export function planImageLoad(
  support: ImageSupport,
  geometry: { cols: number; rows: number } | null,
): ImageAttemptRenderer[] {
  if (geometry === null || support.tier === "none") return [];
  const attempts: ImageAttemptRenderer[] = [];
  if (support.tier === "native" && support.nativeProtocol !== null) attempts.push("native");
  if (
    support.tier === "chafa" ||
    (support.mode === "auto" && support.piChafa.present && support.chafa.state === "ok")
  ) {
    attempts.push("chafa");
  }
  return attempts;
}

/**
 * Everything one image load's pipeline needs from its owner (Issue #144):
 * the owning load's signal, the one-shot kitty probe, and the renderer test
 * seams (chafa child, native transcode/read/encoder).
 */
export interface ImagePipelineContext {
  /** One-shot kitty protocol probe (Issue #101, #116). */
  probeDecode: () => Promise<KittyProbeVerdict>;
  /** The OWNING load's abort signal (Issue #117 follow-up). */
  signal: AbortSignal;
  /** Chafa child seam (tests); default node execFile. */
  exec?: ExecFn;
  /** Native transcode seam; default pi-coding-agent's convertToPng. */
  convertToPng?: NativeRenderCtx["convertToPng"];
  /** Native bounded-read seam (tests); default node fs read. */
  readBytes?: NativeRenderCtx["readBytes"];
  /** pi-tui encoder override (tests); default = the real import. */
  renderImage?: NativeRenderCtx["renderImage"];
}

/**
 * One pipeline per image load (Issue #144): the planned attempt order plus a
 * single `render(absPath)` that owns the whole executor contract — the
 * per-renderer fallback, per-attempt throw handling and typed supersession.
 *
 * `render` never throws and never leaks an abort string:
 * - `ok` stops the list and carries the renderer's rows with the CAPTURED
 *   geometry (both renderers record the requested geometry today: native
 *   deliberately reports the request, not pi-tui's aspect-fitted result, so
 *   resize detection compares like for like);
 * - `aborted` returns immediately — a superseded load must not run its
 *   remaining attempts (Issue #117);
 * - a clean `failed` is remembered and the next renderer runs;
 * - a throw is a hard failure from THAT renderer and stops the list.
 * After the list, the last clean failure is returned.
 *
 * The availability guards that used to live in the session's seams live here,
 * so the pipeline can never disagree with the plan it was built from (#116
 * fix 1): a `chafa.state !== "ok"` snapshot fails the chafa attempt with
 * "chafa is not available", a null protocol fails the native attempt with
 * "native rendering is not available". The factory exposes `attempts` so the
 * session can derive its cache variant and cacheability without recomputing
 * the plan.
 */
export function makeImagePipeline(
  support: ImageSupport,
  geometry: { cols: number; rows: number },
  ctx: ImagePipelineContext,
): { attempts: ImageAttemptRenderer[]; render: (absPath: string) => Promise<RenderOutcome> } {
  const attempts = planImageLoad(support, geometry);
  const render = async (absPath: string): Promise<RenderOutcome> => {
    let failed: { renderer: ImageAttemptRenderer; reason: string } | null = null;
    for (const renderer of attempts) {
      try {
        let out: { kind: "ok"; lines: string[] } | RendererFailure;
        if (renderer === "native") {
          if (support.nativeProtocol === null) {
            failed = { renderer, reason: "native rendering is not available" };
            continue;
          }
          out = await runNativeRender(absPath, geometry, {
            protocol: support.nativeProtocol,
            signal: ctx.signal,
            probeDecode: ctx.probeDecode,
            convertToPng: ctx.convertToPng,
            readBytes: ctx.readBytes,
            renderImage: ctx.renderImage,
          });
        } else {
          if (support.chafa.state !== "ok") {
            failed = { renderer, reason: "chafa is not available" };
            continue;
          }
          out = await runChafaRender(absPath, geometry, {
            binary: support.chafa.binary,
            config: support.config,
            signal: ctx.signal,
            exec: ctx.exec,
          });
        }
        // One aborted/ok/failed mapping for every renderer (Issue #173):
        // both resolve the same per-renderer outcome vocabulary.
        if (out.kind === "aborted") return { kind: "aborted" };
        if (out.kind === "ok") {
          return { kind: "ok", renderer, lines: out.lines, cols: geometry.cols, rows: geometry.rows };
        }
        failed = { renderer, reason: out.reason };
      } catch (error) {
        return {
          kind: "failed",
          renderer,
          reason: error instanceof Error ? error.message : "unexpected renderer failure",
        };
      }
    }
    if (failed !== null) return { kind: "failed", renderer: failed.renderer, reason: failed.reason };
    // Unreachable through the session (an empty plan never installs a
    // renderer); kept total and honest for direct callers.
    return { kind: "failed", renderer: "chafa", reason: "no image renderer is available" };
  };
  return { attempts, render };
}

export { isNativelyRenderable } from "./native_image";
