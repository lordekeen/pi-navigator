/**
 * Overlay frame composition and chrome (Issue #064 view-model extraction;
 * Issue #148 split).
 *
 * Pure functions of plain inputs: the composition helpers (padTo /
 * joinLeftRight / shortPath / truncateAndWidth), the title and footer rows,
 * and the whole frame assembly (composeFrame) with its compact-notice and
 * scrollbar-border builders. Navigator-only layout math lives in layout.ts
 * and the one key declaration lives in help.ts (Issue #148); no component
 * state lives here — NavigatorOverlay passes the values it owns (terminal
 * rows, git state, focus, mode, notice, home) and renders the returned
 * strings.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  FOCUS_BINDINGS,
  FOCUS_HINTS,
  MODE_HINTS,
  plainHint,
  resolveBindings,
  type HintPair,
} from "./help";
import { visiblePanes } from "./layout";
import type { NavigatorTheme } from "./theme";
import type { Focus, GitState, InputMode, NavigatorLayout, ViewerScrollWindow } from "./types";
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
 * The widest the left segment may be for `right` to survive the composer with
 * the one gap cell `joinLeftRight` reserves: `width − visibleWidth(right) −
 * 1`, floored at 0. Callers that must fit left-side content around a right
 * segment query this instead of copying the composer's arithmetic (Issue
 * #147) — #113 and #138 were the same off-by-one corrected caller-side, twice.
 */
