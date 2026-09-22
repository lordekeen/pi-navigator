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
  decodeKittyPrintable,
  Key,
  Markdown,
  matchesKey,
  type Focusable,
} from "@earendil-works/pi-tui";

import {
  FAMILY_MAX_DEPTH,
  HALF_PAGE_DIVISOR,
  IMAGE_EXTENSIONS,
  IMAGE_RESIZE_DEBOUNCE_MS,
  MIN_OVERLAY_HEIGHT,
  MIN_OVERLAY_WIDTH,
} from "./constants";
import { NAVIGATOR_KEYBINDINGS } from "./help";
import { buildFilesHeader, buildFileRow, buildFilesRows } from "./files_view";
import {
  bodyRows,
  buildFooterRow,
  buildTitleRow,
  filesArea,
  leftColumnWidth,
  overlayHeight,
  padTo,
  splitRows,
  useLeftColumn,
  viewerArea,
} from "./frame";
import { buildGitHeader, buildGitRow, buildGitNavRows, buildGitRows } from "./git_view";
import {
  composeHelp,
  helpMaxScroll as computeHelpMaxScroll,
  helpVisibleRows as computeHelpVisibleRows,
} from "./help_view";
import { makeDeferredImageSupport, resolveChafaGeometry, type ImageSupport } from "./images";
import { expandAncestors, findNode, moveCursor, pageJump } from "./tree";
import type { NavigatorTheme } from "./theme";
import type { FileNode, FilesRow, Focus, GitRow, GitState, InputMode, SearchMatch, ViewerFile } from "./types";
import {
  computeRows,
  extOf,
  markMatches,
  maxLineWidth,
  searchLines,
  type DisplayRow,
  type LoadFileOptions,
} from "./viewer";
import {
  buildFilterBar,
  canRenderMarkdown,
  paneContentArea,
  paneContentWidth,
  renderViewerPane,
  type ViewerPaneView,
} from "./viewer_view";

/**
 * Support fingerprint for setImageSupport upgrade detection (D9): the knobs
 * that change what a chafa render looks like. A fingerprint change on an
 * already-rendered image triggers a debounced reflow; loading uses the
 * variant key in index.ts for the cache.
 */
function supportFingerprint(s: ImageSupport): string {
  return [
    s.active ? "1" : "0",
    s.config.binaryPath ?? "",
    s.config.colors,
    s.config.symbolsSet,
    s.config.dither,
    String(s.config.timeoutMs),
    String(s.config.cellWidth),
    String(s.config.maxRows),
  ].join(":");
}

export interface NavigatorOptions {
  cwd: string;
  theme: NavigatorTheme;
  getTerminalRows: () => number;
  requestRender: () => void;
  onClose: () => void;
  /** Optional geometry hint for image loads (chafa render seam). */
  loadFile: (relPath: string, opts?: LoadFileOptions) => Promise<ViewerFile>;
  /** v3: open a commit's diff in the viewer. Optional — when absent, Enter on
   *  a commit falls back to toggling its family (keeps harnesses green). */
  loadCommit?: (shortHash: string) => Promise<ViewerFile>;
  refresh: () => void;
  /** Opt into the Nerd Font icon column (Issue #028). Defaults to false. */
  enableIcons?: boolean;
  /** Home directory for tilde shortening (Issue #039). Defaults to empty string. */
  home?: string;
  /** Initial image-support snapshot (tests inject; index.ts passes a deferred one). */
  imageSupport?: ImageSupport;
  /** Start with hidden files visible (Issue #061; settings). Defaults to false. */
  initialShowHidden?: boolean;
  /** Start with word wrap enabled (Issue #061; settings). Defaults to false. */
  initialWrap?: boolean;
  /** Start with Markdown files rendered (Issue #061; settings). Defaults to false. */
  initialRenderMarkdown?: boolean;
}

/**
 * The in-overlay `?` modal rows, derived from the shared keybinding table in
 * help.ts so the modal and the durable /navigator help entry cannot drift
 * (Issue #063 finding 5). Exported so the help suite can assert the modal is
 * exactly the shared table's projection.
 */
