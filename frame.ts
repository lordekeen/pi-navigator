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
} from "./constants";
import type { NavigatorTheme } from "./theme";
import type { Focus, GitState, InputMode } from "./types";
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
 * Deliberately free to fall below MIN_OVERLAY_HEIGHT: that is what makes the
 * compact "terminal too small" notice reachable (plan section 6).
 */
export function overlayHeight(termRows: number): number {
  const rows = termRows || 24;
  return Math.max(0, Math.min(Math.floor(rows * 0.85), rows - 2));
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

/** Files-pane scroll area height for the current terminal size. */
export function filesArea(termRows: number): number {
  const overlayH = overlayHeight(termRows);
  const body = bodyRows(overlayH);
  const split = splitRows(body);
  return Math.max(2, split.filesH - 1);
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
 * Left/right split with the right side guaranteed: when both cannot fit,
 * the left (informational hint or title path) is ellipsized and the right
 * (pane labels, counters, branch) survives. Plain padTo would truncate the
 * tail, which for the footer is exactly the focus indicator.
 */
export function joinLeftRight(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftPart = visibleWidth(left) > maxLeft ? hardTruncate(left, maxLeft) : left;
  const gap = Math.max(1, width - visibleWidth(leftPart) - rightW);
  const line = leftPart + " ".repeat(gap) + right;
  return padTo(line, width);
}

export const FOCUS_HINTS: Record<Focus, string> = {
  // Width budget: the longest hint plus the pane labels must fit the inner
  // width at a 100-column terminal (98) so the focus indicator never gets
  // truncated off the footer (render test enforces this at 120, 100, 80).
  files: "j k move  Enter open  Tab  / filter  . hidden  y copy  ? help  q close",
  git: "j k move  Enter open file / diff  l h family  g G jump  Tab  y copy  ? help  q close",
  viewer: "j k scroll  Ctrl+d/u  w wrap  m mode  / search  n N  Tab  ? help  q close",
};

export const MODE_HINTS: Record<Exclude<InputMode, "normal">, string> = {
  filter: "type to filter  up/down move  Enter apply  Esc clear",
  search: "type to search  up/down match  Enter apply  Esc clear",
  help: "j k scroll  q Esc ? close help",
};

export function getFooterHint(mode: InputMode, focus: Focus): string {
  switch (mode) {
    case "help":
      return MODE_HINTS.help;
    case "filter":
      return MODE_HINTS.filter;
    case "search":
      return MODE_HINTS.search;
    case "normal":
      return FOCUS_HINTS[focus];
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
  const left = " " + T.accent(T.bold("pi-navigator")) + "  " + T.muted(shortPath(view.cwd, view.home));
  const git = view.git;
  const branchLabel = git?.available
    ? (git.detached ? "(detached)" : git.branch ?? "(detached)")
    : "no git";
  const counters: string[] = [];
  if (git?.available) {
    if (git.ahead > 0) counters.push(T.success(`\u2191${git.ahead}`));
    if (git.behind > 0) counters.push(T.error(`\u2193${git.behind}`));
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
}

/**
 * Footer hints row (normal/search/help modes). While filtering, the footer
 * row area carries the filter bar instead — rendered by the caller
 * (viewer_view.buildFilterBar), mirroring the original live branch.
 */
export function buildFooterRow(innerW: number, view: FooterView): string {
  const T = view.theme;
  const hint = getFooterHint(view.mode, view.focus);
  const left = " " + T.dim(hint);
  let right = "";
  if (view.notice) {
    right = " " + T.warning(view.notice) + " ";
  } else {
    const panes: Array<[Focus, string]> = [
      ["files", "files"],
      ["git", "git"],
      ["viewer", "viewer"],
    ];
    right =
      " " +
      panes.map(([pane, label]) => (view.focus === pane ? T.accent(T.bold(label)) : T.dim(label))).join("  ") +
      " ";
  }
  return joinLeftRight(left, right, innerW);
}