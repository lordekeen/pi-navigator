/**
 * Overlay layout math (Issue #148 split out of frame.ts).
 *
 * Navigator-only geometry: overlay height, the left-column gates, the pane
 * split and the layout derivations. Every export is a pure function of
 * `constants.ts` + `types.ts` inputs — no theme, no width measurement, no
 * viewer imports — so the composition/chrome side of the frame (frame.ts)
 * and its consumers never pull this geometry in by accident.
 */

import {
  GIT_MIN_ROWS,
  LEFT_COLUMN_HIDE_BELOW,
  LEFT_COLUMN_MAX,
  LEFT_COLUMN_MIN,
  LEFT_COLUMN_RATIO,
  OVERLAY_HEIGHT_RATIO,
  OVERLAY_MARGIN_ROWS,
} from "./constants";
import type { Focus, NavigatorLayout } from "./types";

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

/**
 * The data rows a pane group of `groupHeight` draws: the group's header takes
 * one of them (Issue #147). One expression for render and input — the render
 * path applies it to the heights it already holds (`heights.filesH`,
 * `heights.gitH`, the body) and the area helpers below delegate to it, so no
 * render/input floor can disagree. Floored at 1 because a pane never draws
 * fewer than one row; every group a real (non-compact) frame draws is at
 * least 3 rows tall, so the floor is a guard, not a visible value.
 */
export function paneArea(groupHeight: number): number {
  return Math.max(1, groupHeight - 1);
}

/** Files-pane scroll area height for the current terminal size and layout
 *  (Issue #119, D5): the explicit layout parameter keeps a missed call site
 *  from silently computing the default layout's split. Delegates to the one
 *  pane-area expression (Issue #147). */
export function filesArea(termRows: number, layout: NavigatorLayout): number {
  const body = bodyRows(overlayHeight(termRows));
  return paneArea(layoutRows(body, layout).filesH);
}

/** Git-pane scroll area height for the current terminal size and layout
 *  (Issue #127): the git pane's paging step needs the same figure the render
 *  path computes, so it is derived here rather than duplicated at the call
 *  site. Mirrors `filesArea` (Issue #147). */
export function gitArea(termRows: number, layout: NavigatorLayout): number {
  const body = bodyRows(overlayHeight(termRows));
  return paneArea(layoutRows(body, layout).gitH);
}

/** Viewer-pane content area height for the current terminal size (Issue
 *  #147: the same `paneArea` expression the render path applies to the body). */
export function viewerArea(termRows: number): number {
  return paneArea(bodyRows(overlayHeight(termRows)));
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
