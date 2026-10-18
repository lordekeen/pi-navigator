/**
 * images.ts — the public image-support surface: aggregate support resolution,
 * the chafa pane geometry and re-exports (Issue #223 split chafa/native/
 * pipeline out of this module).
 *
 * Owns the support snapshot `ImageSupport`, its deferred construction
 * (`makeDeferredImageSupport`) and resolution (`resolveImageSupport`), the
 * chafa pane geometry (`resolveChafaGeometry`) and the names existing
 * importers use, re-exported here so this file stays their public face
 * (Issue #223). The chafa tier lives in `chafa.ts`, the native tier in
 * `native_image.ts` and the per-load attempt plan + render pipeline in
 * `image_pipeline.ts`.
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
  type ChafaStatus,
  type ExecFn,
  type PiChafaApi,
  type PiChafaStatus,
  type PiChafaSubset,
  type ReadText,
} from "./chafa";
import {
  readHostImageSettings,
  resolveNativeProtocol,
  type NativeProtocol,
} from "./native_image";

/** Effective image renderer for a session (spec §5.4, D10). */
type ImageTier = "native" | "chafa" | "none";

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
  type KittyProbeReply,
  type KittyProbeState,
  type KittyProbeVerdict,
  type NativeProtocol,
  type NativeRenderCtx,
} from "./native_image";
export { isNativelyRenderable, makeImagePipeline } from "./image_pipeline";
export type {
  ImageAttemptRenderer,
  ImagePipelineContext,
  RenderOutcome,
} from "./image_pipeline";
