/**
 * pi-navigator shared types.
 *
 * Data contracts mirror plans/pi-navigator-implementation-plan.md section 3.
 * Keep these structural: all consumers (tree, git, viewer, navigator) import
 * from here so the module boundaries stay honest.
 */

// ── Focus and modes ──

export type Focus = "files" | "git" | "viewer";
export type InputMode = "normal" | "filter" | "search" | "help";

// ── Tree ──

/** Raw git status code for a path ("M", "A", "D", "??", ...). */
export type GitCode = string;

export interface FileNode {
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the workspace root, posix separators, "" for the root. */
  relPath: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Hidden when the name starts with a dot. */
  hidden: boolean;
  depth: number;
  expanded: boolean;
  /** Worktree status code when present; index-only changes use the index code. */
  gitCode?: GitCode;
  parent?: FileNode;
  children: FileNode[];
}

export interface TreeRow {
  kind: "dir" | "file";
  node: FileNode;
}

export interface MatchRow {
  kind: "match";
  node: FileNode;
  /** Dimmed parent prefix, e.g. "src/components/". */
  prefix: string;
  /** Position of the query inside the file name, -1 when only the path matched. */
  nameIndex: number;
}

export type FilesRow = TreeRow | MatchRow;

// ── Git ──

export interface GitChangedFile {
  relPath: string;
  code: GitCode;
}

export interface GitCommit {
  shortHash: string;
  dateRel: string;
  subject: string;
}

export interface GitState {
  /** Git binary present AND cwd inside a repository. */
  available: boolean;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  unstaged: GitChangedFile[];
  staged: GitChangedFile[];
  history: GitCommit[];
  /** Human readable state line when available is false. */
  error?: string;
  refreshedAt: number;
}

export type GitRowTone = "warning" | "success" | "muted" | "dim";

export type GitRow =
  | { kind: "group"; label: string; tone: GitRowTone }
  | { kind: "file"; relPath: string; code: GitCode; staged: boolean }
  | { kind: "commit"; commit: GitCommit };

// ── Viewer ──

export type ViewerKind = "empty" | "text" | "truncated" | "binary" | "image" | "error";

export interface ViewerFile {
  kind: ViewerKind;
  relPath: string;
  sizeBytes?: number;
  /** Total line count when below MAX_LINE_COUNT_BYTES. */
  lineCount?: number;
  /** Modification time at load, used for the "changed on disk" notice. */
  mtimeMs?: number;
  /** Highlighted ANSI lines for text kinds. */
  lines: string[];
  /** Notice row rendered above the content (truncation). */
  notice?: string;
  /** Message for binary, image, and error cards. */
  message?: string;
  /** Image tier ladder outcome; reserved for the plan section 8 spike. */
  imageTier?: "metadata" | "native" | "chafa";
}

export interface SearchMatch {
  line: number;
  start: number;
  end: number;
}
