/**
 * Viewer pane view-model (Issue #064 extraction).
 *
 * Pure layout for the right pane: the header, the search/filter input bars,
 * the metadata/binary/error card, the image-card hints, and the pane body
 * renderer. NavigatorOverlay owns every cache, clamp and state mutation and
 * hands this module a flat `ViewerPaneView` record filled with the
 * already-computed data (marked rows, wrapped display rows, pre-styled
 * rendered-markdown content); nothing here reads component state.
 */

import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import { isNativelyRenderable, type ImageSupport } from "./images";
import type { NavigatorTheme } from "./theme";
import type { Focus, SearchMatch, ViewerFile, ViewerScrollWindow } from "./types";
import { formatSize, hardTruncate, isMarkdownPath, sliceStyled, type DisplayRow } from "./viewer";
import { FRAME_CORNERS, isImageLine, joinLeftRight, padTo, shortPath, truncateAndWidth } from "./frame";
import { MODE_HINTS, plainHint } from "./help";

/** Markdown files get an alternative rendered view (Issue #053). */
export function canRenderMarkdown(file: ViewerFile | null): boolean {
  return file !== null && file.kind !== "diff" && file.rawText !== undefined && isMarkdownPath(file.relPath);
}

/**
 * Content-cell geometry for the current file branch. Mirrors the live
 * decision: rendered markdown has no gutter, text-like files reserve the
 * gutter, and loading/empty states use the bare pane.
 */
export function paneContentWidth(
  file: ViewerFile | null,
  useRendered: boolean,
  rightW: number,
): { contentW: number; digits: number } {
  let contentW: number;
  let digits = 0;
  if (useRendered && file) {
    contentW = Math.max(10, rightW - 2);
  } else if (file) {
    digits = Math.max(2, String(file.lineCount ?? file.lines.length).length);
    const gutterW = digits + 1;
    contentW = Math.max(10, rightW - 2 - (gutterW + 2));
  } else {
    contentW = Math.max(10, rightW - 2);
  }
  return { contentW, digits };
}

/** Notice rows above the text-like content (truncation / disk change). */
export function paneContentArea(
  area: number,
  file: ViewerFile,
  diskChanged: boolean,
): { noticeRows: number; contentArea: number } {
  let noticeRows = 0;
  if ((file.kind === "truncated" || file.kind === "diff") && file.notice) noticeRows += 1;
  if (diskChanged) noticeRows += 1;
  return { noticeRows, contentArea: Math.max(1, area - noticeRows) };
}

/**
 * One render pass's clamped viewer window (Issue #147): the vertical scroll
 * offset, the horizontal scroll offset, and the scrollbar window (null when
 * the content fits or the branch carries none).
 */
export interface ViewerWindow {
  viewScroll: number;
  hscroll: number;
  scrollWindow: ViewerScrollWindow | null;
}

/**
 * Inputs to `viewerWindow`: the requested offsets plus the geometry their
 * clamps need. Omitted clamps are pass-throughs, so a branch that never
 * scrolls (a card) states that by leaving them out rather than by copying a
 * no-op `Math.max`.
 */
export interface ViewerWindowInput {
  requestedScroll: number;
  requestedHscroll: number;
  /** Vertical content length; omit (with count) for a pane that never clamps. */
  total?: number;
  /** Rows the pane draws. */
  count?: number;
  /** Horizontal clamp ceiling; omit to pass requestedHscroll through. */
  maxHscroll?: number;
  /** Body-relative first scrollable row; omit for no scrollbar window. */
  rowOffset?: number;
}

/**
 * The one clamp for the viewer pane (Issue #147): one render pass produces
 * this object, and the body rows, the header badge/readout and the frame
 * scrollbar all consume it, so the #065 divergence between the offset the
 * body was drawn at and the offset a consumer reports cannot be reintroduced
 * by reordering the render code.
 */
export function viewerWindow(input: ViewerWindowInput): ViewerWindow {
  const { total, count } = input;
  const viewScroll =
    total !== undefined && count !== undefined
      ? Math.max(0, Math.min(input.requestedScroll, Math.max(0, total - count)))
      : input.requestedScroll;
  const hscroll =
    input.maxHscroll !== undefined
      ? Math.max(0, Math.min(input.requestedHscroll, input.maxHscroll))
      : input.requestedHscroll;
  const scrollWindow =
    input.rowOffset !== undefined && total !== undefined && count !== undefined && total > count
      ? { rowOffset: input.rowOffset, count, scroll: viewScroll, total }
      : null;
  return { viewScroll, hscroll, scrollWindow };
}

