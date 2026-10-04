/**
 * Navigator session module (Issue #140): the overlay's data lifecycle —
 * poll timer and backoff, tree collection and stamping (`signature`,
 * `treeProbe`, `lastStampedProbe`), the git read, the tree truncation
 * warning, the per-file viewer cache with its image seams and per-load abort
 * ownership (`viewerCache`, `beginImageLoad`), image-support resolution, and
 * the refresh-error dedupe.
 *
 * This is a pure move of the `ctx.ui.custom` closure that used to live in
 * `runNavigator` (index.ts): same behavior, same policy comments (Issues
 * #020/#022/#058/#108/#109/#112/#116/#117 etc.). index.ts keeps settings/env
 * loading, the kitty probe and notifier creation, overlay construction,
 * command dispatch and the returned UI wrapper; the session reaches the
 * component only through the `OverlaySink` port and owns all fs/git work.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  IMAGE_EXTENSIONS,
  IMAGE_NATIVE_CACHE_MAX_CHARS,
  MAX_FS_ENTRIES,
  MAX_POLL_INTERVAL_MS,
  MAX_VIEWER_CACHE_ENTRIES,
  REFRESH_INTERVAL_MS,
} from "./constants";
import { composeDiffLines } from "./diff";
import {
  detectRepo,
  gitCodeMap,
  gitTreeProbe,
  readCommitDiff,
  readGitState,
  readTrackedFiles,
  toCwdRelative,
  type RepoInfo,
} from "./git";
import {
  makeDeferredImageSupport,
  resolveImageSupport,
  runChafaRender,
  runNativeRender,
  type ImageSupport,
  type ImageSupportPaths,
  type KittyProbeVerdict,
  type NativeProtocol,
  type PiChafaApi,
} from "./images";
import type { NavigatorSettings } from "./settings";
import type { NavigatorTheme } from "./theme";
import {
  applyGitCodes,
  buildTree,
  collectDirEntries,
  collectExpanded,
  collectFsEntries,
  collectFsProbe,
  createTreeWalkBudget,
  entriesFromPaths,
  expandedUntrackedDirs,
  reapplyExpansion,
  type TreeEntry,
} from "./tree";
import type { FileNode, GitState, OpenTarget, ViewerFile } from "./types";
import { extOf, restyleViewerFile, type ImageRenderer, type LoadFileOptions } from "./viewer";

/**
 * One-shot file-tree truncation warning (Issue #108): the three tree walks —
 * the git-mode untracked-dir subtrees (one shared budget), the fs walk, and
 * the empty-repo fs fallback — all draw from the single MAX_FS_ENTRIES cap.
 * The identical warning therefore fires at most once per instance, the first
 * time a walk reports truncation (same timing as the inline blocks it
 * replaces: immediate, not deferred to the end of the refresh).
 */
export function makeTreeTruncationWarner(
  notify: (message: string) => void,
): (truncated: boolean) => void {
  let warned = false;
  return (truncated: boolean): void => {
    if (!truncated || warned) return;
    warned = true;
    notify(`file tree truncated at ${MAX_FS_ENTRIES} entries \u2014 some files are not listed`);
  };
}

/**
 * Refresh a cache key's recency so Map iteration order is LRU-first
 * (Issue #109): delete + re-set moves the key to the insertion tail (most
 * recent). No-op when the key is absent.
 */
export function touchCacheEntry<K, V>(cache: Map<K, V>, key: K): void {
  if (!cache.has(key)) return;
  const value = cache.get(key) as V;
  cache.delete(key);
  cache.set(key, value);
}

/**
 * Whether a render may be retained in the viewer cache (Issue #112). A kitty
 * native render embeds its image id in the escape rows, and pi-tui's
 * alt-screen layer re-places a previously uploaded id WITHOUT re-transmitting
 * the data when it sees the same line again (`prepareKittyScreen` rewrites the
 * line to a placement-only `a=p`). Re-serving such a line therefore draws
 * nothing once the terminal has dropped the image — which the `i` card
 * roundtrip, a reopen and a support reflow all cause — so kitty native renders
 * are never retained: every open re-renders through pi-tui with a fresh id.
 * iTerm2 renders inline their whole payload and carry no id state, so they
 * stay cacheable (still bounded by `IMAGE_NATIVE_CACHE_MAX_CHARS`).
 */
