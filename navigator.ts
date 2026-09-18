/**
 * pi-navigator overlay component.
 *
 * Composes the frame, the files pane, the git panel, the viewer pane, the
 * footer and the help modal. Implements the locked keymap from
 * plans/pi-navigator-implementation-plan.md section 4.
 *
 * All data arrives through setters that follow the plan section 3.6 contract
 * (setTree / setGitState); the viewer's state is installed by openRelPath(),
 * which owns its async load. This class owns UI state only and never touches
 * the filesystem or git directly — the render path stays pure and the async
 * work stays in index.ts.
 */

import { copyToClipboard, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from "@earendil-works/pi-tui";

import {
  FAMILY_MAX_DEPTH,
  FAMILY_MAX_ROWS,
  GIT_MIN_ROWS,
  HALF_PAGE_DIVISOR,
  LEFT_COLUMN_HIDE_BELOW,
  LEFT_COLUMN_MAX,
  LEFT_COLUMN_MIN,
  LEFT_COLUMN_RATIO,
  MIN_OVERLAY_HEIGHT,
  MIN_OVERLAY_WIDTH,
} from "./constants";
import { mapExtensionToIcon } from "./icons";
import { expandAncestors, filterRows, findNode, flattenVisible, hasChanges, moveCursor, pageJump } from "./tree";
import type { NavigatorTheme } from "./theme";
import type { FileNode, FilesRow, Focus, GitCommit, GitRow, GitState, InputMode, SearchMatch, ViewerFile } from "./types";
import { computeRows, formatSize, isMarkdownPath, markMatches, maxLineWidth, searchLines, type DisplayRow } from "./viewer";

/**
 * Truncate a (possibly styled) string to a visible width and return both the
 * truncated text and its visible width. Sites that need to truncate and then
 * pad to a column previously called `truncateToWidth` and a separate
 * `visibleWidth` on the result — two char-by-char scans of the same string.
 * This collapses them into one named operation (Issue #018). The empty
 * ellipsis matches the hard-cut convention used across the overlay; pi-tui's
 * `visibleWidth` caches repeated measurements, so the single `visibleWidth`
 * here is cheap and the result width is exact.
 */
function truncateAndWidth(text: string, maxWidth: number): { text: string; width: number } {
  const out = truncateToWidth(text, maxWidth, "");
  return { text: out, width: visibleWidth(out) };
}

export interface NavigatorOptions {
  cwd: string;
  theme: NavigatorTheme;
  getTerminalRows: () => number;
  requestRender: () => void;
  onClose: () => void;
  loadFile: (relPath: string) => Promise<ViewerFile>;
  /** v3: open a commit's diff in the viewer. Optional — when absent, Enter on
   *  a commit falls back to toggling its family (keeps harnesses green). */
  loadCommit?: (shortHash: string) => Promise<ViewerFile>;
  refresh: () => void;
  /** Opt into the Nerd Font icon column (Issue #028). Defaults to false. */
  enableIcons?: boolean;
  /** Home directory for tilde shortening (Issue #039). Defaults to empty string. */
  home?: string;
}

const FOCUS_HINTS: Record<Focus, string> = {
  // Width budget: the longest hint plus the pane labels must fit the inner
  // width at a 100-column terminal (98) so the focus indicator never gets
  // truncated off the footer (render test enforces this at 120, 100, 80).
  files: "j k move  Enter open  Tab  / filter  . hidden  y copy  ? help  q close",
  git: "j k move  Enter open file / diff  l h family  g G jump  Tab  y copy  ? help  q close",
  viewer: "j k scroll  Ctrl+d/u  w wrap  m mode  / search  n N  Tab  ? help  q close",
};

const MODE_HINTS: Record<Exclude<InputMode, "normal">, string> = {
  filter: "type to filter  up/down move  Enter apply  Esc clear",
  search: "type to search  up/down match  Enter apply  Esc clear",
  help: "j k scroll  q Esc ? close help",
};

const HELP_ROWS: Array<[string, string]> = [
  ["Tab / Shift+Tab", "cycle pane focus (files, git, viewer)"],
  ["t", "toggle the file tree"],
  ["j k / arrows", "move the cursor or scroll"],
  ["g G", "jump to top or bottom"],
  ["Ctrl+d Ctrl+u", "half page"],
  ["Enter", "open file / commit diff, or toggle a directory / commit family"],
  ["l h / arrows", "expand or collapse a directory / commit family"],
  ["/", "filter the tree, search the file"],
  ["n N", "next/prev match (viewer)"],
  ["up/down, ^n/^p", "cycle matches (searching)"],
  ["w", "toggle word wrap"],
  ["m", "toggle markdown rendered / code view"],
  ["h l", "horizontal scroll when wrap is off"],
  [".", "toggle hidden files"],
  ["y", "copy the selected path"],
  ["r", "refresh tree and git"],
  ["?", "this help"],
  ["q Esc", "close (Esc clears filter or search first)"],
];

/**
 * Printable character from a key event, using the platform rule: the Kitty
 * decoder first, then a single printable code unit. Shared by the filter and
 * the search input modes so the two cannot drift apart.
 */
function printableChar(data: string): string | null {
  const decoded = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : null);
  return decoded && decoded.length === 1 ? decoded : null;
}

export class NavigatorOverlay implements Focusable {
  /** Set by TUI when focus changes; gates the CURSOR_MARKER emission. */
  focused = false;

  private cwd: string;
  private T: NavigatorTheme;
  private getTerminalRows: () => number;
  private requestRender: () => void;
  private onClose: () => void;
  private loadFile: (relPath: string) => Promise<ViewerFile>;
  private loadCommit: ((shortHash: string) => Promise<ViewerFile>) | undefined;
  private refresh: () => void;

  private root: FileNode | null = null;
  private treeSource: "git" | "fs" | null = null;
  private git: GitState | null = null;

  private focus: Focus = "files";
  private mode: InputMode = "normal";
  private showHidden = false;
  private showTree = true;

  private filesCursor = 0;
  private filesScroll = 0;
  private filterQuery = "";

  private gitCursor = 0;
  private gitScroll = 0;

  private viewFile: ViewerFile | null = null;
  private viewLoading = false;
  private viewTargetRelPath: string | null = null;
  private loadSeq = 0;
  private viewScroll = 0;
  private viewHscroll = 0;
  private viewWrap = false;
  private viewRenderMarkdown = false;
  private diskChanged = false;

  private searchQuery = "";
  private searchMatches: SearchMatch[] = [];
  private searchIndex = 0;
  private searchJump = false;
  // Search matches are recomputed lazily: `searchDirty` is set when the open
  // file's content changes under an active query; `recomputeSearchIfNeeded`
  // then (and only then) reruns `searchLines`. `searchMatchLines` backs the
  // O(1) per-line membership test in `markSearch` (was O(lines×matches)).
  private searchDirty = false;
  private searchMatchLines: Set<number> = new Set();
  // Bumped whenever the marked-lines output changes (matches or current
  // match index), so the `marked` and `computeRows` caches can key off it.
  private searchVersion = 0;

  // Viewer render caches. The top-level `render()` cache is wiped by every
  // `touch()` (every keystroke), so without these the viewer path re-derives
  // the whole file's marked rows, max line width, and wrapped display rows on
  // every keypress. Each cache is keyed on the stable `viewFile` reference
  // (which only changes when a file is (re)opened) plus the inputs that
  // actually affect its output.
  private markedCache: { file: ViewerFile; version: number; marked: ViewerFile } | null = null;
  private maxLineWidthCache: { file: ViewerFile; value: number } | null = null;
  private rowsCache: { marked: ViewerFile; width: number; wrap: boolean; hscroll: number; rows: DisplayRow[] } | null =
    null;
  private mdRenderer: Markdown | null = null;
  private mdCache: { file: ViewerFile; width: number; lines: string[] } | null = null;
  // Row-model memos. Each is keyed on exactly the inputs that affect its
  // output (object references + primitives), so a single render pass that
  // calls filesRows()/gitRows()/gitNavRows() several times builds each array
  // once. The signature approach is robust to intermediate mutations between
  // touch() calls. (Issue #015.)
  private filesRowsCache: { root: FileNode | null; query: string; hidden: boolean; version: number; rows: FilesRow[] } | null =
    null;
  // Bumped on any in-place tree mutation (expand/collapse, expandAncestors) so
  // the filesRowsCache signature catches changes that don't swap the root ref.
  private treeVersion = 0;
  private gitRowsCache: { git: GitState | null; version: number; rows: GitRow[] } | null = null;
  // Bumped on any commit-family expansion toggle so gitRowsCache catches the
  // mutation without a GitState ref swap.
  private gitTreeVersion = 0;
  // shortHash of commits whose family is expanded.
  private gitExpanded = new Set<string>();
  private gitNavRowsCache: { git: GitState | null; version: number; rows: GitRow[] } | null = null;

