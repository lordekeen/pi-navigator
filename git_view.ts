/**
 * Git pane view-model (Issue #064 extraction).
 *
 * Pure builders for the git panel: the row model (buildGitRows /
 * buildGitNavRows), the header, one row, the commit expand/collapse marker
 * and the status-code text style. NavigatorOverlay keeps the memoization
 * wrappers, the gitExpanded set and the gitTreeVersion counter; this module
 * derives rows from plain `git` + `expanded` input.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

import { FAMILY_MAX_ROWS } from "./constants";
import type { NavigatorTheme } from "./theme";
import type { Focus, GitCommit, GitRow, GitState } from "./types";
import { hardTruncate } from "./viewer";
import { joinLeftRight, padTo, truncateAndWidth } from "./frame";

/**
 * Build the git pane row model for a git state + expansion set. Group rows
 * render only when their list is non-empty (Issue #029); clean state shows a
 * dim Clean row; expanded commit families nest one level at a time (v3).
 */
export function buildGitRows(git: GitState | null, expanded: ReadonlySet<string>): GitRow[] {
  const rows: GitRow[] = [];
  if (!git || !git.available) {
    rows.push({ kind: "group", label: git?.error ?? "git unavailable", tone: "dim" });
    return rows;
  }
  if (git.unstaged.length > 0) {
    rows.push({
      kind: "group",
      label: `Unstaged (${git.unstaged.length})`,
      tone: "warning",
    });
    for (const file of git.unstaged) rows.push({ kind: "file", relPath: file.relPath, code: file.code, staged: false });
  }
  if (git.staged.length > 0) {
    rows.push({
      kind: "group",
      label: `Staged (${git.staged.length})`,
      tone: "success",
    });
    for (const file of git.staged) rows.push({ kind: "file", relPath: file.relPath, code: file.code, staged: true });
  }
  if (git.unstaged.length === 0 && git.staged.length === 0) {
    // A failed status read swaps the Clean row for the error so an
    // unreadable change list never masquerades as a clean tree (Issue #107).
    if (git.error) {
      rows.push({ kind: "group", label: git.error, tone: "warning" });
    } else {
      // Plan section 5 item 5: a dim Clean row when both lists are empty.
      rows.push({ kind: "group", label: "Clean \u2014 nothing staged or unstaged", tone: "dim" });
    }
  }
  // Build the ancestor family for every expanded commit (v3, one level per
  // expand). Unlike the v2 deep DFS, each expanded commit emits only its
  // *direct* parents as commit-child rows (depth = anchor depth + 1); a
  // parent becomes an anchor only when the user expands it in turn, so the
  // tree grows one level at a time and FAMILY_MAX_DEPTH becomes a ceiling
  // (surfaced as a notice) instead of a silent cut. A commit that is both a
  // top-level history entry and an ancestor of an expanded commit
  // intentionally appears twice — once flat in history, once nested under
  // its descendant — which mirrors a file tree where the same node can show
  // under multiple expanded parents.
  const familyByAnchor = new Map<string, GitRow[]>();
  if (expanded.size > 0) {
    const byHash = new Map<string, GitCommit>();
    for (const commit of git.history) byHash.set(commit.shortHash, commit);
    // commitDepth: at what indent does a commit's row render? Computed by a
    // walk over the *current* expand/collapse state, never incrementally:
    // a top-level history commit is depth 0; a commit that is listed as a
    // direct parent of an expanded anchor renders one deeper than that
    // anchor, chained through nested expansions. The newest expanded anchor
    // (history order) that lists the hash is the one the added-set dedup
    // claims it for, so the walk picks the same anchor: depth = the anchor's
    // own depth + 1. Recomputing from `expanded` on every cache miss means
    // collapsing a chain correctly *resets* the depths (no stale indents).
    const memo = new Map<string, number>();
    const commitDepth = (hash: string): number => {
      const cached = memo.get(hash);
      if (cached !== undefined) return cached;
      for (const anchor of git.history) {
        if (expanded.has(anchor.shortHash) && (anchor.parents ?? []).includes(hash)) {
          const depth = commitDepth(anchor.shortHash) + 1;
          memo.set(hash, depth);
          return depth;
        }
      }
      memo.set(hash, 0);
      return 0;
    };
    const added = new Set<string>();
    let count = 0;
    for (const commit of git.history) {
      if (count >= FAMILY_MAX_ROWS) break;
      if (!expanded.has(commit.shortHash)) continue;
      const depth = commitDepth(commit.shortHash) + 1;
      const out: GitRow[] = [];
      let capped = false;
      for (const parentHash of commit.parents ?? []) {
        if (count >= FAMILY_MAX_ROWS) {
          capped = true;
          break;
        }
        const parent = byHash.get(parentHash);
        if (!parent || added.has(parent.shortHash)) continue;
        added.add(parent.shortHash);
        count += 1;
        out.push({ kind: "commit-child", commit: parent, depth });
      }
      // v3: no silent cut. When the global breadth cap ends the walk
      // mid-anchor, signal it with a dim hint row (skipped by the cursor).
      if (capped && out.length > 0) {
        out.push({
          kind: "group",
          label: "\u2026 more ancestors (narrow the view or collapse a branch)",
          tone: "dim",
        });
      }
      if (out.length > 0) familyByAnchor.set(commit.shortHash, out);
    }
  }
  rows.push({ kind: "group", label: `History (${git.history.length})`, tone: "muted" });
  for (const commit of git.history) {
    rows.push({ kind: "commit", commit });
    // Emit the whole family block once, directly under its expanded anchor.
    const family = familyByAnchor.get(commit.shortHash);
    if (family) rows.push(...family);
  }
  return rows;
}

