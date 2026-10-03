/**
 * Overlay frame and geometry (Issue #064 view-model extraction).
 *
 * Pure functions of plain inputs: overlay height/split geometry, chrome
 * helpers (padTo / joinLeftRight / shortPath / truncateAndWidth), the title
 * and footer rows, and the focus/mode hint tables. No component state lives
 * here — NavigatorOverlay passes the values it owns (terminal rows, git
 * state, focus, mode, notice, home) and renders the returned strings.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  GIT_MIN_ROWS,
  LEFT_COLUMN_HIDE_BELOW,
  LEFT_COLUMN_MAX,
  LEFT_COLUMN_MIN,
  LEFT_COLUMN_RATIO,
  OVERLAY_HEIGHT_RATIO,
  OVERLAY_MARGIN_ROWS,
} from "./constants";
import type { NavigatorTheme } from "./theme";
import type { Focus, GitState, InputMode, NavigatorLayout } from "./types";
import { hardTruncate } from "./viewer";

/**
 * Truncate a (possibly styled) string to a visible width and return both the
 * truncated text and its visible width. Sites that need to truncate and then
 * pad to a column previously called `truncateToWidth` and a separate
 * `visibleWidth` on the result — two char-by-char scans of the same string.
 * This collapses them into one named operation (Issue #018) on top of
 * `hardTruncate` (viewer.ts), the overlay's empty-ellipsis hard-cut
 * convention (Issue #010). pi-tui's `visibleWidth` caches repeated
 * measurements, so the single `visibleWidth` here is cheap and the result
 * width is exact.
 */
export function truncateAndWidth(text: string, maxWidth: number): { text: string; width: number } {
  const out = hardTruncate(text, maxWidth);
  return { text: out, width: visibleWidth(out) };
}

/**
 * Height in rows, bounded by the terminal so the overlay never overflows it.
 *
 * One source of truth for the ratio: `OVERLAY_OPTIONS.maxHeight` is derived
 * from the same `OVERLAY_HEIGHT_RATIO`, so the box the host allocates and the
 * frame drawn here cannot drift apart (Issue #130).
 *
 * `rows - OVERLAY_MARGIN_ROWS * 2` reserves the host's vertical margin (one row
 * top and bottom), and letting the result fall below MIN_OVERLAY_HEIGHT is
 * deliberate: that is what makes the compact "terminal too small" notice
 * reachable (plan section 6).
 */
export function overlayHeight(termRows: number): number {
  const rows = termRows || 24;
  const bounded = Math.max(0, rows - OVERLAY_MARGIN_ROWS * 2);
  return Math.max(0, Math.min(Math.floor(rows * OVERLAY_HEIGHT_RATIO), bounded));
}

export function bodyRows(overlayH: number): number {
  return Math.max(4, overlayH - 5);
}

export function useLeftColumn(innerW: number, body: number, showTree: boolean): boolean {
  if (!showTree || body < 8) return false;
  const candidate = leftColumnWidth(innerW);
  return innerW >= LEFT_COLUMN_HIDE_BELOW && innerW - candidate - 1 >= 30;
}

export function leftColumnWidth(innerW: number): number {
  return Math.min(LEFT_COLUMN_MAX, Math.max(LEFT_COLUMN_MIN, Math.floor(innerW * LEFT_COLUMN_RATIO)));
}

/** Files-pane scroll area height for the current terminal size and layout
 *  (Issue #119, D5): the explicit layout parameter keeps a missed call site
 *  from silently computing the default layout's split. */
export function filesArea(termRows: number, layout: NavigatorLayout): number {
  const overlayH = overlayHeight(termRows);
  const body = bodyRows(overlayH);
  return Math.max(2, layoutRows(body, layout).filesH - 1);
}

/** Git-pane scroll area height for the current terminal size and layout
 *  (Issue #127): the git pane's paging step needs the same figure the render
 *  path computes, so it is derived here rather than duplicated at the call
 *  site. Mirrors `filesArea`. */