  private helpScroll = 0;
  private notice: string | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  /** Nerd Font icon column enabled; never read from env here (Issue #028). */
  private enableIcons: boolean;
  private iconsNoticeShown = false;
  /** Home directory for path shortening; never read from env here (Issue #039). */
  private home: string;

  constructor(options: NavigatorOptions) {
    this.cwd = options.cwd;
    this.T = options.theme;
    this.getTerminalRows = options.getTerminalRows;
    this.requestRender = options.requestRender;
    this.onClose = options.onClose;
    this.loadFile = options.loadFile;
    this.loadCommit = options.loadCommit;
    this.refresh = options.refresh;
    this.enableIcons = options.enableIcons ?? false;
    this.home = options.home ?? "";
  }

  // ── Public API ──

  /**
   * Install a freshly built tree. Expansion state is applied by index.ts before
   * this call, so the tree arrives ready to render (plan section 3.6 setters).
   */
  setTree(root: FileNode, treeSource: "git" | "fs"): void {
    this.root = root;
    this.treeSource = treeSource;
    this.filesCursor = moveCursor(this.filesRows().length, this.filesCursor, 0);
    this.touch();
  }

  /** Install a new git state, keeping the git cursor in range. */
  setGitState(git: GitState): void {
    this.git = git;
    this.gitCursor = moveCursor(this.gitNavRows().length, this.gitCursor, 0);
    this.touch();
  }

  setDiskChanged(changed: boolean): void {
    if (this.diskChanged === changed) return;
    this.diskChanged = changed;
    this.touch();
  }

  getOpenRelPath(): string | null {
    return this.viewTargetRelPath ?? this.viewFile?.relPath ?? null;
  }

  getOpenMtime(): number | undefined {
    if (this.viewLoading && this.viewTargetRelPath && this.viewTargetRelPath !== this.viewFile?.relPath) {
      return undefined;
    }
    return this.viewFile?.mtimeMs;
  }

  /** Reload the open file, keeping scroll position. Used by "r". */
  reloadOpenFile(): void {
    const file = this.viewFile;
    if (!file) return;
    if (file.kind === "diff" || file.relPath.startsWith("commit:")) {
      const hash = file.commitHash ?? file.relPath.slice("commit:".length);
      if (hash && this.loadCommit) {
        void this.openCommit(hash, true);
      }
      return;
    }
    void this.openRelPath(file.relPath, true);
  }

  /** Open a file by relative path (async; sets viewer state on completion). */
  async openRelPath(relPath: string, keepScroll = false): Promise<void> {
    const seq = ++this.loadSeq;
    this.viewLoading = true;
    this.viewTargetRelPath = relPath;
    const sameFile = this.viewFile?.relPath === relPath;
    if (!keepScroll || !sameFile) {
      this.viewScroll = 0;
      this.viewHscroll = 0;
      if (!sameFile) {
        this.searchQuery = "";
        this.searchMatches = [];
        this.searchIndex = 0;
      }
    }
    this.touch();
    this.requestRender();

    try {
      const file = await this.loadFile(relPath);
      if (this.disposed || this.loadSeq !== seq) return;
      this.viewFile = file;
      this.mdCache = null;
      // New file content: an active query must be re-scanned on next render.
      // The marked/maxLineWidth/rows caches key on the `viewFile` reference,
      // so the new object invalidates them automatically.
      this.searchDirty = true;
      this.diskChanged = false;
      if (!keepScroll || !sameFile) {
        this.viewScroll = 0;
        this.viewHscroll = 0;
      }
    } catch {
      if (this.disposed || this.loadSeq !== seq) return;
      this.viewFile = { kind: "error", relPath, lines: [], message: "unexpected read failure" };
      this.mdCache = null;
      this.searchDirty = true;
    } finally {
      if (!this.disposed && this.loadSeq === seq) {
        this.viewLoading = false;
        this.viewTargetRelPath = null;
        this.touch();
        this.requestRender();
      }
    }
  }