export function leftBudget(width: number, right: string): number {
  return Math.max(0, width - visibleWidth(right) - 1);
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
  const maxLeft = leftBudget(width, right);
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
 * Rows above the body in the full frame (Issue #167): top border, subtitle
 * row, separator. `layout.bodyRows` reserves these three plus the two bottom
 * rows; mouse hit-testing offsets overlay-local coordinates from this value.
 */
export const FRAME_TOP_ROWS = 3;

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
 * Compact "terminal too small" notice (Issue #148): the three lines the
 * overlay draws when the terminal cannot host the frame (width below
 * MIN_OVERLAY_WIDTH / height below MIN_OVERLAY_HEIGHT). Every line is clipped
 * to `width`, so the notice is width-safe like the frame.
 */
export function buildCompactFrame(width: number, theme: NavigatorTheme): string[] {
  const T = theme;
  const barW = Math.max(0, width - 2);
  const notice = (text: string) => padTo(T.frame("\u2502") + padTo(text, barW) + T.frame("\u2502"), width);
  return [
    padTo(T.frame(FRAME_CORNERS.tl + "\u2500".repeat(barW) + FRAME_CORNERS.tr), width),
    notice(T.warning(" terminal too small for pi-navigator - resize, or press Esc ")),
    padTo(T.frame(FRAME_CORNERS.bl + "\u2500".repeat(barW) + FRAME_CORNERS.br), width),
  ];
}

/**
 * One body row's right border cell (Issue #137 §4, pure since Issue #148):
 * the frame's right border column doubles as the viewer scrollbar while the
 * text-like content overflows. Display-only — no timers, no fade, no mouse
 * handling — and hidden while the help modal is open (the caller passes a
 * null window then). The window is recorded by the pane's clamp, so the thumb
 * cannot drift from the drawn content.
 */
export function buildScrollbarBorder(
  i: number,
  scrollWindow: ViewerScrollWindow | null,
  theme: NavigatorTheme,
): string {
  const T = theme;
  if (!scrollWindow) return T.frame("\u2502");
  const rel = i - scrollWindow.rowOffset;
  if (rel < 0 || rel >= scrollWindow.count) return T.frame("\u2502");
  const thumbH = Math.max(1, Math.round((scrollWindow.count * scrollWindow.count) / scrollWindow.total));
  const thumbStart = Math.round(
    (scrollWindow.scroll / Math.max(1, scrollWindow.total - scrollWindow.count)) * (scrollWindow.count - thumbH),
  );
  return rel >= thumbStart && rel < thumbStart + thumbH
    ? T.scrollbarThumb("\u2588")
    : T.scrollbarTrack("\u2502");
}

/**
 * Inputs to `composeFrame` (Issue #148): the values NavigatorOverlay owns
 * after geometry, row building and the footer/filter-bar decision.
 */
export interface FrameView {
  theme: NavigatorTheme;
  innerW: number;
  /** Body row count (the rows between the title row and the footer row). */
  body: number;
  /** Left-column width; ignored when leftRows is null. */
  leftW: number;
  /** Files group height, for the separator row position. */
  filesH: number;
  /** Whether the default layout's files↔git separator row is drawn. */
  showSeparator: boolean;
  /** Left-column rows; null when the left column is hidden. */
  leftRows: string[] | null;
  /** Right-pane rows (one per body row). */
  rightRows: string[];
  /** The viewer scrollbar window, or null when no scrollbar shows. */
  scrollWindow: ViewerScrollWindow | null;
  /** Title-row inputs (path + git context). */
  title: { cwd: string; git: GitState | null; home: string };
  /** The footer or filter-bar row content, undecorated. */
  footerRow: string;
}

/**
 * The frame assembly (Issue #148): top border through bottom border —
 * borders, title row, separator rows, the body join (left column / scrollbar
 * border) and the footer wrapper. Byte-identical to the assembly that lived
 * in NavigatorOverlay.render() before the split; the overlay optionally
 * composes the help modal into the returned lines afterwards.
 */
export function composeFrame(view: FrameView): string[] {
  const T = view.theme;
  const lines: string[] = [];
  // Issue #137 §2: the top border carries the product-name pill; the row
  // below is the subtitle (path + git), not a second title.
  lines.push(buildTopBorder(view.innerW, { theme: T, title: "pi-navigator" }));
  lines.push(
    T.frame("\u2502") +
      buildTitleRow(view.innerW, { theme: T, cwd: view.title.cwd, git: view.title.git, home: view.title.home }) +
      T.frame("\u2502"),
  );
  lines.push(T.frame("\u251c" + "\u2500".repeat(view.innerW) + "\u2524"));

  for (let i = 0; i < view.body; i++) {
    const border = buildScrollbarBorder(i, view.scrollWindow, T);
    if (!view.leftRows) {
      lines.push(T.frame("\u2502") + view.rightRows[i] + border);
      continue;
    }
    if (view.showSeparator && i === view.filesH) {
      lines.push(
        T.frame("\u251c") + T.frame("\u2500".repeat(view.leftW)) + T.frame("\u2524") + view.rightRows[i] + border,
      );
    } else {
      lines.push(T.frame("\u2502") + view.leftRows[i] + T.frame("\u2502") + view.rightRows[i] + border);
    }
  }

  lines.push(T.frame("\u2502") + view.footerRow + T.frame("\u2502"));
  lines.push(T.frame(FRAME_CORNERS.bl + "\u2500".repeat(view.innerW) + FRAME_CORNERS.br));
  return lines;
}

/**
 * The viewer hint ref whose advertised action is unavailable for files that
 * cannot render as markdown (Issue #135 L1); addressed by binding id since
 * Issue #148 so a key-spelling change cannot silently stop the drop.
 */
const MARKDOWN_REF_ID = "markdown";

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
      // Issue #135 L1: an unavailable action is not advertised. For a file that
      // cannot render as markdown the `m` key is inert, so its ref leaves the
      // hint rather than promising a toggle that will not happen. Whole refs
      // leave, so no fragment can remain behind.
      if (focus === "viewer" && opts.markdownApplicable === false) {
        return resolveBindings(FOCUS_BINDINGS.viewer.filter((ref) => ref.id !== MARKDOWN_REF_ID));
      }
      return FOCUS_HINTS[focus];
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
  // shape makes a half-styled hint impossible). The budget is the composer's
  // own left budget (Issue #147: the right segment plus its gap cell), minus
  // one for the hint's own leading space — not composer accounting — so the
  // hints can never be the reason the focus indicator or the notice is what
  // disappears.
  const hint = fitHint(
    getFooterHint(view.mode, view.focus, { markdownApplicable: view.markdownApplicable }),
    Math.max(0, leftBudget(innerW, right) - 1),
  );
  // Issue #137 §1: dim(keys) + muted(" label"), pairs joined by a dim ` · `.
  const left = " " + hint.map((pair) => T.dim(pair.keys) + T.muted(" " + pair.label)).join(T.dim(" \u00b7 "));
  return joinLeftRight(left, right, innerW);
}
