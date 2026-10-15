/**
 * The viewer's derived state (Issue #169): every render cache, the markdown
 * renderer, the search derivation and the content/window composition behind
 * one `render` / `invalidate` interface. The overlay routes input and owns the
 * scroll, focus and settings state; it never names a viewer cache.
 *
 * The pure pane modules (viewer.ts, viewer_view.ts, minimap_view.ts) stay
 * stateless; this module is the one stateful owner on their seam, mirroring
 * how `createViewerCache` owns the file cache in session.ts.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { MINIMAP_DIVIDER_WIDTH, MINIMAP_MIN_CONTENT_WIDTH } from "./constants";
import { padTo } from "./frame";
import { buildMinimap, type MinimapEncoding, type MinimapMarks, type MinimapSketch } from "./minimap_view";
import type { NavigatorMinimapEncoding, NavigatorMinimapPalette } from "./settings";
import type { NavigatorTheme } from "./theme";
import type { SearchMatch, ViewerFile } from "./types";
import { computeRows, markMatches, maxLineWidth, searchLines, type DisplayRow } from "./viewer";
import {
  canRenderMarkdown,
  paneContentArea,
  paneContentWidth,
  viewerWindow,
  type ViewerContent,
  type ViewerWindow,
} from "./viewer_view";

/** One render pass's inputs: class-owned state the pipeline reads. */
export interface ViewerRenderInput {
  file: ViewerFile | null;
  /** Pane panel width (the right pane's full width). */
  rightW: number;
  /** Pane body height (the outer area before notices). */
  bodyArea: number;
  wrap: boolean;
  renderMarkdown: boolean;
  diskChanged: boolean;
  /** The `i` toggle for a rendered image. */
  imageCard: boolean;
  minimap: {
    encoding: NavigatorMinimapEncoding;
    palette: NavigatorMinimapPalette;
    width: number;
    on: boolean;
  };
  /** Requested vertical and horizontal scroll offsets. */
  scroll: number;
  hscroll: number;
}

/** Everything the pane renderer and the scroll-state write-back consume. */
export interface ViewerRenderOutput {
  content: ViewerContent;
  /** The one clamped window this pass drew at (Issue #147). */
  window: ViewerWindow;
  minimap: { sketch: MinimapSketch; width: number; marks: MinimapMarks | null } | null;
  digits: number;
  /** Notice rows drawn above the text content (truncation / diff / disk). */
  noticeRows: number;
  /** True when this pass drew a map (drives the border-thumb rule). */
  mapActive: boolean;
}

/**
 * What `invalidate` drops. The scopes mirror the overlay's one invalidation
 * site per event, so no caller lists caches by hand:
 * - `theme`: every styled cache plus the search results (the theme bakes
 *   into marked and highlighted lines); raw widths survive.
 * - `markdown`: the `m` toggle: code rows, rendered lines and search results.
 * - `content`: a freshly loaded file: rendered lines and the search re-scan.
 * - `minimap`: the `v`/setting toggle: the sketch only.
 */
export type ViewerInvalidateScope = "theme" | "markdown" | "content" | "minimap";

export class ViewerModel {
  private readonly theme: () => NavigatorTheme;
  private readonly styleKey: () => string;

  // ── Render caches ──
  private plainRowsCache: { file: ViewerFile; width: number; wrap: boolean; rows: DisplayRow[] } | null =
    null;
  private maxLineWidthCache: { file: ViewerFile; value: number } | null = null;
  private mapTextsCache: {
    file: ViewerFile;
    width: number;
    wrap: boolean;
    renderMarkdown: boolean;
    texts: string[];
    /** Source line per display row when wrapping (null when row === line). */
    rowLines: number[] | null;
  } | null = null;
  private sketchCache: {
    texts: readonly string[];
    area: number;
    width: number;
    encoding: MinimapEncoding;
    palette: NavigatorMinimapPalette;
    diff: boolean;
    themeKey: string;
    sketch: MinimapSketch | null;
  } | null = null;
  private mdRenderer: Markdown | null = null;
  private mdCache: { file: ViewerFile; width: number; lines: string[] } | null = null;

  // ── Search derivation ──
  private searchQuery = "";
  private searchMatches: SearchMatch[] = [];
  private searchIndex = 0;
  private searchJump = false;
  private searchDirty = false;
  private searchMatchLines: Set<number> = new Set();
  private searchVersion = 0;
  private occurrenceCache: { version: number; value: number } | null = null;
  // The class-owned state the search domain is derived from, kept from the
  // last render pass so `setQuery` can re-scan without one.
  private latestFile: ViewerFile | null = null;
  private latestRendered = false;

