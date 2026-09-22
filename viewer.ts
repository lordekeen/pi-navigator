/**
 * pi-navigator file viewing pipeline.
 *
 * loadFile(): stat, binary sniff, image tier (optionally rendered through an
 * injected renderImage seam, degrading to the metadata card on failure), size
 * caps, tab expansion and pi-native syntax highlighting (highlightCode +
 * getLanguageFromPath; no external binaries, no npm dependencies).
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
import type { SearchMatch, ViewerFile } from "./types";

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

async function highlightText(text: string, relPath: string): Promise<string[]> {
  const lang = getLanguageFromPath(relPath);
  if (!lang) return text.split("\n");
  try {
    return highlightCode(text, lang);
  } catch {
    return text.split("\n");
  }
}

/**
 * Optional image-load parameters for the render seams: geometry hint plus
 * the chafa and/or native renderer injections. At least one seam makes an
 * image file render; with neither, the metadata card stands (today's
 * default).
 */
export interface LoadFileOptions {
  image?: { cols: number; rows: number };
  renderImage?: ImageRenderer;
  renderNativeImage?: ImageRenderer;
}

/**
 * Injected image renderer seam: renders an image file into display rows at
 * the requested geometry (chafa ANSI rows, or native kitty/iTerm2 sequences).
 * loadFile treats any throw as a failed render.
 */
export type ImageRenderer = (
  absPath: string,
  req: { cols: number; rows: number },
) => Promise<{ ok: true; lines: string[]; cols: number; rows: number } | { ok: false; reason: string }>;

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
  try {
    const info = await stat(absPath);
    if (!info.isFile()) return errorCard(relPath, "not a regular file");
    sizeBytes = info.size;
    mtimeMs = info.mtimeMs;
  } catch {
    return errorCard(relPath, "cannot read file (deleted or permission denied)");
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
    // Renderer seams (spec §13): the native seam runs FIRST (§7.1), then chafa
    // (today's behavior, byte-identical for chafa-only callers). A thrown
    // renderer is a hard failure — card with the bounded reason, no fallback
    // (spec §7.3). A clean {ok:false} native failure falls through to chafa
    // when present; with no chafa seam it becomes the card hint.
    let nativeReason: string | undefined;
    if (opts?.image !== undefined && opts.renderNativeImage !== undefined) {
      try {
        const out = await opts.renderNativeImage(absPath, opts.image);
        if (out.ok) {
          return {
            kind: "image",
            relPath,
            sizeBytes,
            mtimeMs,
            lines: [],
            message,
            imageTier: "native",
            imageLines: out.lines,
            // The REQUESTED cap, not pi-tui's aspect-fitted result: resize
            // detection compares pane-derived requests, so a fitted height
            // shorter than the pane would otherwise read as a permanent
            // geometry mismatch and reflow every frame.
            imageCols: opts.image.cols,
            imageRows: opts.image.rows,
          };
        }
        nativeReason = out.reason;
      } catch (err) {
        return {
          kind: "image",
          relPath,
          sizeBytes,
          mtimeMs,
          lines: [],
          message,
          imageTier: "metadata",
          imageError: boundImageError(
            err instanceof Error ? err.message : "unexpected renderer failure",
          ),
        };
      }
    }
    if (opts?.image !== undefined && opts.renderImage !== undefined) {
      try {
        const out = await opts.renderImage(absPath, opts.image);
        if (out.ok) {
          return {
            kind: "image",
            relPath,
            sizeBytes,
            mtimeMs,
            lines: [],
            message,
            imageTier: "chafa",
            imageLines: out.lines,
            imageCols: out.cols,
            imageRows: out.rows,
          };
        }
        return {
          kind: "image",
          relPath,
          sizeBytes,
          mtimeMs,
          lines: [],
          message,
          imageTier: "metadata",
          imageError: boundImageError(out.reason),
        };
      } catch (err) {
        return {
          kind: "image",
          relPath,
          sizeBytes,
          mtimeMs,
          lines: [],
          message,
          imageTier: "metadata",
          imageError: boundImageError(
            err instanceof Error ? err.message : "unexpected renderer failure",
          ),
        };
      }
    }
    // No seam (or only a clean native failure): the existing metadata card;
    // the native reason is the card hint when it was the last failure.
    return {
      kind: "image",
      relPath,
      sizeBytes,
      mtimeMs,
      lines: [],
      message,
      imageTier: "metadata",
      ...(nativeReason !== undefined ? { imageError: boundImageError(nativeReason) } : {}),
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
    const lines = await highlightText(head.join("\n"), relPath);
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
      lines,
      notice: `Truncated view: ${reason}. Showing the first ${head.length} lines.`,
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
    lines,
    ...(rawText !== undefined ? { rawText } : {}),
  };
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
