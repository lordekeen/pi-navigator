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

/**
 * The closed overlay-layout union (Issue #119, D1). Single source for the
 * layout type, the settings `layout.default` options, and router validation:
 * `files-git-viewer` is today's split (files pane + git panel + viewer);
 * `files-viewer` / `git-viewer` give the surviving left-column pane the full
 * body height with no separator row.
 */
export const NAVIGATOR_LAYOUTS = ["files-git-viewer", "files-viewer", "git-viewer"] as const;
export type NavigatorLayout = (typeof NAVIGATOR_LAYOUTS)[number];

// ── Tree ──

/** Raw git status code for a path ("M", "A", "D", "??", ...). */
export type GitCode = string;

export interface FileNode {
  name: string;
  /** Lowercased `name`, precomputed for filter matching. */
  lowerName: string;
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the workspace root, posix separators, "" for the root. */
  relPath: string;
  /** Lowercased `relPath`, precomputed for filter matching. */
  lowerRelPath: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Hidden when the name starts with a dot. */
  hidden: boolean;
  depth: number;
  expanded: boolean;
  /** Worktree status code when present; index-only changes use the index code. */
  gitCode?: GitCode;
  /** True when this node or any descendant carries a gitCode. Set during tree
   *  build and recomputed in applyGitCodes so directory row styling is O(1). */
  subtreeChanged: boolean;
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
  /** Short hashes of the parent(s); empty for a root commit. */
  parents?: string[];
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
  /**
   * Human readable state line when the repo is unavailable, or when it is
   * available but the change list could not be read (e.g. git status failed).
   */
  error?: string;
  refreshedAt: number;
}

export type GitRowTone = "warning" | "success" | "muted" | "dim";

export type GitRow =
  | { kind: "group"; label: string; tone: GitRowTone }
  | { kind: "file"; relPath: string; code: GitCode; staged: boolean }
  | { kind: "commit"; commit: GitCommit }
  | { kind: "commit-child"; commit: GitCommit; depth: number };

// ── Viewer ──

export type ViewerKind = "empty" | "text" | "truncated" | "binary" | "image" | "error" | "diff";

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
  /** Image tier ladder outcome: metadata card, chafa symbol art, or (reserved)
   *  native protocol blocks. */
  imageTier?: "metadata" | "native" | "chafa";
  /** chafa-rendered ANSI rows; set only with kind "image" and imageTier
   *  "chafa" after sanitizeChafaPayload succeeded. `lines` stays empty. */
  imageLines?: string[];
  /** Geometry the chafa rows were rendered at (header badge + resize detect). */
  imageCols?: number;
  imageRows?: number;
  /** Bounded chafa failure reason for the fallback card's hint row. */
  imageError?: string;
  /** Diff-only: short hash the diff is for (v3 commit detail view). */
  commitHash?: string;
  /** Diff-only: parent short hashes, for the notice line. */
  parents?: string[];

  /**
   * Unexpanded, CR-normalized source text for alternative renderers
   * (e.g. rendered Markdown). Retained only for markdown files of kind
   * "text" or "truncated". Undefined for diff, binary, image, error, and
   * non-markdown source files.
   */
  rawText?: string;

  /**
   * The exact pre-highlight text that produced `lines` (post CR-normalization
   * and tab expansion; the capped head for truncated views). Retained only for
   * text/truncated results that were actually highlighted (a known language);
   * the unknown-language fallback is a theme-independent plain split, so there
   * is nothing to restyle. Lets `restyleViewerFile` re-highlight under a new
   * theme without re-reading the file (Issue #136).
   */
  styleText?: string;
  /** The `makeStyleKey` value `lines` were highlighted under (Issue #136). */
  styleKey?: string;
}

export interface SearchMatch {
  line: number;
  start: number;
  end: number;
}