/** Cursor-navigable rows: everything except group/header rows. */
export function buildGitNavRows(rows: GitRow[]): GitRow[] {
  return rows.filter((row) => row.kind !== "group");
}

export interface GitHeaderView {
  theme: NavigatorTheme;
  focus: Focus;
  git: GitState | null;
  treeSource: "git" | "fs" | null;
  /**
   * Position indicator inputs (L3). The header cannot derive these from `git`:
   * the row model depends on which commit families are expanded, and overflow
   * depends on the terminal. `gitCursorIndex` is 0-based over the *navigable*
   * rows (group rows are not selectable), so it matches what j/k traverses.
   */
  gitCursorIndex: number;
  gitNavCount: number;
  gitAreaRows: number;
}

export function buildGitHeader(leftW: number, view: GitHeaderView): string {
  const T = view.theme;
  const label = " " + (view.focus === "git" ? T.accent(T.bold("GIT")) : T.dim("GIT"));
  const git = view.git;
  let info = "";
  if (git?.available) {
    // A failed status read surfaces the error instead of a bogus
    // "0 unstaged · 0 staged" counter (Issue #107). T.dim is fine; the
    // error row itself already carries the warning tone.
    if (git.error) {
      info = T.dim(git.error) + " ";
    } else {
      info = T.dim(`${git.unstaged.length} unstaged \u00b7 ${git.staged.length} staged`) + " ";
      // Plan section 7: when the tree came from the filesystem walk (empty
      // repository fallback), the panel says so instead of implying git mode.
      if (view.treeSource === "fs") info = T.dim("fs walk") + " ";
    }
  } else {
    info = T.dim(git?.error ?? "unavailable") + " ";
  }
  // L3 (audit §Low): a git list that overflows its pane says where the cursor
  // is, matching the files header's N/M. Two deliberate limits: only on
  // overflow (a list that fits needs no position), and only when it fits beside
  // the label — joinLeftRight truncates the LEFT side to make room, and pane
  // labels must never be what gets cut (the Issue #113 class).
  if (view.gitNavCount > view.gitAreaRows) {
    const counter = T.dim(`${Math.min(view.gitCursorIndex + 1, view.gitNavCount)}/${view.gitNavCount}`) + " ";
    if (visibleWidth(label) + visibleWidth(info) + visibleWidth(counter) <= leftW) info += counter;
  }
  return joinLeftRight(label, info, leftW);
}

export interface GitRowView {
  theme: NavigatorTheme;
  /** Set of shortHashes whose family is expanded. */
  expanded: ReadonlySet<string>;
}

