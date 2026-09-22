/**
 * Files pane view-model (Issue #064 extraction).
 *
 * Pure builders for the files pane: the row model (buildFilesRows), the
 * header and one file row. NavigatorOverlay keeps the memoization wrapper,
 * the tree state and the cursor; this module renders rows from plain inputs
 * (root, query, hidden, cursor, theme, icon opt-in, open path).
 */

import { visibleWidth } from "@earendil-works/pi-tui";

import type { NavigatorTheme } from "./theme";
import { filterRows, flattenVisible, hasChanges } from "./tree";
import type { FileNode, FilesRow, Focus } from "./types";
import { mapExtensionToIcon } from "./icons";
import { joinLeftRight, padTo, truncateAndWidth } from "./frame";
import { codeText } from "./git_view";

export interface FilesViewContext {
  theme: NavigatorTheme;
  /** Nerd Font icon column opt-in (Issue #028). */
  enableIcons: boolean;
  filterQuery: string;
  /** Path of the file open in the viewer (viewTargetRelPath ?? viewFile?.relPath). */
  openRelPath: string | null;
  /** Cursor row for the header position counter. */
  filesCursor: number;
  focus: Focus;
}

/** Row-model builder: filtered when a query is active, flattened otherwise. */
export function buildFilesRows(root: FileNode | null, query: string, hidden: boolean): FilesRow[] {
  return !root ? [] : query ? filterRows(root, query, hidden) : flattenVisible(root, hidden);
}

export function buildFilesHeader(leftW: number, total: number, ctx: FilesViewContext): string {
  const T = ctx.theme;
  const label = " " + (ctx.focus === "files" ? T.accent(T.bold("FILES")) : T.dim("FILES"));
  const info = ctx.filterQuery
    ? T.warning(`${total} matches`) + " "
    : T.dim(`${Math.max(1, Math.min(ctx.filesCursor + 1, total))}/${total}`) + " ";
  return joinLeftRight(label, info, leftW);
}

export function buildFileRow(row: FilesRow, isCursor: boolean, leftW: number, ctx: FilesViewContext): string {
  const T = ctx.theme;
  const arrow = isCursor ? T.accent(T.bold("\u25b6 ")) : "  ";
  let body: string;
  let badge = "";
  // Icon column (Issue #028): two cells when PI_NAV_ICONS is on — the glyph
  // plus the trailing space icon() emits — and zero otherwise. The glyph
  // inherits the name color it sits next to. iconW is emission-only: the
  // icon lives inside `body`, which truncateAndWidth measures, so reserving
  // extra cells in room/gap below would double-count it and truncate names
  // one cell early (Issue #060 finding 6).
  const iconW = ctx.enableIcons ? 2 : 0;
  const icon = (nameStyle: (t: string) => string) =>
    iconW ? nameStyle(mapExtensionToIcon(row.node.relPath, row.node.isDir)) + " " : "";

  if (row.kind === "match") {
    const prefixRaw = row.prefix.length > 18 ? "\u2026" + row.prefix.slice(-18) : row.prefix;
    const prefix = T.dim(prefixRaw);
    const name = row.node.name;
    if (row.nameIndex >= 0 && ctx.filterQuery) {
      const before = name.slice(0, row.nameIndex);
      const hit = name.slice(row.nameIndex, row.nameIndex + ctx.filterQuery.length);
      const after = name.slice(row.nameIndex + ctx.filterQuery.length);
      body = icon(T.dim) + prefix + T.text(before) + T.warning(T.bold(hit)) + T.text(after);
    } else {
      body = icon(T.dim) + prefix + T.text(name);
    }
    if (row.node.gitCode) badge = " " + codeText(row.node.gitCode, T);
  } else if (row.node.isDir) {
    const marker = row.node.expanded ? "\u25be " : "\u25b8 ";
    const indent = "  ".repeat(Math.max(0, row.node.depth));
    const nameStyle = hasChanges(row.node) ? T.warning : row.node.hidden ? T.dim : T.muted;
    const label = row.node.name + (row.node.isSymlink ? T.dim(" \u2197") : "");
    // Issue #031: icon sits after the indent so it moves with depth and
    // stays glued to the marker/name it belongs to, instead of floating at
    // a fixed left column that desynchronizes from the indented label.
    body = T.dim(indent) + icon(nameStyle) + T.dim(marker) + nameStyle(label);
  } else {
    const indent = "  ".repeat(Math.max(0, row.node.depth));
    const isOpen = row.node.relPath === ctx.openRelPath;
    let nameStyle = (text: string) => T.text(text);
    if (isOpen) nameStyle = (text: string) => T.accent(T.bold(text));
    else if (row.node.hidden) nameStyle = (text: string) => T.dim(text);
    else if (row.node.gitCode === "??" || row.node.gitCode === "!!") nameStyle = (text: string) => T.dim(text);
    const label = row.node.name + (row.node.isSymlink ? T.dim(" \u2197") : "");
    // Issue #031: same depth-glued icon placement as the dir branch above.
    body = T.dim(indent) + icon(nameStyle) + nameStyle(label);
    if (row.node.gitCode) badge = " " + codeText(row.node.gitCode, T);
  }

  const room = Math.max(4, leftW - 2 - visibleWidth(badge));
  // Truncate once, measure the result once; hardTruncate never injects an
  // ellipsis (Issue #018, #010).
  const fit = truncateAndWidth(body, room);
  const content = arrow + fit.text;
  const gap = Math.max(0, leftW - visibleWidth(arrow) - fit.width - visibleWidth(badge));
  const line = content + " ".repeat(gap) + badge;
  return isCursor ? T.selectedBg(padTo(line, leftW)) : padTo(line, leftW);
}