export function gitArea(termRows: number, layout: NavigatorLayout): number {
  const overlayH = overlayHeight(termRows);
  const body = bodyRows(overlayH);
  return Math.max(2, layoutRows(body, layout).gitH - 1);
}

/** Viewer-pane content area height for the current terminal size. */
export function viewerArea(termRows: number): number {
  const overlayH = overlayHeight(termRows);
  return Math.max(2, bodyRows(overlayH) - 1);
}

export function splitRows(body: number): { filesH: number; gitH: number } {
  let filesH = Math.max(6, Math.floor(body * 0.55));
  let gitH = body - filesH - 1;
  if (gitH < GIT_MIN_ROWS) {
    filesH = Math.max(3, body - GIT_MIN_ROWS - 1);
    gitH = Math.max(2, body - filesH - 1);
  }
  return { filesH, gitH };
}

/**
 * Layout model (Issue #119, D2): which left-column panes a layout renders.
 * Render/builder code branches on `layoutPanes(layout)`, never on a zero
 * height — a zero height is a geometry fact, not the pane-presence source.
 */
export interface LayoutPanes {
  readonly files: boolean;
  readonly git: boolean;
}

export function layoutPanes(layout: NavigatorLayout): LayoutPanes {
  switch (layout) {
    case "files-git-viewer":
      return { files: true, git: true };
    case "files-viewer":
      return { files: true, git: false };
    case "git-viewer":
      return { files: false, git: true };
  }
}

/**
 * Left-column group heights for a body of `body` rows (Issue #119, D3). The
 * default layout delegates to `splitRows` (filesH + gitH + 1 separator =
 * body); a single-pane layout hands the surviving group the full body — its
 * header + body − 1 area rows, exactly the viewer pane's height.
 */
export function layoutRows(body: number, layout: NavigatorLayout): { filesH: number; gitH: number } {
  if (layout === "files-viewer") return { filesH: body, gitH: 0 };
  if (layout === "git-viewer") return { filesH: 0, gitH: body };
  return splitRows(body);
}

/**
 * Focusable panes for a layout, in Tab order (Issue #119, D8). The viewer is
 * always last; the left-column panes appear in their visual order.
 */
export function visiblePanes(layout: NavigatorLayout): readonly Focus[] {
  switch (layout) {
    case "files-git-viewer":
      return ["files", "git", "viewer"];
    case "files-viewer":
      return ["files", "viewer"];
    case "git-viewer":
      return ["git", "viewer"];
  }
}

/** The pane a layout opens focused on (Issue #119, D8). */
export function initialFocus(layout: NavigatorLayout): Focus {
  return layout === "git-viewer" ? "git" : "files";
}

/**
 * Cycle focus within the layout's visible panes (Issue #119, D8): `1` for
 * Tab, `-1` for Shift+Tab, wrapping at both ends. A focus that the layout
 * does not render falls back to the first visible pane.
 */
export function cycleFocus(focus: Focus, direction: 1 | -1, layout: NavigatorLayout): Focus {
  const panes = visiblePanes(layout);
  const index = panes.indexOf(focus);
  if (index < 0) return panes[0] ?? "files";
  return panes[(index + direction + panes.length) % panes.length] ?? "files";
}

export function padTo(content: string, width: number): string {
  const vw = visibleWidth(content);
  if (vw < width) return content + " ".repeat(width - vw);
  return hardTruncate(content, width);
}

export function shortPath(path: string, home: string): string {
  let shortened = path;
  if (home && (path === home || path.startsWith(home + "/"))) {
    shortened = "~" + path.slice(home.length);
  }
  if (shortened.length > 48) shortened = "\u2026" + shortened.slice(shortened.length - 47);
  return shortened;
}

/**
 * True when a row carries a native terminal-image protocol sequence: the
 * kitty APC prefix (`\x1b_G`) or the iTerm2 OSC-1337 `File=` prefix. Mirrors
 * pi-tui's isImageLine; kept local because pi's jiti loader aliases only the
 * exact package specifier, so a `@earendil-works/pi-tui/dist/...` deep import
 * would load an unaliased second pi-tui instance at runtime.
 */
