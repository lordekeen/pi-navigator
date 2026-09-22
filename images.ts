/**
 * images.ts — optional chafa image rendering (pi-chafa delegation) and
 * native terminal image rendering (pi-tui delegation).
 *
 * pi-chafa presence detection, the read-only pi-chafa config mirror, the
 * chafa binary probe, render args/runner, the strict payload sanitizer,
 * geometry resolution, and the aggregate support snapshot (spec §5.3, §6,
 * §7.2, §8, §12.2).
 *
 * Native rendering (spec §5.3, D3) delegates every encoder decision to
 * pi-tui: runNativeRender reads the file through a bounded readBytes seam
 * (default node fs), base64-encodes it, and asks pi-tui's renderImage for
 * the sequence, then mirrors Image.render's row layout verbatim. No protocol
 * bytes are generated here.
 *
 * Seams: everything except probeChafa / runChafaRender /
 * resolveImageSupport's probe call is pure or injectable (readText / exec /
 * readBytes), so the whole module is testable with fixtures — no test
 * touches the real $HOME, a real chafa, or real settings. There is no import
 * from pi-chafa (D2): only its config JSON is read. The payload whitelist
 * (D7) is stricter than pi-chafa's transcript cleaner: only SGR survives,
 * plus chafa's two absolute-mode cursor escapes, which are recognized and
 * dropped (rev. 2 amendment 1).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  allocateImageId,
  getImageDimensions,
  renderImage,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  CHAFA_MIN_VERSION,
  IMAGE_CELLS_MAX,
  IMAGE_CELLS_MIN,
  IMAGE_ERROR_MAX_CHARS,
  IMAGE_MAX_BUFFER_BYTES,
  IMAGE_NATIVE_MAX_BYTES,
  IMAGE_PROBE_TIMEOUT_MS,
  IMAGE_RENDER_TIMEOUT_MAX_MS,
  IMAGE_RENDER_TIMEOUT_MIN_MS,
  IMAGE_ROWS_MIN,
  NATIVE_IMAGE_MIME,
  PI_CHAFA_CONFIG_FILE,
} from "./constants";

import type { NavigatorImageMode } from "./settings";
import { parseTruthyEnv } from "./env";

// ── native-image tier types (spec §5.3) ──

/** Effective image renderer for a session (spec §5.4, D10). */
export type ImageTier = "native" | "chafa" | "none";

/** Terminal image protocols pi-tui can render (closed union, D2). */
export type NativeProtocol = "kitty" | "iterm2";

// ── shared plumbing ──

export type ReadText = (path: string) => string | undefined;

/** Default readText: node fs, never throws, missing/unreadable → undefined. */
function nodeReadText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Bound a user-facing failure detail to IMAGE_ERROR_MAX_CHARS. */
function bounded(text: string): string {
  return text.length <= IMAGE_ERROR_MAX_CHARS
    ? text
    : `${text.slice(0, IMAGE_ERROR_MAX_CHARS - 1)}…`;
}

// ── pi-chafa presence ──

/** Structural provenance subset of pi's SourceInfo (spec §3.2). */
export interface PiChafaSourceInfoLike {
  path?: string;
  baseDir?: string;
}

export interface PiChafaApi {
  getAllTools(): Array<{ name: string; sourceInfo?: PiChafaSourceInfoLike }>;
  getCommands(): Array<{
    name: string;
    source?: string;
    sourceInfo?: PiChafaSourceInfoLike;
  }>;
}

export interface PiChafaStatus {
  present: boolean;
  via: "runtime" | "settings" | "none";
  /** Package root when discovered; for diagnostics/help copy only. */
  packageRoot?: string;
}

/**
 * Confirm a tool/command's identity by reading package.json from
 * sourceInfo.baseDir and from the entry's directory plus up to 3 ancestor
 * directories; present ⇔ parsed `name === "pi-chafa"`. Returns the package
 * root directory on a hit. Unreadable or malformed package.json files are
 * skipped. `sourceInfo.source` is deliberately unused (it is often just
 * "local"); the package.json name is the stable identity (spec §6.1).
 */
