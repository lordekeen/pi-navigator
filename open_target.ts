/**
 * The open-target vocabulary (Issue #172): the displayed viewer target as a
 * typed identity — a file path or a commit hash — plus its string projection
 * and structural equality. Consumed by the overlay and the session so they
 * can compare displayed targets without importing each other (Issue #144).
 */

import type { OpenTarget, ViewerFile } from "./types";

/**
 * The typed open target of a displayed ViewerFile (Issue #142): the diff kind
 * or a stamped commitHash makes it a commit target; everything else is a file
 * target keyed by its display relPath. Null while nothing is displayed, and
 * defensive null for a commit-kind file that carries no hash (it cannot be
 * addressed).
 */
export function targetOf(file: ViewerFile | null): OpenTarget | null {
  if (file === null) return null;
  if (file.kind === "diff" || file.commitHash !== undefined) {
    return file.commitHash === undefined ? null : { kind: "commit", hash: file.commitHash };
  }
  return { kind: "file", relPath: file.relPath };
}

/**
 * The string projection of a target for the consumers that still speak
 * paths: `commit:<hash>` stays the commit display/cache identity (Issue #142
 * decision 6), and a file target is its relPath.
 */
export function targetPath(target: OpenTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "commit" ? `commit:${target.hash}` : target.relPath;
}

/** Structural identity of two targets (Issue #142); null matches nothing. */
export function sameTarget(a: OpenTarget | null, b: OpenTarget | null): boolean {
  if (a === null || b === null) return false;
  if (a.kind === "file" && b.kind === "file") return a.relPath === b.relPath;
  if (a.kind === "commit" && b.kind === "commit") return a.hash === b.hash;
  return false;
}
