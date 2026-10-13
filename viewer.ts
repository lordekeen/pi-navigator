/**
 * pi-navigator file viewing pipeline.
 *
 * loadFile(): stat, binary sniff, image verdict (one typed RenderOutcome from
 * the injected image pipeline, degrading to the metadata card on failure),
 * size caps, tab expansion and pi-native syntax highlighting (highlightCode +
 * getLanguageFromPath; no external binaries, no npm dependencies).
 *
 * This module also owns the typed open-target vocabulary (`targetOf` /
 * `targetPath` / `sameTarget`, Issue #142) so the overlay and the session can
 * compare displayed targets without importing each other (Issue #144).
 *
 * Search note: matches are located inside the already highlighted line using
 * the technique proven by pi-skill-gate (visible search over a styled string;
 * case folding is length preserving for the escape sequences the highlighter
 * emits, so folded offsets stay valid). An occurrence split by an escape
 * sequence is not matched — an accepted v1 approximation.
 */

import { open, readFile, stat } from "node:fs/promises";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
  BINARY_SNIFF_BYTES,
  IMAGE_ERROR_MAX_CHARS,
  IMAGE_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  MAX_HIGHLIGHT_BYTES,
  MAX_HIGHLIGHT_LINES,
  MAX_LINE_COUNT_BYTES,
  TAB_WIDTH,
} from "./constants";
import { type ImageAttemptRenderer, type RenderOutcome } from "./images";
import type { OpenTarget, SearchMatch, ViewerFile } from "./types";

// ── Open targets ──

/**
 * The typed open target of a displayed ViewerFile (Issue #142): the diff kind
 * or a stamped commitHash makes it a commit target; everything else is a file
 * target keyed by its display relPath. Null while nothing is displayed, and
 * defensive null for a commit-kind file that carries no hash (it cannot be
 * addressed). Shared here so the overlay and the session compare targets
 * without importing each other (Issue #144).
 */
export function targetOf(file: ViewerFile | null): OpenTarget | null {
  if (file === null) return null;
  if (file.kind === "diff" || file.commitHash !== undefined) {
    return file.commitHash === undefined ? null : { kind: "commit", hash: file.commitHash };
  }
  return { kind: "file", relPath: file.relPath };
}

/**
 * The string projection of a target for the consumers that still speak
 * paths: `commit:<hash>` stays the commit display/cache identity (Issue #142
 * decision 6), and a file target is its relPath.
 */
export function targetPath(target: OpenTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "commit" ? `commit:${target.hash}` : target.relPath;
}

/** Structural identity of two targets (Issue #142); null matches nothing. */
export function sameTarget(a: OpenTarget | null, b: OpenTarget | null): boolean {
  if (a === null || b === null) return false;
  if (a.kind === "file" && b.kind === "file") return a.relPath === b.relPath;
  if (a.kind === "commit" && b.kind === "commit") return a.hash === b.hash;
  return false;
}

// ── Text helpers ──

/** Expand tabs to the next tab stop, column aware, per line. */
export function expandTabs(text: string, tabWidth = TAB_WIDTH): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (!line.includes("\t")) {
      out.push(line);
      continue;
    }
    let column = 0;
    let expanded = "";
    for (const ch of line) {
      if (ch === "\t") {
        const spaces = tabWidth - (column % tabWidth);
        expanded += " ".repeat(spaces);
        column += spaces;
      } else {
        expanded += ch;
        column += 1;
      }
    }
    out.push(expanded);
  }
  return out.join("\n");
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function visibleTextWidth(text: string): number {
  return visibleWidth(stripAnsi(text));
}

/**
 * Column-slice a styled line for horizontal scrolling. Escape sequences are
 * preserved as encountered; the result is reset-terminated when any styling
 * was included. Columns are terminal cells (Issue #059): a wide character
 * occupies two of them, so a glyph whose first cell falls inside the window is
 * emitted whole — callers hard-cut any transient one-cell overflow (padTo).
 */
// Sticky ANSI escape sequence matcher (CSI + OSC) reused by sliceStyled;
// `lastIndex` is set per call site so it scans the full string without
// allocating a suffix copy per character (Issue #083).
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x1b\x07]*(?:\x1b\\|\x07))/y;

