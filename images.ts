/**
 * images.ts — the public image-support surface: aggregate support resolution,
 * the chafa pane geometry and re-exports (Issue #223 split the chafa tier
 * into `chafa.ts` and the native tier into `native_image.ts`).
 *
 * Owns the support snapshot `ImageSupport`, its deferred construction
 * (`makeDeferredImageSupport`) and resolution (`resolveImageSupport`), the
 * chafa pane geometry (`resolveChafaGeometry`), the per-load attempt plan
 * (`planImageLoad`) and the one render pipeline (`makeImagePipeline` +
 * typed `RenderOutcome`, Issue #144), plus the names existing importers use,
 * re-exported here so this file stays their public face.
 */

import {
  IMAGE_CELLS_MAX,
  IMAGE_CELLS_MIN,
  IMAGE_ROWS_MIN,
} from "./constants";
import type { NavigatorImageMode } from "./settings";
import { clamp } from "./bytes";
import {
  DEFAULT_PI_CHAFA_SUBSET,
  detectPiChafa,
  loadPiChafaConfig,
  probeChafa,
  runChafaRender,
  type ChafaStatus,
  type ExecFn,
  type PiChafaApi,
  type PiChafaStatus,
  type PiChafaSubset,
  type ReadText,
  type RendererFailure,
} from "./chafa";
import {
  readHostImageSettings,
  resolveNativeProtocol,
  runNativeRender,
  type KittyProbeVerdict,
  type NativeProtocol,
  type NativeRenderCtx,
} from "./native_image";

/** Effective image renderer for a session (spec §5.4, D10). */
type ImageTier = "native" | "chafa" | "none";

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

export function resolveChafaGeometry(input: {
  paneCols: number;
  paneRows: number;
  preferredCols: number;
  maxRows: number;
}): { ok: true; cols: number; rows: number } | { ok: false; reason: "narrow" | "short" } {
  if (input.paneCols < IMAGE_CELLS_MIN) return { ok: false, reason: "narrow" };
  if (input.paneRows < IMAGE_ROWS_MIN) return { ok: false, reason: "short" };
  const preferredCols = clamp(input.preferredCols, IMAGE_CELLS_MIN, IMAGE_CELLS_MAX);
  const cols = clamp(
    Math.min(input.paneCols, preferredCols),
    IMAGE_CELLS_MIN,
    IMAGE_CELLS_MAX,
  );
  // The floor wins over a sub-floor maxRows (Issue #193): the clamp needs a
  // non-inverted range, and IMAGE_ROWS_MIN is the minimum viable render.
  const upperRows = Math.max(IMAGE_ROWS_MIN, input.maxRows);
  const rows = clamp(
    Math.min(input.maxRows, input.paneRows),
    IMAGE_ROWS_MIN,
    upperRows,
  );
  return { ok: true, cols, rows };
}