function confirmPackageIdentity(
  sourceInfo: PiChafaSourceInfoLike | undefined,
  readText: ReadText,
): string | undefined {
  if (!sourceInfo) return undefined;
  const candidates: string[] = [];
  if (typeof sourceInfo.baseDir === "string" && sourceInfo.baseDir !== "") {
    candidates.push(sourceInfo.baseDir);
  }
  if (typeof sourceInfo.path === "string" && sourceInfo.path !== "") {
    let dir = dirname(sourceInfo.path);
    for (let hops = 0; hops < 4; hops += 1) {
      candidates.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const dir of candidates) {
    if (packageName(readText, join(dir, "package.json")) === "pi-chafa") {
      return dir;
    }
  }
  return undefined;
}

function packageName(
  readText: ReadText,
  packageJsonPath: string,
): string | undefined {
  const text = readText(packageJsonPath);
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const name = (parsed as Record<string, unknown>).name;
      if (typeof name === "string") return name;
    }
  } catch {
    // malformed package.json — try the next candidate
  }
  return undefined;
}

/**
 * A settings `packages` entry counts when its last path segment is "pi-chafa"
 * after stripping an "npm:" prefix, trailing slashes, and a trailing
 * "@version" suffix: "npm:pi-chafa", "npm:pi-chafa@1.2.3",
 * "../../Sources/pi-chafa", "npm:@scope/pi-chafa", "npm:pi-chafa/".
 */
function isPiChafaPackageEntry(entry: string): boolean {
  let s = entry.trim();
  if (s.startsWith("npm:")) s = s.slice("npm:".length);
  s = s.replace(/[\\/]+$/, "");
  s = s.replace(/\\/g, "/");
  const slash = s.lastIndexOf("/");
  const last = slash >= 0 ? s.slice(slash + 1) : s;
  const name = last.startsWith("@") ? last : last.replace(/@[^/]*$/, "");
  return name === "pi-chafa";
}

