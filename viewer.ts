/**
 * pi-navigator file viewing pipeline.
 *
 * loadFile(): stat, binary sniff, image verdict (one typed RenderOutcome from
 * the injected image pipeline, degrading to the metadata card on failure),
 * size caps, tab expansion and pi-native syntax highlighting (highlightCode +
 * getLanguageFromPath; no external binaries, no npm dependencies).
 *
 * Search note: matches are located inside the already highlighted line using
 * the technique proven by pi-skill-gate (visible search over a styled string;
 * case folding is length preserving for the escape sequences the highlighter
 * emits, so folded offsets stay valid). Escape bytes themselves are never
 * matched (Issue #181: a query like `m` used to match every SGR terminator,
 * and the marker then split the sequence it "matched"); an occurrence split
 * by an escape sequence is not matched — an accepted v1 approximation.
 */

import { open, readFile, stat } from "node:fs/promises";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
import { escapeSpans, sanitizeText, sliceStyled, visibleTextWidth } from "./ansi";
import { truncateUtf8ToBytes } from "./bytes";
import { type ImageAttemptRenderer, type RenderOutcome } from "./images";
import type { SearchMatch, ViewerFile } from "./types";


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

/** True when [start, end) overlaps an escape span. */
function inEscape(spans: Array<{ start: number; end: number }>, start: number, end: number): boolean {
  for (const span of spans) {
    if (span.start >= end) return false;
    if (span.end > start) return true;
  }
  return false;
}

/**
 * Occurrences of `query` in one styled line's VISIBLE text, as offsets into
 * the styled string (Issue #181). Matching runs on the styled string (folded
 * offsets stay valid, see the module note), then every occurrence overlapping
 * an escape sequence is dropped — the highlighter's own bytes used to satisfy
 * queries like `m` (every SGR terminator) or `111` (a colour parameter), and
 * the marker then split the sequence it had "matched".
 */
function visibleMatches(styled: string, query: string): Array<{ start: number; end: number }> {
  if (query.length === 0) return [];
  const smartCase = /\p{Lu}/u.test(query);
  const haystack = smartCase ? styled : styled.toLowerCase();
  const needle = smartCase ? query : query.toLowerCase();
  const maps = smartCase ? null : foldMaps(styled);
  const spans = escapeSpans(styled);
  const out: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    const start = maps ? (maps.starts[idx] ?? idx) : idx;
    const end = maps ? (maps.ends[idx + needle.length - 1] ?? idx + needle.length) : idx + needle.length;
    if (!inEscape(spans, start, end)) out.push({ start, end });
    from = idx + Math.max(1, needle.length);
  }
  return out;
}

/**
 * Replace every occurrence of the query with the match style; optionally style
 * the first occurrence as the current match.
 *
 * Case handling mirrors searchLines(): smart case, so an uppercase query is
 * matched case-sensitively and only real matches are highlighted. Escape
 * sequences are never matched and never split (Issue #181).
 */
export function markMatches(
  styled: string,
  query: string,
  styleMatch: (text: string) => string,
  styleCurrent: (text: string) => string,
  currentOccurrence: number,
): string {
  const matches = visibleMatches(styled, query);
  if (matches.length === 0) return styled;
  let out = "";
  let cursor = 0;
  matches.forEach((match, occurrence) => {
    out += styled.slice(cursor, match.start);
    const slice = styled.slice(match.start, match.end);
    out += occurrence === currentOccurrence ? styleCurrent(slice) : styleMatch(slice);
    cursor = match.end;
  });
  return out + styled.slice(cursor);
}


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


/**
 * Decode UTF-8 bytes, dropping a trailing sequence that the read cut in half,
 * so a capped read never ends on a replacement character. The alignment rule
 * lives in `truncateUtf8ToBytes` (Issue #172), shared with the git commit
 * reads. Exported for the unit suite; the loader itself uses it through
 * readCappedHead.
 */
export function decodeUtf8Head(buffer: Buffer): string {
  return truncateUtf8ToBytes(buffer, buffer.length).toString("utf8");
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
 * Synchronous highlight core. The loader and `restyleViewerFile` both call it
 * directly; `restyleViewerFile` re-runs it on the retained pre-highlight
 * source (Issue #136).
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

  // Repo-controlled content is untrusted: strip the terminal-active bytes
  // (C0 except `\n`, DEL, C1, `\u2028`/`\u2029`, with `\t` mapped to a space)
  // here, before tab expansion and highlighting, so `lines`, `rawText` and the
  // retained `styleText` a restyle re-runs on are all built from the same
  // control-free string (Issue #201).
  raw = sanitizeText(raw);

  const expanded = expandTabs(raw);
  const allLines = expanded.split("\n");
  const overLines = allLines.length > MAX_HIGHLIGHT_LINES;

  if (overBytes || overLines) {
    const head = allLines.slice(0, MAX_HIGHLIGHT_LINES);
    const styleText = head.join("\n");
    const lines = highlightLines(styleText, relPath);
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

  const lines = highlightLines(expanded, relPath);
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


/** Smart-case search over styled lines, visible text only (Issue #181).
 *  Returns match offsets valid for the styled string (see the module note). */
export function searchLines(lines: string[], query: string): SearchMatch[] {
  if (!query) return [];
  const matches: SearchMatch[] = [];
  for (let line = 0; line < lines.length; line++) {
    // Defensive: a malformed ViewerFile with a hole in lines would otherwise
    // throw below. Well-formed files never hit this.
    const raw = lines[line];
    if (raw === undefined) continue;
    for (const match of visibleMatches(raw, query)) {
      matches.push({ line, start: match.start, end: match.end });
    }
  }
  return matches;
}


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
