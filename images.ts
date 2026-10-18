/**
 * images.ts — the public image-support surface: aggregate support resolution
 * and re-exports (Issue #223 split chafa/native/pipeline out of this module).
 *
 * Owns the support snapshot `ImageSupport`, its deferred construction
 * (`makeDeferredImageSupport`) and resolution (`resolveImageSupport`), the
 * chafa pane geometry (`resolveChafaGeometry`) and the names existing
 * importers use, re-exported from the modules below. The chafa tier lives in
 * `chafa.ts`, the native tier in `native_image.ts` and the per-load attempt
 * plan + render pipeline in `image_pipeline.ts` (Issue #144).
 */

import { open } from "node:fs/promises";

import {
  allocateImageId,
  getImageDimensions,
  renderImage,
} from "@earendil-works/pi-tui";

import { convertToPng } from "@earendil-works/pi-coding-agent";

import {
  IMAGE_CELLS_MAX,
  IMAGE_CELLS_MIN,
  IMAGE_NATIVE_MAX_BYTES,
  IMAGE_ROWS_MIN,
  NATIVE_IMAGE_MIME,
} from "./constants";
import type { NavigatorImageMode } from "./settings";
import { clamp } from "./bytes";
import {
  DEFAULT_PI_CHAFA_SUBSET,
  bounded,
  detectPiChafa,
  loadPiChafaConfig,
  nodeReadText,
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

/** Effective image renderer for a session (spec §5.4, D10). */
type ImageTier = "native" | "chafa" | "none";

/** Terminal image protocols pi-tui can render (closed union, D2). */
export type NativeProtocol = "kitty" | "iterm2";

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
 * Read pi's own terminal image settings (spec §6.3). Defaults
 * { showImages: true, imageWidthCells: 60, images: null }; honors
 * terminal.showImages (boolean), terminal.imageWidthCells (positive int),
 * and terminal.images (exact "kitty"/"iterm2" only — anything else,
 * including false/"auto"/"none"/absent/non-string, is null). Missing or
 * corrupt files, and invalid values, fall back to defaults. Never throws.
 */
function readHostImageSettings(
  paths: { userSettings: string },
  deps?: { readText?: ReadText },
): { showImages: boolean; imageWidthCells: number; images: NativeProtocol | null } {
  const readText = deps?.readText ?? nodeReadText;
  const result = { showImages: true, imageWidthCells: 60, images: null as NativeProtocol | null };
  const text = readText(paths.userSettings);
  if (text === undefined) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return result;
  }
  const terminal = (parsed as Record<string, unknown>).terminal;
  if (typeof terminal !== "object" || terminal === null || Array.isArray(terminal)) {
    return result;
  }
  const t = terminal as Record<string, unknown>;
  if (typeof t.showImages === "boolean") result.showImages = t.showImages;
  const width = t.imageWidthCells;
  if (typeof width === "number" && Number.isInteger(width) && width > 0) {
    result.imageWidthCells = width;
  }
  if (t.images === "kitty" || t.images === "iterm2") result.images = t.images;
  return result;
}

/**
 * Instance-independent native capability ladder (spec §5.3, D4; mirrors
 * pi-chafa's resolveCapsImages):
 * 1. deps.capabilities?.().images when non-null (host truth — survives a
 *    non-shared pi-tui instance); 2. the settings file's terminal.images
 *    ("kitty"/"iterm2" only) when deps.userSettings is provided;
 * 3. trimmed PI_IMAGE_PROTOCOL ("kitty"/"iterm2") when set;
 * 4. null. Positive-only: the ladder only ever returns kitty/iterm2 or null;
 * "auto"/false/"none"/garbage in the settings step never block the env
 * step. Pure; no terminal access; never throws.
 */
/**
 * Terminals positively identified as image-incapable. For these, no declared
 * protocol may be honored: the `terminal.images` settings override, pi's own
 * host capability overrides (which push `terminal.images` into pi-tui's
 * `setCapabilityOverrides`), or `PI_IMAGE_PROTOCOL` would all emit sequences
 * the terminal ignores, leaving a blank viewer instead of the chafa/card
 * fallback (Issue #100).
 *
 * Mirrors pi-tui's negative detection table, plus Alacritty's real markers:
 * pi-tui (and therefore this mirror) keys on `TERM_PROGRAM === "alacritty"`,
 * but Alacritty only sets that on macOS — on Linux it exports `ALACRITTY_*`
 * vars and no `TERM_PROGRAM`. Keep in sync with pi-tui's table and the
 * terminal env facts here.
 */