  /**
   * Open a commit's diff in the viewer (v3). Parallel to openRelPath: reuses
   * the same loadSeq race guard, viewTargetRelPath, viewLoading and search
   * state so a diff load can never race a file load. `relPath` is set to
   * `commit:<shortHash>` — distinct from any file path — so the viewer
   * header / caches key on it and index.ts can skip the mtime poll for it.
   */
  async openCommit(shortHash: string, keepScroll = false): Promise<void> {
    if (!this.loadCommit) {
      this.toggleCommitFamily(shortHash);
      return;
    }
    const seq = ++this.loadSeq;
    this.viewLoading = true;
    this.viewTargetRelPath = `commit:${shortHash}`;
    const sameCommit = this.viewFile?.kind === "diff" && this.viewFile.commitHash === shortHash;
    if (!keepScroll || !sameCommit) {
      this.viewScroll = 0;
      this.viewHscroll = 0;
      if (!sameCommit) {
        this.searchQuery = "";
        this.searchMatches = [];
        this.searchIndex = 0;
      }
    }
    this.touch();
    this.requestRender();
    try {
      const file = await this.loadCommit(shortHash);
      if (this.disposed || this.loadSeq !== seq) return;
      this.viewFile = file;
      this.mdCache = null;
      this.searchDirty = true;
      this.diskChanged = false;
      if (!keepScroll || !sameCommit) {
        this.viewScroll = 0;
        this.viewHscroll = 0;
      }
    } catch {
      if (this.disposed || this.loadSeq !== seq) return;
      this.viewFile = {
        kind: "error",
        relPath: `commit:${shortHash}`,
        lines: [],
        message: "cannot read commit",
      };
      this.mdCache = null;
      this.searchDirty = true;
    } finally {
      if (!this.disposed && this.loadSeq === seq) {
        this.viewLoading = false;
        this.viewTargetRelPath = null;
        this.touch();
        this.requestRender();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  // ── Row models ──

  private filesRows(): FilesRow[] {
    const root = this.root;
    const query = this.filterQuery;
    const hidden = this.showHidden;
    const c = this.filesRowsCache;
    if (c && c.root === root && c.query === query && c.hidden === hidden && c.version === this.treeVersion) return c.rows;
    const rows: FilesRow[] = !root
      ? []
      : query
        ? filterRows(root, query, hidden)
        : flattenVisible(root, hidden);
    this.filesRowsCache = { root, query, hidden, version: this.treeVersion, rows };
    return rows;
  }

  private gitRows(): GitRow[] {
    const git = this.git;
    const c = this.gitRowsCache;
    if (c && c.git === git && c.version === this.gitTreeVersion) return c.rows;
    const rows: GitRow[] = [];
    if (!git || !git.available) {
      rows.push({ kind: "group", label: git?.error ?? "git unavailable", tone: "dim" });
      this.gitRowsCache = { git, version: this.gitTreeVersion, rows };
      return rows;
    }
    if (git.unstaged.length > 0) {
      // Group rows only render when their list is non-empty (Issue #029).
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
      // Plan section 5 item 5: a dim Clean row when both lists are empty.
      rows.push({ kind: "group", label: "Clean \u2014 nothing staged or unstaged", tone: "dim" });
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
    if (this.gitExpanded.size > 0) {
      const byHash = new Map<string, GitCommit>();
      for (const commit of git.history) byHash.set(commit.shortHash, commit);
      // commitDepth: at what indent does a commit's row render? Computed by a
      // walk over the *current* expand/collapse state, never incrementally:
      // a top-level history commit is depth 0; a commit that is listed as a
      // direct parent of an expanded anchor renders one deeper than that
      // anchor, chained through nested expansions. The newest expanded anchor
      // (history order) that lists the hash is the one the added-set dedup
      // claims it for, so the walk picks the same anchor: depth = the anchor's
      // own depth + 1. Recomputing from gitExpanded on every cache miss means
      // collapsing a chain correctly *resets* the depths (no stale indents).
      const memo = new Map<string, number>();
      const commitDepth = (hash: string): number => {
        const cached = memo.get(hash);
        if (cached !== undefined) return cached;
        for (const anchor of git.history) {
          if (this.gitExpanded.has(anchor.shortHash) && (anchor.parents ?? []).includes(hash)) {
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
        if (!this.gitExpanded.has(commit.shortHash)) continue;
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
    this.gitRowsCache = { git, version: this.gitTreeVersion, rows };
    return rows;
  }

  private gitNavRows(): GitRow[] {
    const git = this.git;
    const c = this.gitNavRowsCache;
    if (c && c.git === git && c.version === this.gitTreeVersion) return c.rows;
    const rows = this.gitRows().filter((row) => row.kind !== "group");
    this.gitNavRowsCache = { git, version: this.gitTreeVersion, rows };
    return rows;
  }

  /**
   * Toggle whether a commit's ancestor family is expanded in the git pane.
   * Expansion is capped by FAMILY_MAX_DEPTH / FAMILY_MAX_ROWS so a wide or
   * deep history cannot fan the pane out. Keyed solely on the commit's
   * shortHash (stable across refreshes); the cache version bumps so gitRows()
   * re-derives without a GitState ref swap.
   */
  private toggleCommitFamily(shortHash: string): void {
    if (this.gitExpanded.has(shortHash)) this.gitExpanded.delete(shortHash);
    else this.gitExpanded.add(shortHash);
    this.gitTreeVersion++;
    this.touch();
  }

  // ── Input ──

  handleInput(data: string): void {
    if (this.mode === "help") {
      this.handleHelpInput(data);
      return;
    }
    if (this.mode === "filter") {
      this.handleFilterInput(data);
      return;
    }
    if (this.mode === "search") {
      this.handleSearchInput(data);
      return;
    }
    this.handleNormalInput(data);
  }

  private handleHelpInput(data: string): void {
    const maxScroll = this.helpMaxScroll();
    if (matchesKey(data, Key.up) || data === "k") {
      this.helpScroll = Math.max(0, this.helpScroll - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.helpScroll = Math.min(maxScroll, this.helpScroll + 1);
    } else if (data === "?" || data === "q" || matchesKey(data, Key.escape)) {
      this.mode = "normal";
    } else {
      return;
    }
    this.touch();
  }

  private handleFilterInput(data: string): void {
    const rows = this.filesRows();
    if (matchesKey(data, Key.escape)) {
      this.filterQuery = "";
      this.mode = "normal";
      this.filesCursor = 0;
      this.filesScroll = 0;
    } else if (matchesKey(data, Key.enter)) {
      this.mode = "normal";
    } else if (matchesKey(data, Key.backspace)) {
      this.filterQuery = this.filterQuery.slice(0, -1);
      this.filesCursor = 0;
      this.filesScroll = 0;
    } else if (matchesKey(data, Key.down)) {
      this.filesCursor = Math.min(this.filesCursor + 1, Math.max(0, rows.length - 1));
    } else if (matchesKey(data, Key.up)) {
      this.filesCursor = Math.max(0, this.filesCursor - 1);
    } else {
      const printable = printableChar(data);
      if (printable) {
        this.filterQuery += printable;
        this.filesCursor = 0;
        this.filesScroll = 0;
      }
    }
    this.touch();
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.searchQuery = "";
      this.searchMatches = [];
      this.mode = "normal";
    } else if (matchesKey(data, Key.enter)) {
      this.mode = "normal";
    } else if (matchesKey(data, Key.backspace)) {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.recomputeSearch();
      this.searchIndex = 0;
      this.searchJump = true;
    } else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.cycleSearch(1);
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.cycleSearch(-1);
    } else {
      const printable = printableChar(data);
      if (printable) {
        this.searchQuery += printable;
        this.recomputeSearch();
        this.searchIndex = 0;
        this.searchJump = true;
      }
    }
    this.touch();
  }

  private handleNormalInput(data: string): void {
    // Global keys first.
    const isShiftTab = matchesKey(data, Key.shift("tab"));
    if (isShiftTab || matchesKey(data, Key.tab)) {
      const order: Focus[] = ["files", "git", "viewer"];
      const index = order.indexOf(this.focus);
      this.focus = order[(index + (isShiftTab ? order.length - 1 : 1)) % order.length] ?? "files";
      this.touch();
      return;
    }
    if (data === "?") {
      this.mode = "help";
      this.helpScroll = 0;
      this.touch();
      return;
    }
    if (data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.filterQuery) {
        this.filterQuery = "";
        this.filesCursor = 0;
        this.filesScroll = 0;
        this.touch();
        return;
      }
      if (this.searchQuery) {
        this.searchQuery = "";
        this.searchMatches = [];
        this.touch();
        return;
      }
      this.onClose();
      return;
    }
    if (data === "t") {
      this.showTree = !this.showTree;
      this.touch();
      return;
    }
    if (data === "r") {
      this.refresh();
      this.reloadOpenFile();
      this.showNotice("refreshing tree and git");
      return;
    }
    if (data === "y") {
      void this.copyContext();
      return;
    }

    if (this.focus === "files") this.handleFilesInput(data);
    else if (this.focus === "git") this.handleGitInput(data);
    else this.handleViewerInput(data);
  }

  private handleFilesInput(data: string): void {
    const rows = this.filesRows();
    const area = this.filesArea();
    const current = rows[this.filesCursor];

    if (matchesKey(data, Key.up) || data === "k") {
      this.filesCursor = moveCursor(rows.length, this.filesCursor, -1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.filesCursor = moveCursor(rows.length, this.filesCursor, 1);
    } else if (data === "g") {
      this.filesCursor = 0;
    } else if (data === "G") {
      this.filesCursor = moveCursor(rows.length, this.filesCursor, rows.length);
    } else if (matchesKey(data, Key.ctrl("d"))) {
      this.filesCursor = pageJump(rows.length, this.filesCursor, 1, area);
    } else if (matchesKey(data, Key.ctrl("u"))) {
      this.filesCursor = pageJump(rows.length, this.filesCursor, -1, area);
    } else if (matchesKey(data, Key.enter)) {
      if (current?.node.isDir) {
        current.node.expanded = !current.node.expanded;
        this.treeVersion++;
      } else if (current && current.kind !== "dir") {
        this.focus = "viewer";
        void this.openRelPath(current.node.relPath);
      }
    } else if (matchesKey(data, Key.right) || data === "l") {
      if (current?.node.isDir) {
        current.node.expanded = true;
        this.treeVersion++;
      }
    } else if (matchesKey(data, Key.left) || data === "h") {
      if (current?.node.isDir) {
        current.node.expanded = false;
        this.treeVersion++;
      }
    } else if (data === "/") {
      this.mode = "filter";
      this.filterQuery = "";
      this.filesCursor = 0;
      this.filesScroll = 0;
    } else if (data === ".") {
      // Files-scoped per the plan's keymap table, not a global key.
      this.showHidden = !this.showHidden;
      this.filesCursor = 0;
      this.filesScroll = 0;
    } else {
      return;
    }
    this.touch();
  }

  private handleGitInput(data: string): void {
    const rows = this.gitNavRows();
    if (matchesKey(data, Key.up) || data === "k") {
      this.gitCursor = moveCursor(rows.length, this.gitCursor, -1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.gitCursor = moveCursor(rows.length, this.gitCursor, 1);
    } else if (data === "g") {
      this.gitCursor = 0;
    } else if (data === "G") {
      this.gitCursor = moveCursor(rows.length, this.gitCursor, rows.length);
    } else if (matchesKey(data, Key.enter)) {
      const row = rows[this.gitCursor];
      if (!row) return;
      if (row.kind === "file") {
        if (this.root) {
          const node = findNode(this.root, row.relPath);
          if (node) expandAncestors(node);
          this.treeVersion++;
        }
        this.filterQuery = "";
        this.alignFilesCursor(row.relPath);
        this.focus = "viewer";
        void this.openRelPath(row.relPath);
      } else if (row.kind === "commit" || row.kind === "commit-child") {
        // v3: Enter is the "open" verb — open the commit's diff in the
        // viewer. Family expansion moves to l / right (see below), matching
        // the file pane's file-vs-dir split. Without an injected loadCommit
        // the overlay falls back to toggling the family (v2 behavior — focus
        // stays on git), which keeps harnesses that never stub loadCommit
        // working without changing their Enter semantics.
        if (!this.loadCommit) {
          this.toggleCommitFamily(row.commit.shortHash);
        } else {
          this.focus = "viewer";
          void this.openCommit(row.commit.shortHash);
        }
      }
    } else if (matchesKey(data, Key.right) || data === "l") {
      // v3: l / right is the "structure" verb — expand the family of the
      // commit under the cursor (a commit-child expands its own subtree).
      const row = rows[this.gitCursor];
      if (!row) return;
      if (row.kind === "commit" || row.kind === "commit-child") {
        const hash = row.commit.shortHash;
        const depth = row.kind === "commit-child" ? row.depth : 0;
        if (depth >= FAMILY_MAX_DEPTH && !this.gitExpanded.has(hash)) {
          this.showNotice("max depth reached \u2014 collapse a parent to go deeper");
          return; // no touch(); the notice already requested a render
        }
        this.toggleCommitFamily(hash);
      }
    } else if (matchesKey(data, Key.left) || data === "h") {
      const row = rows[this.gitCursor];
      if (!row) return;
      if (row.kind === "commit" || row.kind === "commit-child") {
        const wasExpanded = this.gitExpanded.has(row.commit.shortHash);
        this.gitExpanded.delete(row.commit.shortHash);
        this.gitTreeVersion++;
        this.touch();
        // Step out to the anchor parent like the file pane: when a
        // commit-child collapses, move the cursor to its expanded ancestor so
        // the user lands on a row that is still visible (Issue #030 semantics).
        if (row.kind === "commit-child" && wasExpanded) {
          const anchorIndex = rows.findIndex(
            (r) => r.kind === "commit" && this.gitExpanded.has(r.commit.shortHash) && (r.commit.parents ?? []).includes(row.commit.shortHash),
          );
          if (anchorIndex >= 0) this.gitCursor = anchorIndex;
        }
      }
    } else {
      return;
    }
    this.touch();
  }

  private handleViewerInput(data: string): void {
    const area = this.viewerArea();
    const half = Math.max(1, Math.ceil(area / HALF_PAGE_DIVISOR));
    if (matchesKey(data, Key.up) || data === "k") {
      this.viewScroll = Math.max(0, this.viewScroll - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.viewScroll += 1;
    } else if (matchesKey(data, Key.ctrl("d"))) {
      this.viewScroll += half;
    } else if (matchesKey(data, Key.ctrl("u"))) {
      this.viewScroll = Math.max(0, this.viewScroll - half);
    } else if (data === "g") {
      this.viewScroll = 0;
    } else if (data === "G") {
      this.viewScroll = Number.MAX_SAFE_INTEGER;
    } else if (data === "/") {
      this.mode = "search";
      this.searchQuery = "";
      this.searchMatches = [];
      this.searchIndex = 0;
    } else if (data === "n") {
      this.cycleSearch(1);
    } else if (data === "N") {
      this.cycleSearch(-1);
    } else if (data === "w") {
      if (this.viewRenderMarkdown && this.canRenderMarkdown(this.viewFile)) {
        return;
      }
      this.viewWrap = !this.viewWrap;
      this.viewHscroll = 0;
    } else if (data === "m") {
      if (this.canRenderMarkdown(this.viewFile)) {
        this.viewRenderMarkdown = !this.viewRenderMarkdown;
        this.viewHscroll = 0; // rendered mode is wrap-only

        // Full cache invalidation protocol:
        this.rowsCache = null;
        this.markedCache = null;
        this.mdCache = null;
        this.searchDirty = true;
        this.searchMatches = [];
        this.searchMatchLines.clear();
        this.searchVersion++;

        this.touch();
      } else {
        this.showNotice("rendered view only available for markdown files");
      }
      return;
    } else if (matchesKey(data, Key.left) || data === "h") {
      this.viewHscroll = Math.max(0, this.viewHscroll - 4);
    } else if (matchesKey(data, Key.right) || data === "l") {
      this.viewHscroll += 4;
    } else {
      return;
    }
    this.touch();
  }

  // ── Actions ──

  private canRenderMarkdown(file: ViewerFile | null): boolean {
    return (
      file !== null &&
      file.kind !== "diff" &&
      file.rawText !== undefined &&
      isMarkdownPath(file.relPath)
    );
  }

  private getRenderedMarkdownLines(file: ViewerFile, width: number): string[] {
    if (width <= 0) return [];
    if (this.mdCache && this.mdCache.file === file && this.mdCache.width === width) {
      return this.mdCache.lines;
    }
    if (!this.mdRenderer) {
      this.mdRenderer = new Markdown("", 0, 0, getMarkdownTheme());
    }
    this.mdRenderer.setText(file.rawText ?? "");
    const rawLines = this.mdRenderer.render(width);

    // Width safety clamp: pad to width and prevent bright ellipsis leakage
    const lines = rawLines.map((line) => {
      const vw = visibleWidth(line);
      return vw < width ? line + " ".repeat(width - vw) : truncateToWidth(line, width, "");
    });

    this.mdCache = { file, width, lines };
    this.searchDirty = true;
    return lines;
  }

  private markRenderedLineMatches(
    line: string,
    lineIdx: number,
    currentMatch: SearchMatch | undefined,
    currentOccurrenceOnLine: number,
  ): string {
    const occ = currentMatch && lineIdx === currentMatch.line ? currentOccurrenceOnLine : -1;
    return markMatches(line, this.searchQuery, this.T.searchMatch, this.T.searchCurrent, occ);
  }

  private recomputeSearch(): void {
    if (this.viewRenderMarkdown && this.canRenderMarkdown(this.viewFile) && this.mdCache) {
      this.recomputeSearchOnLines(this.mdCache.lines);
      return;
    }
    const lines = this.viewFile?.lines ?? [];
    this.recomputeSearchOnLines(lines);
  }

  private recomputeSearchOnLines(lines: string[]): void {
    this.searchMatches = searchLines(lines, this.searchQuery);
    this.searchMatchLines = new Set(this.searchMatches.map((m) => m.line));
    if (this.searchMatches.length === 0) this.searchIndex = 0;
    this.searchVersion++;
    this.searchDirty = false;
  }

  private cycleSearch(delta: number): void {
    if (this.searchMatches.length === 0) return;
    const count = this.searchMatches.length;
    this.searchIndex = (this.searchIndex + delta + count) % count;
    this.searchVersion++;
    this.searchJump = true;
  }

  private alignFilesCursor(relPath: string): void {
    const rows = this.filesRows();
    const index = rows.findIndex((row) => row.node.relPath === relPath);
    if (index >= 0) {
      this.filesCursor = index;
      this.ensureFilesCursorVisible();
    }
  }

  private async copyContext(): Promise<void> {
    let value = "";
    if (this.focus === "git") {
      const row = this.gitNavRows()[this.gitCursor];
      if (row?.kind === "file") value = row.relPath;
      else if (row?.kind === "commit") value = row.commit.shortHash;
    } else if (this.focus === "viewer") {
      if (this.viewFile?.kind === "diff" && this.viewFile.commitHash) {
        value = this.viewFile.commitHash;
      } else {
        value = this.viewTargetRelPath ?? this.viewFile?.relPath ?? "";
        if (value.startsWith("commit:")) {
          value = value.slice("commit:".length);
        }
      }
    } else {
      value = this.filesRows()[this.filesCursor]?.node.relPath ?? "";
    }
    if (!value) return;
    try {
      await copyToClipboard(value);
      this.showNotice(`copied ${value}`);
    } catch {
      this.showNotice("clipboard unavailable");
    }
  }

  private showNotice(message: string): void {
    this.notice = message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
      this.touch();
      this.requestRender();
    }, 2000);
    this.touch();
    this.requestRender();
  }

  private touch(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  // ── Geometry helpers ──

  /**
   * Height in rows, bounded by the terminal so the overlay never overflows it.
   * Deliberately free to fall below MIN_OVERLAY_HEIGHT: that is what makes the
   * compact "terminal too small" notice reachable (plan section 6).
   */
  private overlayHeight(): number {
    const termRows = this.getTerminalRows() || 24;
    return Math.max(0, Math.min(Math.floor(termRows * 0.85), termRows - 2));
  }

  private bodyRows(overlayH: number): number {
    return Math.max(4, overlayH - 5);
  }

  /** Help rows that fit. Shared by the input clamp and the renderer. */
  private helpVisibleRows(body = this.bodyRows(this.overlayHeight())): number {
    return Math.min(HELP_ROWS.length, Math.max(1, body - 4));
  }

  /** Single source of truth for the help scroll limit. */
  private helpMaxScroll(): number {
    return Math.max(0, HELP_ROWS.length - this.helpVisibleRows());
  }

  private useLeftColumn(innerW: number, bodyRows: number): boolean {
    if (!this.showTree || bodyRows < 8) return false;
    const candidate = this.leftColumnWidth(innerW);
    return innerW >= LEFT_COLUMN_HIDE_BELOW && innerW - candidate - 1 >= 30;
  }

  private leftColumnWidth(innerW: number): number {
    return Math.min(LEFT_COLUMN_MAX, Math.max(LEFT_COLUMN_MIN, Math.floor(innerW * LEFT_COLUMN_RATIO)));
  }

  private filesArea(): number {
    const overlayH = this.overlayHeight();
    const body = this.bodyRows(overlayH);
    const split = this.splitRows(body);
    return Math.max(2, split.filesH - 1);
  }

  private viewerArea(): number {
    const overlayH = this.overlayHeight();
    return Math.max(2, this.bodyRows(overlayH) - 1);
  }

  private splitRows(body: number): { filesH: number; gitH: number } {
    let filesH = Math.max(6, Math.floor(body * 0.55));
    let gitH = body - filesH - 1;
    if (gitH < GIT_MIN_ROWS) {
      filesH = Math.max(3, body - GIT_MIN_ROWS - 1);
      gitH = Math.max(2, body - filesH - 1);
    }
    return { filesH, gitH };
  }

  // ── Render ──

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const T = this.T;
    const overlayH = this.overlayHeight();
    const innerW = Math.max(0, width - 2);

    // One-time, non-blocking hint when the user opted into Nerd Font icons
    // (Issue #028): glyphs depend on a terminal Nerd Font, which pi cannot
    // detect. Fire before building lines so the footer picks it up; the
    // iconsNoticeShown guard makes it run exactly once.
    if (this.enableIcons && !this.iconsNoticeShown) {
      this.iconsNoticeShown = true;
      this.showNotice("nerd icons on \u2014 glyphs may not render without a Nerd Font");
    }

    if (width < MIN_OVERLAY_WIDTH || overlayH < MIN_OVERLAY_HEIGHT) {
      // Compact notice for terminals that cannot host the frame. Every line is
      // clipped to `width`, so the notice is width-safe like the frame.
      const barW = Math.max(0, width - 2);
      const notice = (text: string) =>
        this.padTo(T.frame("\u2502") + this.padTo(text, barW) + T.frame("\u2502"), width);
      const lines = [
        this.padTo(T.frame("\u250c" + "\u2500".repeat(barW) + "\u2510"), width),
        notice(T.warning(" terminal too small for pi-navigator ")),
        this.padTo(T.frame("\u2514" + "\u2500".repeat(barW) + "\u2518"), width),
      ];
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }
    const body = this.bodyRows(overlayH);
    const withLeft = this.useLeftColumn(innerW, body);
    const leftW = withLeft ? this.leftColumnWidth(innerW) : 0;
    const rightW = withLeft ? innerW - leftW - 1 : innerW;
    const { filesH } = this.splitRows(body);

    const leftRows = withLeft ? this.buildLeftRows(leftW, filesH, body) : null;
    const rightRows = this.buildRightRows(rightW, body);

    const lines: string[] = [];
    lines.push(T.frame("\u250c" + "\u2500".repeat(innerW) + "\u2510"));
    lines.push(T.frame("\u2502") + this.buildTitleRow(innerW) + T.frame("\u2502"));
    lines.push(T.frame("\u251c" + "\u2500".repeat(innerW) + "\u2524"));

    for (let i = 0; i < body; i++) {
      if (!leftRows) {
        lines.push(T.frame("\u2502") + rightRows[i] + T.frame("\u2502"));
        continue;
      }
      if (i === filesH) {
        lines.push(
          T.frame("\u251c") + T.frame("\u2500".repeat(leftW)) + T.frame("\u2524") + rightRows[i] + T.frame("\u2502"),
        );
      } else {
        lines.push(T.frame("\u2502") + leftRows[i] + T.frame("\u2502") + rightRows[i] + T.frame("\u2502"));
      }
    }

    lines.push(T.frame("\u2502") + this.buildFooterRow(innerW) + T.frame("\u2502"));
    lines.push(T.frame("\u2514" + "\u2500".repeat(innerW) + "\u2518"));

    if (this.mode === "help") this.composeHelp(lines, innerW, body);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  // ── Frame pieces ──

  private buildTitleRow(innerW: number): string {
    const T = this.T;
    const left = " " + T.accent(T.bold("pi-navigator")) + "  " + T.muted(this.shortPath(this.cwd));
    const git = this.git;
    const branchLabel = git?.available
      ? (git.detached ? "(detached)" : git.branch ?? "(detached)")
      : "no git";
    const counters: string[] = [];
    if (git?.available) {
      if (git.ahead > 0) counters.push(T.success(`\u2191${git.ahead}`));
      if (git.behind > 0) counters.push(T.error(`\u2193${git.behind}`));
      const changed = git.unstaged.length + git.staged.length;
      if (changed > 0) counters.push(T.dim(`${changed} changed`));
    }
    const right = " " + T.accent(branchLabel) + (counters.length > 0 ? "  " + counters.join(" ") : "") + " ";
    return this.joinLeftRight(left, right, innerW);
  }

  private getFooterHint(): string {
    switch (this.mode) {
      case "help":
        return MODE_HINTS.help;
      case "filter":
        return MODE_HINTS.filter;
      case "search":
        return MODE_HINTS.search;
      case "normal":
        return FOCUS_HINTS[this.focus];
    }
  }

  private buildFooterRow(innerW: number): string {
    const T = this.T;
    // While filtering, the footer row area carries the filter bar instead of
    // the plain hints (plan section 3.6 item 6).
    if (this.mode === "filter") return this.buildFilterBar(innerW);
    const hint = this.getFooterHint();
    const left = " " + T.dim(hint);
    let right = "";
    if (this.notice) {
      right = " " + T.warning(this.notice) + " ";
    } else {
      const panes: Array<[Focus, string]> = [
        ["files", "files"],
        ["git", "git"],
        ["viewer", "viewer"],
      ];
      right =
        " " +
        panes.map(([pane, label]) => (this.focus === pane ? T.accent(T.bold(label)) : T.dim(label))).join("  ") +
        " ";
    }
    return this.joinLeftRight(left, right, innerW);
  }

  /**
   * Left/right split with the right side guaranteed: when both cannot fit,
   * the left (informational hint or title path) is ellipsized and the right
   * (pane labels, counters, branch) survives. Plain padTo would truncate the
   * tail, which for the footer is exactly the focus indicator.
   */
  private joinLeftRight(left: string, right: string, width: number): string {
    const rightW = visibleWidth(right);
    const maxLeft = Math.max(0, width - rightW - 1);
    // Empty ellipsis: truncateToWidth's default "..." is wrapped in \x1b[0m
    // resets that would close the left part's style and render the ellipsis in
    // bright default (visible against the dim footer hint / title path).
    const leftPart = visibleWidth(left) > maxLeft ? truncateToWidth(left, maxLeft, "") : left;
    const gap = Math.max(1, width - visibleWidth(leftPart) - rightW);
    const line = leftPart + " ".repeat(gap) + right;
    return this.padTo(line, width);
  }

  // ── Left column ──

  private buildLeftRows(leftW: number, filesH: number, body: number): string[] {
    const rows: string[] = [];
    const filesRows = this.filesRows();
    const filesArea = Math.max(1, filesH - 1);
    this.ensureFilesCursorVisibleFor(filesRows.length, filesArea);

    rows.push(this.buildFilesHeader(leftW, filesRows.length));
    for (let i = 0; i < filesArea; i++) {
      const index = this.filesScroll + i;
      const row = filesRows[index];
      rows.push(row ? this.buildFileRow(row, index === this.filesCursor, leftW) : this.padTo("", leftW));
    }

    // Placeholder so git rows start at index filesH + 1; the horizontal
    // separator row is drawn by render() and must not consume a data row.
    rows.push(this.padTo("", leftW));

    const gitRows = this.gitRows();
    const navRows = this.gitNavRows();
    const gitArea = Math.max(1, body - filesH - 1 - 1);
    this.ensureGitCursorVisibleFor(gitRows, navRows, gitArea);

    rows.push(this.buildGitHeader(leftW));
    // A dim … in the last slot when git rows continue below the window, unless
    // that slot holds the selection (plan section 3.6 item 4).
    const lastIndex = this.gitScroll + gitArea - 1;
    const selectedRow = navRows[this.gitCursor];
    const selectedIndex = selectedRow ? gitRows.indexOf(selectedRow) : -1;
    const markerIndex = gitRows.length > lastIndex + 1 && selectedIndex !== lastIndex ? lastIndex : -1;
    for (let i = 0; i < gitArea; i++) {
      const index = this.gitScroll + i;
      if (index === markerIndex) {
        rows.push(this.padTo(" " + this.T.dim("\u2026"), leftW));
        continue;
      }
      const row = gitRows[index];
      if (!row) {
        rows.push(this.padTo("", leftW));
        continue;
      }
      rows.push(this.buildGitRow(row, index === selectedIndex, leftW));
    }

    return rows;
  }

  private ensureFilesCursorVisibleFor(total: number, area: number): void {
    if (this.filesCursor < this.filesScroll) this.filesScroll = this.filesCursor;
    if (this.filesCursor >= this.filesScroll + area) this.filesScroll = this.filesCursor - area + 1;
    this.filesScroll = Math.max(0, Math.min(this.filesScroll, Math.max(0, total - area)));
  }

  private ensureFilesCursorVisible(): void {
    this.ensureFilesCursorVisibleFor(this.filesRows().length, this.filesArea());
  }

  private ensureGitCursorVisibleFor(rows: GitRow[], navRows: GitRow[], area: number): void {
    const selected = navRows[this.gitCursor];
    if (!selected) return;
    const index = rows.indexOf(selected);
    if (index < 0) return;
    if (index < this.gitScroll) this.gitScroll = index;
    if (index >= this.gitScroll + area) this.gitScroll = index - area + 1;
    this.gitScroll = Math.max(0, Math.min(this.gitScroll, Math.max(0, rows.length - area)));
  }

  private buildFilesHeader(leftW: number, total: number): string {
    const T = this.T;
    const label = " " + (this.focus === "files" ? T.accent(T.bold("FILES")) : T.dim("FILES"));
    const info = this.filterQuery
      ? T.warning(`${total} matches`) + " "
      : T.dim(`${Math.max(1, Math.min(this.filesCursor + 1, total))}/${total}`) + " ";
    return this.joinLeftRight(label, info, leftW);
  }

  private buildFileRow(row: FilesRow, isCursor: boolean, leftW: number): string {
    const T = this.T;
    const arrow = isCursor ? T.accent(T.bold("\u25b6 ")) : "  ";
    let body: string;
    let badge = "";
    // Icon column (Issue #028): one cell when PI_NAV_ICONS is on, zero
    // otherwise. The glyph inherits the name color it sits next to.
    const iconW = this.enableIcons ? 1 : 0;
    const icon = (nameStyle: (t: string) => string) => (iconW ? nameStyle(mapExtensionToIcon(row.node.relPath, row.node.isDir)) + " " : "");

    if (row.kind === "match") {
      const prefixRaw = row.prefix.length > 18 ? "\u2026" + row.prefix.slice(-18) : row.prefix;
      const prefix = T.dim(prefixRaw);
      const name = row.node.name;
      if (row.nameIndex >= 0 && this.filterQuery) {
        const before = name.slice(0, row.nameIndex);
        const hit = name.slice(row.nameIndex, row.nameIndex + this.filterQuery.length);
        const after = name.slice(row.nameIndex + this.filterQuery.length);
        body = icon(T.dim) + prefix + T.text(before) + T.warning(T.bold(hit)) + T.text(after);
      } else {
        body = icon(T.dim) + prefix + T.text(name);
      }
      if (row.node.gitCode) badge = " " + this.codeText(row.node.gitCode);
    } else if (row.node.isDir) {
      const marker = row.node.expanded ? "\u25be " : "\u25b8 ";
      const indent = "  ".repeat(Math.max(0, row.node.depth));
      const nameStyle = hasChanges(row.node) ? T.warning : row.node.hidden ? T.dim : T.muted;
      const label = row.node.name + (row.node.isSymlink ? T.dim(" \u2197") : "");
      // Issue #031: icon sits after the indent so it moves with depth and
      // stays glued to the marker/name it belongs to, instead of floating at
      // a fixed left column that desynchronizes from the indented label.
      body = T.dim(indent) + icon(nameStyle) + T.dim(marker) + nameStyle(label);
    } else {
      const indent = "  ".repeat(Math.max(0, row.node.depth));
      const openPath = this.viewTargetRelPath ?? this.viewFile?.relPath;
      const isOpen = row.node.relPath === openPath;
      let nameStyle = (text: string) => T.text(text);
      if (isOpen) nameStyle = (text: string) => T.accent(T.bold(text));
      else if (row.node.hidden) nameStyle = (text: string) => T.dim(text);
      else if (row.node.gitCode === "??" || row.node.gitCode === "!!") nameStyle = (text: string) => T.dim(text);
      const label = row.node.name + (row.node.isSymlink ? T.dim(" \u2197") : "");
      // Issue #031: same depth-glued icon placement as the dir branch above.
      body = T.dim(indent) + icon(nameStyle) + nameStyle(label);
      if (row.node.gitCode) badge = " " + this.codeText(row.node.gitCode);
    }

    const room = Math.max(4, leftW - 2 - iconW - visibleWidth(badge));
    // Empty ellipsis: truncateToWidth's default "..." is wrapped in \x1b[0m
    // resets that close the styled body's open style and render "..." in bright
    // default. truncate once, measure the result once (Issue #018).
    const fit = truncateAndWidth(body, room);
    const content = arrow + fit.text;
    const gap = Math.max(0, leftW - visibleWidth(arrow) - iconW - fit.width - visibleWidth(badge));
    const line = content + " ".repeat(gap) + badge;
    return isCursor ? T.selectedBg(this.padTo(line, leftW)) : this.padTo(line, leftW);
  }

  private buildGitHeader(leftW: number): string {
    const T = this.T;
    const label = " " + (this.focus === "git" ? T.accent(T.bold("GIT")) : T.dim("GIT"));
    const git = this.git;
    let info = "";
    if (git?.available) {
      info = T.dim(`${git.unstaged.length} unstaged \u00b7 ${git.staged.length} staged`) + " ";
      // Plan section 7: when the tree came from the filesystem walk (empty
      // repository fallback), the panel says so instead of implying git mode.
      if (this.treeSource === "fs") info = T.dim("fs walk") + " ";
    } else {
      info = T.dim(git?.error ?? "unavailable") + " ";
    }
    return this.joinLeftRight(label, info, leftW);
  }

  /**
   * v3 expand/collapse marker for a commit row, mirroring the file pane's dir
   * marker: ▾ when the family is expanded, ▸ when it has in-history parents to
   * reveal, blank for a root (nothing to expand). Marker glyph + space = 2
   * visible cells, same as the dir marker. A root commit gets no marker so the
   * hash column stays aligned with rows that have one.
   */
  private commitMarker(commit: GitCommit): string {
    const hasParents = (commit.parents?.length ?? 0) > 0;
    if (!hasParents) return "  ";
    return this.gitExpanded.has(commit.shortHash) ? "\u25be " : "\u25b8 "; // ▾ / ▸
  }

  private buildGitRow(row: GitRow, selected: boolean, leftW: number): string {
    const T = this.T;
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
      line = " " + tone(row.label);
    } else if (row.kind === "file") {
      const arrow = selected ? T.accent(T.bold("\u25b6 ")) : "  ";
      const nameStyle = selected ? T.text : row.staged ? T.success : T.warning;
      const badge = " " + this.codeText(row.code);
      const room = Math.max(4, leftW - 2 - visibleWidth(badge));
      const fit = truncateAndWidth(nameStyle(row.relPath), room);
      const gap = Math.max(0, leftW - 2 - fit.width - visibleWidth(badge));
      line = arrow + fit.text + " ".repeat(gap) + badge;
    } else if (row.kind === "commit-child") {
      const arrow = selected ? T.accent(T.bold("\u25b6 ")) : "  ";
      const marker = this.commitMarker(row.commit);
      const hash = T.muted(row.commit.shortHash);
      const indentW = 2 * row.depth;
      // Width accounting: arrow(2) + indent(2·depth) + marker(2) + hash + sep(2).
      const room = Math.max(4, leftW - 2 - indentW - 2 - visibleWidth(row.commit.shortHash) - 2);
      const subject = T.dim(truncateToWidth(row.commit.subject, room, ""));
      line = arrow + "  ".repeat(row.depth) + marker + hash + "  " + subject;
    } else {
      const arrow = selected ? T.accent(T.bold("\u25b6 ")) : "  ";
      const marker = this.commitMarker(row.commit);
      const hash = T.muted(row.commit.shortHash);
      // Width accounting: arrow(2) + marker(2) + hash + sep(2).
      const room = Math.max(4, leftW - 2 - 2 - visibleWidth(row.commit.shortHash) - 2);
      const subject = T.dim(truncateToWidth(row.commit.subject, room, ""));
      line = arrow + marker + hash + "  " + subject;
    }
    return selected ? T.selectedBg(this.padTo(line, leftW)) : this.padTo(line, leftW);
  }

  private codeText(code: string): string {
    const T = this.T;
    if (code === "M") return T.warning(code);
    if (code === "A") return T.success(code);
    if (code === "D") return T.error(code);
    if (code === "R") return T.warning(code);
    if (code === "C") return T.success(code);
    if (code === "??") return T.dim("?");
    if (code === "!!") return T.dim("!");
    return T.muted(code);
  }

  // ── Right pane ──

  private buildRightRows(rightW: number, body: number): string[] {
    const isSwitching = this.viewLoading && this.viewTargetRelPath !== null && this.viewTargetRelPath !== this.viewFile?.relPath;
    const file = isSwitching ? null : this.viewFile;

    const canRender = this.canRenderMarkdown(file);
    const useRendered = canRender && this.viewRenderMarkdown;

    let contentW: number;
    let digits = 0;
    if (useRendered && file) {
      contentW = Math.max(10, rightW - 2);
      this.viewHscroll = 0;
    } else if (file) {
      digits = Math.max(2, String(file.lineCount ?? file.lines.length).length);
      const gutterW = digits + 1;
      contentW = Math.max(10, rightW - 2 - (gutterW + 2));
    } else {
      contentW = Math.max(10, rightW - 2);
    }

    if (useRendered && file) {
      const mdLines = this.getRenderedMarkdownLines(file, contentW);
      this.recomputeSearchIfNeeded(mdLines);
    } else {
      this.recomputeSearchIfNeeded();
    }

    const rows: string[] = [];
    const headerRow = this.mode === "search" ? this.buildSearchBar(rightW) : this.buildViewerHeader(rightW);
    rows.push(headerRow);

    const area = Math.max(1, body - 1);

    if (!file && this.viewLoading) {
      for (let i = 0; i < area; i++) rows.push(this.padTo(i === 0 ? " " + this.T.dim("(loading\u2026)") : "", rightW));
      return rows;
    }
    if (!file) {
      for (let i = 0; i < area; i++) rows.push(this.padTo(i === 0 ? " " + this.T.dim("(select a file)") : "", rightW));
      return rows;
    }

    if (file.kind === "binary" || file.kind === "image" || file.kind === "error") {
      rows.push(...this.buildCard(file, rightW, area));
      return rows;
    }

    // Text-like content (v3: `diff` falls through here, so a commit diff gets
    // the same gutter / wrap / scroll / search path as a text file).
    const T = this.T;
    let noticeRows = 0;
    if ((file.kind === "truncated" || file.kind === "diff") && file.notice) noticeRows += 1;
    if (this.diskChanged) noticeRows += 1;
    const contentArea = Math.max(1, area - noticeRows);

    // Optional notices above the content.
    // v3: the diff notice ("commit abc1234 · N files · +I −D") is a summary,
    // not an alert, so it uses T.dim rather than the truncation warning.
    if (file.kind === "truncated" && file.notice) rows.push(this.padTo(" " + T.warning(file.notice), rightW));
    if (file.kind === "diff" && file.notice) rows.push(this.padTo(" " + T.dim(file.notice), rightW));
    if (this.diskChanged) {
      rows.push(this.padTo(" " + T.warning("file changed on disk \u2014 press r to reload"), rightW));
    }

    if (useRendered) {
      const mdLines = this.getRenderedMarkdownLines(file, contentW);

      if (this.searchJump && this.searchMatches.length > 0) {
        const currentMatch = this.searchMatches[this.searchIndex];
        if (currentMatch) {
          this.viewScroll = Math.max(0, currentMatch.line - Math.floor(contentArea / 2));
        }
        this.searchJump = false;
      }
      this.viewScroll = Math.max(0, Math.min(this.viewScroll, Math.max(0, mdLines.length - contentArea)));

      const currentMatch = this.searchMatches.length > 0
        ? this.searchMatches[Math.min(this.searchIndex, this.searchMatches.length - 1)]
        : undefined;
      const currentOccurrenceOnLine = currentMatch
        ? this.searchMatches.filter((m) => m.line === currentMatch.line && m.start < currentMatch.start).length
        : -1;

      for (let i = 0; i < contentArea; i++) {
        const lineIdx = this.viewScroll + i;
        const rawLine = mdLines[lineIdx];
        if (rawLine === undefined) {
          rows.push(this.padTo("", rightW));
          continue;
        }

        let styledLine = rawLine;
        if (this.searchQuery && this.searchMatches.length > 0 && this.searchMatchLines.has(lineIdx)) {
          styledLine = this.markRenderedLineMatches(styledLine, lineIdx, currentMatch, currentOccurrenceOnLine);
        }
        rows.push(this.padTo(" " + styledLine, rightW));
      }
    } else {
      const marked = this.markSearch(file);

      // Clamp horizontal scroll and scroll position. `maxLineWidth` depends only
      // on visible width, which search marking does not change, so it is cached
      // on the stable `file` reference; `computeRows` is cached on the cached
      // `marked` reference plus width/wrap/hscroll, so vertical scrolling no
      // longer re-wraps the whole file each keystroke.
      const maxH = Math.max(0, this.cachedMaxLineWidth(file) - contentW);
      this.viewHscroll = Math.max(0, Math.min(this.viewHscroll, maxH));

      const display = this.cachedComputeRows(marked, contentW, this.viewWrap, this.viewHscroll);
      if (this.searchJump && this.searchMatches.length > 0) {
        const currentMatch = this.searchMatches[this.searchIndex];
        const target = display.findIndex((row) => row.line === currentMatch?.line);
        if (target >= 0) this.viewScroll = Math.max(0, target - Math.floor(contentArea / 2));
        this.searchJump = false;
      }
      this.viewScroll = Math.max(0, Math.min(this.viewScroll, Math.max(0, display.length - contentArea)));

      for (let i = 0; i < contentArea; i++) {
        const row = display[this.viewScroll + i];
        if (!row) {
          rows.push(this.padTo("", rightW));
          continue;
        }
        const gutter = row.line === null ? " ".repeat(digits) + " " : String(row.line + 1).padStart(digits) + " ";
        const line = " " + T.dim(gutter) + T.frame("\u2502") + " " + row.text;
        rows.push(this.padTo(line, rightW));
      }
    }

    return rows;
  }

  private buildViewerHeader(rightW: number): string {
    const T = this.T;
    const isSwitching = this.viewLoading && this.viewTargetRelPath !== null && this.viewTargetRelPath !== this.viewFile?.relPath;
    const currentPath = (isSwitching ? this.viewTargetRelPath : this.viewFile?.relPath) ?? "(no file)";
    const file = isSwitching ? null : this.viewFile;
    // v3: a commit diff shows "commit <hash>" instead of a path — mirrors git
    // show's header and keeps the long commit:<hash> identity string out of
    // the title row.
    const isCommit = (file?.kind === "diff" && file.commitHash) || currentPath.startsWith("commit:");
    const commitHash = file?.commitHash ?? (currentPath.startsWith("commit:") ? currentPath.slice("commit:".length) : "");
    const headerPath = isCommit ? `commit ${commitHash}` : this.shortPath(currentPath);
    const left = " " + (this.focus === "viewer" ? T.accent(T.bold(headerPath)) : T.muted(headerPath));
    const meta: string[] = [];
    if (file) {
      const size = formatSize(file.sizeBytes);
      if (size) meta.push(size);
      if (file.lineCount !== undefined) meta.push(`${file.lineCount}L`);
      if (file.kind === "truncated") meta.push("truncated");
      if (this.canRenderMarkdown(file)) {
        meta.push(this.viewRenderMarkdown ? "m code" : "m render");
      }
      if (!this.viewRenderMarkdown && this.viewWrap) meta.push("wrap");
      if (this.viewHscroll > 0) meta.push(`col ${this.viewHscroll + 1}`);
      if (this.viewLoading) meta.push("loading\u2026");
    } else if (this.viewLoading && currentPath !== "(no file)") {
      meta.push("loading\u2026");
    }
    const right = meta.length > 0 ? T.dim(meta.join(" \u00b7 ")) + " " : " ";
    return this.joinLeftRight(left, right, rightW);
  }

  /**
   * A typed query plus a reverse-video cursor. While the component is focused
   * the hardware cursor marker precedes the fake cursor, which is what lets the
   * terminal position the IME candidate window over it (standards section 2.3).
   */
  private buildInputBar(query: string, placeholder: string, info: string | null, width: number): string {
    const T = this.T;
    const cursor = this.focused ? CURSOR_MARKER + T.text("\u2588") : T.text("\u2588");
    const left = " " + T.text("/" + query) + cursor;
    const right = (info ? T.warning(info) : T.dim(placeholder)) + " ";
    return this.joinLeftRight(left, right, width);
  }

  /** Search bar: replaces the viewer header line while searching. */
  private buildSearchBar(rightW: number): string {
    return this.buildInputBar(
      this.searchQuery,
      MODE_HINTS.search,
      this.searchQuery
        ? `${this.searchMatches.length === 0 ? 0 : this.searchIndex + 1}/${this.searchMatches.length} matches`
        : null,
      rightW,
    );
  }

  /** Filter bar: drawn in the footer row area while filtering. */
  private buildFilterBar(width: number): string {
    return this.buildInputBar(
      this.filterQuery,
      MODE_HINTS.filter,
      this.filterQuery ? `${this.filesRows().length} matches` : null,
      width,
    );
  }

  private recomputeSearchIfNeeded(lines?: string[]): void {
    if (!this.searchQuery) {
      if (this.searchMatches.length > 0) {
        this.searchMatches = [];
        this.searchMatchLines = new Set();
        this.searchVersion++;
      }
      this.searchDirty = false;
      return;
    }
    // Only rerun the full-file scan when the result may be stale (file content
    // changed under an active query). Keystrokes that change the query call
    // `recomputeSearch` directly and clear the dirty flag, so a plain render —
    // e.g. scrolling or moving the cursor — no longer re-scans the file.
    if (this.searchDirty) {
      if (lines) {
        this.recomputeSearchOnLines(lines);
      } else {
        this.recomputeSearch();
      }
    }
  }

  private markSearch(file: ViewerFile): ViewerFile {
    if (!this.searchQuery || this.searchMatches.length === 0) return file;
    // Cache the marked file: it only changes when the file content or the
    // search version (matches / current index) changes.
    if (this.markedCache && this.markedCache.file === file && this.markedCache.version === this.searchVersion) {
      return this.markedCache.marked;
    }
    const currentMatch = this.searchMatches[Math.min(this.searchIndex, this.searchMatches.length - 1)];
    const T = this.T;
    const matchLines = this.searchMatchLines;
    // Compute the per-line occurrence index of the current match so
    // markMatches highlights the Nth occurrence on its line, not always
    // the first (Issue #025).
    const currentOccurrenceOnLine = currentMatch
      ? this.searchMatches
          .filter((m) => m.line === currentMatch.line && m.start < currentMatch.start)
          .length
      : -1;
    const marked = file.lines.map((line, index) => {
      if (!matchLines.has(index)) return line;
      const occ = index === currentMatch?.line ? currentOccurrenceOnLine : -1;
      return markMatches(line, this.searchQuery, T.searchMatch, T.searchCurrent, occ);
    });
    const result = { ...file, lines: marked };
    this.markedCache = { file, version: this.searchVersion, marked: result };
    return result;
  }

  private cachedMaxLineWidth(file: ViewerFile): number {
    if (this.maxLineWidthCache && this.maxLineWidthCache.file === file) return this.maxLineWidthCache.value;
    const value = maxLineWidth(file);
    this.maxLineWidthCache = { file, value };
    return value;
  }

  private cachedComputeRows(
    marked: ViewerFile,
    width: number,
    wrap: boolean,
    hscroll: number,
  ): DisplayRow[] {
    const c = this.rowsCache;
    if (c && c.marked === marked && c.width === width && c.wrap === wrap && c.hscroll === hscroll) return c.rows;
    const rows = computeRows(marked, width, wrap, hscroll);
    this.rowsCache = { marked, width, wrap, hscroll, rows };
    return rows;
  }

  private buildCard(file: ViewerFile, rightW: number, area: number): string[] {
    const T = this.T;
    const title = file.kind === "image" ? "Image" : file.kind === "binary" ? "Binary file" : "Cannot read";
    const titleStyle = file.kind === "error" ? T.error : file.kind === "binary" ? T.warning : T.accent;
    const body: string[] = [file.relPath];
    if (file.message) body.push(file.message);
    if (file.kind === "binary") body.push("binary content is not rendered");
    if (file.kind === "image") body.push("metadata card in v1; native protocol and chafa");
    if (file.kind === "image") body.push("rendering is the plan section 8 spike");
    if (file.kind === "error") body.push("press Tab, then pick another file");

    const contentWidth = Math.max(
      4,
      Math.min(Math.max(4, rightW - 6), Math.max(24, Math.max(...[title, ...body].map((text) => visibleWidth(text))) + 4)),
    );
    const boxW = contentWidth + 2;
    const boxH = body.length + 2;
    const topPad = Math.max(0, Math.floor((area - boxH) / 2));
    const leftPad = Math.max(0, Math.floor((rightW - boxW) / 2));

    const out: string[] = [];
    const blank = (text: string) => " ".repeat(leftPad) + text + " ".repeat(Math.max(0, rightW - leftPad - visibleWidth(text)));
    const borderRow = (left: string, fill: string, right: string) =>
      blank(T.frame(left + fill.repeat(Math.max(0, boxW - 2)) + right));
    for (let i = 0; i < topPad; i++) out.push(blank(""));
    out.push(borderRow("\u250c", "\u2500", "\u2510"));
    // Interior = 1 space + " title " + padding = contentWidth, so the title row
    // is exactly as wide as the border rows (boxW = contentWidth + 2).
    const titlePad = Math.max(0, contentWidth - visibleWidth(title) - 3);
    out.push(blank(T.frame("\u2502") + " " + titleStyle(T.bold(" " + title + " ")) + " ".repeat(titlePad) + T.frame("\u2502")));
    for (const text of body) {
      // Empty ellipsis: the default "..." is wrapped in \x1b[0m resets that
      // would close the T.muted span and render "..." in bright default.
      // Truncate once and reuse the measured width so the padding matches.
      const cell = truncateAndWidth(text, Math.max(0, contentWidth - 1));
      out.push(
        blank(T.frame("\u2502") + " " + T.muted(cell.text) + " ".repeat(Math.max(0, contentWidth - 1 - cell.width)) + T.frame("\u2502")),
      );
    }
    out.push(borderRow("\u2514", "\u2500", "\u2518"));
    while (out.length < area) out.push(this.padTo("", rightW));
    return out.slice(0, area).map((row) => this.padTo(row, rightW));
  }

  // ── Help modal ──

  private composeHelp(lines: string[], innerW: number, body: number): void {
    const T = this.T;
    const boxW = Math.min(innerW - 2, 66);
    const visibleRows = this.helpVisibleRows(body);
    const boxH = visibleRows + 3;
    const startRow = Math.max(0, Math.floor((body - boxH) / 2));
    const colPad = Math.max(0, Math.floor((innerW - boxW) / 2));
    // The same limit the input handler clamps against, and written back so the
    // stored offset can never sit past what the modal can show.
    const scroll = Math.max(0, Math.min(this.helpScroll, this.helpMaxScroll()));
    this.helpScroll = scroll;

    const modal: string[] = [];
    const inner = (text: string) => {
      const padded = this.padTo(text, boxW - 2);
      return T.frame("\u2502") + padded + T.frame("\u2502");
    };
    modal.push(T.frame("\u250c" + "\u2500".repeat(boxW - 2) + "\u2510"));
    modal.push(inner(" " + T.accent(T.bold("pi-navigator \u2014 keys"))));
    for (let i = 0; i < visibleRows; i++) {
      const row = HELP_ROWS[scroll + i];
      if (!row) {
        modal.push(inner(""));
        continue;
      }
      const [keys, description] = row;
      const keyCell = T.accent(keys.padEnd(16));
      // Row layout is " " + keyCell(16) + " " + descCell inside the boxW-2
      // inner area, so the description gets boxW-20 columns (the prior
      // boxW-22 cut two columns too early). truncateToWidth's default ellipsis
      // wraps "..." in \x1b[0m resets; wrapping that in T.muted() would close
      // the muted span before the ellipsis and render "..." in bright default,
      // breaking the dim modal at narrow widths. Truncate with no ellipsis,
      // strip the injected reset, and append our own ellipsis so the indicator
      // stays inside the muted style.
      const descWidth = boxW - 20;
      let descCell = description;
      if (visibleWidth(description) > descWidth) {
        const cut = truncateToWidth(description, Math.max(1, descWidth - 1), "").replace(/\x1b\[[0-9;]*m/g, "");
        descCell = cut + "\u2026";
      }
      modal.push(inner(" " + keyCell + " " + T.muted(descCell)));
    }
    modal.push(T.frame("\u2514" + "\u2500".repeat(boxW - 2) + "\u2518"));

    for (let i = 0; i < modal.length; i++) {
      const target = 3 + startRow + i; // lines[0..2] are top, title, separator
      if (target >= lines.length - 1) break;
      const modalRow = modal[i];
      if (modalRow === undefined) continue;
      const rowInner = " ".repeat(colPad) + modalRow + " ".repeat(Math.max(0, innerW - colPad - visibleWidth(modalRow)));
      lines[target] = T.frame("\u2502") + this.padTo(rowInner, innerW) + T.frame("\u2502");
    }
  }

  // ── Small helpers ──

  private padTo(content: string, width: number): string {
    const vw = visibleWidth(content);
    if (vw < width) return content + " ".repeat(width - vw);
    // Empty ellipsis: truncateToWidth's default "..." is wrapped in \x1b[0m
    // resets that close any open style and render the ellipsis in bright
    // default (visible against dim text). Hard-cut with a single clean reset.
    return truncateToWidth(content, width, "");
  }

  private shortPath(path: string): string {
    const home = this.home;
    let shortened = path;
    if (home && (path === home || path.startsWith(home))) {
      shortened = "~" + path.slice(home.length);
    }
    if (shortened.length > 48) shortened = "\u2026" + shortened.slice(shortened.length - 47);
    return shortened;
  }
}