export function buildGitRow(row: GitRow, selected: boolean, leftW: number, view: GitRowView): string {
  const T = view.theme;
  let line: string;
  if (row.kind === "group") {
    const tone =
      row.tone === "warning"
        ? T.warning
        : row.tone === "success"
          ? T.success
          : row.tone === "dim"
            ? T.dim
            : T.muted;
    // Issue #113: cut the plain label to the pane *before* styling — one
    // cell for the leading space, the rest for the label. Truncating styled
    // text afterwards would wrap the ellipsis in tone's reset (Issue #010);
    // cutting plain text first keeps the ellipsis inside the styled span.
    const room = Math.max(1, leftW - 1);
    let label = row.label;
    if (visibleWidth(label) > room) {
      label = hardTruncate(label, Math.max(1, room - 1)) + "\u2026";
    }
    line = " " + tone(label);
  } else if (row.kind === "file") {
    const arrow = selected ? T.accent(T.bold("\u25b6 ")) : "  ";
    const nameStyle = selected ? T.text : row.staged ? T.success : T.warning;
    const badge = " " + codeText(row.code, T);
    const room = Math.max(4, leftW - 2 - visibleWidth(badge));
    const fit = truncateAndWidth(nameStyle(row.relPath), room);
    const gap = Math.max(0, leftW - 2 - fit.width - visibleWidth(badge));
    line = arrow + fit.text + " ".repeat(gap) + badge;
  } else if (row.kind === "commit-child") {
    const arrow = selected ? T.accent(T.bold("\u25b6 ")) : "  ";
    const marker = commitMarker(row.commit, view.expanded);
    const hash = T.muted(row.commit.shortHash);
    const indentW = 2 * row.depth;
    // Width accounting: arrow(2) + indent(2·depth) + marker(2) + hash + sep(2).
    const room = Math.max(4, leftW - 2 - indentW - 2 - visibleWidth(row.commit.shortHash) - 2);
    // L5 (audit §Low): the subject is the row's primary content — the text
    // step — while the hash stays muted as secondary metadata; dim is for
    // chrome and hints, not content.
    const subject = T.text(hardTruncate(row.commit.subject, room));
    line = arrow + "  ".repeat(row.depth) + marker + hash + "  " + subject;
  } else {
    const arrow = selected ? T.accent(T.bold("\u25b6 ")) : "  ";
    const marker = commitMarker(row.commit, view.expanded);
    const hash = T.muted(row.commit.shortHash);
    // Width accounting: arrow(2) + marker(2) + hash + sep(2).
    const room = Math.max(4, leftW - 2 - 2 - visibleWidth(row.commit.shortHash) - 2);
    // L5: same content/metadata hierarchy as the nested commit-child row.
    const subject = T.text(hardTruncate(row.commit.subject, room));
    line = arrow + marker + hash + "  " + subject;
  }
  return selected ? T.selectedBg(padTo(line, leftW)) : padTo(line, leftW);
}

/**
 * v3 expand/collapse marker for a commit row, mirroring the file pane's dir
 * marker: ▾ when the family is expanded, ▸ when it has in-history parents to
 * reveal, blank for a root (nothing to expand). Marker glyph + space = 2
 * visible cells, same as the dir marker. A root commit gets no marker so the
 * hash column stays aligned with rows that have one.
 */
export function commitMarker(commit: GitCommit, expanded: ReadonlySet<string>): string {
  const hasParents = (commit.parents?.length ?? 0) > 0;
  if (!hasParents) return "  ";
  return expanded.has(commit.shortHash) ? "\u25be " : "\u25b8 "; // ▾ / ▸
}

export function codeText(code: string, theme: NavigatorTheme): string {
  const T = theme;
  if (code === "M") return T.warning(code);
  if (code === "A") return T.success(code);
  if (code === "D") return T.error(code);
  if (code === "R") return T.warning(code);
  if (code === "C") return T.success(code);
  if (code === "??") return T.dim("?");
  if (code === "!!") return T.dim("!");
  return T.muted(code);
}