export function sliceStyled(styled: string, start: number, end: number): string {
  let out = "";
  let column = 0;
  let styledOut = false;
  let i = 0;
  while (i < styled.length) {
    ANSI_ESCAPE_RE.lastIndex = i;
    const esc = ANSI_ESCAPE_RE.exec(styled);
    if (esc) {
      out += esc[0];
      styledOut = true;
      i += esc[0].length;
      continue;
    }
    const code = styled.codePointAt(i);
    if (code === undefined) break; // unreachable: i walks valid code points
    const ch = String.fromCodePoint(code);
    if (column >= start && column < end) out += ch;
    column += visibleWidth(ch);
    i += ch.length;
    if (column >= end) break;
  }
  if (styledOut && out.length > 0 && !out.endsWith("\x1b[0m")) out += "\x1b[0m";
  return out;
}

/**
 * Hard-truncate a (possibly styled) string to a visible width with no
 * ellipsis. `truncateToWidth`'s default `"..."` ellipsis is wrapped in
 * `\x1b[0m` resets, which close any enclosing style and render the ellipsis
 * in bright default (Issue #010); overlay callers instead pass an empty
 * ellipsis so they can re-style or pad the cut themselves. This helper is
 * that convention in one named place: it delegates to
 * `truncateToWidth(text, width, "")`, so like `sliceStyled` the result is
 * reset-terminated when a cut actually happens (a bare `\x1b[0m` closes an
 * open style at the cut, which cannot leak into later padding), and it never
 * splits a wide (CJK) character — the contiguous prefix simply under-fills
 * the last cell.
 */
export function hardTruncate(text: string, width: number): string {
  return truncateToWidth(text, width, "");
}

/**
 * Per-position fold maps for a haystack whose `toLowerCase()` changes length
 * (e.g. `İ` U+0130 folds to "i" + a combining dot, two folded chars). For every
 * folded position f, `starts[f]`/`ends[f]` give the unfolded span of the code
 * point that produced it, so folded indexOf offsets can be applied to the
 * unfolded string without drifting (Issue #060; #035 fixed only the needle
 * side). Returns null when folding is length preserving — the common case —
 * keeping the fast path offset-identical.
 */
function foldMaps(styled: string): { starts: number[]; ends: number[] } | null {
  const folded = styled.toLowerCase();
  if (folded.length === styled.length) return null;
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < styled.length) {
    const code = styled.codePointAt(i);
    if (code === undefined) break; // unreachable: i walks valid code points
    const ch = String.fromCodePoint(code);
    const lower = ch.toLowerCase();
    for (let k = 0; k < lower.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    i += ch.length;
  }
  return { starts, ends };
}

/**
 * Replace every occurrence of the query with the match style; optionally style
 * the first occurrence as the current match.
 *
 * Case handling mirrors searchLines(): smart case, so an uppercase query is
 * matched case-sensitively and only real matches are highlighted.
 */
export function markMatches(
  styled: string,
  query: string,
  styleMatch: (text: string) => string,
  styleCurrent: (text: string) => string,
  currentOccurrence: number,
): string {
  if (!query) return styled;
  const smartCase = /\p{Lu}/u.test(query);
  const haystack = smartCase ? styled : styled.toLowerCase();
  const needle = smartCase ? query : query.toLowerCase();
  const maps = smartCase ? null : foldMaps(styled);
  let from = 0; // folded haystack cursor for indexOf
  let fromUnfolded = 0; // unfolded cursor for slicing when maps is set
  let occurrence = 0;
  let out = "";
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) {
      out += styled.slice(fromUnfolded);
      break;
    }
    const start = maps ? (maps.starts[idx] ?? idx) : idx;
    const end = maps ? (maps.ends[idx + needle.length - 1] ?? styled.length) : idx + needle.length;
    out += styled.slice(fromUnfolded, start);
    const slice = styled.slice(start, end);
    const useCurrent = occurrence === currentOccurrence;
    out += useCurrent ? styleCurrent(slice) : styleMatch(slice);
    occurrence += 1;
    from = idx + Math.max(1, needle.length);
    fromUnfolded = end;
  }
  return out;
}

// ── Detection ──

export function extOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  const basename = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "";
  return basename.slice(dot + 1).toLowerCase();
}

export function isMarkdownPath(relPath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extOf(relPath));
}

