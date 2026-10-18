/**
 * chafa.ts — the optional chafa render tier: pi-chafa detection, the
 * pi-chafa.json config mirror, the binary probe, the renderer and the strict
 * payload sanitizer (split out of `images.ts`, Issue #223).
 *
 * Owns pi-chafa presence evidence (`detectPiChafa`), the read-only config
 * subset (`loadPiChafaConfig` / `PiChafaSubset`), the `chafa --version`
 * probe (`probeChafa` / `ChafaStatus`), the argv builder + runner
 * (`runChafaRender`) and the SGR-only payload whitelist
 * (`sanitizeChafaPayload`) (spec §3.1, §6.1, §6.2, §8). There is no import
 * from pi-chafa (D2): only its config JSON is read.
 *
 * Seams: readText / exec are injectable, so the whole module is testable
 * with fixtures — no test touches the real $HOME, a real chafa, or real
 * settings.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  CHAFA_MIN_VERSION,
  IMAGE_ERROR_MAX_CHARS,
  IMAGE_MAX_BUFFER_BYTES,
  IMAGE_PROBE_TIMEOUT_MS,
  IMAGE_RENDER_TIMEOUT_MAX_MS,
  IMAGE_RENDER_TIMEOUT_MIN_MS,
  PI_CHAFA_CONFIG_FILE,
} from "./constants";
import { parseTruthyEnv } from "./env";
import { sanitizeText } from "./ansi";
import { boundText, clamp } from "./bytes";

export type ReadText = (path: string) => string | undefined;

/** Default readText: node fs, never throws, missing/unreadable → undefined. */
export function nodeReadText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Bound a user-facing failure detail to IMAGE_ERROR_MAX_CHARS. This is the
 * single untrusted-boundary bounder: every failure/probe detail (chafa
 * stderr, timeouts, exit codes, probe errors) funnels through here before it
 * reaches a rendered row, so it also strips terminal-active control bytes
 * (Issue #216) — chafa's stderr echoes the repo-controlled image path, and an
 * ESC/BEL in a filename would otherwise corrupt the image card's hint row.
 * Sanitizing before the length cap keeps the stored string ≤ the cap.
 */
export function bounded(text: string): string {
  return boundText(sanitizeText(text), IMAGE_ERROR_MAX_CHARS);
}

/**
 * The failure half of a renderer's raw result (Issue #144): a clean failure
 * with a bounded, renderer-agnostic reason, or a typed supersession.
 */
export type RendererFailure = { kind: "failed"; reason: string } | { kind: "aborted" };

/** Structural provenance subset of pi's SourceInfo (spec §3.2). */
interface PiChafaSourceInfoLike {
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

type ChafaColors = "none" | "2" | "8" | "16" | "240" | "256" | "full";
type ChafaDither = "none" | "ordered" | "diffusion" | "noise";

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

/**
 * The chafa symbols arg vector — pi-chafa's buildSymbolsArgs (spec §3.1,
 * verbatim order), with the size taken from the live pane-bounded geometry
 * (§7.2). No shell: the image path is argv, never interpolated.
 */
function buildSymbolsArgs(
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
// Sticky (y) so matching runs against `raw` at an explicit lastIndex, never
// slicing the tail (Issue #104: the old ^-anchored exec over raw.slice(esc)
// allocated the whole suffix on every escape). Assembled from the ESC
// constant (not a control-character regex literal).
const SGR_STICKY_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "y");

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
    SGR_STICKY_RE.lastIndex = esc;
    const sgr = SGR_STICKY_RE.exec(raw);
    if (sgr !== null && sgr[0] !== undefined) {
      cleaned += sgr[0];
      i = esc + sgr[0].length;
      continue;
    }
    if (raw.startsWith(CURSOR_HIDE, esc) || raw.startsWith(CURSOR_SHOW, esc)) {
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
 * to ctx.signal. Aborts, timeouts, stderr, and nonzero exits all become a
 * typed RendererFailure (never a throw); success is the sanitized payload.
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
): Promise<{ kind: "ok"; lines: string[] } | RendererFailure> {
  const timeoutMs = clamp(
    ctx.config.timeoutMs,
    IMAGE_RENDER_TIMEOUT_MIN_MS,
    IMAGE_RENDER_TIMEOUT_MAX_MS,
  );
  const execFn = ctx.exec ?? nodeExecFile;
  // Pre-spawn abort check, mirroring runNativeRender's entry check (Issue #117
  // follow-up): a superseded load must not fork a chafa child at all.
  if (ctx.signal?.aborted) {
    return { kind: "aborted" };
  }
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
      return { kind: "aborted" };
    }
    if (err.killed || err.signal === "SIGTERM") {
      return {
        kind: "failed",
        reason: bounded(
          `chafa timed out after ${timeoutMs}ms. Reduce the image size, lower cellWidth/maxRows, or raise timeoutMs in pi-chafa config.`,
        ),
      };
    }
    const stderr = (err.stderr ?? "").trim();
    if (stderr) {
      return { kind: "failed", reason: bounded(`chafa exited with an error: ${stderr}`) };
    }
    return {
      kind: "failed",
      reason: bounded(`chafa failed (code ${String(err.code ?? "unknown")})`),
    };
  }
  const sanitized = sanitizeChafaPayload(stdout, geometry);
  return sanitized.ok
    ? { kind: "ok", lines: sanitized.lines }
    : { kind: "failed", reason: sanitized.reason };
}
