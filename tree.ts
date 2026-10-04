/**
 * pi-navigator tree model.
 *
 * Two sources, one builder:
 * - git listing: tracked files plus untracked paths from git status
 * - filesystem walk: async, depth-capped, static ignore list (no .gitignore
 *   parsing in v1; documented follow-up)
 *
 * Both normalize to TreeEntry records so a single builder keeps empty
 * directories and symlink markers. Every filesystem call on this path is async
 * (standards section 4.4: never block the event loop). The module is
 * fs-read-only and otherwise pure, which keeps it unit-testable once Node is
 * available.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { HALF_PAGE_DIVISOR, IGNORED_NAMES, MAX_FS_ENTRIES, MAX_TREE_DEPTH } from "./constants";
import type { FileNode, MatchRow, TreeRow } from "./types";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

// ── Entry collection ──

export interface TreeEntry {
  /** cwd-relative posix path. */
  relPath: string;
  isDir: boolean;
  symlink: boolean;
}

/** Shared total-entry cap for filesystem walks (Issue #108): one budget
 * handed to every concurrent descent — and, in git mode, to every
 * collectDirEntries call — draws them all from a single entry count, so
 * per-call caps can never multiply. `truncated` flips to true only when the
 * cap actually dropped an entry or a descent; a walk finishing naturally at
 * exactly the cap stays false. */
export interface TreeWalkBudget {
  readonly max: number;
  truncated: boolean;
}

// Module-private cumulative counts keyed by budget. The exported budget stays
// {max, truncated}; the hidden counter is what lets several walks drawing on
// one budget respect a single combined cap (Issue #108). Keys are weak, so a
// discarded budget is reclaimed with the walks that used it.
const budgetCounts = new WeakMap<TreeWalkBudget, number>();

export function createTreeWalkBudget(maxEntries: number = MAX_FS_ENTRIES): TreeWalkBudget {
  const budget: TreeWalkBudget = { max: maxEntries, truncated: false };
  budgetCounts.set(budget, 0);
  return budget;
}

/** Issue #108: true once the budget's cumulative count has reached its max;
 * marks the budget truncated. The check and the push that follows are
 * synchronous, so under JS's single thread the combined count can never
 * exceed the cap. */
function budgetHit(budget: TreeWalkBudget): boolean {
  const count = budgetCounts.get(budget) ?? 0;
  if (count < budget.max) return false;
  budget.truncated = true;
  return true;
}

/** Records one pushed entry against the budget (Issue #108). */
function budgetCounted(budget: TreeWalkBudget): void {
  budgetCounts.set(budget, (budgetCounts.get(budget) ?? 0) + 1);
}

/**
 * Entries for one declared directory's subtree, via the same bounded walk as
 * collectFsEntries (depth cap, IGNORED_NAMES, symlink cycle guard, and — when
 * a budget is passed — that budget's total-entry cap). Fills the children of
 * an untracked directory that `git status -unormal` reports as a single
 * `?? dir/` record with no children (Issue #058). The walk starts at the
 * directory's tree depth so the cap matches a root walk exactly; entries
 * stay cwd-relative so the caller can merge them straight into the build.
 * Callers that pass the same budget to several calls share one combined cap
 * (Issue #108); when omitted, the call draws on its own default budget.
 */
export async function collectDirEntries(
  cwd: string,
  relDir: string,
  budget?: TreeWalkBudget,
): Promise<TreeEntry[]> {
  const segments = relDir.split("/").filter(Boolean).length;
  if (segments === 0) return [];
  const walkBudget = budget ?? createTreeWalkBudget();
  const entries: TreeEntry[] = [];
  const visited = new Set<string>();
  try {
    // Same seed as collectFsEntries: a symlink pointing back at the workspace
    // root is refused, not re-walked.
    visited.add(await realpath(cwd));
  } catch {
    // Unreachable root: the per-directory walk failures handle it.
  }
  await walk(join(cwd, relDir), relDir, segments - 1, entries, visited, walkBudget);
  return entries;
}

/**
 * Async filesystem walk. Dot entries are included (flagged hidden at render
 * time) so the "." toggle never requires a re-scan. IGNORED_NAMES directories
 * are skipped entirely. Symlink cycles are refused through a realpath
 * visited-set; the link itself is kept as an entry with symlink: true. The
 * root's realpath seeds the set so a link back to the workspace root itself
 * is refused, not walked. All descents share one total-entry budget (Issue
 * #108): once MAX_FS_ENTRIES entries exist the walk stops, `truncated` is
 * true and the tree is incomplete. `opts.maxEntries` overrides the cap for
 * tests.
 */