function knownNoImageSupport(env: Record<string, string | undefined>): boolean {
  const termProgram = (env["TERM_PROGRAM"] ?? "").toLowerCase();
  const terminalEmulator = (env["TERMINAL_EMULATOR"] ?? "").toLowerCase();
  if (termProgram === "alacritty" || termProgram === "vscode" || termProgram === "zed") return true;
  if (terminalEmulator === "jetbrains-jediterm") return true;
  if (
    env["ALACRITTY_LOG"] !== undefined ||
    env["ALACRITTY_WINDOW_ID"] !== undefined ||
    env["ALACRITTY_SOCKET"] !== undefined
  ) {
    return true;
  }
  if (env["WT_SESSION"] !== undefined) return true;
  return false;
}

function resolveNativeProtocol(deps?: {
  capabilities?: () => { images: NativeProtocol | null };
  readText?: ReadText;
  env?: Record<string, string | undefined>;
  userSettings?: string;
}): NativeProtocol | null {
  const env = deps?.env ?? process.env;
  const term = (env["TERM"] ?? "").toLowerCase();
  const isMultiplexer = Boolean(
    env["TMUX"] || term.startsWith("tmux") || term.startsWith("screen"),
  );
  if (isMultiplexer) {
    return null;
  }
  // A terminal positively identified as image-incapable must not receive a
  // declared protocol from ANY source: pi itself pushes `terminal.images`
  // into pi-tui's capability overrides (pi main.js: setCapabilityOverrides),
  // so the caps step below can report kitty in Alacritty too. The negative
  // guard must precede every declaration — emit nothing and let auto/chafa/
  // card take over (Issue #100). Terminals with real capability (kitty,
  // ghostty, wezterm, iTerm2 …) are never in the negative table, so their
  // detection and forcing are unaffected.
  if (knownNoImageSupport(env)) {
    return null;
  }
  const caps = deps?.capabilities?.().images;
  if (caps !== null && caps !== undefined) return caps;
  if (deps?.userSettings !== undefined) {
    const fromSettings = readHostImageSettings(
      { userSettings: deps.userSettings },
      { readText: deps?.readText },
    ).images;
    if (fromSettings !== null) return fromSettings;
  }
  const envProtocol = env["PI_IMAGE_PROTOCOL"];
  if (typeof envProtocol === "string") {
    const trimmed = envProtocol.trim();
    if (trimmed === "kitty" || trimmed === "iterm2") return trimmed;
  }
  return null;
}

/** One native render's context: protocol plus abort/read seams. */
// The kitty graphics protocol's query action (`a=q`) makes a terminal attempt
// to load the payload and reply, per the spec: with an id present, "the
// terminal emulator will reply after trying to load the image, saying whether
// loading was successful or not".
//
// Issue #116 root cause: `f=100` means PNG in the kitty protocol spec. During
// `a=T` (transmit), kitty auto-detects the actual image format regardless of
// the `f=` tag, so JPEG/WebP payloads tagged `f=100` render fine. But during
// `a=q` (query), kitty decodes *strictly per the `f=` tag* — sending a JPEG
// payload tagged `f=100` makes kitty attempt PNG decoding, fail, and return an
// error reply. That error was permanently memoized per MIME, degrading every
// JPEG/WebP for the rest of the process.
//
// Fix: the probe always sends a PNG sample (valid under `f=100`). The question
// it answers is "does this terminal support kitty graphics?" — not "can it
// decode this specific format?" Since pi-tui's `encodeKitty` uses `f=100` for
// all formats and kitty auto-detects at `a=T` time, per-format probing was
// both unnecessary and actively harmful.
//
// The verdict is cached per overlay invocation (not per process) so an error
// from a glitched reply does not permanently degrade the session.

export type KittyProbeVerdict = "ok" | "error" | "no-reply";

/**
 * 1x1 PNG sample for the kitty `a=q` protocol probe (Issue #116). A single
 * PNG is sufficient because `f=100` means PNG in the kitty spec and kitty
 * auto-detects the actual format during `a=T` transmission; the Issue #102
 * per-MIME JPEG/WebP samples failed the probe because kitty decoded them as
 * PNG per the `f=100` tag and are no longer carried.
 */
