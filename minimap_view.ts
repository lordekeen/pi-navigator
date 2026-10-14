/**
 * Viewer minimap model (Issue #165) — pure.
 *
 * The pane's display rows are folded into at most `area` blocks (Bresenham:
 * every block is a whole number of display rows, and the blocks span the rows
 * exactly), each block is encoded as one row of glyphs, and the viewport is
 * painted as a background band at render time.
 *
 * The module never sees a ViewerFile, a DisplayRow or a pane: the caller
 * measures nothing and this module learns nothing about the panes. `texts` is
 * one styled string per display row, in pane order; `area` is the rows the map
 * may occupy; `width` is the carved columns.
 *
 * Two encodings share the row model:
 * - `braille` — each glyph is a 2×4 dot grid; a dot lights where the block's
 *   rows have ink in that dot column, so indentation and word gaps read as
 *   shape (code-minimap's default render mode).
 * - `bars` — a positioned block from the block's first to last ink column
 *   (code-minimap's block mode).
 *
 * `mono` paints ink in the scrollbar thumb tone (Task 4 adds the diff mirror);
 * `syntax` is wired in Task 4.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { MINIMAP_MAX_COLUMNS } from "./constants";
import type { NavigatorTheme } from "./theme";
import { inkRuns, stripAnsi } from "./viewer";

export type MinimapEncoding = "braille" | "bars";
export type MinimapPalette = "mono" | "syntax";

/** One map row's slice of the display rows; `end` is exclusive. */
export interface MinimapBlock {
  start: number;
  end: number;
}

export interface MinimapSketch {
  /** One entry per map row; length === the input's `area`. */
  readonly blocks: readonly MinimapBlock[];
  /** One styled, exactly `width`-wide row per block (no band painted). */
  readonly rows: readonly string[];
}

export interface MinimapInput {
  /** One styled text per display row, in pane order. */
  readonly texts: readonly string[];
  /** Rows the map may occupy. */
  readonly area: number;
  /** Columns carved for the map. */
  readonly width: number;
  readonly encoding: MinimapEncoding;
  readonly palette: MinimapPalette;
  /** True when the pane shows a diff (enables the diff-status mirror). */
  readonly diff: boolean;
  readonly theme: NavigatorTheme;
}

/** Unicode dot bits for dot (row, column) of a braille cell. */
const DOTBIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

const BLANK_BRAILLE = "\u2800";
const BAR = "\u2588";

/** Cell width of one character, ASCII fast path first. */
function charWidth(ch: string): number {
  return ch.codePointAt(0)! < 0x80 ? 1 : visibleWidth(ch);
}

/**
 * The Bresenham blocks: `start(k) = floor(k·n/H)`, `end(k) = floor((k+1)·n/H)`.
 * Consecutive ends become starts, so the blocks are contiguous, every block is
 * `floor(n/H)` or `ceil(n/H)` rows, and the last end is exactly `n`.
 */
function blocksFor(n: number, area: number): MinimapBlock[] {
  const blocks: MinimapBlock[] = [];
  for (let k = 0; k < area; k += 1) {
    blocks.push({ start: Math.floor((k * n) / area), end: Math.floor(((k + 1) * n) / area) });
  }
  return blocks;
}

/** The horizontal extent the map's columns span: the widest measured row, capped. */
function columnsFor(plain: readonly string[]): number {
  let widest = 1;
  for (const text of plain) {
    const width = visibleWidth(text);
    if (width > widest) widest = width;
    if (widest >= MINIMAP_MAX_COLUMNS) return MINIMAP_MAX_COLUMNS;
  }
  return widest;
}

/** The map-column bucket a source column falls in. */
function bucketOf(column: number, columns: number, buckets: number): number {
  const bucket = Math.floor((column * buckets) / columns);
  return bucket >= buckets ? buckets - 1 : bucket < 0 ? 0 : bucket;
}

/** Pad or hard-cut a styled row to exactly `width` columns (empty ellipsis, #010). */
function fitWidth(row: string, width: number): string {
  const cut = truncateToWidth(row, width, "");
  const w = visibleWidth(cut);
  return w >= width ? cut : cut + " ".repeat(width - w);
}

/** Ink columns of one plain row: first/last for bars, plus bucket marks for braille. */
function markInk(
  plain: string,
  columns: number,
  buckets: number,
  mark: ((bucket: number) => void) | null,
  range: { first: number; last: number },
): void {
  let column = 0;
  for (const ch of plain) {
    const w = charWidth(ch);
    if (ch !== " ") {
      if (column < range.first) range.first = column;
      const last = column + w - 1;
      if (last > range.last) range.last = last;
      if (mark) {
        const from = bucketOf(column, columns, buckets);
        const to = bucketOf(last, columns, buckets);
        for (let b = from; b <= to; b += 1) mark(b);
      }
    }
    column += w;
  }
}

function barArt(first: number, last: number, columns: number, width: number): string {
  if (first > last) return " ".repeat(width);
  const from = bucketOf(first, columns, width);
  const to = bucketOf(last, columns, width);
  return " ".repeat(from) + BAR.repeat(to - from + 1) + " ".repeat(width - to - 1);
}

function brailleArt(grid: boolean[][], width: number): string {
  let art = "";
  for (let glyph = 0; glyph < width; glyph += 1) {
    let bits = 0;
    for (let r = 0; r < 4; r += 1) {
      for (let side = 0; side < 2; side += 1) {
        const dot = glyph * 2 + side;
        if (grid[r]?.[dot]) bits |= DOTBIT[r]?.[side] ?? 0;
      }
    }
    art += bits === 0 ? BLANK_BRAILLE : String.fromCharCode(0x2800 + bits);
  }
  return art;
}