export function isCacheableRender(useNative: boolean, protocol: NativeProtocol | null): boolean {
  return !(useNative && protocol === "kitty");
}

/**
 * Viewer cache policy (Issues #020, #109, #112, D7): owns the per-file render
 * cache as an opaque Map plus its retention and eviction rules, so the policy
 * is testable through lookup/store/drop instead of living inline in
 * loadFileCached (a closure recreated per command invocation). `maxEntries`
 * bounds the entry count. Semantics preserved from the original inline
 * implementation:
 * - lookup misses when the render is not cacheable, the key is absent, the
 *   mtime moved by more than ±1 ms, or the variant changed; a genuine hit
 *   refreshes recency via touchCacheEntry so eviction stays LRU, not FIFO.
 * - store is a no-op unless the render is cacheable and the file carries an
 *   mtime; on a store at capacity the least-recently-used key is evicted
 *   BEFORE the insert. One deliberate improvement: the eviction check is
 *   gated on the key being NEW — re-storing an existing key no longer
 *   silently drops an unrelated LRU entry.
 */
export interface ViewerCache {
  lookup(
    relPath: string,
    opts: { cacheable: boolean; mtimeMs: number; variant: string },
  ): ViewerFile | undefined;
  store(relPath: string, opts: { cacheable: boolean; variant: string; file: ViewerFile }): void;
  drop(relPath: string): void;
  readonly size: number;
}