export interface ImageSupport {
  mode: NavigatorImageMode;
  /** Resolved native capability (spec §5.4, D10); null when not native-capable. */
  nativeProtocol: NativeProtocol | null;
  /** Effective renderer for this session (spec §5.4). */
  tier: ImageTier;
  piChafa: PiChafaStatus;
  chafa: ChafaStatus | { state: "deferred" };
  config: PiChafaSubset;
  hostShowImages: boolean;
  /**
   * pi's `terminal.imageWidthCells` — the preferred native width (spec §7.2
   * Q2 amendment); pi defaults it to 60. Native geometry uses
   * min(paneCols, hostImageWidthCells).
   */
  hostImageWidthCells: number;
}

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
function planImageLoad(
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

/** Deferred snapshot for overlay construction (D9): never blocks, never probes. */
export function makeDeferredImageSupport(mode: NavigatorImageMode): ImageSupport {
  return {
    mode,
    nativeProtocol: null,
    tier: "none",
    piChafa: { present: false, via: "none" },
    chafa: { state: "deferred" },
    config: { ...DEFAULT_PI_CHAFA_SUBSET },
    hostShowImages: true,
    // pi's default width preference (spec §7.2 Q2 amendment).
    hostImageWidthCells: 60,
  };
}

export interface ImageSupportPaths {
  userSettings: string;
  projectSettings: string;
  agentDir: string;
}

export interface ImageSupportDeps {
  readText?: ReadText;
  exec?: ExecFn;
  env?: Record<string, string | undefined>;
  previous?: ImageSupport;
  onWarning?: (message: string) => void;
  /** pi-tui capabilities accessor for the native ladder (host truth, D4). */
  capabilities?: () => { images: NativeProtocol | null };
}

/**
 * Resolve the aggregate support snapshot (spec §6.4): host settings + pi-chafa
 * presence + config + chafa probe, then `tier`. pi-chafa absent → chafa
 * stays "deferred" (no probe). A previous "ok" probe is reused when the
 * resolved binaryPath is unchanged. A pi-chafa config `version > 1` substitutes
 * defaults and warns via deps.onWarning (rev. 2 amendment 4).
 */
export async function resolveImageSupport(
  api: PiChafaApi,
  paths: ImageSupportPaths,
  settings: { images: { mode: NavigatorImageMode } },
  deps?: ImageSupportDeps,
): Promise<ImageSupport> {
  const readText = deps?.readText;
  const hostSettings = readHostImageSettings(
    { userSettings: paths.userSettings },
    { readText },
  );
  const piChafa = detectPiChafa(
    api,
    { userSettings: paths.userSettings, projectSettings: paths.projectSettings },
    { readText },
  );
  const parsedConfig = loadPiChafaConfig({
    agentDir: paths.agentDir,
    env: deps?.env,
    readText,
  });
  let config = parsedConfig;
  if (parsedConfig.version > 1) {
    deps?.onWarning?.(
      `pi-chafa config version ${parsedConfig.version} is newer than this navigator supports; using defaults`,
    );
    config = { ...DEFAULT_PI_CHAFA_SUBSET };
  }

  // Native capability ladder (spec §6 step 3, D4): pure, no probe.
  const nativeProtocol = resolveNativeProtocol({
    capabilities: deps?.capabilities,
    readText,
    env: deps?.env,
    userSettings: paths.userSettings,
  });

  const mode = settings.images.mode;
  let chafa: ImageSupport["chafa"];
  if (mode === "native") {
    // Spec §6 step 4: strict native never needs chafa — stay deferred, and
    // skip the previous-probe reuse too.
    chafa = { state: "deferred" };
  } else if (!piChafa.present) {
    chafa = { state: "deferred" };
  } else if (
    deps?.previous &&
    deps.previous.chafa.state === "ok" &&
    deps.previous.config.binaryPath === config.binaryPath
  ) {
    chafa = deps.previous.chafa;
  } else {
    chafa = await probeChafa(config.binaryPath, deps?.exec);
  }

  // Effective tier (spec §5.4). Host image settings always gate.
  let tier: ImageTier;
  if (!hostSettings.showImages || mode === "off") {
    tier = "none";
  } else if (mode === "chafa") {
    tier = piChafa.present && chafa.state === "ok" ? "chafa" : "none";
  } else if (mode === "native") {
    tier = nativeProtocol !== null ? "native" : "none";
  } else {
    // mode === "auto": native → chafa → none, honoring preferNative (D6).
    tier =
      nativeProtocol !== null && config.preferNative
        ? "native"
        : piChafa.present && chafa.state === "ok"
          ? "chafa"
          : "none";
  }

  return {
    mode,
    nativeProtocol,
    tier,
    piChafa,
    chafa,
    config,
    hostShowImages: hostSettings.showImages,
    hostImageWidthCells: hostSettings.imageWidthCells,
  };
}

export {
  detectPiChafa,
  type ChafaStatus,
  type ExecFn,
  type PiChafaApi,
  type PiChafaStatus,
  type PiChafaSubset,
  type ReadText,
} from "./chafa";
export {
  NATIVE_PROTOCOL_RULES,
  buildKittyProbeQuery,
  consumeKittyProbeReply,
  createKittyProbeState,
  isNativelyRenderable,
  type KittyProbeReply,
  type KittyProbeState,
  type KittyProbeVerdict,
  type NativeProtocol,
  type NativeRenderCtx,
} from "./native_image";
