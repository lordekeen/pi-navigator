/**
 * pi-navigator overlay component.
 *
 * Composes the frame, the files pane, the git panel, the viewer pane, the
 * footer and the help modal. Implements the locked keymap from
 * plans/pi-navigator-implementation-plan.md section 4.
 *
 * All data arrives through setters that follow the plan section 3.6 contract
 * (setTree / setGitState / setImageSupport); the viewer's state is installed
 * by openTarget(), which owns its async load. This class owns UI state only
 * and never touches the filesystem or git directly — the render path stays
 * pure and the async work stays in `session.ts` (Issue #140).
 */

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  type Focusable,
  type KeybindingsManager,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import {
  FAMILY_MAX_DEPTH,
  HALF_PAGE_DIVISOR,
  IMAGE_CELLS_MIN,
  IMAGE_EXTENSIONS,
  IMAGE_ROWS_MIN,
  MIN_OVERLAY_HEIGHT,
  MIN_OVERLAY_WIDTH,
} from "./constants";
import { restyleDiffViewerFile } from "./diff";
import {
  DEFAULT_NAVIGATOR_SETTINGS,
  type NavigatorMinimapEncoding,
  type NavigatorMinimapPalette,
} from "./settings";
import { NAVIGATOR_KEYBINDINGS } from "./help";
import { buildFilesHeader, buildFileRow, buildFilesRows, filesEmptyRow } from "./files_view";
import { buildCompactFrame, buildFooterRow, composeFrame, FRAME_TOP_ROWS, padTo } from "./frame";
import { buildGitHeader, buildGitRow, buildGitNavRows, buildGitRows } from "./git_view";
import {
  bodyRows,
  cycleFocus,
  filesArea,
  gitArea,
  initialFocus,
  layoutPanes,
  layoutRows,
  leftColumnWidth,
  overlayHeight,
  paneArea,
  useLeftColumn,
  viewerArea,
} from "./layout";
import {
  composeHelp,
  helpMaxScroll as computeHelpMaxScroll,
  helpVisibleRows as computeHelpVisibleRows,
} from "./help_view";
import { makeDeferredImageSupport, resolveChafaGeometry, type ImageSupport } from "./images";
import { expandAncestors, moveCursor, pageJump, setExpanded } from "./tree";
import type { NavigatorTheme } from "./theme";
import type {
  FileNode,
  FilesRow,
  Focus,
  GitRow,
  GitState,
  ImageVerdict,
  InputMode,
  NavigatorLayout,
  OpenTarget,
  ViewerFile,
  ViewerScrollWindow,
} from "./types";
import {
  extOf,
  restyleViewerFile,
  type LoadFileOptions,
} from "./viewer";
import { sameTarget, targetOf, targetPath } from "./open_target";
import {
  buildFilterBar,
  canRenderMarkdown,
  renderViewerPane,
  type ViewerPaneView,
  type ViewerWindow,
} from "./viewer_view";
import { ViewerModel } from "./viewer_model";
import type { MinimapSketch } from "./minimap_view";

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
  /** Host keybinding seam (Issues #125/#126): the KeybindingsManager the host
   *  injects into the ctx.ui.custom factory. Consulted for host-owned actions
   *  only — cancel matches "tui.select.cancel", which covers Esc, Ctrl+C and
   *  any user remap in one call. Optional: when absent, cancel falls back to
   *  the literal Esc match, so harnesses that construct the overlay without
   *  it keep their exact behavior. */
  keybindings?: KeybindingsManager;
  refresh: () => void;
  /**
   * Pane-geometry drift reporter (Issue #144): when a displayed rendered
   * image's recorded geometry no longer matches the pane, the overlay calls
   * this once per fresh render pass. The session owns the debounce, the
   * re-arm-while-loading rule and the re-open; harnesses that omit it simply
   * observe the drift detection as a no-op. */
  onImageViewChanged?: () => void;
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
  /** Minimap encoding (Issue #165; settings). Defaults to "braille". */
  initialMinimap?: NavigatorMinimapEncoding;
  /** Minimap palette (Issue #165; settings). Defaults to "mono". */
  initialMinimapColors?: NavigatorMinimapPalette;
  /** Minimap width in columns (Issue #165; settings). Defaults to 6. */
  initialMinimapWidth?: number;
  /** The layout the overlay opens with (Issue #119; settings or subcommand).
   *  Defaults to "files-git-viewer". Fixed for the overlay's lifetime. */
  initialLayout?: NavigatorLayout;
  /** Current retained-content style key (Issues #136/#141). `invalidate()`
   *  restyles the open file or commit diff from its retained source when this
   *  changed; defaults to `() => ""`, which is a no-op back-reference for
   *  every file. */
  styleKey?: () => string;
}

/**
 * The in-overlay `?` modal rows, derived from the shared keybinding table in
 * help.ts so the modal and the durable /navigator help entry cannot drift
 * (Issue #063 finding 5). Exported so the help suite can assert the modal is
 * exactly the shared table's projection.
 */
export const HELP_ROWS: Array<[string, string]> = NAVIGATOR_KEYBINDINGS.map((row) => [row.keys, row.description]);

/**
 * Printable block of text from a key event or paste, using the platform
 * rule: the Kitty decoder first, then the raw chunk (a pasted multi-char
 * string or a surrogate pair such as an emoji, Issue #105). Shared by the
 * filter and the search input modes so the two cannot drift apart.
 */
function printableText(data: string): string | null {
  const decoded = decodeKittyPrintable(data);
  const text = decoded ?? data;
  if (text.length === 0) return null;
  // Any C0/C1 control character (including ESC and DEL) rejects the whole
  // chunk: escape sequences and unmatched special keys must never enter the
  // query.
  if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return null;
  return text;
}

/**
 * Delete the last full code point of a query, never splitting a surrogate
 * pair (a lone surrogate would otherwise survive Backspace after an emoji,
 * Issue #105).
 */
function deleteLastCodePoint(text: string): string {
  let end = text.length - 1;
  if (end < 0) return text;
  const last = text.charCodeAt(end);
  if (last >= 0xdc00 && last <= 0xdfff && end > 0) {
    const prev = text.charCodeAt(end - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) end--;
  }
  return text.slice(0, end);
}

/**
 * One cursor-movement language for the cursor-list panes (Issue #179): j/k
 * and the arrows step, g/G and Home/End jump to the ends, ctrl+d/u and
 * PgDn/PgUp page by half the pane's visible height. Returns null for any
 * other key so the caller's own branches keep running; the clamps are
 * tree.ts's moveCursor/pageJump, with the pane's own total and visible area.
 */