  constructor(deps: { theme: () => NavigatorTheme; styleKey: () => string }) {
    this.theme = deps.theme;
    this.styleKey = deps.styleKey;
  }

  // ── Search surface ──

  get query(): string {
    return this.searchQuery;
  }

  get matches(): SearchMatch[] {
    return this.searchMatches;
  }

  get matchIndex(): number {
    return this.searchIndex;
  }

  getState(): { query: string; index: number; total: number } {
    return { query: this.searchQuery, index: this.searchIndex, total: this.searchMatches.length };
  }

  /**
   * Record the class's current source (the open file and the rendered-mode
   * flag) when either changes, so `setQuery` re-scans the right line domain
   * even before the next render pass.
   */
  setSource(file: ViewerFile | null, renderMarkdown: boolean): void {
    this.latestFile = file;
    this.latestRendered = renderMarkdown;
  }

  /** Replace the query and re-scan the current line domain; index resets. */
  setQuery(query: string): void {
    this.searchQuery = query;
    // No source recorded yet: the next render recomputes against the file it
    // displays (precedent: the class used to read `viewFile` live).
    if (this.latestFile === null) this.searchDirty = true;
    else this.recomputeSearch();
    this.searchIndex = 0;
    this.searchJump = true;
  }

  /** Advance the current match by `delta` (n/N), wrapping around. */
  cycle(delta: number): void {
    if (this.searchMatches.length === 0) return;
    const count = this.searchMatches.length;
    this.searchIndex = (this.searchIndex + delta + count) % count;
    this.searchVersion += 1;
    this.searchJump = true;
  }

  /** One door for every cache invalidation the overlay performs. */
  invalidate(scope: ViewerInvalidateScope): void {
    if (scope === "minimap") {
      this.sketchCache = null;
      return;
    }
    if (scope === "content") {
      this.mdCache = null;
      this.searchDirty = true;
      return;
    }
    this.plainRowsCache = null;
    this.mdCache = null;
    if (scope === "theme") {
      this.mdRenderer = null;
      this.mapTextsCache = null;
      this.sketchCache = null;
    }
    this.searchMatches = [];
    this.searchMatchLines = new Set();
    this.searchDirty = true;
    this.searchVersion += 1;
  }

  // ── Render ──

