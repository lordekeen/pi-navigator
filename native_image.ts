/**
 * native_image.ts — the native (kitty/iTerm2) image tier (split out of
 * `images.ts`, Issue #223).
 *
 * Owns the instance-independent capability ladder (`resolveNativeProtocol`,
 * including pi's terminal-image settings and the negative terminal table),
 * the kitty `a=q` probe state machine (`buildKittyProbeQuery` /
 * `createKittyProbeState` / `consumeKittyProbeReply`), the per-protocol rules
 * table `NATIVE_PROTOCOL_RULES`, the mime gate (`isNativelyRenderable`) and
 * the bounded pi-tui renderer `runNativeRender` (spec §5.3, D3/D4/D5).
 *
 * No protocol bytes are generated here (D3): every encoder decision delegates
 * to pi-tui's `renderImage`, and the module only mirrors pi-tui's row layout
 * while the rules table chooses the probe/transcode/image-id/layout clauses
 * (Issue #144). Seams (readBytes / convertToPng / renderImage / capabilities)
 * keep the whole module testable without a real terminal.
 */

import { open } from "node:fs/promises";

import {
  allocateImageId,
  getImageDimensions,
  renderImage,
} from "@earendil-works/pi-tui";

import { convertToPng } from "@earendil-works/pi-coding-agent";

import { IMAGE_NATIVE_MAX_BYTES, NATIVE_IMAGE_MIME } from "./constants";
import { bounded, nodeReadText, type ReadText, type RendererFailure } from "./chafa";

/** Terminal image protocols pi-tui can render (closed union, D2). */
export type NativeProtocol = "kitty" | "iterm2";

/**
 * Read pi's own terminal image settings (spec §6.3). Defaults
 * { showImages: true, imageWidthCells: 60, images: null }; honors
 * terminal.showImages (boolean), terminal.imageWidthCells (positive int),
 * and terminal.images (exact "kitty"/"iterm2" only — anything else,
 * including false/"auto"/"none"/absent/non-string, is null). Missing or
 * corrupt files, and invalid values, fall back to defaults. Never throws.
 */
export function readHostImageSettings(
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

export function resolveNativeProtocol(deps?: {
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
export async function runNativeRender(
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
