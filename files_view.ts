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
  /** Path of the file open in the viewer (the in-flight target's string
   *  projection, then viewFile's relPath; Issue #142). */
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
  let info: string;
  if (ctx.filterQuery) {
    info = T.warning(total === 1 ? "1 match" : `${total} matches`) + " ";
  } else if (total > 0) {
    info = T.dim(`${Math.min(ctx.filesCursor + 1, total)}/${total}`) + " ";
  } else {
    // Issue #129: a zero-entry tree hides the position counter instead of
    // rendering "1/0" — the old Math.max(1, …) guard floored the numerator
    // while the denominator could still be zero. With no entries there is no
    // position to report, and the numerator can never exceed the denominator.
    info = "";
  }
  return joinLeftRight(label, info, leftW);
}

/**
 * The placeholder row an empty tree gets instead of a blank pane (Issue #129).
 *
 * The reason is the point: a filter matching nothing is a different state from
 * a tree with no entries, and saying which one it is keeps the row explanatory
 * rather than decorative.
 *
 * Deliberately NOT part of the row model: as a model row it would be counted by
 * `buildFilesHeader`'s numerator/denominator (an empty tree would read "1/1"),
 * need a new `FilesRow` variant, and force a decision about whether the cursor
 * may land on it. As presentation it changes neither the counts nor the cursor
 * math, and the pane's row budget stays exactly as it was.
 */
export function filesEmptyRow(leftW: number, ctx: FilesViewContext): string {
  const T = ctx.theme;
  const reason = ctx.filterQuery !== "" ? `no matches for "${ctx.filterQuery}"` : "no files";
  return padTo(" " + T.dim(reason), leftW);
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
    const changed = hasChanges(row.node);
    const nameStyle = changed ? T.warning : row.node.hidden ? T.dim : T.muted;
    const label = row.node.name + (row.node.isSymlink ? T.dim(" \u2197") : "");
    // Issue #031: icon sits after the indent so it moves with depth and
    // stays glued to the marker/name it belongs to, instead of floating at
    // a fixed left column that desynchronizes from the indented label.
    body = T.dim(indent) + icon(nameStyle) + T.dim(marker) + nameStyle(label);
    // Issue #128: "contains changes" must not ride on colour alone (host UI
    // invariant 4). The `•` in the right-aligned badge cell file rows reserve
    // for git codes is the twin; the warning tone above is reinforcement, not
    // the carrier. Chosen over a suffix or an arrow change because (a) it
    // occupies the already-reserved badge cell, so columns never shift, (b)
    // it is punctuation, never a letter, so it cannot be misread as an
    // M/A/D/R/C/?/! status code, and (c) unlike a name suffix it is not glued
    // to the truncatable label — the badge is appended after the body budget
    // is computed, so the NAME loses cells first and the whole `•` survives at
    // every real pane width (>= LEFT_COLUMN_MIN 24). It is distinct from the
    // ▸/▾ disclosure arrow, which stays glued to the indent, and needs no
    // Nerd Font, so it renders in monochrome and with icons off alike. Only
    // below unreachable widths (< 8 cells) would padTo's hard cut drop it,
    // glyph-whole, never a partial marker.
    if (changed) badge = " " + T.warning("\u2022");
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