  render(input: ViewerRenderInput): ViewerRenderOutput {
    const { file, wrap, renderMarkdown, diskChanged, imageCard } = input;
    const useRendered = canRenderMarkdown(file) && renderMarkdown;
    const { contentW, digits } = paneContentWidth(file, useRendered, input.rightW);
    const area = input.bodyArea;
    const { noticeRows, contentArea } = file
      ? paneContentArea(area, file, diskChanged)
      : { noticeRows: 0, contentArea: area };

    // Issue #165: decide the map before any body computation, so the row width
    // is settled once and the decision never costs a second render of the same
    // content (the #054 guarantee: markdown renders once per pass). The gate is
    // the file's own line count, which is exact when wrap is off (`n` IS the
    // line count) and a sound-enough signal otherwise.
    const map = input.minimap;
    let mapW = 0;
    let minimap: { sketch: MinimapSketch; width: number; marks: MinimapMarks | null } | null = null;
    if (
      file &&
      map.encoding !== "off" &&
      map.on &&
      contentW - map.width - MINIMAP_DIVIDER_WIDTH >= MINIMAP_MIN_CONTENT_WIDTH &&
      (file.lines.length > contentArea || (wrap && !useRendered))
    ) {
      const entry = this.minimapTexts(
        file,
        contentW - map.width - MINIMAP_DIVIDER_WIDTH,
        useRendered,
        wrap,
      );
      if (entry.texts.length > contentArea) {
        const sketch = this.viewerSketch(
          entry.texts,
          contentArea,
          map.width,
          file.kind === "diff",
          map.encoding === "bars" ? "bars" : "braille",
          map.palette,
        );
        if (sketch) {
          mapW = map.width;
          minimap = { sketch, width: mapW, marks: this.minimapMarks(entry, sketch) };
        }
      }
    }
    // The divider is carved with the map (one column), so the visible text
    // width is the pane's content width minus the map's footprint.
    const rowsW = contentW - (mapW > 0 ? mapW + MINIMAP_DIVIDER_WIDTH : 0);

    const mdLines = useRendered && file ? this.getRenderedMarkdownLines(file, rowsW) : null;
    this.latestFile = file;
    this.latestRendered = useRendered;
    this.recomputeSearchIfNeeded();

    let content: ViewerContent = { kind: "none" };
    let win: ViewerWindow;
    let scroll = input.scroll;

    if (file) {
      const verdict =
        file.kind === "image" && file.imageVerdict?.kind === "rendered" ? file.imageVerdict : null;
      const renderedImage = verdict !== null && verdict.lines.length > 0 && !imageCard;
      const isCard =
        file.kind === "binary" ||
        file.kind === "error" ||
        (file.kind === "image" && !renderedImage);

      if (verdict !== null && renderedImage) {
        // Render branch: no gutter, no wrap, no hscroll, no search (§7.5).
        // A native image is a terminal-anchored placement, so scroll is pinned
        // to 0 through the window, which keeps the pin exact.
        win = viewerWindow({
          requestedScroll: verdict.renderer === "native" ? 0 : input.scroll,
          requestedHscroll: input.hscroll,
          total: verdict.lines.length,
          count: area,
        });
        content = { kind: "image-lines", lines: verdict.lines };
      } else if (!isCard) {
        if (useRendered && mdLines) {
          if (this.searchJump && this.searchMatches.length > 0) {
            const currentMatch = this.searchMatches[this.searchIndex];
            if (currentMatch) {
              scroll = Math.max(0, currentMatch.line - Math.floor(contentArea / 2));
            }
            this.searchJump = false;
          }
          win = viewerWindow({
            requestedScroll: scroll,
            requestedHscroll: input.hscroll,
            total: mdLines.length,
            count: contentArea,
            rowOffset: 1 + noticeRows,
          });
          const currentMatch =
            this.searchMatches.length > 0
              ? this.searchMatches[Math.min(this.searchIndex, this.searchMatches.length - 1)]
              : undefined;
          const currentOccurrenceOnLine = this.currentOccurrenceIndex();
          const T = this.theme();
          const rows: Array<string | null> = [];
          for (let i = 0; i < contentArea; i++) {
            const lineIdx = win.viewScroll + i;
            const rawLine = mdLines[lineIdx];
            if (rawLine === undefined) {
              rows.push(null);
              continue;
            }
            let styledLine = rawLine;
            if (this.searchQuery && this.searchMatches.length > 0 && this.searchMatchLines.has(lineIdx)) {
              styledLine = this.markRenderedLineMatches(
                styledLine,
                lineIdx,
                currentMatch,
                currentOccurrenceOnLine,
                T,
              );
            }
            rows.push(styledLine);
          }
          content = { kind: "markdown", rows };
        } else {
          // Issue #168: one plain wrap shared by the body rows and the minimap,
          // with marking applied to the visible window after the clamp.
          const maxH = Math.max(0, this.cachedMaxLineWidth(file) - rowsW);
          const plain = this.cachedPlainRows(file, rowsW, wrap);
          if (this.searchJump && this.searchMatches.length > 0) {
            const currentMatch = this.searchMatches[this.searchIndex];
            const target = plain.findIndex((row) => row.line === currentMatch?.line);
            if (target >= 0) scroll = Math.max(0, target - Math.floor(contentArea / 2));
            this.searchJump = false;
          }
          win = viewerWindow({
            requestedScroll: scroll,
            requestedHscroll: input.hscroll,
            total: plain.length,
            count: contentArea,
            maxHscroll: maxH,
            rowOffset: 1 + noticeRows,
          });
          const rows = this.markedWindow(file, plain, win.viewScroll, contentArea, rowsW, wrap);
          content = { kind: "display", rows };
        }
      } else {
        // Metadata/binary/error card: nothing scrolls, so the window is a
        // pass-through — no clamp, no scrollbar.
        win = viewerWindow({ requestedScroll: input.scroll, requestedHscroll: input.hscroll });
        content = { kind: "card" };
      }
    } else {
      // Loading / no file: the same pass-through window keeps every path's
      // assignment uniform.
      win = viewerWindow({ requestedScroll: input.scroll, requestedHscroll: input.hscroll });
    }

    return { content, window: win, minimap, digits, noticeRows, mapActive: minimap !== null };
  }

  // ── Search derivation ──

  private recomputeSearch(): void {
    const file = this.latestFile;
    const lines =
      this.latestRendered && file !== null && canRenderMarkdown(file) && this.mdCache?.file === file
        ? this.mdCache.lines
        : (file?.lines ?? []);
    this.searchMatches = searchLines(lines, this.searchQuery);
    this.searchMatchLines = new Set(this.searchMatches.map((match) => match.line));
    if (this.searchIndex >= this.searchMatches.length) {
      this.searchIndex = Math.max(0, this.searchMatches.length - 1);
    }
    this.searchVersion += 1;
    this.searchDirty = false;
  }