/** Ink characters in one row's plain text. */
function inkCount(plain: string): number {
  let count = 0;
  for (const ch of plain) if (ch !== " ") count += 1;
  return count;
}

/**
 * The block's representative row: the one with the most ink, ties to the
 * first. Everything a row encodes beyond ink (its colour) is decided from this
 * single row, so a folded block reads as "what this band mostly is".
 */
function representative(block: MinimapBlock, plain: readonly string[]): number {
  let best = block.start;
  let bestInk = -1;
  for (let j = block.start; j < block.end; j += 1) {
    const ink = inkCount(plain[j] ?? "");
    if (ink > bestInk) {
      bestInk = ink;
      best = j;
    }
  }
  return best;
}

/** The colour with the most ink characters in one styled row, ties to the first. */
function dominantColor(styled: string): string | null {
  const counts = new Map<string, number>();
  for (const run of inkRuns(styled)) {
    if (run.color === null) continue;
    counts.set(run.color, (counts.get(run.color) ?? 0) + inkCount(run.text));
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [color, count] of counts) {
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The diff-status tone for one row, mirroring `styleDiffLines` (diff.ts): the
 * file/meta prefixes and the `+++`/`---` markers are muted, a hunk header is
 * the accent, and the rest follow their +/- prefix. The commit-message head and
 * the blank separator carry no prefix and therefore read as context — a
 * deliberate simplification (a six-column map cannot show message structure).
 */
function diffTone(plain: string, theme: NavigatorTheme): (text: string) => string {
  if (plain.startsWith("+++ ") || plain.startsWith("--- ")) return theme.muted;
  if (plain.startsWith("@@")) return theme.accent;
  if (plain.startsWith("+")) return theme.diffAdded;
  if (plain.startsWith("-")) return theme.diffRemoved;
  if (
    plain.startsWith("diff ") ||
    plain.startsWith("index ") ||
    plain.startsWith("new file") ||
    plain.startsWith("deleted file") ||
    plain.startsWith("Binary files")
  ) {
    return theme.muted;
  }
  return theme.diffContext;
}

/**
 * The painter for one block's row: syntax mode uses the representative row's
 * dominant captured colour (re-emitted verbatim), falling back to the diff
 * mirror on a diff and then to the plain ink tone.
 */
function rowPainter(
  palette: MinimapPalette,
  diff: boolean,
  representativeRow: { plain: string; styled: string },
  theme: NavigatorTheme,
): (text: string) => string {
  if (palette === "syntax") {
    const color = dominantColor(representativeRow.styled);
    if (color !== null) return (text) => theme.syntax(color, text);
  }
  if (diff) return diffTone(representativeRow.plain, theme);
  return theme.scrollbarThumb;
}

/**
 * Fold `texts` into a sketch, or null when the pane does not scroll
 * (`texts.length <= area`) — the map only exists where there is something to
 * map.
 */
export function buildMinimap(input: MinimapInput): MinimapSketch | null {
  const { texts, area, theme } = input;
  const n = texts.length;
  const width = Math.floor(input.width);
  if (width <= 0 || area <= 0 || n <= area) return null;

  const plain = texts.map((text) => stripAnsi(text));
  const columns = columnsFor(plain);
  const blocks = blocksFor(n, area);
  const rows: string[] = [];

  for (const block of blocks) {
    const rep = representative(block, plain);
    const paint = rowPainter(input.palette, input.diff, {
      plain: plain[rep] ?? "",
      styled: texts[rep] ?? "",
    }, theme);
    if (input.encoding === "braille") {
      const dots = width * 2;
      const grid: boolean[][] = Array.from({ length: 4 }, () => new Array<boolean>(dots).fill(false));
      const span = block.end - block.start;
      for (let j = block.start; j < block.end; j += 1) {
        const dotRow = Math.min(3, Math.floor(((j - block.start) * 4) / span));
        const row = grid[dotRow];
        if (!row) continue;
        markInk(plain[j] ?? "", columns, dots, (bucket) => {
          row[bucket] = true;
        }, { first: Number.MAX_SAFE_INTEGER, last: -1 });
      }
      rows.push(fitWidth(paint(brailleArt(grid, width)), width));
      continue;
    }
    const range = { first: Number.MAX_SAFE_INTEGER, last: -1 };
    for (let j = block.start; j < block.end; j += 1) {
      markInk(plain[j] ?? "", columns, width, null, range);
    }
    rows.push(fitWidth(paint(barArt(range.first, range.last, columns, width)), width));
  }

  return { blocks, rows };
}

/**
 * Paint the viewport band: every map row whose display-row range intersects
 * `[scroll, scroll + count)` gets a background, foreground preserved. The band
 * is computed from the live (clamped) scroll window, so a scroll never needs a
 * new sketch.
 */
export function renderMinimap(
  sketch: MinimapSketch,
  scroll: number,
  count: number,
  theme: NavigatorTheme,
): string[] {
  const { blocks, rows } = sketch;
  if (count <= 0) return [...rows];
  const top = Math.max(0, scroll);
  const bottom = top + count;
  let from = -1;
  let to = -1;
  for (let k = 0; k < blocks.length; k += 1) {
    const block = blocks[k];
    if (!block) continue;
    if (block.end > top && block.start < bottom) {
      if (from < 0) from = k;
      to = k;
    } else if (to >= 0) {
      break;
    }
  }
  if (from < 0) return [...rows];
  return rows.map((row, k) => (k >= from && k <= to ? theme.selectedBg(row) : row));
}