export function createViewerCache(maxEntries: number): ViewerCache {
  const entries = new Map<string, { mtimeMs: number; variant: string; file: ViewerFile }>();
  return {
    lookup(relPath, { cacheable, mtimeMs, variant }) {
      // Kitty native renders are excluded outright by `cacheable` (#112):
      // every open re-renders through pi-tui with a fresh image id.
      if (!cacheable) return undefined;
      const entry = entries.get(relPath);
      if (entry === undefined) return undefined;
      if (Math.abs(entry.mtimeMs - mtimeMs) > 1 || entry.variant !== variant) return undefined;
      // Genuine hit: refresh recency so eviction is LRU, not FIFO (#109).
      touchCacheEntry(entries, relPath);
      return entry.file;
    },
    store(relPath, { cacheable, variant, file }) {
      // Kitty native renders are excluded outright by `cacheable` (#112).
      if (!cacheable) return;
      // Cache only results that carry an mtime (text/binary/image/truncated);
      // error cards have none and are cheap to rebuild.
      const mtimeMs = file.mtimeMs;
      if (mtimeMs === undefined) return;
      // Native over-cap renders (D7) display but are not retained: the
      // entry-count cache is not a byte bound, so the base64 rows are dropped
      // on the next open.
      if (
        file.imageTier === "native" &&
        (file.imageLines ?? []).join("").length > IMAGE_NATIVE_CACHE_MAX_CHARS
      ) {
        return;
      }
      // Evict only when inserting a NEW key (deliberate improvement over the
      // original inline eviction, which ran unconditionally at capacity).
      if (!entries.has(relPath) && entries.size >= maxEntries) {
        // LRU eviction (Issue #109): hits refreshed recency via
        // touchCacheEntry, so the first key is the least recently used.
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(relPath, { mtimeMs, variant, file });
    },
    drop(relPath) {
      entries.delete(relPath);
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * One immutable-snapshot-bound pair of image render seams (Issue #116 fix 1).
 *
 * The loader captures `const s = imageSupport` at load start and decides
 * useNative / chafaSeam / variant from it; the seams must gate and render
 * from THAT same snapshot. Re-reading the live `imageSupport` mid-load let a
 * `setImageSupport` that lands between the capture and the seam call make the
 * seam disagree with the loader that chose it (e.g. a native-bound load
 * answering "native rendering is not available" and silently degrading to
 * chafa through viewer.ts's fallback).
 *
 * The seams own no controller: they forward the OWNING load's signal (Issue
 * #117 follow-up), so a render can only be aborted by its own load being
 * superseded or disposed — never by another load's fallback.
 */
export function makeImageSeams(opts: {
  /** The ONE snapshot this load renders under (Issue #116). */
  support: ImageSupport;
  probeDecode: () => Promise<KittyProbeVerdict>;
  /** The owning load's abort signal (Issue #117 follow-up). */
  signal: AbortSignal;
}): { renderNativeImage: ImageRenderer; renderImage: ImageRenderer } {
  /** Injected render seam (viewer.ts ImageRenderer contract): the chafa
   * availability check plus the owning load's signal, so a superseded load's
   * child never outlives the view. The result carries the requested geometry
   * back so the viewer stores imageCols/imageRows. */
  const renderImage: ImageRenderer = async (absPath, req) => {
    const support = opts.support;
    if (support.chafa.state !== "ok") return { ok: false, reason: "chafa is not available" };
    const out = await runChafaRender(absPath, req, {
      binary: support.chafa.binary,
      config: support.config,
      signal: opts.signal,
    });
    return out.ok ? { ok: true, lines: out.lines, cols: req.cols, rows: req.rows } : out;
  };

  /** Injected native render seam (same ImageRenderer contract and load-bound
   * signal as renderImage): gates on the snapshot's effective tier — a
   * strict-native session with no capability rejects cleanly so the loader
   * can degrade per file under auto. runNativeRender never throws; every
   * failure is a bounded {ok:false}. */
  const renderNativeImage: ImageRenderer = async (absPath, req) => {
    const support = opts.support;
    if (support.tier !== "native" || support.nativeProtocol === null) {
      return { ok: false, reason: "native rendering is not available" };
    }
    return runNativeRender(absPath, req, {
      protocol: support.nativeProtocol,
      signal: opts.signal,
      probeDecode: opts.probeDecode,
    });
  };

  return { renderNativeImage, renderImage };
}

/**
 * Overlay-facing port (Issue #140): the component interactions the mount
 * closure used to perform directly. The sink is defined before the overlay
 * exists (its methods only run once the overlay is constructed), so index.ts
 * can build the session first and hand its methods to the ctor. Issue #142
 * deepened the disk-watch protocol: the session pulls the displayed open
 * target, stats it, and hands the result to `checkOpenTarget`, which owns the
 * comparison, the flag and the verdict (three string calls replaced by two
 * typed ones).
 */
export interface OverlaySink {
  setTree(root: FileNode, source: "git" | "fs"): void;
  setGitState(git: GitState): void;
  setImageSupport(support: ImageSupport): void;
  /** The DISPLAYED open target (Issue #142); null while nothing is shown. */
  getOpenTarget(): OpenTarget | null;
  /**
   * Disk-watch check (Issue #142): compares the statted mtime (±1 ms; `null`
   * = stat failed = changed) against the displayed target's, writes the
   * disk-changed flag, and returns the verdict for the session's backoff.
   * Returns false without touching state when the passed target is no longer
   * the displayed one (the #040 TOCTOU guard, structural now).
   */
  checkOpenTarget(target: OpenTarget, mtimeMs: number | null): boolean;
  requestRender(): void;
}

/**
 * Everything the session needs from its mount (Issue #140). Settings, env
 * and flags are read once by index.ts before construction; `settings` and
 * `theme` are the resolved values the session renders and polls under.
 */
export interface SessionDeps {
  cwd: string;
  theme: NavigatorTheme;
  /** The env/flag-resolved settings read once per overlay invocation. */
  settings: NavigatorSettings;
  /** Current syntax style key (Issue #136), from `makeStyleKey`. Threaded into
   *  each load (so the result retains it with the pre-highlight source) and
   *  applied to cache hits, which restyle stale lines without a re-read.
   *  Optional: when absent the loader gets no key and hits are served as
   *  stored. */
  styleKey?: () => string;
  /** Host settings paths for the image-support resolution. */
  imagePaths: ImageSupportPaths;
  /** The viewer primitive: stat → sniff → read → normalize → highlight. */
  loadFile: (absPath: string, relPath: string, opts?: LoadFileOptions) => Promise<ViewerFile>;
  /** Raw warning channel, pre-bound by index.ts to ctx.ui.notify(message, "warning"). */
  notify: (message: string) => void;
  /** The already-created makeWarningNotifier(ctx.ui): one dedupe set per invocation. */
  notifyWarning: (message: string) => void;
  /** The bounded kitty a=q probe, created once per overlay invocation. */
  kittyProbe: () => Promise<KittyProbeVerdict>;
  /** Host truth for the native ladder (D4): pi-tui's getCapabilities. */
  capabilities: () => { images: NativeProtocol | null };
  /** Host API used by resolveImageSupport for the pi-chafa presence read. */
  pi: PiChafaApi;
  sink: OverlaySink;
}

export interface NavigatorSession {
  loadFile(relPath: string, opts?: LoadFileOptions): Promise<ViewerFile>;
  loadCommit(shortHash: string): Promise<ViewerFile>;
  start(): void;
  refresh(): void;
  onActivity(): void;
  dispose(): void;
}

export function createSession(deps: SessionDeps): NavigatorSession {
  const cwd = deps.cwd;

  let root: FileNode | null = null;
  let treeSource: "git" | "fs" | null = null;
  let signature = "";
  let treeProbe: string | null = null;
  // Last git status probe that was actually stamped onto the tree via
  // applyGitCodes. When an idle tick's probe matches this, the codes are
  // unchanged and the full-tree walk can be skipped (Issue #022).
  let lastStampedProbe: string | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let currentPollDelay = REFRESH_INTERVAL_MS;
  let closed = false;
  let inFlight = false;
  let lastError: string | null = null;

  // Deferred snapshot for overlay construction (D9): the overlay opens
  // immediately and imageSupport is upgraded when resolution lands.
  let imageSupport: ImageSupport = makeDeferredImageSupport(deps.settings.images.mode);
  let supportResolving = false;
  let currentImageLoad: AbortController | null = null;

  // One-shot tree truncation warning (Issue #108): the tree walks share a
  // single MAX_FS_ENTRIES cap; the first truncating walk warns immediately.
  // Same injected notifier instance as index.ts's, so the warning dedupe is
  // shared exactly as before the move.
  const noteTruncation = makeTreeTruncationWarner(deps.notifyWarning);

  /**
   * Per-load abort ownership (Issue #117 follow-up): every viewer load owns
   * one controller, and starting a load aborts the previous load's render —
   * the ONLY place one load aborts another load's work. The seams receive
   * their own load's signal, so a superseded load can never abort a newer
   * load's render (the #117 cascade).
   */
  const beginImageLoad = (): AbortController => {
    currentImageLoad?.abort();
    const controller = new AbortController();
    currentImageLoad = controller;
    return controller;
  };

  const scheduleRender = (): void => {
    if (!closed) deps.sink.requestRender();
  };

  const scheduleNextPoll = (): void => {
    if (closed) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (closed) return;
      await refreshData();
      scheduleRender();
      scheduleNextPoll();
    }, currentPollDelay);
  };

  // Per-file viewer cache (Issue #020): re-opening a file whose mtime is
  // unchanged reuses the cached highlighted lines instead of re-running
  // the stat → sniff → read → normalize → expandTabs → highlight pipeline.
  // A cheap stat decides validity; the full loadFile only runs on a real
  // change. Bounded by MAX_VIEWER_CACHE_ENTRIES (least recently used
  // evicted, #109). Chafa renders add a variant key (D11) so a geometry or
  // knob change is a cache miss; non-image entries keep variant "" and
  // behave as today.
  const viewerCache = createViewerCache(MAX_VIEWER_CACHE_ENTRIES);

  /** Variant key for a chafa cache entry: geometry + rendering knobs. */
  const imageVariant = (g: { cols: number; rows: number }, s: ImageSupport): string =>
    `${g.cols}x${g.rows}:${s.config.binaryPath ?? ""}:${s.config.colors}:${s.config.symbolsSet}:${s.config.dither}:${s.config.timeoutMs}`;

  const loadFileCached = async (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> => {
    // Issue #117 follow-up: every load owns one controller and supersedes
    // the previous load's render — including a cache hit, a text file, or
    // a failed stat, so a stale chafa child or native render never
    // outlives the view that requested it.
    const loadAbort = beginImageLoad();
    const absPath = join(cwd, relPath);
    // Issue #136: the style key this load runs under, captured once per load.
    const styleKey = deps.styleKey?.();
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(absPath)).mtimeMs;
    } catch {
      // Stat failed (deleted/permissions): let loadFile produce the error
      // card; drop any stale cache entry for this path.
      viewerCache.drop(relPath);
      return deps.loadFile(absPath, relPath);
    }
    const image = opts?.image;
    const isImage = IMAGE_EXTENSIONS.has(extOf(relPath));
    const s = imageSupport;
    // Tier/mode-aware gating (spec §7.1, §7.3): native when the tier says
    // so; chafa when the tier says so or under auto as the per-file
    // fallback for a non-PNG/oversized file (mime gate, D5).
    const useNative =
      isImage && image !== undefined && s.tier === "native" && s.nativeProtocol !== null;
    const useChafa = isImage && image !== undefined && s.tier === "chafa";
    const chafaFallback =
      isImage &&
      image !== undefined &&
      s.mode === "auto" &&
      s.piChafa.present &&
      s.chafa.state === "ok";
    const chafaSeam = useChafa || chafaFallback;
    const variant =
      useNative && image
        ? `native:${s.nativeProtocol}:${image.cols}x${image.rows}`
        : chafaSeam && image
          ? imageVariant(image, s)
          : "";
    const cacheable = isCacheableRender(useNative, s.nativeProtocol);
    const cached = viewerCache.lookup(relPath, { cacheable, mtimeMs, variant });
    if (cached) {
      // Issue #136 self-heal on a hit: stale syntax lines are re-highlighted
      // from the retained source under the current key. A theme switch thus
      // costs one re-highlight per file actually reopened — never a re-read.
      // The entry is not dropped or re-read; a restyled object is stored back
      // (which also refreshes LRU recency) and returned. Without a key source
      // (harness-only) there is no staleness notion: serve as stored.
      if (deps.styleKey === undefined) return cached;
      const restyled = restyleViewerFile(cached, styleKey ?? "");
      if (restyled !== cached) {
        viewerCache.store(relPath, { cacheable, variant, file: restyled });
        return restyled;
      }
      return cached;
    }
    let file: ViewerFile;
    if ((useNative || chafaSeam) && image) {
      // The seams render under the ONE snapshot captured at load start
      // (Issue #116 fix 1): a mid-load setImageSupport cannot make them
      // disagree with the tier decision made above.
      const seams = makeImageSeams({
        support: s,
        probeDecode: deps.kittyProbe,
        signal: loadAbort.signal,
      });
      file = await deps.loadFile(absPath, relPath, {
        image,
        ...(useNative ? { renderNativeImage: seams.renderNativeImage } : {}),
        ...(chafaSeam ? { renderImage: seams.renderImage } : {}),
        ...(styleKey !== undefined ? { styleKey } : {}),
      });
    } else if (styleKey !== undefined) {
      file = await deps.loadFile(absPath, relPath, { styleKey });
    } else {
      file = await deps.loadFile(absPath, relPath);
    }
    // Retention/eviction policy lives in createViewerCache (#109, #112,
    // D7): cacheable gate, mtime requirement, native over-cap carve-out,
    // and LRU eviction at capacity.
    viewerCache.store(relPath, { cacheable, variant, file });
    return file;
  };

  // v3 commit-diff loader: readCommitDiff returns *plain* diff lines plus
  // a stat; the theme is applied here (styleDiffLines) so git.ts stays
  // theme-free. Commits are immutable, so no cache for v1 — a bounded
  // `git show` per open is cheap.
  const loadCommit = async (shortHash: string): Promise<ViewerFile> => {
    // A commit diff is also a viewer load: opening one supersedes any
    // in-flight image render (Issue #117 follow-up).
    beginImageLoad();
    const diff = await readCommitDiff(cwd, shortHash);
    // Issue #120: the commit message rides above the diff, `git show`
    // style — subject bold, body plain, one blank separator line when a
    // diff body follows. composeDiffLines lives in diff.ts so the message
    // assembly joins styleDiffLines under the same theme-free split.
    const lines = composeDiffLines(diff, deps.theme);
    return {
      kind: "diff",
      relPath: `commit:${diff.shortHash}`,
      commitHash: diff.shortHash,
      parents: diff.parents,
      lineCount: diff.lines.length,
      lines,
      notice: diff.notice,
      // Issue #141: retain the plain styling source and the key it was styled
      // under, so invalidate() can recompose the diff under a new theme
      // without another `git show` — the #136 pattern for the diff pipeline.
      styleDiff: { message: diff.message, lines: diff.lines },
      styleKey: deps.styleKey?.(),
    };
  };

  /**
   * Resolve support once per /navigator invocation (D9, §6.4): host image
   * settings, pi-chafa presence/config, and the bounded binary probe, then
   * push the result into the overlay. The previous snapshot is passed so
   * an already-ok probe is reused on `r` (self-heal only when it was not
   * ok). Never blocks the overlay: called fire-and-forget.
   */
  const resolveSupport = async (): Promise<void> => {
    if (supportResolving || closed) return;
    supportResolving = true;
    try {
      const support = await resolveImageSupport(deps.pi, deps.imagePaths, deps.settings, {
        previous: imageSupport,
        onWarning: deps.notifyWarning,
        // Host truth for the native ladder (D4): the alias-shared pi-tui
        // instance reports the terminal as the host sees it.
        capabilities: deps.capabilities,
      });
      if (closed) return;
      imageSupport = support;
      deps.sink.setImageSupport(support);
      scheduleRender();
    } finally {
      supportResolving = false;
    }
  };

  /** The git read half of a tick: repo detection plus the porcelain state. */
  const readGit = async (): Promise<{ repo: RepoInfo; git: GitState }> => {
    const repo = await detectRepo(cwd);
    const git = await readGitState(cwd, repo);
    return { repo, git };
  };

  /**
   * Cheap change probe (plan section 7): the tree is only re-collected
   * when this string changes. Fs mode probes the modification times of
   * the expanded directories; git mode uses the porcelain-derived
   * signature. No full walk and no ls-files on an idle tick. In git
   * mode the mtimes of expanded UNTRACKED directories are folded in:
   * -unormal reports each as a single `?? dir/` record no matter its
   * contents, so the porcelain signature alone could never see an
   * entry added inside one (Issue #058).
   */
  const collectTreeProbe = async (git: GitState): Promise<string> =>
    git.available
      ? gitTreeProbe(git) + "\n" + (await collectFsProbe(cwd, expandedUntrackedDirs(root)))
      : await collectFsProbe(cwd, collectExpanded(root));

  /** Collect the entries for a changed tick, source tag included. */
  const collectTreeEntries = async (
    git: GitState,
    repo: RepoInfo,
  ): Promise<{ entries: TreeEntry[]; source: "git" | "fs" }> => {
    let entries: TreeEntry[];
    let nextSource: "git" | "fs";
    if (git.available) {
      const tracked = toCwdRelative(await readTrackedFiles(cwd), repo.prefix);
      const untracked = git.unstaged.filter((file) => file.code === "??").map((file) => file.relPath);
      const base = entriesFromPaths(Array.from(new Set([...tracked, ...untracked])));
      // Issue #058: -unormal reports an untracked directory as a single
      // `?? dir/` record (no children). Fill those subtrees with the
      // same bounded filesystem walk the fs mode uses (depth cap,
      // IGNORED_NAMES, cycle guard) so the directory is a real,
      // expandable node. Keep it read-only: the `??` badge lives on the
      // directory row itself; filled children carry no per-file codes.
      const declaredDirs = base.filter((entry) => entry.isDir);
      // Issue #108: one shared budget across every untracked-dir walk,
      // so the concurrent per-dir calls draw from a single total cap
      // instead of multiplying it.
      const fsBudget = createTreeWalkBudget();
      const subtreeEntries = await Promise.all(
        declaredDirs.map((dir) => collectDirEntries(cwd, dir.relPath, fsBudget)),
      );
      entries = [...base, ...subtreeEntries.flat()];
      noteTruncation(fsBudget.truncated);
      nextSource = "git";
    } else {
      const fsResult = await collectFsEntries(cwd);
      entries = fsResult.entries;
      noteTruncation(fsResult.truncated);
      nextSource = "fs";
    }
    if (git.available && entries.length === 0) {
      // Fresh repository: git has nothing to list, so fall back to the
      // filesystem walk (plan section 9, empty repository row).
      const fsFallback = await collectFsEntries(cwd);
      entries = fsFallback.entries;
      noteTruncation(fsFallback.truncated);
      nextSource = "fs";
    }
    return { entries, source: nextSource };
  };

  /** Install newly collected entries as the current tree (rebuild or re-stamp). */
  const stampTree = (
    entries: TreeEntry[],
    git: GitState,
    probe: string,
    expandedBefore: Set<string>,
  ): void => {
    const nextSignature = entries.map((entry) => entry.relPath + (entry.isDir ? "/" : "")).join("\n");
    const firstBuild = root === null;
    if (nextSignature !== signature || firstBuild) {
      const nextRoot = buildTree(cwd, entries, gitCodeMap(git));
      // Top level starts expanded; from the second build on the
      // remembered set wins, so a collapsed top-level directory stays
      // collapsed (README: "preserving expanded directories").
      reapplyExpansion(nextRoot, expandedBefore, firstBuild ? 0 : -1);
      root = nextRoot;
      signature = nextSignature;
      lastStampedProbe = probe;
    } else if (root) {
      // Tree shape unchanged; only re-stamp git codes if the status
      // probe actually changed since the last stamp.
      if (probe !== lastStampedProbe) {
        applyGitCodes(root, gitCodeMap(git));
        lastStampedProbe = probe;
      }
    }
  };

  /**
   * Open-target mtime probe (Issue #142): get target → skip commit targets
   * (a commit is not a filesystem path) → stat → hand the result to the sink,
   * which owns the comparison, the disk-changed flag and the verdict this
   * feeds to the backoff.
   */
  const probeOpenFile = async (): Promise<boolean> => {
    const target = deps.sink.getOpenTarget();
    if (target === null || target.kind === "commit") return false;
    try {
      const info = await stat(join(cwd, target.relPath));
      return deps.sink.checkOpenTarget(target, info.mtimeMs);
    } catch {
      return deps.sink.checkOpenTarget(target, null);
    }
  };

  /**
   * Dynamic polling backoff: if state changed, poll frequently (base delay);
   * if idle without changes, back off up to MAX_POLL_INTERVAL_MS (Issue #008).
   */
  const applyBackoff = (changed: boolean): void => {
    if (changed) {
      currentPollDelay = REFRESH_INTERVAL_MS;
    } else {
      currentPollDelay = Math.min(MAX_POLL_INTERVAL_MS, currentPollDelay + 2000);
    }
  };

  const refreshData = async (): Promise<void> => {
    // One refresh at a time. A tick that fires while the previous one is
    // still awaiting git (several execFile calls, 3 s timeout each) is
    // dropped, so runs can never interleave or land out of order.
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const { repo, git } = await readGit();
      if (closed) return;

      const probe = await collectTreeProbe(git);
      const treeChanged = root === null || probe !== treeProbe;

      if (treeChanged) {
        const expandedBefore = collectExpanded(root);
        const { entries, source } = await collectTreeEntries(git, repo);
        if (closed) return;
        stampTree(entries, git, probe, expandedBefore);
        treeSource = source;
        treeProbe = probe;
      } else if (root) {
        if (probe !== lastStampedProbe) {
          applyGitCodes(root, gitCodeMap(git));
          lastStampedProbe = probe;
        }
      }

      if (root && treeSource) deps.sink.setTree(root, treeSource);
      deps.sink.setGitState(git);
      lastError = null;

      const fileMtimeChanged = await probeOpenFile();

      applyBackoff(treeChanged || fileMtimeChanged);
    } catch (error) {
      if (closed) return;
      const message = error instanceof Error ? error.message : "refresh failed";
      // Notify once per distinct failure, not once per tick: a persistent
      // failure used to raise a warning every 3 s.
      if (message !== lastError) {
        lastError = message;
        deps.notify(`pi-navigator: ${message}`);
      }
    } finally {
      inFlight = false;
    }
  };

  const start = (): void => {
    // Fire-and-forget: the overlay opens immediately; a resolved snapshot
    // upgrades a displayed image card through setImageSupport (D9).
    void resolveSupport();
    void refreshData().then(() => {
      scheduleRender();
      scheduleNextPoll();
    });
  };

  const refresh = (): void => {
    currentPollDelay = REFRESH_INTERVAL_MS;
    void resolveSupport();
    void refreshData().then(() => {
      scheduleRender();
      scheduleNextPoll();
    });
  };

  const onActivity = (): void => {
    currentPollDelay = REFRESH_INTERVAL_MS;
    scheduleNextPoll();
  };

  /** Stop everything this session owns. Safe to call more than once. */
  const dispose = (): void => {
    closed = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    currentImageLoad?.abort();
    currentImageLoad = null;
  };

  return { loadFile: loadFileCached, loadCommit, start, refresh, onActivity, dispose };
}