  private recomputeSearchIfNeeded(): void {
    if (!this.searchQuery) {
      if (this.searchMatches.length > 0) {
        this.searchMatches = [];
        this.searchMatchLines = new Set();
        this.searchVersion += 1;
      }
      this.searchDirty = false;
      return;
    }
    // Only rerun the full scan when the result may be stale (file content
    // changed under an active query); keystrokes recompute directly in
    // `setQuery`, so a plain render — scrolling, moving the cursor — does not
    // re-scan the file.
    if (this.searchDirty) this.recomputeSearch();
  }

  /**
   * The current match's 0-based occurrence on its own line, so markMatches
   * highlights the Nth occurrence rather than always the first (Issue #025).
   * Cached per search version (Issue #168).
   */
  private currentOccurrenceIndex(): number {
    if (this.occurrenceCache?.version === this.searchVersion) return this.occurrenceCache.value;
    const currentMatch = this.searchMatches[Math.min(this.searchIndex, this.searchMatches.length - 1)];
    const value = currentMatch
      ? this.searchMatches.filter((m) => m.line === currentMatch.line && m.start < currentMatch.start).length
      : -1;
    this.occurrenceCache = { version: this.searchVersion, value };
    return value;
  }

  private markRenderedLineMatches(
    line: string,
    lineIdx: number,
    currentMatch: SearchMatch | undefined,
    currentOccurrenceOnLine: number,
    theme: NavigatorTheme,
  ): string {
    const occ = currentMatch && lineIdx === currentMatch.line ? currentOccurrenceOnLine : -1;
    return markMatches(line, this.searchQuery, theme.searchMatch, theme.searchCurrent, occ);
  }

  /**
   * The display rows to draw: the plain wrap with the rows visible in the
   * window marked (Issue #168). Only the window's rows are marked — a keystroke
   * never touches the rest of the file — while the returned array stays
   * full-length so the pane's own windowing is unchanged. A whole source line
   * is marked and split at the plain wrap's chunk boundaries, so a match
   * spanning a boundary stays highlighted on both chunks.
   */
  private markedWindow(
    file: ViewerFile,
    plain: DisplayRow[],
    start: number,
    count: number,
    width: number,
    wrap: boolean,
  ): DisplayRow[] {
    if (!this.searchQuery || this.searchMatches.length === 0) return plain;
    const rows = plain.slice();
    const matchLines = this.searchMatchLines;
    const currentMatch = this.searchMatches[Math.min(this.searchIndex, this.searchMatches.length - 1)];
    const occurrence = this.currentOccurrenceIndex();
    const theme = this.theme();
    const end = Math.min(plain.length, start + Math.max(0, count));
    let v = Math.max(0, start);
    while (v < end) {
      // A run is one source line: its first row and, when wrapped, its
      // continuation rows. The run may start above the window, so walk back to
      // find the chunk offset that maps a row to its marked chunk.
      let runStart = v;
      while (runStart > 0 && plain[runStart - 1]?.line === null) runStart -= 1;
      const line = plain[runStart]?.line;
      const marked =
        line !== null && line !== undefined && matchLines.has(line)
          ? markMatches(
              file.lines[line] ?? "",
              this.searchQuery,
              theme.searchMatch,
              theme.searchCurrent,
              line === currentMatch?.line ? occurrence : -1,
            )
          : null;
      const chunks = marked !== null && wrap ? wrapTextWithAnsi(marked, width) : null;
      do {
        const row = plain[v];
        if (row !== undefined && marked !== null) {
          const text = chunks ? (chunks[v - runStart] ?? row.text) : marked;
          if (text !== row.text) rows[v] = { line: row.line, text };
        }
        v += 1;
      } while (v < end && plain[v]?.line === null);
    }
    return rows;
  }

  // ── Caches ──

  private getRenderedMarkdownLines(file: ViewerFile, width: number): string[] {
    if (width <= 0) return [];
    if (this.mdCache && this.mdCache.file === file && this.mdCache.width === width) {
      return this.mdCache.lines;
    }
    if (!this.mdRenderer) {
      this.mdRenderer = new Markdown("", 0, 0, getMarkdownTheme());
    }
    this.mdRenderer.setText(file.rawText ?? "");
    const rawLines = this.mdRenderer.render(width);
    // Width safety clamp: pad to width and prevent bright ellipsis leakage.
    const lines = rawLines.map((line) => padTo(line, width));
    this.mdCache = { file, width, lines };
    this.searchDirty = true;
    return lines;
  }

