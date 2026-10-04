import { type TreeEntry, walkTree } from "../tree";
import type { FileNode } from "../types";

/** Tracked files and untracked paths as tree entries. A trailing slash marks
 * an untracked directory: `git status -unormal` reports an entirely untracked
 * directory as a single `?? dir/` record, so the slash is authoritative —
 * stripped here, no per-entry stat in the hot path (Issue #058). */
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