/**
 * The pane's one body payload (Issue #149): the class fills exactly one
 * variant per render pass and `renderViewerPane` branches on `kind` once, so
 * the body channels' exclusivity is carried by the union instead of by
 * coordinating parallel nullable fields.
 */
export type ViewerContent =
  | { kind: "image-lines"; lines: string[] }        // rendered image rows (non-empty by construction)
  | { kind: "card" }                                 // binary / error / image shown as a card
  // Rendered-markdown mode active: these rows are authoritative — pre-styled
  // by the overlay, which owns markRenderedLineMatches; null entry = blank row.
  | { kind: "markdown"; rows: Array<string | null> } // pre-styled rendered markdown
  // Text mode: search-marked, wrapped and truncated by the overlay's caches.
  | { kind: "display"; rows: DisplayRow[] }          // text-like wrapped rows (incl. diffs)
  | { kind: "none" };                                // no body drawn (null file / loading)

/**
 * Flat view-model record the overlay fills with already-computed data.
 * `content` carries the one body payload (Issue #149); the remaining fields
 * are header/bar state plus geometry and support snapshots.
 */
export interface ViewerPaneView {
  /** Renderer tokens; every color goes through this. */
  theme: NavigatorTheme;
  /** Active pane (header accent). */
  focus: Focus;
  /** Home directory for ~-shortening of the header path. */
  home: string;
  /** Hardware cursor marker emission (input bars). */
  focused: boolean;
  /** Resolved file to render; null while switching files or none open. */
  file: ViewerFile | null;
  /** True while a load is in flight (header meta + "(loading…)" body). */
  loading: boolean;
  /** True while switching files: the header shows the target path. */
  switching: boolean;
  /** Header target relPath while switching (`commit:` prefix for diffs). */
  targetRelPath: string | null;
  /** True when the open file changed on disk (notice row). */
  diskChanged: boolean;
  /** Search input bar replaces the viewer header. */
  searchMode: boolean;
  /** Raw rendered-markdown flag (did the user toggle `m`). */
  renderMarkdown: boolean;
  /** The one body payload; the renderer switches on `kind` once (Issue #149). */
  content: ViewerContent;
  /** Gutter width in digits (text mode). */
  digits: number;
  /** Already-clamped vertical scroll offset (all content branches). */
  viewScroll: number;
  /** Viewport readout for the header (Issue #137 §3): `null` unless the
   *  text-like content overflows the pane (`total > contentArea`); card,
   *  loading, empty and image-card branches never set it. `end` is the last
   *  visible row (1-based, inclusive). */
  scrollInfo: { start: number; end: number; total: number } | null;
  /** Word-wrap flag (header meta). */
  wrap: boolean;
  /** Horizontal scroll offset (header meta). */
  hscroll: number;
  /** Image-support snapshot (header badge + card hints). */
  imageSupport: ImageSupport;
  /** Current pane geometry for chafa (null when never laid out). */
  imageGeometry: { cols: number; rows: number } | null;
  /** Search query for the search bar counter. */
  searchQuery: string;
  /** Active search matches for the bar counter. */
  searchMatches: SearchMatch[];
  /** Index of the current match (bar counter). */
  searchIndex: number;
}

/**
 * The right-pane renderer: header/bar slot plus the body for every branch —
 * loading, empty, rendered chafa image, metadata/binary/error card, and the
 * text-like content (gutter + notices + rendered-markdown or wrapped rows).
 * Pure: the caller has already applied every clamp and cache.
 */