/** True when a settings file's `packages` array lists pi-chafa. */
function packagesListPiChafa(text: string | undefined): boolean {
  if (text === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const packages = (parsed as Record<string, unknown>).packages;
  if (!Array.isArray(packages)) return false;
  return packages.some(
    (entry) => typeof entry === "string" && isPiChafaPackageEntry(entry),
  );
}

/**
 * Ordered pi-chafa presence evidence; first hit wins (spec §6.1, D3):
 * 1. runtime — a "show_image" tool (fallback: an "images" extension command)
 *    whose nearby package.json is named "pi-chafa" (never the tool/command
 *    name alone); 2. a `packages` listing in the user or project settings
 *    file; 3. absent. A readable pi-chafa.json is NOT evidence. Tolerates
 *    missing provenance, unreadable files, and malformed JSON; never throws.
 */
export function detectPiChafa(
  api: PiChafaApi,
  paths: { userSettings: string; projectSettings: string },
  deps?: { readText?: ReadText },
): PiChafaStatus {
  const readText = deps?.readText ?? nodeReadText;

  // 1. Runtime (authoritative).
  const tool = api.getAllTools().find((t) => t.name === "show_image");
  const command = tool
    ? undefined
    : api
        .getCommands()
        .find((c) => c.name === "images" && c.source === "extension");
  const entry = tool ?? command;
  if (entry) {
    const packageRoot = confirmPackageIdentity(entry.sourceInfo, readText);
    if (packageRoot !== undefined) {
      return { present: true, via: "runtime", packageRoot };
    }
  }

  // 2. Settings listing (user, then project).
  for (const settingsPath of [paths.userSettings, paths.projectSettings]) {
    if (packagesListPiChafa(readText(settingsPath))) {
      return { present: true, via: "settings" };
    }
  }

  // 3. Absent.
  return { present: false, via: "none" };
}

// ── pi-chafa config (read-only mirror of the documented subset) ──

export type ChafaColors = "none" | "2" | "8" | "16" | "240" | "256" | "full";
export type ChafaDither = "none" | "ordered" | "diffusion" | "noise";

const COLOR_MODES: readonly ChafaColors[] = [
  "none",
  "2",
  "8",
  "16",
  "240",
  "256",
  "full",
];
const DITHER_MODES: readonly ChafaDither[] = [
  "none",
  "ordered",
  "diffusion",
  "noise",
];

function isColorMode(value: unknown): value is ChafaColors {
  return (
    typeof value === "string" &&
    (COLOR_MODES as readonly string[]).includes(value)
  );
}

function isDitherMode(value: unknown): value is ChafaDither {
  return (
    typeof value === "string" &&
    (DITHER_MODES as readonly string[]).includes(value)
  );
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export interface PiChafaSubset {
  version: number;
  binaryPath: string | null;
  cellWidth: number;
  maxRows: number;
  colors: ChafaColors;
  symbolsSet: string;
  dither: ChafaDither;
  timeoutMs: number;
  /** Mirrored pi-chafa preference (D6): honored by mode "auto"; default true. */
  preferNative: boolean;
}

/** Defaults mirror pi-chafa's DEFAULT_CONFIG for the mirrored subset (§3.1); preferNative is mirrored (D6), formatOrder stays ignored. */
export const DEFAULT_PI_CHAFA_SUBSET: PiChafaSubset = {
  version: 1,
  binaryPath: null,
  cellWidth: 60,
  maxRows: 50,
  colors: "240",
  symbolsSet: "block+border",
  dither: "none",
  timeoutMs: 8000,
  preferNative: true,
};

/** Validate an unknown raw config object; unknown keys and invalid values are skipped silently (pi-chafa parity). */
function validatePiChafaConfig(raw: unknown): Partial<PiChafaSubset> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: Partial<PiChafaSubset> = {};

  if (
    typeof record.version === "number" &&
    Number.isInteger(record.version) &&
    record.version > 0
  ) {
    out.version = record.version;
  }
  const cellWidth = positiveInt(record.cellWidth);
  if (cellWidth !== undefined) out.cellWidth = cellWidth;
  const maxRows = positiveInt(record.maxRows);
  if (maxRows !== undefined) out.maxRows = maxRows;
  const timeoutMs = positiveInt(record.timeoutMs);
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  if (isColorMode(record.colors)) out.colors = record.colors;
  if (isDitherMode(record.dither)) out.dither = record.dither;
  if (
    typeof record.symbolsSet === "string" &&
    record.symbolsSet.trim() !== ""
  ) {
    out.symbolsSet = record.symbolsSet.trim();
  }
  if (record.binaryPath === null) out.binaryPath = null;
  else if (
    typeof record.binaryPath === "string" &&
    record.binaryPath.trim() !== ""
  ) {
    out.binaryPath = record.binaryPath.trim();
  }
  // preferNative mirrors pi-chafa: only a real boolean counts (D6); anything
  // else is skipped silently so the default stands.
  if (typeof record.preferNative === "boolean") {
    out.preferNative = record.preferNative;
  }
  return out;
}

function envValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim() === "") return undefined;
  return value.trim();
}

function envPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const value = envValue(env, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Default config dir: CHAFA_CONFIG_DIR override else ~/.pi/agent (pi-chafa parity). */
function defaultConfigDir(env: Record<string, string | undefined>): string {
  return envValue(env, "CHAFA_CONFIG_DIR") ?? join(homedir(), ".pi", "agent");
}

/**
 * Load + validate pi-chafa.json into the mirrored subset; precedence
 * defaults ← file ← CHAFA_* env (pi-chafa parity). CHAFA_CONFIG_DIR (a
 * non-empty trimmed string) wins for locating the file; otherwise
 * deps.agentDir, else ~/.pi/agent. Missing/corrupt files fall back to
 * defaults; invalid file values and invalid env values are skipped silently;
 * empty/whitespace env is treated as absent. The parsed `version` is
 * exposed; the `version > 1` guard lives in resolveImageSupport.
 */
export function loadPiChafaConfig(deps?: {
  agentDir?: string;
  env?: Record<string, string | undefined>;
  readText?: ReadText;
}): PiChafaSubset {
  const env = deps?.env ?? process.env;
  const readText = deps?.readText ?? nodeReadText;
  const dir = envValue(env, "CHAFA_CONFIG_DIR") ?? deps?.agentDir ?? defaultConfigDir(env);
  const config: PiChafaSubset = { ...DEFAULT_PI_CHAFA_SUBSET };
  if (dir) {
    const raw = readText(join(dir, PI_CHAFA_CONFIG_FILE));
    if (raw !== undefined) {
      try {
        const validated = validatePiChafaConfig(JSON.parse(raw));
        Object.assign(config, validated);
      } catch {
        // corrupt JSON → defaults
      }
    }
  }
  // CHAFA_* env over the file: env wins; invalid env values skipped.
  const bin = envValue(env, "CHAFA_BIN");
  const cellWidth = envPositiveInt(env, "CHAFA_CELL_WIDTH");
  const maxRows = envPositiveInt(env, "CHAFA_MAX_ROWS");
  const timeoutMs = envPositiveInt(env, "CHAFA_TIMEOUT_MS");
  const colors = envValue(env, "CHAFA_COLORS");
  const symbolsSet = envValue(env, "CHAFA_SYMBOLS");
  const dither = envValue(env, "CHAFA_DITHER");
  // pi-chafa's envBoolean semantics via the shared truth table; any warning
  // parseTruthyEnv would emit is dropped — pi-chafa ignores invalid env
  // silently, falling back to file/default (D6).
  const preferNative = parseTruthyEnv(
    env["CHAFA_PREFER_NATIVE"],
    "CHAFA_PREFER_NATIVE",
  ).value;
  return {
    ...config,
    binaryPath: bin ?? config.binaryPath,
    cellWidth: cellWidth ?? config.cellWidth,
    maxRows: maxRows ?? config.maxRows,
    timeoutMs: timeoutMs ?? config.timeoutMs,
    colors: isColorMode(colors) ? colors : config.colors,
    symbolsSet: symbolsSet ?? config.symbolsSet,
    dither: isDitherMode(dither) ? dither : config.dither,
    preferNative: preferNative ?? config.preferNative,
  };
}

// ── chafa binary ──

export type ChafaStatus =
  | { state: "ok"; binary: string; version: { major: number; minor: number } }
  | { state: "missing" | "too-old" | "error"; detail: string };

interface ExecOpts {
  timeout: number;
  signal?: AbortSignal;
  encoding: "utf8";
  maxBuffer: number;
}

export type ExecFn = (
  bin: string,
  args: string[],
  opts: ExecOpts,
) => Promise<{ stdout: string; stderr: string }>;

type ExecError = NodeJS.ErrnoException & {
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
};

/** execFile wrapper — no shell; stdout/stderr attached to the rejection (pi-chafa parity). */
function nodeExecFile(
  bin: string,
  args: string[],
  opts: ExecOpts,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, opts, (error, stdout, stderr) => {
      if (error) {
        const err = error as ExecError;
        err.stdout ??= String(stdout);
        err.stderr ??= String(stderr);
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Probe stdout cap for `chafa --version` (1 MiB). */
const MAX_PROBE_BUFFER = 1024 * 1024;

/** Platform install hint — copied verbatim from pi-chafa for cross-extension consistency. */
function installHint(binary: string): string {
  let hint: string;
  if (process.platform === "darwin") {
    hint = "brew install chafa";
  } else if (process.platform === "win32") {
    hint = "grab a build from https://hpjansson.org/chafa/";
  } else {
    hint = "apt install chafa (or your distro's package)";
  }
  return `chafa was not found on PATH (looked for ${binary}). Install it with: ${hint}. Or set CHAFA_BIN to its absolute path.`;
}

/**
 * Resolve the chafa binary (trimmed binaryPath else "chafa" on PATH) and
 * verify it meets CHAFA_MIN_VERSION (spec §6.2). Never throws — ENOENT →
 * missing with the verbatim install hint; unparsable output or other exec
 * failures → error; a version below 1.10 → too-old.
 */
export async function probeChafa(
  binaryPath: string | null,
  exec?: ExecFn,
): Promise<ChafaStatus> {
  const binary =
    binaryPath && binaryPath.trim() !== "" ? binaryPath.trim() : "chafa";
  const execFn = exec ?? nodeExecFile;
  let stdout: string;
  try {
    const result = await execFn(binary, ["--version"], {
      timeout: IMAGE_PROBE_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: MAX_PROBE_BUFFER,
    });
    stdout = result.stdout;
  } catch (error) {
    const err = error as ExecError;
    if (err.code === "ENOENT") {
      return { state: "missing", detail: installHint(binary) };
    }
    return {
      state: "error",
      detail: bounded(`Failed to run ${binary} --version: ${err.message}`),
    };
  }
  const match = /Chafa version (\d+)\.(\d+)/.exec(stdout);
  if (!match) {
    return {
      state: "error",
      detail: `Could not parse a version from "${binary} --version". Is ${binary} really chafa?`,
    };
  }
  const version = { major: Number(match[1]), minor: Number(match[2]) };
  if (
    version.major < CHAFA_MIN_VERSION.major ||
    (version.major === CHAFA_MIN_VERSION.major &&
      version.minor < CHAFA_MIN_VERSION.minor)
  ) {
    return {
      state: "too-old",
      detail:
        `chafa ${version.major}.${version.minor} is older than the minimum supported version ` +
        `${CHAFA_MIN_VERSION.major}.${CHAFA_MIN_VERSION.minor}. Upgrade chafa (${installHint(binary)}) ` +
        `or point CHAFA_BIN at a newer binary.`,
    };
  }
  return { state: "ok", binary, version };
}

// ── render ──

/**
 * The chafa symbols arg vector — pi-chafa's buildSymbolsArgs (spec §3.1,
 * verbatim order), with the size taken from the live pane-bounded geometry
 * (§7.2). No shell: the image path is argv, never interpolated.
 */
export function buildSymbolsArgs(
  imagePath: string,
  s: PiChafaSubset,
  geometry: { cols: number; rows: number },
): string[] {
  return [
    "--format",
    "symbols",
    "--relative",
    "off",
    "--size",
    `${geometry.cols}x${geometry.rows}`,
    "--colors",
    s.colors,
    "--symbols",
    s.symbolsSet,
    "--dither",
    s.dither,
    "--animate",
    "off",
    imagePath,
  ];
}

const ESC = "\x1b";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
// Assembled from the ESC constant (not a control-character regex literal).
const SGR_RE = new RegExp(`^${ESC}\\[[0-9;]*m`);

/**
 * Chafa output is untrusted ANSI; the whitelist is strict (spec §8, D7):
 * only SGR (`\x1b[…m`) survives; chafa's absolute-mode cursor-hide/show
 * escapes are recognized and dropped (rev. 2 amendment 1); any other ESC
 * form (CSI cursor ops, other `?` modes, OSC, DCS, lone ESC) rejects the
 * whole payload. Then strip `\r`, split on `\n`, drop trailing empty lines,
 * cap to geometry.rows, truncate over-wide lines with an empty ellipsis
 * (hard-cut, Issue #010), and guarantee a per-row trailing `\x1b[0m`.
 * Empty results are rejected. Lines are returned with no trailing `\n`.
 */
export function sanitizeChafaPayload(
  raw: string,
  geometry: { cols: number; rows: number },
): { ok: true; lines: string[] } | { ok: false; reason: string } {
  // 1. ESC whitelist scan, left to right.
  let cleaned = "";
  let i = 0;
  for (;;) {
    const esc = raw.indexOf(ESC, i);
    if (esc === -1) {
      cleaned += raw.slice(i);
      break;
    }
    cleaned += raw.slice(i, esc);
    const rest = raw.slice(esc);
    const sgr = SGR_RE.exec(rest);
    if (sgr !== null && sgr[0] !== undefined) {
      cleaned += sgr[0];
      i = esc + sgr[0].length;
      continue;
    }
    if (rest.startsWith(CURSOR_HIDE) || rest.startsWith(CURSOR_SHOW)) {
      i = esc + CURSOR_HIDE.length;
      continue;
    }
    return { ok: false, reason: "unexpected escape sequence" };
  }

  // 2. Strip carriage returns (Issue #009 class).
  cleaned = cleaned.replace(/\r/g, "");

  // 3. Split, drop trailing empty lines, cap to geometry.rows.
  const split = cleaned.split("\n");
  while (split.length > 0 && split[split.length - 1] === "") split.pop();
  const capped = split.slice(0, geometry.rows);
  if (capped.length === 0) {
    return { ok: false, reason: "chafa produced no output" };
  }

  // 4. Per-row width safety + guaranteed reset.
  const lines = capped.map((line) => {
    let out = line;
    if (visibleWidth(out) > geometry.cols) {
      // Empty ellipsis hard-cuts; truncateToWidth appends a reset when it cuts.
      out = truncateToWidth(out, geometry.cols, "");
    }
    if (!out.endsWith("\x1b[0m")) out += "\x1b[0m";
    return out;
  });
  return { ok: true, lines };
}

/**
 * Run one chafa render: timeout clamped to [IMAGE_RENDER_TIMEOUT_MIN_MS,
 * IMAGE_RENDER_TIMEOUT_MAX_MS], stdout capped at IMAGE_MAX_BUFFER_BYTES, tied
 * to ctx.signal. Aborts, timeouts, stderr, and nonzero exits all become
 * { ok: false, reason } (never a throw); success is the sanitized payload.
 */
export async function runChafaRender(
  absPath: string,
  geometry: { cols: number; rows: number },
  ctx: {
    binary: string;
    config: PiChafaSubset;
    signal?: AbortSignal;
    exec?: ExecFn;
  },
): Promise<{ ok: true; lines: string[] } | { ok: false; reason: string }> {
  const timeoutMs = clamp(
    ctx.config.timeoutMs,
    IMAGE_RENDER_TIMEOUT_MIN_MS,
    IMAGE_RENDER_TIMEOUT_MAX_MS,
  );
  const execFn = ctx.exec ?? nodeExecFile;
  let stdout: string;
  try {
    const result = await execFn(
      ctx.binary,
      buildSymbolsArgs(absPath, ctx.config, geometry),
      {
        timeout: timeoutMs,
        signal: ctx.signal,
        encoding: "utf8",
        maxBuffer: IMAGE_MAX_BUFFER_BYTES,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    const err = error as ExecError;
    if (
      err.name === "AbortError" ||
      err.code === "ABORT_ERR" ||
      ctx.signal?.aborted
    ) {
      return { ok: false, reason: "render aborted" };
    }
    if (err.killed || err.signal === "SIGTERM") {
      return {
        ok: false,
        reason: bounded(
          `chafa timed out after ${timeoutMs}ms. Reduce the image size, lower cellWidth/maxRows, or raise timeoutMs in pi-chafa config.`,
        ),
      };
    }
    const stderr = (err.stderr ?? "").trim();
    if (stderr) {
      return { ok: false, reason: bounded(`chafa exited with an error: ${stderr}`) };
    }
    return {
      ok: false,
      reason: bounded(`chafa failed (code ${String(err.code ?? "unknown")})`),
    };
  }
  return sanitizeChafaPayload(stdout, geometry);
}

// ── host + geometry ──

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

// ── native render (spec §5.3, D3, D5, D7) ──

/** One native render's context: protocol plus abort/read seams. */
// ── Kitty decode probe (Issue #101) ───────────────────────────────────────
// The kitty graphics protocol's query action (`a=q`) makes a terminal attempt
// to load the payload and reply, per the spec: with an id present, "the
// terminal emulator will reply after trying to load the image, saying whether
// loading was successful or not". One 1x1 PNG probe per session tells us
// whether native payloads are actually decodable instead of trusting
// declarations and advertisement (verified 68-byte gray+alpha PNG).

export type KittyProbeVerdict = "ok" | "error" | "no-reply";

/** 1x1 PNG sample payload for the kitty `a=q` decode probe. */
export const KITTY_PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** Build the kitty graphics query escape for the 1x1 PNG probe (a=q, t=d). */
export function buildKittyProbeQuery(id: number): string {
  return `\x1b_Ga=q,t=d,f=100,i=${id};${KITTY_PROBE_PNG_BASE64}\x1b\\`;
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

/**
 * Feed one raw input chunk while a probe is pending. Returns:
 * - "pending": not settled yet (wait for more input; never consume)
 * - "foreign": this chunk does not belong to our probe's reply (consume=false)
 * - "ok" | "error": our probe's reply completed (the caller may consume)
 */
export function consumeKittyProbeReply(
  state: KittyProbeState,
  data: string,
  id: number,
): "ok" | "error" | "pending" | "foreign" {
  state.buffer += data;
  const start = state.buffer.indexOf("\x1b_G");
  if (start === -1) {
    if (state.buffer.length > 8192) state.buffer = "";
    return "foreign";
  }
  const head = state.buffer.slice(start);
  const match = head.match(/^\x1b_Gi=(\d+);(.*)$/s);
  if (!match) {
    // A different kitty exchange (or a partial one): keep it in the buffer
    // only while it could still become our reply.
    if (!/^\x1b_Gi=\d+;/.test(head) && head.length > 128) state.buffer = "";
    return "pending";
  }
  const matchId = Number(match[1]);
  if (matchId !== id) {
    state.buffer = "";
    return "foreign";
  }
  const body = match[2] ?? "";
  const term = body.indexOf("\x1b\\");
  const bel = body.indexOf("\x07");
  const end = term === -1 ? bel : term;
  if (end === -1) {
    // Our id but no terminator yet: wait for the rest of the chunk.
    if (body.length > 4096) state.buffer = "";
    return "pending";
  }
  state.buffer = "";
  const text = body.slice(0, end).trim();
  // Anything but the literal "OK" is the protocol's error message.
  return text === "OK" ? "ok" : "error";
}

export interface NativeRenderCtx {
  protocol: NativeProtocol;
  signal?: AbortSignal;
  /** Test seam; default node fs read. */
  readBytes?: (path: string) => Promise<Uint8Array>;
  /** Optional environment dictionary (test seam; default process.env). */
  env?: Record<string, string | undefined>;
  /**
   * One-shot kitty decode probe (Issue #101): when present, a kitty render is
   * gated on its verdict — an explicit "error" means the terminal cannot
   * decode the payload (degrade to chafa/card); "ok" and "no-reply" keep
   * the render (no-reply is conservative: terminals that do not answer
   * queries must not be regressed).
   */
  probeDecode?: (mime: string) => Promise<KittyProbeVerdict>;
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
 * One native render (spec §5.3): abort check → mime gate → bounded read →
 * base64 → pi-tui getImageDimensions → renderImage → Image.render row
 * layout. Every failure is a bounded { ok: false, reason } — never throws.
 * No protocol bytes are generated by this module (D3): the sequence and the
 * row layout come entirely from pi-tui.
 */
export async function runNativeRender(
  absPath: string,
  geometry: { cols: number; rows: number },
  ctx: NativeRenderCtx,
): Promise<
  | { ok: true; lines: string[]; cols: number; rows: number }
  | { ok: false; reason: string }
> {
  // a) Abort before any read.
  if (ctx.signal?.aborted) {
    return { ok: false, reason: bounded("render aborted") };
  }

  // Defensive guard for direct callers (tests pass `env`; production always
  // resolves the protocol via resolveNativeProtocol first, which already
  // applies both guard layers — Issue #100).
  if (ctx.env) {
    const term = (ctx.env["TERM"] ?? "").toLowerCase();
    if (ctx.env["TMUX"] || term.startsWith("tmux") || term.startsWith("screen")) {
      return {
        ok: false,
        reason: bounded("image protocols disabled under tmux/screen"),
      };
    }
    if (knownNoImageSupport(ctx.env)) {
      return { ok: false, reason: bounded("terminal does not support image protocols") };
    }
  }

  // b) Mime gate (D5): unknown extension, or kitty with a non-PNG/JPEG/WebP mime — no read.
  const mime = mimeOfPath(absPath);
  if (mime === undefined) {
    return {
      ok: false,
      reason: bounded("native rendering does not support this image format"),
    };
  }
  if (
    ctx.protocol === "kitty" &&
    mime !== "image/png" &&
    mime !== "image/jpeg" &&
    mime !== "image/webp"
  ) {
    return { ok: false, reason: bounded("kitty requires PNG, JPEG, or WebP") };
  }

  // b2) Kitty decode probe (Issue #101): an explicit terminal error means the
  // payload cannot be decoded — degrade to chafa/card instead of emitting a
  // sequence the terminal ignores. "ok" and "no-reply" proceed (no-reply is
  // conservative: terminals that do not answer queries keep declared behavior).
  if (ctx.protocol === "kitty" && ctx.probeDecode !== undefined) {
    let verdict: KittyProbeVerdict;
    try {
      verdict = await ctx.probeDecode(mime);
    } catch {
      verdict = "no-reply";
    }
    if (verdict === "error") {
      return { ok: false, reason: bounded("terminal cannot decode this image format") };
    }
  }

  // c) Bounded read (D7); any read error is a clean failure.
  let bytes: Uint8Array;
  try {
    bytes = await (ctx.readBytes ?? nodeReadBytes)(absPath);
  } catch {
    return { ok: false, reason: bounded("could not read the image file") };
  }
  if (bytes.byteLength > IMAGE_NATIVE_MAX_BYTES) {
    return { ok: false, reason: bounded("image exceeds the 4 MiB native rendering cap") };
  }

  // d) base64 → dimensions; validity is sniffed from the bytes.
  const base64 = Buffer.from(bytes).toString("base64");
  const dims = getImageDimensions(base64, mime);
  if (dims === null) {
    return { ok: false, reason: bounded("could not read image dimensions") };
  }

  // e) Encode through pi-tui (D3); null means the capability vanished.
  const result = renderImage(base64, dims, {
    maxWidthCells: geometry.cols,
    maxHeightCells: geometry.rows,
    imageId: ctx.protocol === "kitty" ? allocateImageId() : undefined,
    moveCursor: false,
  });
  if (result === null) {
    return { ok: false, reason: bounded("native rendering is not available") };
  }

  // f) Row layout, mirroring pi-tui Image.render (0.85.1) exactly.
  const lines =
    ctx.protocol === "kitty"
      ? [result.sequence, ...Array(result.rows - 1).fill("")]
      : [
          ...Array(result.rows - 1).fill(""),
          (result.rows > 1 ? `\x1b[${result.rows - 1}A` : "") +
            result.sequence,
        ];

  // g) pi-tui's own geometry is authoritative (aspect-fitted), not the request.
  return { ok: true, lines, cols: result.columns, rows: result.rows };
}

/**
 * Pane-bounded chafa geometry (spec §7.2, rev. 2 amendments 2–3). The pane is
 * the hard cap; the pi-chafa cellWidth preference is honored whenever the
 * pane is wider. Rejects panes below IMAGE_CELLS_MIN / IMAGE_ROWS_MIN.
 */
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
  const upperRows = Math.max(IMAGE_ROWS_MIN, input.maxRows);
  const rows = clamp(
    Math.min(input.maxRows, input.paneRows),
    IMAGE_ROWS_MIN,
    upperRows,
  );
  return { ok: true, cols, rows };
}

// ── aggregate support ──

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