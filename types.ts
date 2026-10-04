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
  /**
   * True only for an untracked-directory record: porcelain reports an
   * entirely untracked directory as a single `?? dir/` record, and
   * `parsePorcelain` strips the trailing-slash marker from `relPath` and
   * records the fact here (Issue #146). Absent on every other record.
   */
  isDir?: boolean;
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

/**
 * What the viewer is showing (Issue #142): a file keyed by its relPath, or a
 * commit keyed by its short hash. The one vocabulary the disk-watch protocol,
 * the reload verb and the "open file" highlight share, so none of them has to
 * parse the `commit:<hash>` display string to recover the fact.
 */
export type OpenTarget =
  | { kind: "file"; relPath: string }
  | { kind: "commit"; hash: string };

/**
 * The scrollbar window for a pane body (Issue #137 §3/§4, moved to the
 * shared types in Issue #148 so frame.ts can draw the border from it without
 * importing viewer_view.ts): where the scrollable content starts relative to
 * the pane body, how many rows the pane draws, and the clamped offset it was
 * drawn at. The header readout and the frame's right-border scrollbar both
 * read this record.
 */
export interface ViewerScrollWindow {
  rowOffset: number;
  count: number;
  scroll: number;
  total: number;
}

export type ViewerKind = "empty" | "text" | "truncated" | "binary" | "image" | "error" | "diff";

/**
 * The per-load outcome of the image pipeline (Issue #143): either the rows a
 * renderer produced — with the renderer named, so the pane never re-derives
 * which one spoke — or the metadata card, carrying the failure that ended the
 * attempt list when there was one. One decision per load: `planImageLoad`
 * orders the eligible renderers, the session binds them to its seams, and
 * `viewer.ts` executes the list (a clean failure continues, a throw or an
 * abort stops it).
 *
 * For a native render, `cols`/`rows` are the REQUESTED geometry, not pi-tui's
 * aspect-fitted result: resize detection compares pane-derived requests, so a
 * fitted height shorter than the pane would otherwise read as a permanent
 * geometry mismatch and reflow every frame. Chafa carries the renderer's
 * returned geometry.
 */
export type ImageVerdict =
  | { kind: "rendered"; renderer: "native" | "chafa"; lines: string[]; cols: number; rows: number }
  | { kind: "card"; failed?: { renderer: "native" | "chafa"; detail: string } };

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
  /** The image pipeline's per-load outcome (Issue #143): rendered rows plus
   *  the renderer that produced them, or the metadata card carrying the
   *  failure that ended the attempt list. Set only with kind "image"; the
   *  rendered rows live on the verdict, so `lines` stays empty. */
  imageVerdict?: ImageVerdict;
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

  /**
   * The plain styling source for a diff view: the commit message and the raw
   * diff lines `lines` were composed from (structural mirror of diff.ts's
   * CommitMessage pair, inlined so this module keeps its dependency-free
   * direction). Retained only for `kind: "diff"` results, so the open diff
   * can be recomposed under a new theme without another `git show`
   * (Issue #141).
   */
  styleDiff?: { message: { subject: string; body: string[] }; lines: string[] };
}

export interface SearchMatch {
  line: number;
  start: number;
  end: number;
}