export async function collectFsEntries(
  cwd: string,
  opts?: { maxEntries?: number },
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const budget = createTreeWalkBudget(opts?.maxEntries);
  const entries: TreeEntry[] = [];
  const visited = new Set<string>();
  try {
    // Without this seed, a symlink pointing at the workspace root would pass
    // the visited check (the root is never added as a child) and re-walk the
    // whole tree, only stopped by the depth cap.
    visited.add(await realpath(cwd));
  } catch {
    // Unreachable root: the per-directory walk failures handle it.
  }
  await walk(cwd, "", 0, entries, visited, budget);
  return { entries, truncated: budget.truncated };
}

async function walk(
  dirPath: string,
  relDir: string,
  depth: number,
  entries: TreeEntry[],
  visited: Set<string>,
  budget: TreeWalkBudget,
): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  // Collect this level's entries and the subdirectory descents to launch.
  // Descents run concurrently per level (Promise.all) so the walk is no longer
  // serialized one child directory at a time (Issue #023). All `visited` adds
  // happen synchronously here, before any descent starts, so the set is a safe
  // cycle guard under the fan-out. Depth cap and IGNORED_NAMES are unchanged.
  const descents: Promise<void>[] = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (IGNORED_NAMES.has(name)) continue;

    const relPath = relDir ? `${relDir}/${name}` : name;
    const fullPath = join(dirPath, name);
    const symlink = dirent.isSymbolicLink();
    let isDir = dirent.isDirectory();

    if (symlink) {
      try {
        const real = await realpath(fullPath);
        isDir = (await stat(real)).isDirectory();
      } catch {
        // Broken symlink: kept as a leaf entry below the budget check.
        if (budgetHit(budget)) break;
        entries.push({ relPath, isDir: false, symlink: true });
        budgetCounted(budget);
        continue;
      }
    }

    // Issue #108: the shared budget counts every entry across every walk
    // drawing on it; once hit, this level stops — nothing pushed, nothing
    // descended. Check and push are synchronous, so the combined count can
    // never exceed the cap under the concurrent descents.
    if (budgetHit(budget)) break;
    entries.push({ relPath, isDir, symlink });
    budgetCounted(budget);

    if (!isDir) continue;
    if (depth + 1 > MAX_TREE_DEPTH) continue;

    try {
      const real = await realpath(fullPath);
      if (visited.has(real)) continue;
      visited.add(real);
    } catch {
      continue;
    }
    if (budgetHit(budget)) break;
    descents.push(walk(fullPath, relPath, depth + 1, entries, visited, budget));
  }
  await Promise.all(descents);
}

/**
 * Cheap refresh probe for fs mode (plan section 7): the modification times of
 * the currently expanded directories plus the root. Adding, removing or
 * renaming an entry changes the mtime of its parent directory, so the probe
 * detects changes without walking anything. Contents of collapsed directories
 * are deliberately not probed, matching the plan.
 */
export async function collectFsProbe(cwd: string, dirs: Set<string>): Promise<string> {
  const entries = ["", ...dirs];
  const parts = await Promise.all(
    entries.map(async (relDir) => {
      try {
        const info = await stat(join(cwd, relDir));
        return `${relDir}:${Math.floor(info.mtimeMs)}`;
      } catch {
        return `${relDir}:missing`;
      }
    }),
  );
  return parts.join("|");
}

// ── Build ──

function makeNode(
  name: string,
  relPath: string,
  path: string,
  isDir: boolean,
  depth: number,
): FileNode {
  return {
    name,
    lowerName: name.toLowerCase(),
    relPath,
    lowerRelPath: relPath.toLowerCase(),
    path,
    isDir,
    isSymlink: false,
    hidden: name.startsWith("."),
    depth,
    expanded: depth < 1,
    children: [],
    subtreeChanged: false,
  };
}

function sortTree(node: FileNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
  for (const child of node.children) {
    if (child.isDir) sortTree(child);
  }
}

/**
 * Build the tree from normalized entries. Directories missing from the entry
 * list are created on demand; declared directories survive even when empty.
 */