export function renderViewerPane(view: ViewerPaneView, width: number, area: number): string[] {
  const T = view.theme;
  const rows: string[] = [];
  rows.push(view.searchMode ? buildSearchBar(view, width) : buildViewerHeader(view, width));

  if (!view.file && view.loading) {
    for (let i = 0; i < area; i++) rows.push(padTo(i === 0 ? " " + T.dim("(loading\u2026)") : "", width));
    return rows;
  }
  if (!view.file) {
    for (let i = 0; i < area; i++) rows.push(padTo(i === 0 ? " " + T.dim("(select a file)") : "", width));
    return rows;
  }
  const file = view.file;

  // Rendered-image branch: chafa rows are pre-styled and content-stable,
  // each carrying its own trailing reset (§8), so every row is truncated to
  // the full pane width with an empty ellipsis (Issue #010) and padded;
  // native rows are pass-through with right-side fill (spec §8, D9).
  if (view.content.kind === "image-lines") {
    // Native rows (spec §8.2, D9): the sequence row is emitted first,
    // un-truncated, with right-side space fill only — the image anchors where
    // the sequence appears, so no width function may cut or re-anchor it.
    // Filler rows are `""` at this boundary and become blank pane rows. Chafa
    // rows keep their hard-cut + pad contract.
    const verdict = file.imageVerdict;
    const native = verdict?.kind === "rendered" && verdict.renderer === "native";
    for (let i = 0; i < area; i++) {
      const line = view.content.lines[view.viewScroll + i];
      if (line === undefined || line === "") {
        rows.push(padTo("", width));
        continue;
      }
      rows.push(
        native && isImageLine(line)
          ? line + " ".repeat(width)
          : padTo(hardTruncate(line, width), width),
      );
    }
    return rows;
  }

  // Card branch: the class routes every binary / error / image it does not
  // render here, so a zero-line rendered verdict gets the metadata card —
  // never the text-like gutter (Issue #103) — and no file.kind or line-count
  // check re-derives the choice (Issue #149).
  if (view.content.kind === "card") {
    rows.push(...buildCard(file, width, area, view));
    return rows;
  }

  // Text-like content (v3: `diff` falls through here, so a commit diff gets
  // the same gutter / wrap / scroll / search path as a text file).
  const { contentArea } = paneContentArea(area, file, view.diskChanged);

  // Optional notices above the content.
  // v3: the diff notice ("commit abc1234 · N files · +I −D") is a summary,
  // not an alert, so it uses T.dim rather than the truncation warning.
  if (file.kind === "truncated" && file.notice) rows.push(padTo(" " + T.warning(file.notice), width));
  if (file.kind === "diff" && file.notice) rows.push(padTo(" " + T.dim(file.notice), width));
  if (view.diskChanged) {
    rows.push(padTo(" " + T.warning("file changed on disk \u2014 press r to reload"), width));
  }

  const body = view.content;
  if (body.kind === "markdown") {
    for (let i = 0; i < contentArea; i++) {
      const row = body.rows[i];
      rows.push(row === null ? padTo("", width) : padTo(" " + row, width));
    }
  } else if (body.kind === "display") {
    const { contentW } = paneContentWidth(file, false, width);
    for (let i = 0; i < contentArea; i++) {
      const row = body.rows[view.viewScroll + i];
      if (!row) {
        rows.push(padTo("", width));
        continue;
      }
      const gutter = row.line === null ? " ".repeat(view.digits) + " " : String(row.line + 1).padStart(view.digits) + " ";
      const text = view.wrap ? row.text : sliceStyled(row.text, view.hscroll, view.hscroll + contentW);
      const line = " " + T.dim(gutter) + T.frame("\u2502") + " " + text;
      rows.push(padTo(line, width));
    }
  }

  return rows;
}