const KITTY_PROBE_SAMPLE: string =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Build the kitty graphics query escape for the protocol probe
 * (a=q, t=d, f=100). Always transmits the PNG sample — `f=100` means PNG in
 * the kitty spec and the probe tests protocol support, not per-format
 * decodability (Issue #116).
 */
export function buildKittyProbeQuery(id: number): string {
  return `\x1b_Ga=q,t=d,f=100,i=${id};${KITTY_PROBE_SAMPLE}\x1b\\`;
}

/**
 * Incremental state for matching a probe reply across input chunks.
 * The reply is `\x1b_Gi=<id>;OK\x1b\\` (terminals may also use BEL as the
 * string terminator); an error reply carries a printable message instead of
 * `OK`. Replies addressed to other ids are left for other consumers.
 */
export interface KittyProbeState {
  buffer: string;
}

export function createKittyProbeState(): KittyProbeState {
  return { buffer: "" };
}

export interface KittyProbeReply {
  verdict: "ok" | "error" | "pending" | "foreign";
  /** Bytes the reply did not consume (Issue #213): a keystroke coalesced with
   *  the terminal's answer in one input chunk. Always "" unless a verdict
   *  settled. */
  leftover: string;
}

/**
 * Feed one raw input chunk while a probe is pending. Returns:
 * - verdict "pending": not settled yet (wait for more input; never consume)
 * - verdict "foreign": this chunk does not belong to our probe's reply
 * - verdict "ok" | "error": our probe's reply completed (the caller may
 *   consume) and `leftover` carries any bytes after the reply's terminator
 *   (Issue #213).
 *
 * A chunk may carry several exchanges: complete foreign replies are skipped
 * and the scan continues, so our own reply is not lost when it follows one in
 * the same chunk (Issue #193).
 */
export function consumeKittyProbeReply(
  state: KittyProbeState,
  data: string,
  id: number,
): KittyProbeReply {
  state.buffer += data;
  for (;;) {
    const start = state.buffer.indexOf("\x1b_G");
    if (start === -1) {
      if (state.buffer.length > 8192) state.buffer = "";
      return { verdict: "foreign", leftover: "" };
    }
    const head = state.buffer.slice(start);
    const match = head.match(/^\x1b_Gi=(\d+);(.*)$/s);
    if (!match) {
      // A different kitty exchange (or a partial one): keep it in the buffer
      // only while it could still become our reply.
      if (!/^\x1b_Gi=\d+;/.test(head) && head.length > 128) state.buffer = "";
      return { verdict: "pending", leftover: "" };
    }
    const matchId = Number(match[1]);
    const body = match[2] ?? "";
    const term = body.indexOf("\x1b\\");
    const bel = body.indexOf("\x07");
    const end = term === -1 ? bel : term;
    if (matchId !== id) {
      if (end === -1) {
        // The foreign exchange is still incomplete: wait for its terminator.
        if (body.length > 4096) state.buffer = "";
        return { verdict: "pending", leftover: "" };
      }
      // Advance past the complete foreign exchange and re-scan: our own reply
      // may follow in the same chunk (Issue #193).
      state.buffer = body.slice(end + (term === -1 ? 1 : 2));
      continue;
    }
    if (end === -1) {
      // Our id but no terminator yet: wait for the rest of the chunk.
      if (body.length > 4096) state.buffer = "";
      return { verdict: "pending", leftover: "" };
    }
    // The reply occupies `prefix + body[0..end) + terminator`; everything after
    // it in the buffer belongs to the key decoder (Issue #213).
    const prefix = head.length - body.length;
    const leftover = state.buffer.slice(start + prefix + end + (term === -1 ? 1 : 2));
    state.buffer = "";
    const text = body.slice(0, end).trim();
    // Anything but the literal "OK" is the protocol's error message.
    return { verdict: text === "OK" ? "ok" : "error", leftover };
  }
}

export interface NativeRenderCtx {
  protocol: NativeProtocol;
  signal?: AbortSignal;
  /** Test seam; default node fs read. */
  readBytes?: (path: string) => Promise<Uint8Array>;
  /** Optional environment dictionary (test seam; default process.env). */
  env?: Record<string, string | undefined>;
  /**
   * One-shot kitty protocol probe (Issue #101, #116): when present, a kitty
   * render is gated on its verdict — an explicit "error" means the terminal
   * does not support kitty graphics (degrade to chafa/card); "ok" and
   * "no-reply" keep the render (no-reply is conservative: terminals that do
   * not answer queries must not be regressed). The probe is per-protocol, not
   * per-MIME — it always sends a PNG sample since `f=100` means PNG in the
   * kitty spec and kitty auto-detects format at `a=T` time.
   */
  probeDecode?: () => Promise<KittyProbeVerdict>;
  /**
   * Optional image converter for non-PNG formats under Kitty (Issue #116).
   * Kitty's graphics protocol requires PNG format (f=100); non-PNG formats
   * (JPEG, WebP, GIF) are converted to PNG before transmission.
   * Defaults to convertToPng from @earendil-works/pi-coding-agent.
   */
  convertToPng?: (
    base64Data: string,
    mimeType: string,
  ) => Promise<{ data: string; mimeType: string } | null>;
  /**
   * pi-tui encoder override (Issue #144): defaults to the real `renderImage`
   * import. The pipeline threads it through so protocol-level tests can drive
   * the row/layout contract without mutating pi-tui's capability cache.
   */
  renderImage?: typeof renderImage;
}

/**
 * Default bounded read (spec §5.3 step 3, D7): open the file, read at most
 * IMAGE_NATIVE_MAX_BYTES + 1 bytes (never allocating more), close. A full
 * buffer means the file exceeds the cap; the caller decides from the length.
 */
async function nodeReadBytes(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(IMAGE_NATIVE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return bytesRead === buffer.byteLength
      ? buffer
      : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Extension of the basename (lowercased, after the last dot; a leading dot
 * or no dot → no extension) mapped through NATIVE_IMAGE_MIME (D5).
 */
function mimeOfPath(absPath: string): string | undefined {
  const slash = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  const base = slash >= 0 ? absPath.slice(slash + 1) : absPath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return NATIVE_IMAGE_MIME[base.slice(dot + 1).toLowerCase()];
}

/**
 * True when runNativeRender's mime gate (D5) would accept this path. The one
 * home for the native format gate (Issue #143): the renderer and the viewer
 * pane's format hint both read it, so they cannot disagree.
 */
export function isNativelyRenderable(relPath: string): boolean {
  return mimeOfPath(relPath) !== undefined;
}

/**
 * Per-protocol behavior (Issue #144): the four clauses runNativeRender used
 * to branch inline plus the cache policy `isCacheableRender` reads. A new
 * protocol is a table entry, not five conditions kept in sync by hand.
 *
 * kitty: query the terminal before rendering (Issue #101); transcode
 * non-PNG payloads to PNG (`f=100` means PNG, and the terminal auto-detects
 * only at `a=T` time, Issue #116); allocate a fresh image id per render (a
 * re-sent id is re-placed without re-transmission, Issue #112); lay the
 * sequence out first with empty filler rows after it; never cache.
 *
 * iterm2: no query; every format renders inline (no transcode); no id
 * state; the sequence sits in the LAST row, preceded by a cursor-up and the
 * filler rows; cacheable (the rows carry their whole payload).
 */
export const NATIVE_PROTOCOL_RULES: Record<
  NativeProtocol,
  {
    /** Run the kitty `a=q` decode probe before rendering. */
    decodeProbe: boolean;
    /** Transcode non-PNG payloads to PNG (the wire format is PNG). */
    requiresPng: boolean;
    /** Allocate a fresh image id per render. */
    freshImageId: boolean;
    /** Where the platform sequence lands relative to the filler rows. */
    layout: "sequence-first" | "cursor-up-tail";
    /** Whether the rendered rows may be retained in the viewer cache. */
    cacheable: boolean;
  }
> = {
  kitty: {
    decodeProbe: true,
    requiresPng: true,
    freshImageId: true,
    layout: "sequence-first",
    cacheable: false,
  },
  iterm2: {
    decodeProbe: false,
    requiresPng: false,
    freshImageId: false,
    layout: "cursor-up-tail",
    cacheable: true,
  },
};

/**
 * One native render (spec §5.3): abort check → mime gate → bounded read →
 * base64 → pi-tui getImageDimensions → renderImage → Image.render row
 * layout. Every failure is a typed RendererFailure — never throws. No
 * protocol bytes are generated by this module (D3): the sequence and the row
 * layout come entirely from pi-tui, with NATIVE_PROTOCOL_RULES choosing the
 * probe, the transcode, the image id and the layout (Issue #144).
 */
async function runNativeRender(
  absPath: string,
  geometry: { cols: number; rows: number },
  ctx: NativeRenderCtx,
): Promise<
  | { kind: "ok"; lines: string[]; cols: number; rows: number }
  | RendererFailure
> {
  const rules = NATIVE_PROTOCOL_RULES[ctx.protocol];

  // a) Abort before any read.
  if (ctx.signal?.aborted) {
    return { kind: "aborted" };
  }

  // Defensive guard for direct callers (tests pass `env`; production always
  // resolves the protocol via resolveNativeProtocol first, which already
  // applies both guard layers — Issue #100).
  if (ctx.env) {
    const term = (ctx.env["TERM"] ?? "").toLowerCase();
    if (ctx.env["TMUX"] || term.startsWith("tmux") || term.startsWith("screen")) {
      return {
        kind: "failed",
        reason: bounded("image protocols disabled under tmux/screen"),
      };
    }
    if (knownNoImageSupport(ctx.env)) {
      return { kind: "failed", reason: bounded("terminal does not support image protocols") };
    }
  }

  // b) Mime gate (D5): unknown extension — no read. Every NATIVE_IMAGE_MIME
  //    format is accepted; non-PNG is transcoded where the table says so (e).
  const mime = mimeOfPath(absPath);
  if (mime === undefined) {
    return {
      kind: "failed",
      reason: bounded("native rendering does not support this image format"),
    };
  }

  // b2) Kitty protocol probe (Issue #101, #116): an explicit terminal error
  // means the terminal does not support kitty graphics — degrade to chafa/card
  // instead of emitting a sequence the terminal ignores. "ok" and "no-reply"
  // proceed (no-reply is conservative: terminals that do not answer queries
  // keep declared behavior). The probe is per-protocol (always PNG under
  // f=100), not per-MIME — kitty graphics support is verified using a 1x1 PNG.
  if (rules.decodeProbe && ctx.probeDecode !== undefined) {
    let verdict: KittyProbeVerdict;
    try {
      verdict = await ctx.probeDecode();
    } catch {
      verdict = "no-reply";
    }
    if (verdict === "error") {
      return { kind: "failed", reason: bounded("terminal does not support kitty graphics") };
    }
  }

  // c) Bounded read (D7); any read error is a clean failure.
  let bytes: Uint8Array;
  try {
    bytes = await (ctx.readBytes ?? nodeReadBytes)(absPath);
  } catch {
    return { kind: "failed", reason: bounded("could not read the image file") };
  }
  if (bytes.byteLength > IMAGE_NATIVE_MAX_BYTES) {
    return { kind: "failed", reason: bounded("image exceeds the 4 MiB native rendering cap") };
  }

  // d) base64 → dimensions; validity is sniffed from the bytes.
  let base64 = Buffer.from(bytes).toString("base64");
  const dims = getImageDimensions(base64, mime);
  if (dims === null) {
    return { kind: "failed", reason: bounded("could not read image dimensions") };
  }

  // e) Where the table requires PNG (Kitty `f=100`), non-PNG formats (JPEG,
  // WebP, GIF) are converted before transmission (mirroring the pi host Image
  // component / tool-execution), avoiding Kitty PNG decode rejections while
  // enabling native display. iTerm2 carries every format inline.
  if (rules.requiresPng && mime !== "image/png") {
    const convert = ctx.convertToPng ?? convertToPng;
    let converted: { data: string; mimeType: string } | null;
    try {
      converted = await convert(base64, mime);
    } catch {
      converted = null;
    }
    if (!converted) {
      return { kind: "failed", reason: bounded("could not convert image to PNG for Kitty rendering") };
    }
    base64 = converted.data;
  }

  if (ctx.signal?.aborted) {
    return { kind: "aborted" };
  }

  // f) Encode through pi-tui (D3); null means the capability vanished.
  const encode = ctx.renderImage ?? renderImage;
  const result = encode(base64, dims, {
    maxWidthCells: geometry.cols,
    maxHeightCells: geometry.rows,
    imageId: rules.freshImageId ? allocateImageId() : undefined,
    moveCursor: false,
  });
  if (result === null) {
    return { kind: "failed", reason: bounded("native rendering is not available") };
  }

  // g) Row layout from the table, mirroring pi-tui Image.render (0.85.1).
  const lines =
    rules.layout === "sequence-first"
      ? [result.sequence, ...Array(result.rows - 1).fill("")]
      : [
          ...Array(result.rows - 1).fill(""),
          (result.rows > 1 ? `\x1b[${result.rows - 1}A` : "") +
            result.sequence,
        ];

  // h) pi-tui's own geometry is authoritative (aspect-fitted), not the request.
  return { kind: "ok", lines, cols: result.columns, rows: result.rows };
}

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