export function buildTree(cwd: string, entries: TreeEntry[], gitCodes: Map<string, string>): FileNode {
  const root = makeNode(".", "", cwd, true, -1);
  root.expanded = true;

  const dirMap = new Map<string, FileNode>([["", root]]);

  const insert = (relPath: string, isDir: boolean, symlink: boolean, gitCode?: string): FileNode | null => {
    const clean = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const parts = clean.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length - 1 > MAX_TREE_DEPTH) return null;

    let current = root;
    let rel = "";

    for (let i = 0; i < parts.length - 1; i++) {
      // i is bounded by parts.length, so parts[i] is always present.
      const part = parts[i]!;
      rel = rel ? `${rel}/${part}` : part;
      let dirNode = dirMap.get(rel);
      if (!dirNode) {
        dirNode = makeNode(part, rel, join(cwd, rel), true, current.depth + 1);
        dirMap.set(rel, dirNode);
        current.children.push(dirNode);
      }
      current = dirNode;
    }

    // parts was checked non-empty above, so the final element exists.
    const name = parts[parts.length - 1]!;
    const fullRel = parts.join("/");
    const existing = dirMap.get(fullRel);
    if (isDir) {
      if (existing) {
        existing.isSymlink = symlink;
        if (gitCode) existing.gitCode = gitCode;
        return existing;
      }
      const dirNode = makeNode(name, fullRel, join(cwd, fullRel), true, current.depth + 1);
      dirNode.isSymlink = symlink;
      dirNode.gitCode = gitCode;
      dirMap.set(fullRel, dirNode);
      current.children.push(dirNode);
      return dirNode;
    }

    if (existing) {
      // A directory already claimed the path; keep it (git may report both).
      if (gitCode) existing.gitCode = gitCode;
      return existing;
    }

    const fileNode = makeNode(name, fullRel, join(cwd, fullRel), false, current.depth + 1);
    fileNode.isSymlink = symlink;
    fileNode.gitCode = gitCode;
    current.children.push(fileNode);
    return fileNode;
  };

  // Directories first so declared-empty directories exist, then files.
  for (const entry of entries) {
    if (!entry.isDir) continue;
    insert(entry.relPath, true, entry.symlink, gitCodes.get(entry.relPath));
  }
  for (const entry of entries) {
    if (entry.isDir) continue;
    insert(entry.relPath, false, entry.symlink, gitCodes.get(entry.relPath));
  }

  sortTree(root);
  recomputeSubtreeChanged(root);
  return root;
}

// ── Git codes ──

/**
 * Stamp worktree/index codes onto an existing tree without rebuilding it.
 * Lives here rather than in the entry module: it is pure tree data, and the
 * entry module's job is orchestration only.
 */
export function applyGitCodes(root: FileNode, codes: Map<string, string>): void {
  walkTree(root, (node) => {
    if (!node.isDir && node.relPath) node.gitCode = codes.get(node.relPath);
  });
  recomputeSubtreeChanged(root);
}

/**
 * Bottom-up recompute of the `subtreeChanged` flag (true when this node or any
 * descendant carries a gitCode). Called after buildTree sorts and after
 * applyGitCodes re-stamps codes, so directory row styling is an O(1) field
 * read instead of a recursive scan per dir row per render (Issue #017).
 */
function recomputeSubtreeChanged(node: FileNode): boolean {
  if (!node.isDir) return (node.subtreeChanged = Boolean(node.gitCode));
  let any = Boolean(node.gitCode);
  for (const child of node.children) {
    if (recomputeSubtreeChanged(child)) any = true;
  }
  node.subtreeChanged = any;
  return any;
}

// ── Traversal ──

/**
 * Action returned by `visit` to control tree traversal:
 * - `false` or `"prune"`: skip descending into this node's children (prune subtree)
 * - `"stop"`: abort the entire traversal immediately
 * - `true` or `void`: continue traversal normally
 */
export type WalkAction = boolean | "prune" | "stop" | void;

/**
 * Depth-first walk over a node and its children. Every traversal in the
 * extension runs through this one walker.
 */
export function walkTree(root: FileNode, visit: (node: FileNode) => WalkAction): void {
  const stack: FileNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    const action = visit(node);
    if (action === "stop") return;
    if (action === false || action === "prune") continue;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child) stack.push(child);
    }
  }
}

// ── Expansion state ──

/**
 * RelPaths of expanded untracked (`??`) directory nodes. The git-mode probe's
 * porcelain signature cannot see entry changes inside an untracked directory
 * (`git status -unormal` reports it as one record no matter its contents), so
 * index.ts folds the mtimes of these subtrees into the probe via
 * collectFsProbe — mirroring fs-mode probing for exactly those subtrees
 * (Issue #058). Contents of collapsed directories are deliberately not
 * probed, matching the plan.
 */