export function isImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

/**
 * Left/right split with the right side guaranteed: when both cannot fit,
 * the left (informational hint or title path) is ellipsized and the right
 * (pane labels, counters, branch) survives. Plain padTo would truncate the
 * tail, which for the footer is exactly the focus indicator.
 *
 * A native image row is pass-through (D9, spec §8): its anchor is owned by
 * its emitter, and width-joining cannot preserve it — the image side is
 * returned unchanged, byte-identical.
 */
export function joinLeftRight(left: string, right: string, width: number): string {
  if (isImageLine(left)) return left;
  if (isImageLine(right)) return right;
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftPart = visibleWidth(left) > maxLeft ? hardTruncate(left, maxLeft) : left;
  const gap = Math.max(1, width - visibleWidth(leftPart) - rightW);
  const line = leftPart + " ".repeat(gap) + right;
  return padTo(line, width);
}

/**
 * Rounded corner glyphs shared by every bordered surface (Issue #137 §2).
 * Horizontal strokes stay `─` and vertical strokes stay `│`; only the four
 * corner cells are curved. The junction tees (`├ ┤ ┼`) have no curved
 * counterparts and stay sharp.
 */
export const FRAME_CORNERS = {
  tl: "\u256d",
  tr: "\u256e",
  bl: "\u2570",
  br: "\u256f",
} as const;

/**
 * The overlay's top border with the product-name pill (Issue #137 §2):
 * `╭` + `──` + accent-bold `" title "` + `─`.repeat(fill) + `╮`, so the total
 * visible width is `innerW + 2` — the mock's E chrome
 * (`fill = innerW - 2 - visibleWidth(titleWithSpaces)`).
 *
 * A frame too narrow for a pill (fill < 1) degrades to a plain rounded
 * border: a mid-word pill reads as corruption, so the title is dropped whole
 * rather than cut. Width is measured with `visibleWidth`, never `.length`;
 * the caller owns the title text.
 */
export function buildTopBorder(innerW: number, view: { theme: NavigatorTheme; title: string }): string {
  const T = view.theme;
  const titleText = " " + view.title + " ";
  const fill = innerW - 2 - visibleWidth(titleText);
  if (fill < 1) return T.frame(FRAME_CORNERS.tl + "\u2500".repeat(innerW) + FRAME_CORNERS.tr);
  return (
    T.frame(FRAME_CORNERS.tl + "\u2500\u2500") +
    T.accent(T.bold(titleText)) +
    T.frame("\u2500".repeat(fill) + FRAME_CORNERS.tr)
  );
}

/**
 * A footer hint (Issue #137 §1): the keys and the action they perform.
 * `buildFooterRow` styles a pair `dim(keys) + muted(" " + label)` — pi-main's
 * keyHint shape — and `plainHint` flattens the same pair for the input-bar
 * placeholders, so the footer and the placeholders cannot drift apart.
 */
export interface HintPair {
  keys: string;
  label: string;
}

