import { type TreeEntry, walkTree } from "../tree";
import type { FileNode } from "../types";

/** Tracked files and untracked paths as tree entries. A trailing slash marks
 * an untracked directory: `git status -unormal` reports an entirely untracked
 * directory as a single `?? dir/` record, so the slash is authoritative —
 * stripped here, no per-entry stat in the hot path (Issue #058).
 *
 * Deliberately raw (Issue #198): `symlink` is always false and paths are not
 * normalized or deduped — `buildTree` owns separator/`./` canonicalization,
 * depth capping and dedup, and tests feed unnormalized paths through here on
 * purpose (tree.test.ts's `a\b.txt` / `./c.txt` case); normalizing in the
 * fixture would delete that coverage. Symlink cases build their entries
 * inline. */
export function entriesFromPaths(paths: string[]): TreeEntry[] {
  return paths.map((relPath) => {
    const isDir = relPath.endsWith("/");
    return { relPath: isDir ? relPath.slice(0, -1) : relPath, isDir, symlink: false };
  });
}

export function findNode(root: FileNode, relPath: string): FileNode | null {
  if (relPath === "") return root;
  let found: FileNode | null = null;
  walkTree(root, (node) => {
    if (node.relPath === relPath) {
      found = node;
      return "stop";
    }
  });
  return found;
}