  private cachedMaxLineWidth(file: ViewerFile): number {
    if (this.maxLineWidthCache && this.maxLineWidthCache.file === file) return this.maxLineWidthCache.value;
    const value = maxLineWidth(file);
    this.maxLineWidthCache = { file, value };
    return value;
  }

  private cachedPlainRows(file: ViewerFile, width: number, wrap: boolean): DisplayRow[] {
    const c = this.plainRowsCache;
    if (c && c.file === file && c.width === width && c.wrap === wrap) return c.rows;
    let rows: DisplayRow[];
    if (wrap) {
      rows = computeRows(file, width, true, 0);
    } else {
      rows = [];
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i];
        if (line !== undefined) rows.push({ line: i, text: line });
      }
    }
    this.plainRowsCache = { file, width, wrap, rows };
    return rows;
  }

  /**
   * The map's row texts for one width (Issue #165): the **unmarked** twin of
   * the body rows, memoised so the sketch can key on a stable array identity.
   * The wrapped source is the body's shared plain wrap (Issue #168), so the
   * map never wraps the file a second time. `rowLines` maps each display row
   * back to its source line while wrapping, so search marks can resolve a
   * match line to the map rows it occupies (Issue #166).
   */
  private minimapTexts(
    file: ViewerFile,
    width: number,
    renderMarkdown: boolean,
    wrap: boolean,
  ): { texts: string[]; rowLines: number[] | null } {
    const c = this.mapTextsCache;
    if (
      c &&
      c.file === file &&
      c.width === width &&
      c.wrap === wrap &&
      c.renderMarkdown === renderMarkdown
    ) {
      return c;
    }
    let texts: string[];
    let rowLines: number[] | null = null;
    if (renderMarkdown) {
      texts = this.getRenderedMarkdownLines(file, width);
    } else if (wrap) {
      const plain = this.cachedPlainRows(file, width, true);
      texts = plain.map((row) => row.text);
      rowLines = [];
      let line = -1;
      for (const row of plain) {
        if (row.line !== null) line = row.line;
        rowLines.push(line);
      }
    } else {
      texts = file.lines;
    }
    this.mapTextsCache = { file, width, wrap, renderMarkdown, texts, rowLines };
    return this.mapTextsCache;
  }

  /**
   * The map's search marks for one render pass (Issue #166): one flag per map
   * row whose display range holds a matched line, plus the current match's row.
   * Computed per pass — outside the sketch cache — because match state changes
   * on far more events than the fold, and returned null when nothing matches.
   */
  private minimapMarks(
    entry: { texts: string[]; rowLines: number[] | null },
    sketch: MinimapSketch,
  ): MinimapMarks | null {
    if (!this.searchQuery || this.searchMatches.length === 0) return null;
    const currentMatch = this.searchMatches[Math.min(this.searchIndex, this.searchMatches.length - 1)];
    const currentLine = currentMatch?.line ?? -1;
    const marked: boolean[] = [];
    let current = -1;
    sketch.blocks.forEach((block, k) => {
      let hit = false;
      let cur = false;
      for (let j = block.start; j < block.end; j += 1) {
        const line = entry.rowLines ? entry.rowLines[j] : j;
        if (line === undefined) continue;
        if (this.searchMatchLines.has(line)) hit = true;
        if (line === currentLine) cur = true;
      }
      marked.push(hit);
      if (cur) current = k;
    });
    return { marked, current };
  }

  /**
   * One sketch for the current texts, size, palette and theme (Issue #165).
   * The texts array's identity already covers a reload, the `m` toggle and a
   * restyle; the other components cover resize, the `v`/setting toggles and a
   * theme switch (through the same style key the file is restyled under).
   */
  private viewerSketch(
    texts: readonly string[],
    area: number,
    width: number,
    diff: boolean,
    encoding: MinimapEncoding,
    palette: NavigatorMinimapPalette,
  ): MinimapSketch | null {
    const themeKey = this.styleKey();
    const c = this.sketchCache;
    if (
      c &&
      c.texts === texts &&
      c.area === area &&
      c.width === width &&
      c.encoding === encoding &&
      c.palette === palette &&
      c.diff === diff &&
      c.themeKey === themeKey
    ) {
      return c.sketch;
    }
    const sketch = buildMinimap({ texts, area, width, encoding, palette, diff, theme: this.theme() });
    this.sketchCache = { texts, area, width, encoding, palette, diff, themeKey, sketch };
    return sketch;
  }
}