export function buildViewerHeader(view: ViewerPaneView, rightW: number): string {
  const T = view.theme;
  const currentPath = (view.switching ? view.targetRelPath : view.file?.relPath) ?? "(no file)";
  const file = view.switching ? null : view.file;
  // v3: a commit diff shows "commit <hash>" instead of a path — mirrors git
  // show's header and keeps the long commit:<hash> identity string out of
  // the title row.
  const isCommit = (file?.kind === "diff" && file.commitHash) || currentPath.startsWith("commit:");
  const commitHash = file?.commitHash ?? (currentPath.startsWith("commit:") ? currentPath.slice("commit:".length) : "");
  const headerPath = isCommit ? `commit ${commitHash}` : shortPath(currentPath, view.home);
  const left = " " + (view.focus === "viewer" ? T.accent(T.bold(headerPath)) : T.muted(headerPath));
  const meta: string[] = [];
  if (file) {
    const size = formatSize(file.sizeBytes);
    if (size) meta.push(size);
    if (file.lineCount !== undefined) meta.push(`${file.lineCount}L`);
    if (file.tokens !== undefined) meta.push(`~${file.tokens} tok`);
    if (file.kind === "truncated") meta.push("truncated");
    if (canRenderMarkdown(file)) {
      meta.push(view.renderMarkdown ? "m code" : "m render");
    }
    if (file.kind === "image" && view.imageSupport.tier !== "none") {
      // Header badge (spec §7.5, §10): a rendered image shows its renderer and
      // the toggle affordance; a capable card shows how to get back to it.
      const verdict = file.imageVerdict;
      // Issue #149 delta: the badge keys on the same content slot the body
      // draws, so a rendered verdict with zero lines reads `i render` with
      // its card (matching the body and the `i` handler). The verdict only
      // narrows the renderer name — image-lines implies a rendered verdict
      // by construction.
      if (view.content.kind === "image-lines") {
        meta.push(verdict?.kind === "rendered" && verdict.renderer === "chafa" ? "chafa" : (view.imageSupport.nativeProtocol ?? "native"));
        meta.push("i card");
      } else {
        meta.push("i render");
      }
    }
    if (!view.renderMarkdown && view.wrap) meta.push("wrap");
    if (view.hscroll > 0) meta.push(`col ${view.hscroll + 1}`);
    if (view.loading) meta.push("loading\u2026");
    // Issue #137 §3: the position readout is the last meta item, plain
    // numbers with an en dash and no thousands separators. The meta block
    // below renders as one dim `·`-joined span — no separate styling here.
    if (view.scrollInfo) {
      const { start, end, total } = view.scrollInfo;
      meta.push(`showing ${start}\u2013${end} of ${total}`);
    }
  } else if (view.loading && currentPath !== "(no file)") {
    meta.push("loading\u2026");
  }
  const right = meta.length > 0 ? T.dim(meta.join(" \u00b7 ")) + " " : " ";
  return joinLeftRight(left, right, rightW);
}

export interface InputBarView {
  theme: NavigatorTheme;
  /** Hardware cursor marker emission (component focus). */
  focused: boolean;
}

/**
 * A typed query plus a reverse-video cursor. While the component is focused
 * the hardware cursor marker precedes the fake cursor, which is what lets the
 * terminal position the IME candidate window over it (standards section 2.3).
 */
export function buildInputBar(query: string, placeholder: string, info: string | null, width: number, view: InputBarView): string {
  const T = view.theme;
  const cursor = view.focused ? CURSOR_MARKER + T.text("\u2588") : T.text("\u2588");
  const left = " " + T.text("/" + query) + cursor;
  const right = (info ? T.warning(info) : T.dim(placeholder)) + " ";
  return joinLeftRight(left, right, width);
}

/** Search bar: replaces the viewer header line while searching. */
export function buildSearchBar(view: ViewerPaneView, rightW: number): string {
  return buildInputBar(
    view.searchQuery,
    plainHint(MODE_HINTS.search),
    view.searchQuery
      ? `${view.searchMatches.length === 0 ? 0 : view.searchIndex + 1}/${view.searchMatches.length} matches`
      : null,
    rightW,
    view,
  );
}

export interface FilterBarView extends InputBarView {
  filterQuery: string;
  matchCount: number;
}

/** Filter bar: drawn in the footer row area while filtering. */
export function buildFilterBar(width: number, view: FilterBarView): string {
  return buildInputBar(view.filterQuery, plainHint(MODE_HINTS.filter), view.filterQuery ? `${view.matchCount} matches` : null, width, view);
}

