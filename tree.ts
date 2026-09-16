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

import { HALF_PAGE_DIVISOR, IGNORED_NAMES, MAX_TREE_DEPTH } from "./constants";
import type { FileNode, MatchRow, TreeRow } from "./types";

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

// ── Entry collection ──

export interface TreeEntry {
  /** cwd-relative posix path. */
  relPath: string;
  isDir: boolean;
  symlink: boolean;
}

/** Tracked files and untracked paths as plain file entries. */
export function entriesFromPaths(paths: string[]): TreeEntry[] {
  return paths.map((relPath) => ({ relPath, isDir: false, symlink: false }));
}

/**
 * Async filesystem walk. Dot entries are included (flagged hidden at render
 * time) so the "." toggle never requires a re-scan. IGNORED_NAMES directories
 * are skipped entirely. Symlink cycles are refused through a realpath
 * visited-set; the link itself is kept as an entry with symlink: true. The
 * root's realpath seeds the set so a link back to the workspace root itself
 * is refused, not walked.
 */
export async function collectFsEntries(cwd: string): Promise<TreeEntry[]> {
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
  await walk(cwd, "", 0, entries, visited);
  return entries;
}

async function walk(
  dirPath: string,
  relDir: string,
  depth: number,
  entries: TreeEntry[],
  visited: Set<string>,
): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

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
        entries.push({ relPath, isDir: false, symlink: true });
        continue;
      }
    }

    entries.push({ relPath, isDir, symlink });

    if (!isDir) continue;
    if (depth + 1 > MAX_TREE_DEPTH) continue;

    try {
      const real = await realpath(fullPath);
      if (visited.has(real)) continue;
      visited.add(real);
    } catch {
      continue;
    }
    await walk(fullPath, relPath, depth + 1, entries, visited);
  }
}

/**
 * Cheap refresh probe for fs mode (plan section 7): the modification times of
 * the currently expanded directories plus the root. Adding, removing or
 * renaming an entry changes the mtime of its parent directory, so the probe
 * detects changes without walking anything. Contents of collapsed directories
 * are deliberately not probed, matching the plan.
 */
export async function collectFsProbe(cwd: string, dirs: Set<string>): Promise<string> {
  const parts: string[] = [];
  for (const relDir of ["", ...dirs]) {
    try {
      const info = await stat(join(cwd, relDir));
      parts.push(`${relDir}:${Math.floor(info.mtimeMs)}`);
    } catch {
      parts.push(`${relDir}:missing`);
    }
  }
  return parts.join("|");
}

// ── Build ──

function makeNode(
  name: string,
  relPath: string,
  path: string,
  isDir: boolean,
  depth: number,
  parent: FileNode | null,
): FileNode {
  return {
    name,
    relPath,
    path,
    isDir,
    isSymlink: false,
    hidden: name.startsWith("."),
    depth,
    expanded: depth < 1,
    parent: parent ?? undefined,
    children: [],
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
  const root = makeNode(".", "", cwd, true, -1, null);
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
        dirNode = makeNode(part, rel, join(cwd, rel), true, current.depth + 1, current);
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
      const dirNode = makeNode(name, fullRel, join(cwd, fullRel), true, current.depth + 1, current);
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

    const fileNode = makeNode(name, fullRel, join(cwd, fullRel), false, current.depth + 1, current);
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
}

// ── Traversal ──

/**
 * Depth-first walk over a node and its children. Return false from `visit` to
 * stop early. Every traversal in the extension runs through this one walker.
 */
export function walkTree(root: FileNode, visit: (node: FileNode) => boolean | void): void {
  const stack: FileNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (visit(node) === false) return;
    for (const child of node.children) stack.push(child);
  }
}

// ── Expansion state ──

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

export function expandAncestors(node: FileNode): void {
  let current: FileNode | undefined = node.parent;
  while (current) {
    current.expanded = true;
    current = current.parent;
  }
}

export function findNode(root: FileNode, relPath: string): FileNode | null {
  if (relPath === "") return root;
  let found: FileNode | null = null;
  walkTree(root, (node) => {
    for (const child of node.children) {
      if (child.relPath === relPath) {
        found = child;
        return false;
      }
    }
  });
  return found;
}

export function hasChanges(node: FileNode): boolean {
  if (node.gitCode) return true;
  return node.children.some(hasChanges);
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
      if (child.isDir) {
        walk(child);
        continue;
      }
      if (!showHidden && child.hidden) continue;
      const lowerPath = child.relPath.toLowerCase();
      if (!lowerPath.includes(q)) continue;
      matches.push({
        kind: "match",
        node: child,
        prefix: child.relPath.slice(0, child.relPath.length - child.name.length),
        nameIndex: child.name.toLowerCase().indexOf(q),
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