export const HELP_ROWS: Array<[string, string]> = NAVIGATOR_KEYBINDINGS.map((row) => [row.keys, row.description]);

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
  private loadFile: (relPath: string, opts?: LoadFileOptions) => Promise<ViewerFile>;
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
  // In-place tree mutation goes through toggleDir/expandTo only, which bump this (Issue #064).
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

  /** Resolved image-support snapshot (§6.4); deferred until index.ts resolves. */
  private imageSupport: ImageSupport;
  /** Session-only `i` toggle: show the metadata card for a chafa-capable image. */
  private imageAsCard = false;
  /** Pane snapshot recorded by the last layout pass (pure bookkeeping, §7.5). */
  private lastViewerLayout: { cols: number; rows: number } | null = null;
  /** Debounced re-render timer (D10); cleared by dispose(). */
  private reflowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fingerprint of the last installed support (setImageSupport upgrade detection). */
  private lastSupportFingerprint: string;

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
    this.imageSupport = options.imageSupport ?? makeDeferredImageSupport("off");
    this.lastSupportFingerprint = supportFingerprint(this.imageSupport);
    // Settings-landed initial state (Issue #061): defaults preserve the
    // session-toggle behavior of prior versions exactly.
    this.showHidden = options.initialShowHidden ?? false;
    this.viewWrap = options.initialWrap ?? false;
    this.viewRenderMarkdown = options.initialRenderMarkdown ?? false;
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
    // One-time, non-blocking hint when the user opted into Nerd Font icons
    // (Issue #028): glyphs depend on a terminal Nerd Font, which pi cannot
    // detect. Fired from the setter, not render(), so the render path stays
    // free of state mutations and re-render requests (cf. #053); the
    // iconsNoticeShown guard makes it run exactly once.
    if (this.enableIcons && !this.iconsNoticeShown) {
      this.iconsNoticeShown = true;
      this.showNotice("nerd icons on \u2014 glyphs may not render without a Nerd Font");
    }
    this.touch();
  }

  /** Install a new git state, keeping the git cursor in range. */
  setGitState(git: GitState): void {
    this.git = git;
    this.gitCursor = moveCursor(this.gitNavRows().length, this.gitCursor, 0);
    this.touch();
  }

  /**
   * Install a resolved image-support snapshot (D9). Matches the setter
   * contract: assign, then reflow a displayed image when the change can
   * upgrade its rendering (deferred → ok, or a knob fingerprint change on an
   * already-rendered image); always touch so the header badge and card hints
   * refresh. The reflow is debounced and no-ops if the file changed.
   */
  setImageSupport(support: ImageSupport): void {
    const previousFingerprint = this.lastSupportFingerprint;
    this.imageSupport = support;
    const fingerprint = supportFingerprint(support);
    this.lastSupportFingerprint = fingerprint;
    if (
      support.active &&
      this.viewFile?.kind === "image" &&
      !this.imageAsCard &&
      (this.viewFile.imageTier !== "chafa" || fingerprint !== previousFingerprint)
    ) {
      this.scheduleReflow(this.viewFile.relPath);
    }
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
        // The `i` toggle is session-only and scoped to one open file (D8).
        this.imageAsCard = false;
        this.searchQuery = "";
        this.searchMatches = [];
        this.searchIndex = 0;
      }
    }
    this.touch();
    this.requestRender();

    try {
      const geometry = this.currentImageGeometry();
      const loadOpts =
        this.imageSupport.active && IMAGE_EXTENSIONS.has(extOf(relPath)) && geometry !== null
          ? { image: geometry }
          : undefined;
      const file = await this.loadFile(relPath, loadOpts);
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
    if (this.reflowTimer) {
      clearTimeout(this.reflowTimer);
      this.reflowTimer = null;
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
    const rows = buildFilesRows(root, query, hidden);
    this.filesRowsCache = { root, query, hidden, version: this.treeVersion, rows };
    return rows;
  }

  private gitRows(): GitRow[] {
    const git = this.git;
    const c = this.gitRowsCache;
    if (c && c.git === git && c.version === this.gitTreeVersion) return c.rows;
    const rows = buildGitRows(git, this.gitExpanded);
    this.gitRowsCache = { git, version: this.gitTreeVersion, rows };
    return rows;
  }

  private gitNavRows(): GitRow[] {
    const git = this.git;
    const c = this.gitNavRowsCache;
    if (c && c.git === git && c.version === this.gitTreeVersion) return c.rows;
    const rows = buildGitNavRows(this.gitRows());
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

  /**
   * Toggle `node.expanded` (or set it to `expanded` when given). The only
   * in-place files-tree mutation entry point: treeVersion is bumped here so
   * a future caller cannot stale the filesRowsCache (Issue #064 finding 2).
   * touch() is idempotent (clears the render cache), so the calling handler's
   * own trailing touch() stays harmless — no double render.
   */
  private toggleDir(node: FileNode, expanded?: boolean): void {
    node.expanded = expanded === undefined ? !node.expanded : expanded;
    this.treeVersion++;
    this.touch();
  }

  /** Expand `node` and its ancestors (git-pane Enter on a file row, Issue #064). */
  private expandTo(node: FileNode): void {
    expandAncestors(node);
    this.treeVersion++;
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
    const area = filesArea(this.getTerminalRows());
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
        this.toggleDir(current.node);
      } else if (current && current.kind !== "dir") {
        this.focus = "viewer";
        void this.openRelPath(current.node.relPath);
      }
    } else if (matchesKey(data, Key.right) || data === "l") {
      if (current?.node.isDir) {
        this.toggleDir(current.node, true);
      }
    } else if (matchesKey(data, Key.left) || data === "h") {
      if (current?.node.isDir) {
        this.toggleDir(current.node, false);
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
          if (node) this.expandTo(node);
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
    const file = this.viewFile;
    const area = viewerArea(this.getTerminalRows());
    const half = Math.max(1, Math.ceil(area / HALF_PAGE_DIVISOR));
    // A rendered chafa image is pre-styled content: wrap/hscroll/search are
    // meaningless, so w, h/l, /, n/N are inert on it (rendered-markdown
    // precedent, Issue #053); only the scrolling keys and `i` act (§7.5).
    const renderedImage =
      file !== null &&
      file.kind === "image" &&
      file.imageTier === "chafa" &&
      !this.imageAsCard &&
      (file.imageLines?.length ?? 0) > 0;
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
      if (renderedImage) {
        this.showNotice("search is not available for rendered images");
        return;
      }
      this.mode = "search";
      this.searchQuery = "";
      this.searchMatches = [];
      this.searchIndex = 0;
    } else if (data === "n") {
      if (renderedImage) return;
      this.cycleSearch(1);
    } else if (data === "N") {
      if (renderedImage) return;
      this.cycleSearch(-1);
    } else if (data === "w") {
      if (renderedImage) return;
      if (this.viewRenderMarkdown && canRenderMarkdown(this.viewFile)) {
        return;
      }
      this.viewWrap = !this.viewWrap;
      this.viewHscroll = 0;
    } else if (data === "m") {
      if (canRenderMarkdown(this.viewFile)) {
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
    } else if (data === "i") {
      // D8 toggle: chafa render ⇄ metadata card (session-only, reset on file
      // change). A card showing under active support re-requests the render
      // instead of toggling, so `i` is always the "image rendering" verb.
      if (!file || file.kind !== "image") return;
      if (file.imageTier === "chafa" && (file.imageLines?.length ?? 0) > 0) {
        this.imageAsCard = !this.imageAsCard;
      } else if (this.imageSupport.active) {
        this.imageAsCard = false;
        void this.openRelPath(file.relPath, true);
        return;
      } else {
        return;
      }
    } else if (matchesKey(data, Key.left) || data === "h") {
      if (renderedImage) return;
      if (this.viewRenderMarkdown && canRenderMarkdown(this.viewFile)) return;
      this.viewHscroll = Math.max(0, this.viewHscroll - 4);
    } else if (matchesKey(data, Key.right) || data === "l") {
      if (renderedImage) return;
      if (this.viewRenderMarkdown && canRenderMarkdown(this.viewFile)) return;
      this.viewHscroll += 4;
    } else {
      return;
    }
    this.touch();
  }

  // ── Actions ──

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
    const lines = rawLines.map((line) => padTo(line, width));

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
    if (this.viewRenderMarkdown && canRenderMarkdown(this.viewFile) && this.mdCache) {
      this.recomputeSearchOnLines(this.mdCache.lines);
      return;
    }
    const lines = this.viewFile?.lines ?? [];
    this.recomputeSearchOnLines(lines);
  }

  private recomputeSearchOnLines(lines: string[]): void {
    this.searchMatches = searchLines(lines, this.searchQuery);
    this.searchMatchLines = new Set(this.searchMatches.map((m) => m.line));
    if (this.searchIndex >= this.searchMatches.length) {
      this.searchIndex = Math.max(0, this.searchMatches.length - 1);
    }
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

  /** Help rows that fit. Shared by the input clamp and the renderer. */
  private helpVisibleRows(body = bodyRows(overlayHeight(this.getTerminalRows()))): number {
    return computeHelpVisibleRows(body, HELP_ROWS.length);
  }

  /** Single source of truth for the help scroll limit. */
  private helpMaxScroll(): number {
    return computeHelpMaxScroll(HELP_ROWS.length, this.helpVisibleRows());
  }

  /**
   * Chafa geometry for the current pane snapshot (§7.2). The chafa branch
   * has no gutter, so paneCols is the full right panel width (rev. 2
   * amendment 3). Null when no frame has been laid out yet (render() records
   * lastViewerLayout) or when the pane rejects the render (narrow/short) —
   * the card wins in both cases. Pane-only: support capability is judged by
   * the callers (openRelPath gates on active; imageCardHints ladders from
   * the pane before the capability states).
   */
  private currentImageGeometry(): { cols: number; rows: number } | null {
    if (!this.lastViewerLayout) return null;
    const resolved = resolveChafaGeometry({
      paneCols: this.lastViewerLayout.cols,
      paneRows: this.lastViewerLayout.rows,
      preferredCols: this.imageSupport.config.cellWidth,
      maxRows: this.imageSupport.config.maxRows,
    });
    return resolved.ok ? { cols: resolved.cols, rows: resolved.rows } : null;
  }

  /**
   * Debounced re-open of a chafa image at the current pane geometry (D10).
   * One timer at a time; the callback re-checks everything that could have
   * changed since scheduling (dispose, support, file), so a stale reflow is
   * a no-op. dispose() clears the timer outright.
   */
  private scheduleReflow(relPath: string): void {
    if (this.disposed || this.reflowTimer !== null) return;
    this.reflowTimer = setTimeout(() => {
      this.reflowTimer = null;
      if (
        !this.disposed &&
        this.imageSupport.active &&
        this.viewFile?.relPath === relPath &&
        this.viewFile.kind === "image"
      ) {
        void this.openRelPath(relPath, true);
      }
    }, IMAGE_RESIZE_DEBOUNCE_MS);
  }

  /**
   * Resize detection (D10): when the open file is a rendered chafa image
   * whose recorded geometry no longer matches the pane, schedule a debounced
   * re-render. Runs at the end of a fresh render pass; schedules only — no
   * user-visible state is mutated during render (Issue #053). Stale rows stay
   * clipped by the render clamp until the reflow lands.
   */
  private maybeScheduleResizeReflow(): void {
    const file = this.viewFile;
    if (!file || this.viewLoading || this.imageAsCard) return;
    if (file.kind !== "image" || file.imageTier !== "chafa" || (file.imageLines?.length ?? 0) === 0) return;
    if (!this.imageSupport.active) return;
    const geometry = this.currentImageGeometry();
    if (!geometry) return;
    if (geometry.cols === file.imageCols && geometry.rows === file.imageRows) return;
    this.scheduleReflow(file.relPath);
  }

  // ── Render ──

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const T = this.T;
    const overlayH = overlayHeight(this.getTerminalRows());
    const innerW = Math.max(0, width - 2);

    if (width < MIN_OVERLAY_WIDTH || overlayH < MIN_OVERLAY_HEIGHT) {
      // Compact notice for terminals that cannot host the frame. Every line is
      // clipped to `width`, so the notice is width-safe like the frame.
      const barW = Math.max(0, width - 2);
      const notice = (text: string) =>
        padTo(T.frame("\u2502") + padTo(text, barW) + T.frame("\u2502"), width);
      const lines = [
        padTo(T.frame("\u250c" + "\u2500".repeat(barW) + "\u2510"), width),
        notice(T.warning(" terminal too small for pi-navigator ")),
        padTo(T.frame("\u2514" + "\u2500".repeat(barW) + "\u2518"), width),
      ];
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }
    const body = bodyRows(overlayH);
    const withLeft = useLeftColumn(innerW, body, this.showTree);
    const leftW = withLeft ? leftColumnWidth(innerW) : 0;
    const rightW = withLeft ? innerW - leftW - 1 : innerW;
    const { filesH } = splitRows(body);

    const leftRows = withLeft ? this.buildLeftRows(leftW, filesH, body) : null;
    const rightRows = this.buildRightRows(rightW, body);
    this.maybeScheduleResizeReflow();

    const lines: string[] = [];
    lines.push(T.frame("\u250c" + "\u2500".repeat(innerW) + "\u2510"));
    lines.push(
      T.frame("\u2502") +
        buildTitleRow(innerW, { theme: T, cwd: this.cwd, git: this.git, home: this.home }) +
        T.frame("\u2502"),
    );
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

    // While filtering, the footer row area carries the filter bar instead of
    // the plain hints (plan section 3.6 item 6).
    const footerRow =
      this.mode === "filter"
        ? buildFilterBar(innerW, {
            theme: T,
            focused: this.focused,
            filterQuery: this.filterQuery,
            matchCount: this.filesRows().length,
          })
        : buildFooterRow(innerW, { theme: T, mode: this.mode, focus: this.focus, notice: this.notice });
    lines.push(T.frame("\u2502") + footerRow + T.frame("\u2502"));
    lines.push(T.frame("\u2514" + "\u2500".repeat(innerW) + "\u2518"));

    if (this.mode === "help") {
      // Same limit the input handler clamps against, written back so the
      // stored offset can never sit past what the modal can show.
      const scroll = Math.max(0, Math.min(this.helpScroll, this.helpMaxScroll()));
      this.helpScroll = scroll;
      composeHelp(lines, innerW, body, { theme: T, helpRows: HELP_ROWS, helpScroll: scroll });
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  // ── Left column ──

  private buildLeftRows(leftW: number, filesH: number, body: number): string[] {
    const rows: string[] = [];
    const filesRowModel = this.filesRows();
    const filesAreaRows = Math.max(1, filesH - 1);
    this.ensureFilesCursorVisibleFor(filesRowModel.length, filesAreaRows);

    const filesCtx = {
      theme: this.T,
      enableIcons: this.enableIcons,
      filterQuery: this.filterQuery,
      openRelPath: this.viewTargetRelPath ?? this.viewFile?.relPath ?? null,
      filesCursor: this.filesCursor,
      focus: this.focus,
    };
    rows.push(buildFilesHeader(leftW, filesRowModel.length, filesCtx));
    for (let i = 0; i < filesAreaRows; i++) {
      const index = this.filesScroll + i;
      const row = filesRowModel[index];
      rows.push(row ? buildFileRow(row, index === this.filesCursor, leftW, filesCtx) : padTo("", leftW));
    }

    // Placeholder so git rows start at index filesH + 1; the horizontal
    // separator row is drawn by render() and must not consume a data row.
    rows.push(padTo("", leftW));

    const gitRowModel = this.gitRows();
    const navRows = this.gitNavRows();
    const gitArea = Math.max(1, body - filesH - 1 - 1);
    this.ensureGitCursorVisibleFor(gitRowModel, navRows, gitArea);

    rows.push(buildGitHeader(leftW, { theme: this.T, focus: this.focus, git: this.git, treeSource: this.treeSource }));
    // A dim … in the last slot when git rows continue below the window, unless
    // that slot holds the selection (plan section 3.6 item 4).
    const lastIndex = this.gitScroll + gitArea - 1;
    const selectedRow = navRows[this.gitCursor];
    const selectedIndex = selectedRow ? gitRowModel.indexOf(selectedRow) : -1;
    const markerIndex = gitRowModel.length > lastIndex + 1 && selectedIndex !== lastIndex ? lastIndex : -1;
    const gitCtx = { theme: this.T, expanded: this.gitExpanded };
    for (let i = 0; i < gitArea; i++) {
      const index = this.gitScroll + i;
      if (index === markerIndex) {
        rows.push(padTo(" " + this.T.dim("\u2026"), leftW));
        continue;
      }
      const row = gitRowModel[index];
      if (!row) {
        rows.push(padTo("", leftW));
        continue;
      }
      rows.push(buildGitRow(row, index === selectedIndex, leftW, gitCtx));
    }

    return rows;
  }

  private ensureFilesCursorVisibleFor(total: number, area: number): void {
    if (this.filesCursor < this.filesScroll) this.filesScroll = this.filesCursor;
    if (this.filesCursor >= this.filesScroll + area) this.filesScroll = this.filesCursor - area + 1;
    this.filesScroll = Math.max(0, Math.min(this.filesScroll, Math.max(0, total - area)));
  }

  private ensureFilesCursorVisible(): void {
    this.ensureFilesCursorVisibleFor(this.filesRows().length, filesArea(this.getTerminalRows()));
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

  // ── Right pane ──

  private buildRightRows(rightW: number, body: number): string[] {
    const isSwitching = this.viewLoading && this.viewTargetRelPath !== null && this.viewTargetRelPath !== this.viewFile?.relPath;
    const file = isSwitching ? null : this.viewFile;

    const canRender = canRenderMarkdown(file);
    const useRendered = canRender && this.viewRenderMarkdown;

    const { contentW, digits } = paneContentWidth(file, useRendered, rightW);

    const mdLines = useRendered && file ? this.getRenderedMarkdownLines(file, contentW) : null;
    if (mdLines) {
      this.recomputeSearchIfNeeded(mdLines);
    } else {
      this.recomputeSearchIfNeeded();
    }

    const area = Math.max(1, body - 1);
    // Pane snapshot for chafa geometry. The chafa branch has no gutter, so
    // the pane is the full right panel width (rev. 2 amendment 3). Pure
    // bookkeeping — no user-visible state is touched during render (Issue
    // #053).
    this.lastViewerLayout = { cols: rightW, rows: area };

    // Precompute the content the pure renderer lays out. Every cache write,
    // clamp and searchJump mutation stays here, in the original order; the
    // pure viewer renderer only pads and joins the already-computed rows.
    let mdContent: Array<string | null> | null = null;
    let display: DisplayRow[] | null = null;
    let imageLines: string[] | null = null;

    if (file) {
      const chafaRender =
        file.kind === "image" &&
        file.imageTier === "chafa" &&
        (file.imageLines?.length ?? 0) > 0 &&
        !this.imageAsCard;
      const isCard =
        file.kind === "binary" ||
        file.kind === "error" ||
        (file.kind === "image" && (file.imageTier !== "chafa" || this.imageAsCard));

      if (chafaRender) {
        // Chafa render branch: no gutter, no wrap, no hscroll, no search
        // (§7.5). viewScroll clamps exactly like the text path (render-time
        // clamp keeps the frame valid between a resize and its debounced
        // reflow, D10).
        const imageRows = file.imageLines ?? [];
        this.viewScroll = Math.max(0, Math.min(this.viewScroll, Math.max(0, imageRows.length - area)));
        imageLines = imageRows;
      } else if (!isCard) {
        const { contentArea } = paneContentArea(area, file, this.diskChanged);

        if (useRendered && mdLines) {
          if (this.searchJump && this.searchMatches.length > 0) {
            const currentMatch = this.searchMatches[this.searchIndex];
            if (currentMatch) {
              this.viewScroll = Math.max(0, currentMatch.line - Math.floor(contentArea / 2));
            }
            this.searchJump = false;
          }
          this.viewScroll = Math.max(0, Math.min(this.viewScroll, Math.max(0, mdLines.length - contentArea)));

          const currentMatch =
            this.searchMatches.length > 0
              ? this.searchMatches[Math.min(this.searchIndex, this.searchMatches.length - 1)]
              : undefined;
          const currentOccurrenceOnLine = currentMatch
            ? this.searchMatches.filter((m) => m.line === currentMatch.line && m.start < currentMatch.start).length
            : -1;

          // Pre-style the rendered-markdown content rows: per-line search
          // marking stays in the class (markRenderedLineMatches), the pure
          // renderer just pads the pre-styled results.
          mdContent = [];
          for (let i = 0; i < contentArea; i++) {
            const lineIdx = this.viewScroll + i;
            const rawLine = mdLines[lineIdx];
            if (rawLine === undefined) {
              mdContent.push(null);
              continue;
            }
            let styledLine = rawLine;
            if (this.searchQuery && this.searchMatches.length > 0 && this.searchMatchLines.has(lineIdx)) {
              styledLine = this.markRenderedLineMatches(styledLine, lineIdx, currentMatch, currentOccurrenceOnLine);
            }
            mdContent.push(styledLine);
          }
        } else {
          const marked = this.markSearch(file);

          // Clamp horizontal scroll and scroll position. `maxLineWidth` depends
          // only on visible width, which search marking does not change, so it
          // is cached on the stable `file` reference; `computeRows` is cached
          // on the cached `marked` reference plus width/wrap/hscroll, so
          // vertical scrolling no longer re-wraps the whole file each
          // keystroke.
          // Clamp before the header is built (Issue #065): the `col N` badge
          // reads this.viewHscroll after this point, so badge and body agree.
          const maxH = Math.max(0, this.cachedMaxLineWidth(file) - contentW);
          this.viewHscroll = Math.max(0, Math.min(this.viewHscroll, maxH));

          display = this.cachedComputeRows(marked, contentW, this.viewWrap, this.viewHscroll);
          if (this.searchJump && this.searchMatches.length > 0) {
            const currentMatch = this.searchMatches[this.searchIndex];
            const target = display.findIndex((row) => row.line === currentMatch?.line);
            if (target >= 0) this.viewScroll = Math.max(0, target - Math.floor(contentArea / 2));
            this.searchJump = false;
          }
          this.viewScroll = Math.max(0, Math.min(this.viewScroll, Math.max(0, display.length - contentArea)));
        }
      }
    }

    const view: ViewerPaneView = {
      theme: this.T,
      focus: this.focus,
      home: this.home,
      focused: this.focused,
      file,
      loading: this.viewLoading,
      switching: isSwitching,
      targetRelPath: this.viewTargetRelPath,
      diskChanged: this.diskChanged,
      searchMode: this.mode === "search",
      renderMarkdown: this.viewRenderMarkdown,
      renderedMode: useRendered,
      mdContent,
      display,
      digits,
      viewScroll: this.viewScroll,
      wrap: this.viewWrap,
      // Post-clamp by construction (Issue #065): the text branch above has
      // already clamped this.viewHscroll, so the badge reports the same offset
      // the body rows were rendered at. Moving this record above the clamp
      // would re-introduce the divergent badge.
      hscroll: this.viewHscroll,
      imageLines,
      imageAsCard: this.imageAsCard,
      imageSupport: this.imageSupport,
      imageGeometry: this.currentImageGeometry(),
      searchQuery: this.searchQuery,
      searchMatches: this.searchMatches,
      searchIndex: this.searchIndex,
    };
    return renderViewerPane(view, rightW, area);
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

}