export function buildCard(file: ViewerFile, rightW: number, area: number, view: ViewerPaneView): string[] {
  const T = view.theme;
  const title = file.kind === "image" ? "Image" : file.kind === "binary" ? "Binary file" : "Cannot read";
  const titleStyle = file.kind === "error" ? T.error : file.kind === "binary" ? T.warning : T.accent;
  const body: string[] = [file.relPath];
  if (file.message) body.push(file.message);
  if (file.kind === "binary") body.push("binary content is not rendered");
  if (file.kind === "image") body.push(...imageCardHints(file, view.imageSupport, view.imageGeometry));
  if (file.kind === "error") body.push("press Tab, then pick another file");

  const contentWidth = Math.max(
    4,
    Math.min(Math.max(4, rightW - 6), Math.max(24, Math.max(...[title, ...body].map((text) => visibleWidth(text))) + 4)),
  );
  const boxW = contentWidth + 2;
  const boxH = body.length + 2;
  const topPad = Math.max(0, Math.floor((area - boxH) / 2));
  const leftPad = Math.max(0, Math.floor((rightW - boxW) / 2));

  const out: string[] = [];
  const blank = (text: string) => " ".repeat(leftPad) + text + " ".repeat(Math.max(0, rightW - leftPad - visibleWidth(text)));
  const borderRow = (left: string, fill: string, right: string) =>
    blank(T.frame(left + fill.repeat(Math.max(0, boxW - 2)) + right));
  for (let i = 0; i < topPad; i++) out.push(blank(""));
  out.push(borderRow(FRAME_CORNERS.tl, "\u2500", FRAME_CORNERS.tr));
  // Interior = 1 space + " title " + padding = contentWidth, so the title row
  // is exactly as wide as the border rows (boxW = contentWidth + 2).
  const titlePad = Math.max(0, contentWidth - visibleWidth(title) - 3);
  out.push(blank(T.frame("\u2502") + " " + titleStyle(T.bold(" " + title + " ")) + " ".repeat(titlePad) + T.frame("\u2502")));
  for (const text of body) {
    // Empty ellipsis: the default "..." is wrapped in \x1b[0m resets that
    // would close the T.muted span and render "..." in bright default.
    // Truncate once and reuse the measured width so the padding matches.
    const cell = truncateAndWidth(text, Math.max(0, contentWidth - 1));
    out.push(
      blank(T.frame("\u2502") + " " + T.muted(cell.text) + " ".repeat(Math.max(0, contentWidth - 1 - cell.width)) + T.frame("\u2502")),
    );
  }
  out.push(borderRow(FRAME_CORNERS.bl, "\u2500", FRAME_CORNERS.br));
  while (out.length < area) out.push(padTo("", rightW));
  return out.slice(0, area).map((row) => padTo(row, rightW));
}

/**
 * Which renderer's name a failed verdict gets on the card (Issue #143): the
 * verdict records who spoke, so no mode/probe state is re-read here — native
 * failures name the protocol, chafa failures name chafa.
 */
function failedRendererLabel(
  failed: { renderer: "native" | "chafa" },
  support: ImageSupport,
): string {
  return failed.renderer === "native" ? (support.nativeProtocol ?? "native") : "chafa";
}

/**
 * Image-card guidance rows (spec §9/§10): the first applicable hint in
 * priority order — render failure (labelled with the renderer that failed),
 * pane too small, host images disabled, the strict-native states (no
 * capability, format not natively renderable), then the #057 chafa ladder,
 * then the mode-off enable hint. Rows stay short; buildCard hard-cuts safely
 * at narrow widths.
 */
export function imageCardHints(
  file: ViewerFile,
  support: ImageSupport,
  geometry: { cols: number; rows: number } | null,
): string[] {
  const failed = file.imageVerdict?.kind === "card" ? file.imageVerdict.failed : undefined;
  if (failed) return [`${failedRendererLabel(failed, support)} failed: ${failed.detail}`];
  if (geometry === null) return ["pane too small for a rendered image"];
  if (!support.hostShowImages) return ["terminal.showImages is false - image rendering disabled"];
  if (support.mode === "native") {
    if (support.nativeProtocol === null) {
      return ["this terminal does not support kitty/iTerm2 - use auto or chafa"];
    }
    if (!isNativelyRenderable(file.relPath)) {
      return ["this image format cannot be rendered natively - use chafa or auto"];
    }
    return [];
  }
  if (!support.piChafa.present) {
    // Kept within the card's content clamp (rightW - 6) so the default
    // 120-column layout shows the whole hint, not a hard cut.
    return ["optional: install chafa + pi-chafa (pi install npm:pi-chafa)"];
  }
  if (support.chafa.state === "missing") return ["chafa not found - install it, or set CHAFA_BIN / binaryPath"];
  if (support.chafa.state === "too-old") return ["chafa is older than 1.10 - upgrade to render images"];
  if (support.chafa.state === "error") return [`chafa probe failed: ${support.chafa.detail}`];
  if (support.chafa.state === "deferred") return ["checking image support\u2026"];
  if (support.mode === "off") return ["optional: enable images.mode=chafa, native, or auto to render images here"];
  return [];
}