export const FOCUS_HINTS: Record<Focus, HintPair[]> = {
  // Width budget: the longest hint plus the pane labels must fit the inner
  // width at a 100-column terminal (98) so the focus indicator never gets
  // truncated off the footer (render test enforces this at 120, 100, 80).
  // Issue #127 added the Home/End and PgUp/PgDn aliases; the footer is a
  // curated subset (the help modal lists every binding), so hints that no
  // longer fit were dropped whole rather than left to truncate mid-phrase.
  // Issue #137 §1: items are typed pairs; an item that carries no action
  // word of its own (`g G Home/End`, bare `Tab`) gets the minimal label
  // naming its effect. Issue #137 §5: the close pair advertises the default
  // cancel key baked into the tables (`q Esc`), matching help.ts; remaps of
  // `tui.select.cancel` still close because input goes through
  // `matchesCancel`.
  files: [
    { keys: "j k", label: "move" },
    { keys: "Enter", label: "open" },
    { keys: "g G Home/End", label: "jump" },
    { keys: "Tab", label: "pane" },
    { keys: "/", label: "filter" },
    { keys: ".", label: "hidden" },
    { keys: "?", label: "help" },
    { keys: "q Esc", label: "close" },
  ],
  git: [
    { keys: "j k", label: "move" },
    { keys: "Enter", label: "open/diff" },
    { keys: "l h", label: "family" },
    { keys: "g G Home/End", label: "jump" },
    { keys: "?", label: "help" },
    { keys: "q Esc", label: "close" },
  ],
  viewer: [
    { keys: "j k", label: "scroll" },
    { keys: "Ctrl+d/u PgUp/PgDn", label: "page" },
    { keys: "w", label: "wrap" },
    { keys: "m", label: "mode" },
    { keys: "/", label: "search" },
    { keys: "?", label: "help" },
    { keys: "q Esc", label: "close" },
  ],
};

export const MODE_HINTS: Record<Exclude<InputMode, "normal">, HintPair[]> = {
  filter: [
    { keys: "type", label: "to filter" },
    { keys: "up/down", label: "move" },
    { keys: "Home/End", label: "first/last" },
    { keys: "Enter", label: "apply" },
    { keys: "Esc", label: "clear" },
  ],
  search: [
    { keys: "type", label: "to search" },
    { keys: "up/down", label: "match" },
    { keys: "Enter", label: "apply" },
    { keys: "Esc", label: "clear" },
  ],
  help: [
    { keys: "j k", label: "scroll" },
    { keys: "PgUp/PgDn", label: "page" },
    { keys: "Home/End", label: "top/bottom" },
    { keys: "q Esc ?", label: "close help" },
  ],
};

/** The viewer hint pair that only applies to files that can render as markdown
 *  (Issue #135 L1); removed from the footer when they cannot. */
const VIEWER_MARKDOWN_HINT_PAIR: HintPair = { keys: "m", label: "mode" };

/**
 * Flatten hint pairs to plain text — `keys + " " + label` joined by `" · "`
 * (Issue #137 §1). The input-bar placeholders use this so they cannot drift
 * from the footer tables, and width budgets measure the same text the footer
 * renders.
 */
export function plainHint(pairs: HintPair[]): string {
  return pairs.map((pair) => `${pair.keys} ${pair.label}`).join(" \u00b7 ");
}

export function getFooterHint(
  mode: InputMode,
  focus: Focus,
  opts: { markdownApplicable?: boolean | undefined } = {},
): HintPair[] {
  switch (mode) {
    case "help":
      return MODE_HINTS.help;
    case "filter":
      return MODE_HINTS.filter;
    case "search":
      return MODE_HINTS.search;
    case "normal": {
      const hint = FOCUS_HINTS[focus];
      // Issue #135 L1: an unavailable action is not advertised. For a file that
      // cannot render as markdown the `m` key is inert, so its pair leaves the
      // hint rather than promising a toggle that will not happen. Whole pairs
      // leave, so no fragment can remain behind.
      if (focus === "viewer" && opts.markdownApplicable === false) {
        return hint.filter(
          (pair) => pair.keys !== VIEWER_MARKDOWN_HINT_PAIR.keys || pair.label !== VIEWER_MARKDOWN_HINT_PAIR.label,
        );
      }
      return hint;
    }
  }
}

export interface TitleRowView {
  theme: NavigatorTheme;
  cwd: string;
  git: GitState | null;
  /** Home directory for ~-shortening of the title path. */
  home: string;
}