function movedCursor(total: number, index: number, area: number, data: string): number | null {
  if (matchesKey(data, Key.up) || data === "k") return moveCursor(total, index, -1);
  if (matchesKey(data, Key.down) || data === "j") return moveCursor(total, index, 1);
  if (data === "g" || matchesKey(data, Key.home)) return 0;
  if (data === "G" || matchesKey(data, Key.end)) return moveCursor(total, index, total);
  if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.pageDown)) {
    return pageJump(total, index, 1, area);
  }
  if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.pageUp)) {
    return pageJump(total, index, -1, area);
  }
  return null;
}

export class NavigatorOverlay implements Focusable {
  /** Set by TUI when focus changes; gates the CURSOR_MARKER emission. */
  focused = false;

  private cwd: string;
  private T: NavigatorTheme;
  private getTerminalRows: () => number;
  private requestRender: () => void;
  private onClose: () => void;
  private onImageViewChanged: () => void;
  private loadFile: (relPath: string, opts?: LoadFileOptions) => Promise<ViewerFile>;
  /** Style-key source for the viewer restyle on invalidate (Issue #136). */
  private styleKey: () => string;
  private loadCommit: ((shortHash: string) => Promise<ViewerFile>) | undefined;
  /** Injected host KeybindingsManager (Issues #125/#126); null in harnesses. */
  private keybindings: KeybindingsManager | null;
  private refresh: () => void;

  private root: FileNode | null = null;
  private treeSource: "git" | "fs" | null = null;
  private git: GitState | null = null;

  private focus: Focus = "files";
  private mode: InputMode = "normal";
  private showHidden = false;
  /** Whether the left column renders at all; toggled by `t` in every layout
   *  (Issue #119, D7 — "tree" was no longer what it controls). */
  private showLeftColumn = true;
  /** The layout chosen at open time; fixed for the overlay's lifetime (#119). */
  private layout: NavigatorLayout;

  private filesCursor = 0;
  private filesScroll = 0;
  private filterQuery = "";

  private gitCursor = 0;
  private gitScroll = 0;

  private viewFile: ViewerFile | null = null;
  private viewLoading = false;
  /** The in-flight target while viewLoading; null otherwise (Issue #142). */
  private viewTarget: OpenTarget | null = null;
  private loadSeq = 0;
  private viewScroll = 0;
  private viewHscroll = 0;
  private viewWrap = false;
  private viewRenderMarkdown = false;
  private diskChanged = false;

  /**
   * The viewer's derived state — the render caches, the markdown renderer and
   * the search derivation — behind one render/invalidate owner (Issue #169).
   * The overlay routes input and owns scroll, focus and settings; it never
   * names a viewer cache.
   */
  private viewerModel: ViewerModel;
  /**
   * Viewer minimap (Issue #165). `viewMinimapOn` is the session toggle (`v`),
   * seeded from the setting like `viewWrap`; the setting's `off` beats it. The
   * model above owns the text/sketch caches.
   */
  private viewMinimap: NavigatorMinimapEncoding = "braille";
  private viewMinimapColors: NavigatorMinimapPalette = "mono";
  private viewMinimapWidth = 6;
  private viewMinimapOn = true;
  /** True when the last pass rendered a map (drives the border-thumb rule). */
  private viewerMapActive = false;
  /**
   * Map hit-test geometry from the last full render (Issue #167): the map's
   * overlay-local top row, its column count and its folded blocks. Null when
   * no map was drawn (or a compact frame replaced the overlay), so a click
   * falls through to nothing.
   */
  private mapHit: { top: number; width: number; blocks: MinimapSketch["blocks"] } | null = null;
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
  private cachedRows: number | undefined;
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
  /**
   * Viewer scrollbar window recorded by buildRightRows during a render pass
   * (Issue #137 §4): the frame's right border column draws the track/thumb
   * from this record so the thumb cannot drift from the clamp applied to
   * `viewScroll`. It is the window's value (Issue #147) — the render branch
   * that computes the window is its single writer. Transient — recomputed on
   * every pass, never cached, so `invalidate()` has nothing to clear for it.
   */
  private viewerScrollWindow: ViewerScrollWindow | null = null;

  constructor(options: NavigatorOptions) {
    this.cwd = options.cwd;
    this.T = options.theme;
    this.getTerminalRows = options.getTerminalRows;
    this.requestRender = options.requestRender;
    this.onClose = options.onClose;
    this.onImageViewChanged = options.onImageViewChanged ?? (() => undefined);
    this.loadFile = options.loadFile;
    this.styleKey = options.styleKey ?? (() => "");
    this.loadCommit = options.loadCommit;
    this.keybindings = options.keybindings ?? null;
    this.refresh = options.refresh;
    this.enableIcons = options.enableIcons ?? DEFAULT_NAVIGATOR_SETTINGS.icons.enabled;
    this.home = options.home ?? "";
    this.imageSupport = options.imageSupport ?? makeDeferredImageSupport("off");
    // Settings-landed initial state (Issue #061): the fallbacks are the
    // registry defaults (Issue #171) — one source, so a default can never
    // drift between settings.ts and this constructor.
    this.showHidden = options.initialShowHidden ?? DEFAULT_NAVIGATOR_SETTINGS.tree.showHidden;
    this.viewWrap = options.initialWrap ?? DEFAULT_NAVIGATOR_SETTINGS.viewer.wrap;
    this.viewRenderMarkdown =
      options.initialRenderMarkdown ?? DEFAULT_NAVIGATOR_SETTINGS.viewer.markdown === "rendered";
    this.viewMinimap = options.initialMinimap ?? DEFAULT_NAVIGATOR_SETTINGS.viewer.minimap;
    this.viewMinimapColors = options.initialMinimapColors ?? DEFAULT_NAVIGATOR_SETTINGS.viewer.minimapColors;
    this.viewMinimapWidth = options.initialMinimapWidth ?? DEFAULT_NAVIGATOR_SETTINGS.viewer.minimapWidth;
    this.viewMinimapOn = this.viewMinimap !== "off";
    // Layout-landed initial state (Issue #119, D6/D8): the layout fixes the
    // pane set, the initial focus, and the render geometry for this overlay.
    this.layout = options.initialLayout ?? DEFAULT_NAVIGATOR_SETTINGS.layout.default;
    this.focus = initialFocus(this.layout);
    this.viewerModel = new ViewerModel({
      theme: () => this.T,
      styleKey: () => this.styleKey(),
    });
  }