export function expandedUntrackedDirs(root: FileNode | null): Set<string> {
  const dirs = new Set<string>();
  if (!root) return dirs;
  walkTree(root, (node) => {
    if (node.isDir && node.expanded && node.gitCode === "??" && node.relPath) dirs.add(node.relPath);
  });
  return dirs;
}

export function collectExpanded(root: FileNode | null): Set<string> {
  const expanded = new Set<string>();
  if (!root) return expanded;
  walkTree(root, (node) => {
    if (node.isDir && node.expanded && node.relPath) expanded.add(node.relPath);
  });
  return expanded;
}

/**
 * Apply the remembered expansion set to a freshly built tree.
 *
 * `defaultDepth` exists only for the first build after open: pass 0 to expand
 * the top level by default. Later builds pass the default (-1) so the
 * remembered set is honoured exactly, which is what keeps an explicitly
 * collapsed top-level directory collapsed across rebuilds.
 */
export function reapplyExpansion(root: FileNode, expanded: Set<string>, defaultDepth = -1): void {
  walkTree(root, (node) => {
    if (node.isDir && node.relPath) node.expanded = expanded.has(node.relPath) || node.depth <= defaultDepth;
  });
}

// ── Navigation helpers ──

/** Clamp a cursor move into [0, total - 1]. One place for cursor math. */
export function moveCursor(total: number, index: number, delta: number): number {
  return Math.max(0, Math.min(index + delta, Math.max(0, total - 1)));
}

/** Half-page jump for the pane's current height, in rows. */
export function pageJump(total: number, index: number, delta: number, height: number): number {
  const step = Math.max(1, Math.ceil(height / HALF_PAGE_DIVISOR));
  return moveCursor(total, index, delta < 0 ? -step : step);
}

/** The one expansion mutation door (Issue #150): negate when `expanded` is omitted. */
export function setExpanded(node: FileNode, expanded?: boolean): void {
  node.expanded = expanded === undefined ? !node.expanded : expanded;
}

/**
 * Expand every non-root ancestor of `relPath`, walking the path's segments
 * from `root` — root-anchored instead of following the removed `parent`
 * back-pointer (Issue #150): the graph has no upward links, so the anchor is
 * the one node the caller already holds. The node itself (the last segment)
 * is never expanded, matching the old upward-walk semantics; the root's own
 * flag is not set (inert: `buildTree` sets it true and nothing reads it).
 */
export function expandAncestors(root: FileNode, relPath: string): void {
  let current = root;
  for (const part of relPath.split("/").filter(Boolean).slice(0, -1)) {
    const next = current.children.find((child) => child.name === part);
    if (!next) return;
    next.expanded = true;
    current = next;
  }
}

export function hasChanges(node: FileNode): boolean {
  // O(1) field read; the flag is maintained by recomputeSubtreeChanged()
  // during buildTree and applyGitCodes. Kept as a function for call-site
  // readability and so tests exercise the same path the render uses.
  return node.subtreeChanged;
}

/** Visible rows for the files pane (expansion aware, hidden aware). */
export function flattenVisible(root: FileNode, showHidden: boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (parent: FileNode) => {
    for (const child of parent.children) {
      if (!showHidden && child.hidden) continue;
      rows.push({ kind: child.isDir ? "dir" : "file", node: child });
      if (child.isDir && child.expanded) walk(child);
    }
  };
  walk(root);
  return rows;
}

/**
 * Flat fuzzy-ish filter over file paths. Name matches rank above path matches,
 * and the dimmed parent prefix is preserved so results keep context.
 */
export function filterRows(root: FileNode, query: string, showHidden: boolean): MatchRow[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const matches: MatchRow[] = [];

  const walk = (parent: FileNode) => {
    for (const child of parent.children) {
      // Mirror flattenVisible exactly: with showHidden off, a hidden node is
      // skipped outright — including a hidden DIRECTORY, so files under
      // `.github/` never surface through filtering either (Issue #060
      // finding 3). A hidden file matching the query stays hidden too.
      if (!showHidden && child.hidden) continue;
      if (child.isDir) {
        walk(child);
        continue;
      }
      if (!child.lowerRelPath.includes(q)) continue;
      matches.push({
        kind: "match",
        node: child,
        prefix: child.relPath.slice(0, child.relPath.length - child.name.length),
        nameIndex: child.lowerName.indexOf(q),
      });
    }
  };
  walk(root);

  matches.sort((a, b) => {
    const rankA = a.nameIndex >= 0 ? 0 : 1;
    const rankB = b.nameIndex >= 0 ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    return collator.compare(a.node.relPath, b.node.relPath);
  });
  return matches;
}