async function sniffBinary(absPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(absPath, "r");
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Cheap dimension probe for PNG and GIF; undefined otherwise. */
export function imageDimensions(buffer: Buffer): string | undefined {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return `${width}x${height}`;
  }
  if (buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return `${width}x${height}`;
  }
  return undefined;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Estimated token count under pi's chars/4 context-budget heuristic
 * (compaction's `estimateTokens`). It is an estimate by design — no offline
 * tokenizer exists for the model the viewer runs under — so the UI marks it
 * with a `~`.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Loading ──

/**
 * Decode UTF-8 bytes, dropping a trailing sequence that the read cut in half,
 * so a capped read never ends on a replacement character. Exported for the
 * unit suite; the loader itself uses it through readCappedHead.
 */
export function decodeUtf8Head(buffer: Buffer): string {
  let end = buffer.length;
  const last = buffer[end - 1];
  if (last !== undefined && last >= 0x80) {
    // Walk back over continuation bytes to the lead byte of the final sequence.
    let lead = end - 1;
    let continuations = 0;
    while (lead >= 0 && (buffer[lead] ?? 0) >= 0x80 && (buffer[lead] ?? 0) < 0xc0 && continuations < 3) {
      lead -= 1;
      continuations += 1;
    }
    const leadByte = lead >= 0 ? buffer[lead] ?? 0 : 0;
    const needed = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 0;
    if (needed > 0 && end - lead < needed) end = lead;
  }
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Read at most `maxBytes` from the head of a file. This is what keeps an
 * oversized file out of memory: without it the loader would pull in the whole
 * file and only then truncate it (plan section 3.4 step 5, "read utf8 (capped)").
 */
async function readCappedHead(absPath: string, maxBytes: number): Promise<string> {
  const handle = await open(absPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return decodeUtf8Head(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function errorCard(relPath: string, message: string): ViewerFile {
  return { kind: "error", relPath, lines: [], message };
}

/**
 * Synchronous highlight core. `highlightText` is the loader's async wrapper
 * (it awaits nothing), while `restyleViewerFile` re-runs this directly on the
 * retained pre-highlight source (Issue #136).
 */
function highlightLines(text: string, relPath: string): string[] {
  const lang = getLanguageFromPath(relPath);
  if (!lang) return text.split("\n");
  try {
    return highlightCode(text, lang);
  } catch {
    return text.split("\n");
  }
}

async function highlightText(text: string, relPath: string): Promise<string[]> {
  return highlightLines(text, relPath);
}

/**
 * The retained highlight source + style key for a load result (Issue #136),
 * attached only when highlighting actually ran (`getLanguageFromPath` found a
 * language). The unknown-language path is `text.split("\n")` — theme-
 * independent and never stale, so there is nothing to retain. `styleText` is
 * exactly the string handed to the highlighter, so a restyle is a pure re-run.
 */
function retainedStyle(
  styleText: string,
  relPath: string,
  styleKey: string | undefined,
): Pick<ViewerFile, "styleText" | "styleKey"> {
  if (!getLanguageFromPath(relPath)) return {};
  return { styleText, styleKey };
}

/**
 * Optional image-load parameters for the loader: the geometry hint plus the
 * one render seam (the session's image pipeline). At least one attempt makes
 * an image file render; with no renderer the metadata card stands (today's
 * default). `stat` is the session's already-performed stat record (Issue
 * #144): one stat per image load. `styleKey` is the current theme style key,
 * retained with the pre-highlight source on text results (Issue #136).
 */
export interface LoadFileOptions {
  image?: { cols: number; rows: number };
  imageRenderer?: ImageRenderer;
  stat?: { isFile: boolean; sizeBytes: number; mtimeMs: number };
  styleKey?: string;
}

/**
 * The one image render seam `loadFile` consumes (Issue #144): a single call
 * per image load returning the pipeline's typed outcome. The pipeline owns
 * the attempt order, the fallback and the supersession signal, so the loader
 * never sees a renderer list, an abort string, or a per-attempt policy.
 */
export type ImageRenderer = (absPath: string) => Promise<RenderOutcome>;

/** Bound a renderer failure reason so the card hint stays within the cap. */
function boundImageError(reason: string): string {
  return reason.length > IMAGE_ERROR_MAX_CHARS
    ? reason.slice(0, IMAGE_ERROR_MAX_CHARS - 1) + "\u2026"
    : reason;
}

/**
 * Load a file for display. Never throws; every failure mode returns a typed
 * ViewerFile the UI can render (error, binary, image, or truncated).
 */
export async function loadFile(
  absPath: string,
  relPath: string,
  opts?: LoadFileOptions,
): Promise<ViewerFile> {
  let sizeBytes: number;
  let mtimeMs: number;
  const providedStat = opts?.stat;
  if (providedStat !== undefined) {
    // The session already statted this path for its cache key (Issue #144):
    // trust that record instead of paying a second stat per image load.
    if (!providedStat.isFile) return errorCard(relPath, "not a regular file");
    sizeBytes = providedStat.sizeBytes;
    mtimeMs = providedStat.mtimeMs;
  } else {
    try {
      const info = await stat(absPath);
      if (!info.isFile()) return errorCard(relPath, "not a regular file");
      sizeBytes = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      return errorCard(relPath, "cannot read file (deleted or permission denied)");
    }
  }

  const ext = extOf(relPath);

  if (IMAGE_EXTENSIONS.has(ext)) {
    let dims: string | undefined;
    try {
      const head = Buffer.alloc(64);
      const handle = await open(absPath, "r");
      try {
        const { bytesRead } = await handle.read(head, 0, 64, 0);
        dims = imageDimensions(head.subarray(0, bytesRead));
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      dims = undefined;
    }
    const message = [formatSize(sizeBytes), dims].filter(Boolean).join(" \u00b7 ");
    // One call, one typed outcome (Issue #144): the pipeline owns the attempt
    // order, the per-renderer fallback and the supersession stop; the loader
    // only maps the result — `ok` to the rendered verdict (with the pipeline's
    // CAPTURED geometry: native reports the request, not pi-tui's
    // aspect-fitted result, so resize detection compares like for like),
    // `failed` to the bounded metadata card, `aborted` to a failure-free card
    // (a superseded load's result is discarded by the overlay's sequence guard
    // anyway). The pipeline never throws by contract; an override that does
    // leaves a failure-free card rather than rejecting loadFile.
    const image = opts?.image;
    const renderer = opts?.imageRenderer;
    let failed: { renderer: ImageAttemptRenderer; detail: string } | undefined;
    if (image !== undefined && renderer !== undefined) {
      let outcome: RenderOutcome | null = null;
      try {
        outcome = await renderer(absPath);
      } catch {
        outcome = null;
      }
      if (outcome !== null) {
        if (outcome.kind === "ok") {
          return {
            kind: "image",
            relPath,
            sizeBytes,
            mtimeMs,
            lines: [],
            message,
            imageVerdict: {
              kind: "rendered",
              renderer: outcome.renderer,
              lines: outcome.lines,
              cols: outcome.cols,
              rows: outcome.rows,
            },
          };
        }
        if (outcome.kind === "failed") {
          failed = { renderer: outcome.renderer, detail: boundImageError(outcome.reason) };
        }
      }
    }
    // No renderer, a failure-free abort, or a throwing override: the metadata
    // card carries the last failure as its hint row when there was one.
    return {
      kind: "image",
      relPath,
      sizeBytes,
      mtimeMs,
      lines: [],
      message,
      imageVerdict: { kind: "card", ...(failed !== undefined ? { failed } : {}) },
    };
  }

  if (await sniffBinary(absPath)) {
    return {
      kind: "binary",
      relPath,
      sizeBytes,
      mtimeMs,
      lines: [],
      message: `${formatSize(sizeBytes)} \u00b7 binary content not rendered`,
    };
  }

  const overBytes = sizeBytes > MAX_HIGHLIGHT_BYTES;
  // Read the file whole only while it fits the highlight cap; beyond that read
  // just the head, so memory stays bounded by the caps and not by the file.
  let raw: string;
  let completeRead: boolean;
  try {
    if (overBytes) {
      raw = await readCappedHead(absPath, MAX_HIGHLIGHT_BYTES);
      completeRead = false;
    } else {
      raw = await readFile(absPath, "utf8");
      completeRead = true;
    }
  } catch {
    return errorCard(relPath, "cannot read file (permission denied)");
  }

  // Normalize CRLF and lone CR to LF before any downstream processing. A
  // stray carriage return in a rendered line resets the terminal cursor to
  // column 0, so the row's trailing padding overwrites the gutter and border
  // and breaks the overlay layout. Files checked out with CRLF endings (this
  // repo's own .ts sources among them) otherwise hit this on every opened
  // file. \r\n is folded to \n first so no line gains a spurious blank.
  raw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const expanded = expandTabs(raw);
  const allLines = expanded.split("\n");
  const overLines = allLines.length > MAX_HIGHLIGHT_LINES;

  if (overBytes || overLines) {
    const head = allLines.slice(0, MAX_HIGHLIGHT_LINES);
    const styleText = head.join("\n");
    const lines = await highlightText(styleText, relPath);
    const reason = overBytes
      ? `${formatSize(sizeBytes)} exceeds the ${formatSize(MAX_HIGHLIGHT_BYTES)} highlight cap`
      : `${allLines.length} lines exceed the ${MAX_HIGHLIGHT_LINES} line cap`;
    // The total count is only known — and only cheap — when the whole file was
    // read (plan section 9: "total line count when cheap").
    const lineCount = completeRead && sizeBytes <= MAX_LINE_COUNT_BYTES ? allLines.length : undefined;
    const rawText = isMarkdownPath(relPath) ? raw.split("\n").slice(0, MAX_HIGHLIGHT_LINES).join("\n") : undefined;
    return {
      kind: "truncated",
      relPath,
      sizeBytes,
      mtimeMs,
      lineCount,
      tokens: estimateTokens(styleText),
      lines,
      notice: `Truncated view: ${reason}. Showing the first ${head.length} lines.`,
      ...retainedStyle(styleText, relPath, opts?.styleKey),
      ...(rawText !== undefined ? { rawText } : {}),
    };
  }

  const lines = await highlightText(expanded, relPath);
  const lineCount = sizeBytes <= MAX_LINE_COUNT_BYTES ? allLines.length : undefined;
  const rawText = isMarkdownPath(relPath) ? raw : undefined;
  return {
    kind: "text",
    relPath,
    sizeBytes,
    mtimeMs,
    lineCount,
    tokens: estimateTokens(expanded),
    lines,
    ...retainedStyle(expanded, relPath, opts?.styleKey),
    ...(rawText !== undefined ? { rawText } : {}),
  };
}

/**
 * Re-highlight a viewer file from its retained pre-highlight source under a
 * new style key (Issue #136). Synchronous and I/O-free: the highlight core is
 * a pure function of `styleText` + `relPath`, so a theme switch pays one
 * re-highlight per file actually restyled, never a re-read. Returns the same
 * reference when there is nothing to do (no retained source, or the key
 * already matches), so callers can detect the no-op cheaply.
 */
export function restyleViewerFile(file: ViewerFile, styleKey: string): ViewerFile {
  if (file.styleText === undefined || file.styleKey === styleKey) return file;
  return { ...file, lines: highlightLines(file.styleText, file.relPath), styleKey };
}

// ── Search ──

/** Smart-case search over styled lines. Returns match offsets valid for the
 *  styled string (see the module note). */
export function searchLines(lines: string[], query: string): SearchMatch[] {
  if (!query) return [];
  const smartCase = /\p{Lu}/u.test(query);
  const needle = smartCase ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  for (let line = 0; line < lines.length; line++) {
    // Defensive: a malformed ViewerFile with a hole in lines would otherwise
    // throw on the .toLowerCase() below. Well-formed files never hit this.
    const raw = lines[line];
    if (raw === undefined) continue;
    const maps = smartCase ? null : foldMaps(raw);
    const haystack = smartCase ? raw : raw.toLowerCase();
    let from = 0;
    let idx: number;
    while ((idx = haystack.indexOf(needle, from)) !== -1) {
      const start = maps ? (maps.starts[idx] ?? idx) : idx;
      const end = maps ? (maps.ends[idx + needle.length - 1] ?? idx + needle.length) : idx + needle.length;
      matches.push({ line, start, end });
      from = idx + Math.max(1, needle.length);
    }
  }
  return matches;
}

// ── Display rows ──

export interface DisplayRow {
  /** Source line index, null for wrapped continuation rows. */
  line: number | null;
  text: string;
}

/**
 * Build the visual rows for the pane: one row per wrapped chunk when wrap is
 * on, one clipped row per source line otherwise.
 */
export function computeRows(file: ViewerFile, width: number, wrap: boolean, hscroll: number): DisplayRow[] {
  const rows: DisplayRow[] = [];
  if (width <= 0) return rows;
  for (let i = 0; i < file.lines.length; i++) {
    const line = file.lines[i];
    if (line === undefined) continue;
    if (wrap) {
      const chunks = wrapTextWithAnsi(line, width);
      chunks.forEach((chunk: string, index: number) => rows.push({ line: index === 0 ? i : null, text: chunk }));
    } else {
      rows.push({ line: i, text: sliceStyled(line, hscroll, hscroll + width) });
    }
  }
  return rows;
}

/** Longest visible line width, used to clamp the horizontal scroll. */
export function maxLineWidth(file: ViewerFile): number {
  let max = 0;
  for (const line of file.lines) {
    const width = visibleTextWidth(line);
    if (width > max) max = width;
  }
  return max;
}