  /**
   * Install a freshly built tree. Expansion state is applied by the session
   * (`collectExpanded`/`reapplyExpansion` in `session.ts`) before this call,
   * so the tree arrives ready to render (plan section 3.6 setters).
   */
  setTree(root: FileNode, treeSource: "git" | "fs"): void {
    // Re-anchor the selection by relPath (Issue #124): a refresh rebuilding
    // the tree with entries added/removed above the cursor must not silently
    // retarget the cursor onto a different file. The anchor is captured
    // before the root swaps; when the path survives — including under an
    // active filter — alignFilesCursor refinds it, otherwise the cursor
    // clamps in range (deleted, filtered out, or hidden by a collapsed
    // directory).
    const anchor = this.filesRows()[this.filesCursor]?.node.relPath;
    this.root = root;
    this.treeSource = treeSource;
    const rows = this.filesRows();
    if (anchor !== undefined && rows.some((row) => row.node.relPath === anchor)) {
      this.alignFilesCursor(anchor);
    } else {
      this.filesCursor = moveCursor(rows.length, this.filesCursor, 0);
    }
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

  /** Install a new git state, keeping the git cursor on the selected row. */
  setGitState(git: GitState): void {
    // Same identity re-anchor as setTree (Issue #124): file rows by relPath,
    // commit rows by shortHash — both stable across refreshes. Clamp only
    // when the row is gone.
    const anchorRow = this.gitNavRows()[this.gitCursor];
    const anchor = anchorRow ? this.gitRowIdentity(anchorRow) : null;
    this.git = git;
    const rows = this.gitNavRows();
    const index = anchor !== null ? rows.findIndex((row) => this.gitRowIdentity(row) === anchor) : -1;
    this.gitCursor = index >= 0 ? index : moveCursor(rows.length, this.gitCursor, 0);
    this.touch();
  }

  /**
   * Install a resolved image-support snapshot (D9). A plain install (Issue
   * #144): the session owns the reflow clock, so the overlay only assigns
   * and touches — the header badge and card hints refresh, and the session
   * arms any upgrade reflow from `resolveSupport`.
   */
  setImageSupport(support: ImageSupport): void {
    this.imageSupport = support;
    this.touch();
  }

  /**
   * The DISPLAYED image view's shape (Issue #144): null when nothing is
   * displayed or the file is not `kind: "image"`. `rendered` requires a
   * rendered verdict with rows (an empty render is card-like); `asCard` is
   * the session-only `i` toggle. The session's reflow clock reads this to
   * decide whether a support landing can upgrade the view.
   */
  getImageView(): { rendered: boolean; asCard: boolean } | null {
    const file = this.viewFile;
    if (file === null || file.kind !== "image") return null;
    const verdict = file.imageVerdict;
    return {
      rendered: verdict !== undefined && verdict.kind === "rendered" && verdict.lines.length > 0,
      asCard: this.imageAsCard,
    };
  }

  /**
   * Re-open the DISPLAYED file target through the normal load primitive,
   * keeping scroll (Issue #144). The session's reflow clock calls this after
   * re-validating the displayed target; a commit or absent target is a no-op
   * so a targetless request can never become a load.
   */
  reflowOpenImage(): void {
    const target = targetOf(this.viewFile);
    if (target === null || target.kind !== "file") return;
    void this.openTarget(target, true);
  }

  private setDiskChanged(changed: boolean): void {
    if (this.diskChanged === changed) return;
    this.diskChanged = changed;
    this.touch();
  }

  /**
   * The displayed open target (Issue #142): derived from the installed
   * ViewerFile, so it is null while nothing is shown. Displayed-only — the
   * in-flight target is never reported to the session's poll.
   */
  getOpenTarget(): OpenTarget | null {
    return targetOf(this.viewFile);
  }

  /**
   * The disk-watch check (Issue #142): returns false without touching state
   * when the passed target is no longer the displayed one (the #040 TOCTOU
   * guard, structural now); otherwise compares the statted mtime ±1 ms
   * against the displayed file's, writes the disk-changed flag itself (a
   * stat failure — `null` — means changed) and returns the verdict the
   * session feeds to its backoff.
   */
  checkOpenTarget(target: OpenTarget, mtimeMs: number | null): boolean {
    const current = targetOf(this.viewFile);
    if (current === null || !sameTarget(current, target)) return false;
    const known = this.viewFile?.mtimeMs;
    const changed = mtimeMs === null || (known !== undefined && Math.abs(mtimeMs - known) > 1);
    this.setDiskChanged(changed);
    return changed;
  }

  /** Observable search state for tests and diagnostics (Issue #093). */
  getSearchState(): { query: string; index: number; total: number } {
    return this.viewerModel.getState();
  }

  /** Reload the displayed target, keeping scroll position. Used by "r". */
  reloadOpenFile(): void {
    const target = targetOf(this.viewFile);
    // openTarget no-ops a commit target when no loadCommit is injected, so no
    // kind check is needed here (Issue #175).
    if (target) void this.openTarget(target, true);
  }

  /**
   * The one viewer load primitive (Issue #142): owns the loadSeq race guard,
   * the in-flight target, the scroll/search reset and the completion and
   * disposal handling for every kind of open target. `openRelPath` and
   * `openCommit` are thin delegates; a commit target with no injected loader
   * is a no-op (the `openCommit` entry keeps its v2 family-toggle fallback).
   */
  async openTarget(target: OpenTarget, keepScroll = false): Promise<void> {
    const commitLoader = this.loadCommit;
    if (target.kind === "commit" && commitLoader === undefined) return;
    const seq = ++this.loadSeq;
    this.viewLoading = true;
    this.viewTarget = target;
    const same = sameTarget(target, targetOf(this.viewFile));
    if (!keepScroll || !same) {
      this.viewScroll = 0;
      this.viewHscroll = 0;
      if (!same) {
        // The `i` toggle is session-only and scoped to one open file (D8);
        // it has no meaning for a commit diff.
        if (target.kind === "file") this.imageAsCard = false;
        this.viewerModel.setQuery("");
      }
    }
    this.touch();
    this.requestRender();

    try {
      let file: ViewerFile;
      if (target.kind === "commit") {
        // The early guard returned when no loader exists; the re-read keeps
        // the narrowing honest without a non-null assertion.
        if (commitLoader === undefined) return;
        file = await commitLoader(target.hash);
      } else {
        const geometry = this.currentImageGeometry();
        // The extension + pane geometry are the navigator's half of the load
        // decision (Issue #143): a geometry hint is passed for any image path
        // the pane can host, and the session's plan answers whether an
        // attempt actually runs under the live support snapshot.
        const loadOpts =
          IMAGE_EXTENSIONS.has(extOf(target.relPath)) && geometry !== null
            ? { image: geometry }
            : undefined;
        file = await this.loadFile(target.relPath, loadOpts);
      }
      if (this.disposed || this.loadSeq !== seq) return;
      this.viewFile = file;
      // New content: rendered lines drop and an active query re-scans on the
      // next render. The model's caches key on the `viewFile` reference, so
      // the new object invalidates the rest automatically.
      this.viewerModel.invalidate("content");
      this.viewerModel.setSource(file, this.viewRenderMarkdown);
      this.diskChanged = false;
      if (!keepScroll || !same) {
        this.viewScroll = 0;
        this.viewHscroll = 0;
      }
    } catch {
      if (this.disposed || this.loadSeq !== seq) return;
      if (target.kind === "commit") {
        // Issue #142 decision 7: the error card carries the hash, so the
        // commit identity survives without parsing `commit:` back out.
        this.viewFile = {
          kind: "error",
          relPath: `commit:${target.hash}`,
          commitHash: target.hash,
          lines: [],
          message: "cannot read commit",
        };
      } else {
        this.viewFile = { kind: "error", relPath: target.relPath, lines: [], message: "unexpected read failure" };
      }
      this.viewerModel.invalidate("content");
      this.viewerModel.setSource(this.viewFile, this.viewRenderMarkdown);
    } finally {
      if (!this.disposed && this.loadSeq === seq) {
        this.viewLoading = false;
        this.viewTarget = null;
        this.touch();
        this.requestRender();
      }
    }
  }

  /** Open a file by relative path (async; sets viewer state on completion). */
  openRelPath(relPath: string, keepScroll = false): Promise<void> {
    return this.openTarget({ kind: "file", relPath }, keepScroll);
  }

  /**
   * Open a commit's diff in the viewer (v3). Delegates to the shared load
   * primitive; the installed ViewerFile's `relPath` is `commit:<shortHash>` —
   * distinct from any file path — so the viewer header / caches key on it and
   * the mtime poll skips commit targets (Issue #142). Without an injected
   * loader, Enter falls back to toggling the commit's family (v2 behavior).
   */
  openCommit(shortHash: string, keepScroll = false): Promise<void> {
    if (!this.loadCommit) {
      this.toggleCommitFamily(shortHash);
      return Promise.resolve();
    }
    return this.openTarget({ kind: "commit", hash: shortHash }, keepScroll);
  }

  dispose(): void {
    this.disposed = true;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
  }

  /**
   * Re-style the open viewer file from its retained source under the current
   * theme (Issues #136/#141): syntax highlighting for text files, the diff
   * composer for a commit diff. Synchronous and I/O-free — a theme switch
   * reuses the retained source, never a re-read or a `git show`; both
   * restylers return the same reference when the key is already current.
   */
  private restyleOpenFile(): void {
    const file = this.viewFile;
    if (!file) return;
    this.viewFile =
      file.kind === "diff"
        ? restyleDiffViewerFile(file, this.T, this.styleKey())
        : restyleViewerFile(file, this.styleKey());
  }

  invalidate(): void {
    // Theme-change notification from the host (interactive-mode onThemeChange
    // calls ui.invalidate() on every switch). Clear the DERIVED render state
    // that bakes the theme in, so the next render re-derives it against the
    // theme now in force:
    //  - cachedLines/cachedWidth: the composed frame (styled strings);
    //  - the viewer model's theme-styled state: the wrapped rows, the rendered
    //    markdown (its renderer captures the markdown theme at construction),
    //    the minimap texts/sketch and the search results. The current match
    //    keeps its index across a theme switch; the results re-scan.
    // Deliberately kept: the DATA-derived state — the raw visible line widths
    // (ANSI escapes are zero-width, so they are theme-independent), the
    // files/git row models, and the file-content cache in session.ts
    // (viewerCache): re-reading and re-hashing files is the expensive part,
    // and the derivation above is all that must be redone to repaint.
    //
    // Issues #136/#141: a theme switch also changes the tokens baked into
    // the open file's or diff's lines. Restyle it from the retained source
    // BEFORE clearing the derived caches — synchronous and I/O-free, so the
    // invalidate path never re-reads a file or re-runs git. A resize/cell-
    // size invalidate leaves the style key unchanged, so the restyle returns
    // the same object and costs nothing.
    this.restyleOpenFile();
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
    this.viewerModel.invalidate("theme");
  }


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
   * Toggle `node.expanded` (or set it to `expanded` when given) via
   * `setExpanded` — the write itself lives in tree.ts (Issue #150). The only
   * in-place files-tree mutation entry point: treeVersion is bumped here so
   * a future caller cannot stale the filesRowsCache (Issue #064 finding 2).
   * touch() is idempotent (clears the render cache), so the calling handler's
   * own trailing touch() stays harmless — no double render.
   */
  private toggleDir(node: FileNode, expanded?: boolean): void {
    setExpanded(node, expanded);
    this.treeVersion++;
    this.touch();
  }

  /** Expand `root`'s ancestors of `relPath` (git-pane Enter on a file row, Issue #064). */
  private expandTo(root: FileNode, relPath: string): void {
    expandAncestors(root, relPath);
    this.treeVersion++;
    this.touch();
  }


  /**
   * Host-owned cancel (Issues #125/#126): consult the injected
   * KeybindingsManager for "tui.select.cancel" — the host's cancel action,
   * whose default keys are Esc and Ctrl+C (pi-tui's tui.select.cancel
   * table entry), plus any user remap. Without an injected manager
   * (harnesses), fall back to the literal Esc match this overlay always
   * had. Overlay-local letters (j k g G l h w m i n N y t r . / ?) stay
   * literal — they have no host binding ids and are this extension's own
   * key language.
   */
  private matchesCancel(data: string): boolean {
    return this.keybindings !== null
      ? this.keybindings.matches(data, "tui.select.cancel")
      : matchesKey(data, Key.escape);
  }

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

  /**
   * Map click-to-jump (Issue #167). A left press on the minimap column
   * scrolls the viewer to the clicked map row's first display row and focuses
   * the viewer; a click is swallowed so the renderer's fallback does not also
   * react to the same gesture. Wheel and drag are deliberately not routed —
   * no pane has mouse scrolling yet, and every click target stays reachable
   * by key. The compact frame and the help/filter modes are excluded.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "press" && event.type !== "click") return undefined;
    if (event.button !== "left") return undefined;
    if (this.mode === "help" || this.mode === "filter") return undefined;
    if (event.width < MIN_OVERLAY_WIDTH || event.height < MIN_OVERLAY_HEIGHT) return undefined;
    const map = this.mapHit;
    if (!map) return undefined;
    const x0 = event.width - 1 - map.width;
    if (event.x < x0 || event.x > event.width - 2) return undefined;
    const block = map.blocks[event.y - map.top];
    if (block === undefined) return undefined;
    if (event.type === "press") {
      this.viewScroll = block.start;
      this.focus = "viewer";
      this.touch();
      this.requestRender();
    }
    return { handled: true, focus: true };
  }

  private handleHelpInput(data: string): void {
    const maxScroll = this.helpMaxScroll();
    // The modal scrolls through the same movement language (Issue #179): its
    // cursor is the scroll offset and its total is maxScroll + 1.
    const moved = movedCursor(maxScroll + 1, this.helpScroll, this.helpVisibleRows(), data);
    if (moved !== null) {
      this.helpScroll = moved;
    } else if (data === "?" || data === "q" || this.matchesCancel(data)) {
      this.mode = "normal";
    } else {
      return;
    }
    this.touch();
  }

  private handleFilterInput(data: string): void {
    const rows = this.filesRows();
    if (this.matchesCancel(data)) {
      this.filterQuery = "";
      this.mode = "normal";
      this.filesCursor = 0;
      this.filesScroll = 0;
    } else if (matchesKey(data, Key.enter)) {
      this.mode = "normal";
    } else if (matchesKey(data, Key.backspace)) {
      const anchor = this.filesRows()[this.filesCursor]?.node.relPath;
      this.filterQuery = deleteLastCodePoint(this.filterQuery);
      this.keepFilterSelection(anchor);
    } else if (matchesKey(data, Key.down)) {
      this.filesCursor = Math.min(this.filesCursor + 1, Math.max(0, rows.length - 1));
    } else if (matchesKey(data, Key.up)) {
      this.filesCursor = Math.max(0, this.filesCursor - 1);
    } else if (matchesKey(data, Key.home)) {
      // First/last match while filtering (Issue #127).
      this.filesCursor = 0;
    } else if (matchesKey(data, Key.end)) {
      this.filesCursor = moveCursor(rows.length, this.filesCursor, rows.length);
    } else {
      const printable = printableText(data);
      if (printable) {
        const anchor = this.filesRows()[this.filesCursor]?.node.relPath;
        this.filterQuery += printable;
        this.keepFilterSelection(anchor);
      }
    }
    this.touch();
  }

  private handleSearchInput(data: string): void {
    if (this.matchesCancel(data)) {
      this.viewerModel.setQuery("");
      this.mode = "normal";
    } else if (matchesKey(data, Key.enter)) {
      this.mode = "normal";
    } else if (matchesKey(data, Key.backspace)) {
      this.viewerModel.setQuery(deleteLastCodePoint(this.viewerModel.query));
    } else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.viewerModel.cycle(1);
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.viewerModel.cycle(-1);
    } else {
      const printable = printableText(data);
      if (printable) {
        this.viewerModel.setQuery(this.viewerModel.query + printable);
      }
    }
    this.touch();
  }

  private handleNormalInput(data: string): void {
    // Global keys first.
    const isShiftTab = matchesKey(data, Key.shift("tab"));
    if (isShiftTab || matchesKey(data, Key.tab)) {
      // Tab/Shift+Tab cycle only the layout's visible panes (Issue #119, D8).
      this.focus = cycleFocus(this.focus, isShiftTab ? -1 : 1, this.layout);
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
    if (this.matchesCancel(data)) {
      if (this.filterQuery) {
        this.filterQuery = "";
        this.filesCursor = 0;
        this.filesScroll = 0;
        this.touch();
        return;
      }
      if (this.viewerModel.query) {
        this.viewerModel.setQuery("");
        this.touch();
        return;
      }
      this.onClose();
      return;
    }
    if (data === "t") {
      this.showLeftColumn = !this.showLeftColumn;
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
    const area = filesArea(this.getTerminalRows(), this.layout);
    const current = rows[this.filesCursor];

    const moved = movedCursor(rows.length, this.filesCursor, area, data);
    if (moved !== null) {
      this.filesCursor = moved;
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
    const moved = movedCursor(
      rows.length,
      this.gitCursor,
      gitArea(this.getTerminalRows(), this.layout),
      data,
    );
    if (moved !== null) {
      this.gitCursor = moved;
    } else if (matchesKey(data, Key.enter)) {
      const row = rows[this.gitCursor];
      if (!row) return;
      if (row.kind === "file") {
        // Untracked directories render with a trailing slash (git_view.changedPath)
        // while tree nodes are slash-free; reveal by the tree path.
        const treePath = row.relPath.replace(/\/+$/, "");
        if (this.root) this.expandTo(this.root, treePath);
        this.filterQuery = "";
        this.alignFilesCursor(treePath);
        this.focus = "viewer";
        void this.openRelPath(row.relPath); // display path: what gets opened is unchanged
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
        // Step out to the anchor parent like the file pane: move the cursor to
        // the row's expanded ancestor so the user lands on a row that is still
        // visible (Issue #030 semantics). Only a real collapse steps out —
        // `h` on an already-collapsed row leaves the cursor alone, matching the
        // files pane, where `h` on a collapsed directory does not move it. The
        // anchor may itself be a commit-child row when the current row is a
        // *nested* child, so both kinds qualify; take the nearest (deepest) one
        // (Issue #211).
        if (row.kind === "commit-child" && wasExpanded) {
          let anchorIndex = -1;
          let anchorDepth = -1;
          rows.forEach((r, i) => {
            if (
              (r.kind === "commit" || r.kind === "commit-child") &&
              this.gitExpanded.has(r.commit.shortHash) &&
              (r.commit.parents ?? []).includes(row.commit.shortHash)
            ) {
              const depth = r.kind === "commit-child" ? r.depth : 0;
              if (depth > anchorDepth) {
                anchorDepth = depth;
                anchorIndex = i;
              }
            }
          });
          if (anchorIndex >= 0) this.gitCursor = anchorIndex;
        }
      }
    } else {
      return;
    }
    this.touch();
  }

  /**
   * The displayed file's rendered-image verdict, or null when there is none
   * to act on (no image, a card verdict, an empty row list, or the `i`
   * toggle hiding it). Issue #143: one verdict read replaces the per-site
   * tier + imageLines re-derivations.
   */
  private renderedImageVerdict(): Extract<ImageVerdict, { kind: "rendered" }> | null {
    if (this.imageAsCard) return null;
    const file = this.viewFile;
    if (file === null || file.kind !== "image") return null;
    const verdict = file.imageVerdict;
    if (verdict === undefined || verdict.kind !== "rendered" || verdict.lines.length === 0) {
      return null;
    }
    return verdict;
  }

  private handleViewerInput(data: string): void {
    const file = this.viewFile;
    const area = viewerArea(this.getTerminalRows());
    const half = Math.max(1, Math.ceil(area / HALF_PAGE_DIVISOR));
    // A rendered image (chafa or native) is pre-styled content:
    // wrap/hscroll/search are meaningless, so w, h/l, /, n/N are inert on it
    // (rendered-markdown precedent, Issue #053); only the scrolling keys and
    // `i` act (§7.5). A native image additionally pins scroll (D9): its
    // placement is terminal-anchored, so j/k/ctrl+d/ctrl+u/g/G are inert too.
    const renderedVerdict = this.renderedImageVerdict();
    const renderedImage = renderedVerdict !== null;
    const nativeImage = renderedVerdict !== null && renderedVerdict.renderer === "native";
    if (matchesKey(data, Key.up) || data === "k") {
      if (nativeImage) return;
      this.viewScroll = Math.max(0, this.viewScroll - 1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (nativeImage) return;
      this.viewScroll += 1;
    } else if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.pageDown)) {
      if (nativeImage) return;
      this.viewScroll += half;
    } else if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.pageUp)) {
      if (nativeImage) return;
      this.viewScroll = Math.max(0, this.viewScroll - half);
    } else if (data === "g" || matchesKey(data, Key.home)) {
      if (nativeImage) return;
      this.viewScroll = 0;
    } else if (data === "G" || matchesKey(data, Key.end)) {
      if (nativeImage) return;
      this.viewScroll = Number.MAX_SAFE_INTEGER;
    } else if (data === "/") {
      if (renderedImage) {
        this.showNotice("search is not available for rendered images");
        return;
      }
      this.mode = "search";
      this.viewerModel.setQuery("");
    } else if (data === "n") {
      if (renderedImage) return;
      this.viewerModel.cycle(1);
    } else if (data === "N") {
      if (renderedImage) return;
      this.viewerModel.cycle(-1);
    } else if (data === "w") {
      if (renderedImage) return;
      if (this.viewRenderMarkdown && canRenderMarkdown(this.viewFile)) {
        return;
      }
      this.viewWrap = !this.viewWrap;
      this.viewHscroll = 0;
    } else if (data === "v") {
      // Issue #165: the session toggle, like `w`/`m` — never writes settings.
      // Inert on a rendered image (its content is not mapped) and while the
      // map is auto-hidden the toggle still flips, so widening the pane later
      // shows the map again.
      if (renderedImage) return;
      this.viewMinimapOn = !this.viewMinimapOn;
      this.viewerModel.invalidate("minimap");
      this.touch();
      return;
    } else if (data === "m") {
      if (canRenderMarkdown(this.viewFile)) {
        this.viewRenderMarkdown = !this.viewRenderMarkdown;
        this.viewHscroll = 0; // rendered mode is wrap-only
        this.viewerModel.invalidate("markdown");
        this.viewerModel.setSource(this.viewFile, this.viewRenderMarkdown);

        this.touch();
      }
      // Issue #135 L1: no notice when the file cannot render as markdown — an
      // unavailable action is silent, like the other inapplicable keys here
      // (n/N with no matches, i on a non-image, w on an image). The footer stops
      // advertising `m` for such files instead (getFooterHint).
      return;
    } else if (data === "i") {
      // D8 toggle: render ⇄ metadata card (session-only, reset on file
      // change). A card showing under an available tier re-requests the
      // render instead of toggling, so `i` is always the "image rendering"
      // verb.
      if (!file || file.kind !== "image") return;
      const verdict = file.imageVerdict;
      const rendered = verdict !== undefined && verdict.kind === "rendered" && verdict.lines.length > 0;
      // Nothing to show and no tier to render with: `i` is inert.
      if (!rendered && this.imageSupport.tier === "none") return;
      if (rendered && !this.imageAsCard) {
        // Hide: a pure state flip, the stored rows stay on the file.
        this.imageAsCard = true;
      } else if (rendered && verdict.kind === "rendered" && verdict.renderer === "chafa") {
        // Chafa rows are plain text, so re-emitting them is always safe.
        this.imageAsCard = false;
      } else {
        // Show again through a fresh render. A native render's rows are a
        // kitty/iTerm2 placement carrying an image id that must not be
        // reused: re-emitting the same id makes pi-tui re-place it without
        // re-transmitting, so the pane stays blank (Issue #112). A metadata
        // card under an available tier upgrades to a render the same way.
        this.imageAsCard = false;
        void this.openRelPath(file.relPath, true);
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


  /**
   * Identity of a cursor-navigable git row (Issue #124): file rows anchor by
   * relPath, commit rows by shortHash — both stable across state refreshes.
   * Group/header rows are not navigable and carry no identity.
   */
  private gitRowIdentity(row: GitRow): string | null {
    if (row.kind === "file") return `file:${row.relPath}`;
    if (row.kind === "commit" || row.kind === "commit-child") return `commit:${row.commit.shortHash}`;
    return null;
  }

  private alignFilesCursor(relPath: string): void {
    const rows = this.filesRows();
    const index = rows.findIndex((row) => row.node.relPath === relPath);
    if (index >= 0) {
      this.filesCursor = index;
      this.ensureFilesCursorVisible();
    }
  }

  /**
   * Keep the filter selection on the path that was selected before the query
   * changed (Issue #124): refining a query must not drop the user at the top
   * of the list. When the path no longer matches, clamp to the nearest
   * surviving row instead of jumping to index 0.
   */
  private keepFilterSelection(anchor: string | undefined): void {
    const rows = this.filesRows();
    if (anchor !== undefined) {
      const index = rows.findIndex((row) => row.node.relPath === anchor);
      if (index >= 0) {
        this.filesCursor = index;
        this.ensureFilesCursorVisible();
        return;
      }
    }
    this.filesCursor = moveCursor(rows.length, this.filesCursor, 0);
  }

  private async copyContext(): Promise<void> {
    let value = "";
    if (this.focus === "git") {
      const row = this.gitNavRows()[this.gitCursor];
      if (row?.kind === "file") value = row.relPath;
      else if (row?.kind === "commit") value = row.commit.shortHash;
      else if (row?.kind === "commit-child") value = row.commit.shortHash;
    } else if (this.focus === "viewer") {
      // The in-flight target first: while a load runs, the displayed
      // ViewerFile still describes the previous content (Issue #142).
      const target = this.viewTarget ?? targetOf(this.viewFile);
      value = target === null ? "" : target.kind === "commit" ? target.hash : target.relPath;
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
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }


  /** Help rows that fit. Shared by the input clamp and the renderer. */
  private helpVisibleRows(body = bodyRows(overlayHeight(this.getTerminalRows()))): number {
    return computeHelpVisibleRows(body, HELP_ROWS.length);
  }

  /** Single source of truth for the help scroll limit. */
  private helpMaxScroll(): number {
    return computeHelpMaxScroll(HELP_ROWS.length, this.helpVisibleRows());
  }

  /** Half-page step for the help modal (PageUp/PageDown aliases, Issue #127). */
  /**
   * Native geometry for the current pane snapshot (§7.2, Q2 amendment): the
   * pane is the hard cap and the host width preference narrows it
   * (min(paneCols, terminal.imageWidthCells)); NO IMAGE_CELLS_MAX and no
   * floor-clamp above 1. Same refuse thresholds as chafa. Chafa branch:
   * paneCols is the full right panel width (rev. 2 amendment 3). Null when
   * no frame has been laid out yet or when the pane rejects the render —
   * the card wins in both cases. Pane-only: support capability is judged by
   * the plan (`planImageLoad` gates the attempt list; imageCardHints ladders
   * from the pane before the capability states).
   */
  private currentImageGeometry(): { cols: number; rows: number } | null {
    if (!this.lastViewerLayout) return null;
    if (this.imageSupport.tier === "native") {
      if (this.lastViewerLayout.cols < IMAGE_CELLS_MIN || this.lastViewerLayout.rows < IMAGE_ROWS_MIN) {
        return null;
      }
      return {
        cols: Math.min(this.lastViewerLayout.cols, this.imageSupport.hostImageWidthCells),
        rows: this.lastViewerLayout.rows,
      };
    }
    const resolved = resolveChafaGeometry({
      paneCols: this.lastViewerLayout.cols,
      paneRows: this.lastViewerLayout.rows,
      preferredCols: this.imageSupport.config.cellWidth,
      maxRows: this.imageSupport.config.maxRows,
    });
    return resolved.ok ? { cols: resolved.cols, rows: resolved.rows } : null;
  }

  /**
   * Resize detection (D10): when the open file is a rendered image (chafa or
   * native) whose recorded geometry no longer matches the pane, report the
   * drift to the session, which owns the debounce and the re-open (Issue
   * #144). Runs at the end of a fresh render pass; only reports — no
   * user-visible state is mutated during render (Issue #053). Stale rows stay
   * clipped by the render clamp until the reflow lands.
   */
  private maybeScheduleResizeReflow(): void {
    const file = this.viewFile;
    if (!file || this.viewLoading || this.imageAsCard) return;
    if (file.kind !== "image") return;
    const verdict = file.imageVerdict;
    if (verdict === undefined || verdict.kind !== "rendered" || verdict.lines.length === 0) return;
    if (this.imageSupport.tier === "none") return;
    const geometry = this.currentImageGeometry();
    if (!geometry) return;
    if (geometry.cols === verdict.cols && geometry.rows === verdict.rows) return;
    this.onImageViewChanged();
  }


  render(width: number): string[] {
    // Issue #207: the frame's row count is a function of the terminal
    // height, so a height-only resize must not hit the width-keyed cache.
    if (this.cachedLines && this.cachedWidth === width && this.cachedRows === this.getTerminalRows()) {
      return this.cachedLines;
    }
    const T = this.T;
    const overlayH = overlayHeight(this.getTerminalRows());
    const innerW = Math.max(0, width - 2);

    if (width < MIN_OVERLAY_WIDTH || overlayH < MIN_OVERLAY_HEIGHT) {
      // Compact notice for terminals that cannot host the frame (Issue #148:
      // the pure builder in frame.ts; every line is clipped to `width`).
      const lines = buildCompactFrame(width, T);
      this.cachedWidth = width;
      this.cachedRows = this.getTerminalRows();
      this.cachedLines = lines;
      this.mapHit = null; // no map exists in the compact frame
      return lines;
    }
    const body = bodyRows(overlayH);
    const withLeft = useLeftColumn(innerW, body, this.showLeftColumn);
    const leftW = withLeft ? leftColumnWidth(innerW) : 0;
    const rightW = withLeft ? innerW - leftW - 1 : innerW;
    const { filesH, gitH } = layoutRows(body, this.layout);
    // The horizontal separator between the files pane and the git panel only
    // exists in the default layout (Issue #119): in a single-pane layout the
    // surviving group owns the full body and no separator row is drawn.
    const showSeparator = this.layout === "files-git-viewer";

    const leftRows = withLeft ? this.buildLeftRows(leftW, { filesH, gitH }) : null;
    const rightRows = this.buildRightRows(rightW, body);
    this.maybeScheduleResizeReflow();

    // Issue #137 §4: the frame's right border column doubles as the viewer
    // scrollbar while the text-like content overflows — hidden while the help
    // modal is open (it composes over the body). The window was recorded by
    // buildRightRows above, so the thumb cannot drift from the clamp.
    // Issue #165: the minimap's band is the viewer's position cue while it is
    // shown, so the border thumb is dropped rather than duplicated (the
    // thumb remains the only cue whenever the map is off or auto-hidden).
    const scrollWindow =
      this.mode === "help" || this.viewerMapActive ? null : this.viewerScrollWindow;

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
        : buildFooterRow(innerW, {
            theme: T,
            mode: this.mode,
            focus: this.focus,
            notice: this.notice,
            layout: this.layout,
            // Issue #135 L1: the `m` hint is dropped for files that cannot
            // render as markdown, so the footer never advertises a dead key.
            markdownApplicable: canRenderMarkdown(this.viewFile),
          });

    // Issue #148: frame.ts assembles the frame (borders, title, separator
    // rows, body join, scrollbar border, footer wrapper).
    const lines = composeFrame({
      theme: T,
      innerW,
      body,
      leftW,
      filesH,
      showSeparator,
      leftRows,
      rightRows,
      scrollWindow,
      title: { cwd: this.cwd, git: this.git, home: this.home },
      footerRow,
    });

    if (this.mode === "help") {
      // Same limit the input handler clamps against, written back so the
      // stored offset can never sit past what the modal can show.
      const scroll = Math.max(0, Math.min(this.helpScroll, this.helpMaxScroll()));
      this.helpScroll = scroll;
      composeHelp(lines, innerW, body, { theme: T, helpRows: HELP_ROWS, helpScroll: scroll });
    }

    this.cachedWidth = width;
    this.cachedRows = this.getTerminalRows();
    this.cachedLines = lines;
    return lines;
  }


  /**
   * Left-column rows for the current layout (Issue #119): per `layoutPanes`,
   * the files group (header + filesH − 1 rows), the git group (header +
   * gitH − 1 rows), and in the default layout the one placeholder row the
   * separator in render() occupies. Group heights arrive from `layoutRows`,
   * so a single-pane layout fills the full body and the row accounting
   * (filesH + placeholder + gitH = body) holds without a separate body
   * parameter.
   */
  private buildLeftRows(leftW: number, heights: { filesH: number; gitH: number }): string[] {
    const rows: string[] = [];
    const panes = layoutPanes(this.layout);

    if (panes.files) {
      const filesRowModel = this.filesRows();
      const filesAreaRows = paneArea(heights.filesH);
      this.ensureFilesCursorVisibleFor(filesRowModel.length, filesAreaRows);

      const filesCtx = {
        theme: this.T,
        enableIcons: this.enableIcons,
        filterQuery: this.filterQuery,
        openRelPath: targetPath(this.viewTarget) ?? this.viewFile?.relPath ?? null,
        filesCursor: this.filesCursor,
        focus: this.focus,
      };
      rows.push(buildFilesHeader(leftW, filesRowModel.length, filesCtx));
      for (let i = 0; i < filesAreaRows; i++) {
        const index = this.filesScroll + i;
        const row = filesRowModel[index];
        if (row) {
          rows.push(buildFileRow(row, index === this.filesCursor, leftW, filesCtx));
        } else if (i === 0 && filesRowModel.length === 0) {
          // Issue #129: an empty tree explains itself in the first data row —
          // the filter query is the reason when there is one. Presentation
          // only, so the header's counts and the pane's row budget are
          // untouched (see filesEmptyRow).
          rows.push(filesEmptyRow(leftW, filesCtx));
        } else {
          rows.push(padTo("", leftW));
        }
      }
    }

    if (panes.git) {
      // Placeholder so git rows start at index filesH + 1 (default layout
      // only); the horizontal separator row is drawn by render() and must not
      // consume a data row. A single-pane layout has no separator and no
      // placeholder.
      if (this.layout === "files-git-viewer") rows.push(padTo("", leftW));

      const gitRowModel = this.gitRows();
      const navRows = this.gitNavRows();
      const gitAreaRows = paneArea(heights.gitH);
      this.ensureGitCursorVisibleFor(gitRowModel, navRows, gitAreaRows);

      rows.push(buildGitHeader(leftW, {
        theme: this.T,
        focus: this.focus,
        git: this.git,
        treeSource: this.treeSource,
        // L3: position + overflow for the git pane's header. navRows (not the
        // model rows) is the navigable set the cursor indexes.
        gitCursorIndex: this.gitCursor,
        gitNavCount: navRows.length,
        gitAreaRows,
      }));
      // A dim … in the last slot when git rows continue below the window, unless
      // that slot holds the selection (plan section 3.6 item 4).
      const lastIndex = this.gitScroll + gitAreaRows - 1;
      const selectedRow = navRows[this.gitCursor];
      const selectedIndex = selectedRow ? gitRowModel.indexOf(selectedRow) : -1;
      const markerIndex = gitRowModel.length > lastIndex + 1 && selectedIndex !== lastIndex ? lastIndex : -1;
      const gitCtx = { theme: this.T, expanded: this.gitExpanded };
      for (let i = 0; i < gitAreaRows; i++) {
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
    }

    return rows;
  }

  private ensureFilesCursorVisibleFor(total: number, area: number): void {
    if (this.filesCursor < this.filesScroll) this.filesScroll = this.filesCursor;
    if (this.filesCursor >= this.filesScroll + area) this.filesScroll = this.filesCursor - area + 1;
    this.filesScroll = Math.max(0, Math.min(this.filesScroll, Math.max(0, total - area)));
  }

  private ensureFilesCursorVisible(): void {
    this.ensureFilesCursorVisibleFor(this.filesRows().length, filesArea(this.getTerminalRows(), this.layout));
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


  private buildRightRows(rightW: number, body: number): string[] {
    const isSwitching =
      this.viewLoading && this.viewTarget !== null && !sameTarget(this.viewTarget, targetOf(this.viewFile));
    const file = isSwitching ? null : this.viewFile;
    const area = paneArea(body);

    // Issue #169: the model owns the derived render state — caches, markdown
    // rendering, the search derivation and the content/window composition.
    // The class hands it this pass's inputs and writes back the one window.
    const out = this.viewerModel.render({
      file,
      rightW,
      bodyArea: area,
      wrap: this.viewWrap,
      renderMarkdown: this.viewRenderMarkdown,
      diskChanged: this.diskChanged,
      imageCard: this.imageAsCard,
      minimap: {
        encoding: this.viewMinimap,
        palette: this.viewMinimapColors,
        width: this.viewMinimapWidth,
        on: this.viewMinimapOn,
      },
      scroll: this.viewScroll,
      hscroll: this.viewHscroll,
    });
    this.applyWindow(out.window);
    // The map's band IS the viewer's position indicator while it shows
    // (Issue #165): the frame's border thumb is suppressed in render() so two
    // cues cannot drift apart over the same window.
    this.viewerMapActive = out.mapActive;
    // Issue #167: the map's hit-test geometry for a later mouse event — the
    // overlay-local row its first map row was drawn at (frame chrome + the
    // viewer header + any notice rows), the carved width and the fold itself.
    this.mapHit = out.minimap
      ? {
          top: FRAME_TOP_ROWS + 1 + out.noticeRows,
          width: out.minimap.width,
          blocks: out.minimap.sketch.blocks,
        }
      : null;
    // Pane snapshot for chafa geometry. The chafa branch has no gutter, so the
    // pane is the full right panel width (rev. 2 amendment 3). Pure
    // bookkeeping — no user-visible state is touched during render (Issue
    // #053).
    this.lastViewerLayout = { cols: rightW, rows: area };

    const scrollWindow = out.window.scrollWindow;
    const view: ViewerPaneView = {
      theme: this.T,
      focus: this.focus,
      home: this.home,
      focused: this.focused,
      file,
      loading: this.viewLoading,
      switching: isSwitching,
      targetRelPath: targetPath(this.viewTarget),
      diskChanged: this.diskChanged,
      searchMode: this.mode === "search",
      renderMarkdown: this.viewRenderMarkdown,
      content: out.content,
      digits: out.digits,
      viewScroll: out.window.viewScroll,
      // Issue #137 §3: derived from the same clamped window the body rows
      // were drawn at, so the readout cannot disagree with the content.
      scrollInfo: scrollWindow
        ? {
            start: scrollWindow.scroll + 1,
            end: Math.min(scrollWindow.scroll + scrollWindow.count, scrollWindow.total),
            total: scrollWindow.total,
          }
        : null,
      wrap: this.viewWrap,
      // Post-clamp by construction (Issue #065, #147): the model ran this
      // offset through the one window, and the body rows are drawn from that
      // same window, so the badge reports the offset the rows were rendered
      // at.
      hscroll: out.window.hscroll,
      imageSupport: this.imageSupport,
      imageGeometry: this.currentImageGeometry(),
      minimap: out.minimap,
      searchQuery: this.viewerModel.query,
      searchMatches: this.viewerModel.matches,
      searchIndex: this.viewerModel.matchIndex,
    };
    return renderViewerPane(view, rightW, area);
  }

  /**
   * One writer for the scroll state (Issue #169): the window the body rows
   * were drawn at is the only source of the vertical offset, the horizontal
   * offset and the border scrollbar.
   */
  private applyWindow(win: ViewerWindow): void {
    this.viewScroll = win.viewScroll;
    this.viewHscroll = win.hscroll;
    this.viewerScrollWindow = win.scrollWindow;
  }

}