export function buildTitleRow(innerW: number, view: TitleRowView): string {
  const T = view.theme;
  // Subtitle row (Issue #137 §2): the product name now lives in the top
  // border pill (buildTopBorder), so this row carries the path and the git
  // context only. Row count and geometry are unchanged.
  const left = " " + T.muted(shortPath(view.cwd, view.home));
  const git = view.git;
  const branchLabel = git?.available
    ? (git.detached ? "(detached)" : git.branch ?? "(detached)")
    : "no git";
  const counters: string[] = [];
  if (git?.available) {
    if (git.ahead > 0) counters.push(T.success(`\u2191${git.ahead}`));
    if (git.behind > 0) counters.push(T.warning(`\u2193${git.behind}`));
    const changed = git.unstaged.length + git.staged.length;
    if (changed > 0) counters.push(T.dim(`${changed} changed`));
  }
  const right = " " + T.accent(branchLabel) + (counters.length > 0 ? "  " + counters.join(" ") : "") + " ";
  return joinLeftRight(left, right, innerW);
}

export interface FooterView {
  theme: NavigatorTheme;
  mode: InputMode;
  focus: Focus;
  notice: string | null;
  /** The overlay's layout; omitted means the default three-pane split
   *  (Issue #119) — the pane labels drop the panes the layout lacks. */
  layout?: NavigatorLayout;
  /** Whether the open file can render as markdown (Issue #135 L1). `false`
   *  removes the `m` item from the viewer hint, because an unavailable action
   *  must not be advertised; omit it when unknown (harnesses, no file open). */
  markdownApplicable?: boolean | undefined;
}

/**
 * Fits footer hints to a width budget by dropping whole trailing pairs
 * (Issue #135 L4, Issue #137 §1).
 *
 * A hint pair never renders half-styled: the budget is measured with
 * `visibleWidth` on the plain `keys + " " + label` text, so a line that does
 * not fit sheds pairs instead of being cut mid-phrase — which is what the
 * audit flagged at 80 columns, where `joinLeftRight` truncated the hint to
 * make room for the pane labels. Returns `[]` when not even the first pair
 * fits; the caller pads the row back to width.
 */
export function fitHint(pairs: HintPair[], budget: number): HintPair[] {
  if (visibleWidth(plainHint(pairs)) <= budget) return pairs;
  const kept: HintPair[] = [];
  for (const pair of pairs) {
    const next = [...kept, pair];
    if (visibleWidth(plainHint(next)) > budget) break;
    kept.push(pair);
  }
  return kept;
}

/**
 * Footer hints row (normal/search/help modes). While filtering, the footer
 * row area carries the filter bar instead — rendered by the caller
 * (viewer_view.buildFilterBar), mirroring the original live branch. The close
 * pair advertises the default cancel key baked into the tables (`q Esc`,
 * Issue #137 §5); a remap of `tui.select.cancel` still closes, because input
 * goes through `matchesCancel`.
 */
export function buildFooterRow(innerW: number, view: FooterView): string {
  const T = view.theme;
  let right = "";
  if (view.notice) {
    right = " " + T.warning(view.notice) + " ";
  } else {
    const panes: Array<[Focus, string]> = visiblePanes(view.layout ?? "files-git-viewer").map(
      (pane) => [pane, pane] as [Focus, string],
    );
    right =
      " " +
      panes.map(([pane, label]) => (view.focus === pane ? T.accent(T.bold(label)) : T.dim(label))).join("  ") +
      " ";
  }
  // Issue #135 L4: fit the hint to what the row has left, dropping whole
  // pairs rather than letting joinLeftRight cut one mid-phrase (the #137 pair
  // shape makes a half-styled hint impossible). The budget mirrors
  // joinLeftRight's own accounting (the right segment plus one gap cell, and
  // the hint's own leading space) so the hints can never be the reason the
  // focus indicator or the notice is what disappears.
  const hint = fitHint(
    getFooterHint(view.mode, view.focus, { markdownApplicable: view.markdownApplicable }),
    Math.max(0, innerW - visibleWidth(right) - 2),
  );
  // Issue #137 §1: dim(keys) + muted(" label"), pairs joined by a dim ` · `.
  const left = " " + hint.map((pair) => T.dim(pair.keys) + T.muted(" " + pair.label)).join(T.dim(" \u00b7 "));
  return joinLeftRight(left, right, innerW);
}