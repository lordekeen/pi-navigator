/**
 * Navigator session module (Issue #140): the overlay's data lifecycle —
 * poll timer and backoff, tree collection and stamping (`signature`,
 * `treeProbe`, `lastStampedProbe`), the git read, the tree truncation
 * warning, the per-file viewer cache with the image pipeline binding and
 * per-load abort ownership (`viewerCache`, `beginImageLoad`), the reflow
 * clock (`imageViewChanged`), image-support resolution, and the refresh-error
 * dedupe.
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
  IMAGE_RESIZE_DEBOUNCE_MS,
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
  readGitTree,
  readIgnoredEntries,
  type RepoInfo,
} from "./git";
import {
  makeDeferredImageSupport,
  makeImagePipeline,
  NATIVE_PROTOCOL_RULES,
  resolveImageSupport,
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
  expandedUntrackedDirs,
  reapplyExpansion,
  type TreeEntry,
  type TreeSkipPredicate,
} from "./tree";
import type { FileNode, GitState, OpenTarget, ViewerFile } from "./types";
import { extOf, restyleViewerFile, type LoadFileOptions } from "./viewer";
import { sameTarget } from "./open_target";

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
 * Skip predicate built from git's ignored listing (Issue #158): a path is
 * skipped when it is an ignored entry itself or lives under an ignored
 * directory. The listing's directory records are collapsed by `--directory`
 * (`dir/` → `isDir`), so descendants of an ignored directory are matched by
 * ancestor prefix rather than by enumerating its children.
 */
function makeIgnoredSkip(ignored: TreeEntry[]): TreeSkipPredicate {
  const exact = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of ignored) {
    exact.add(entry.relPath);
    if (entry.isDir) dirs.add(entry.relPath);
  }
  return (relPath: string): boolean => {
    if (exact.has(relPath)) return true;
    for (let slash = relPath.indexOf("/"); slash !== -1; slash = relPath.indexOf("/", slash + 1)) {
      if (dirs.has(relPath.slice(0, slash))) return true;
    }
    return false;
  };
}

/**
 * First-occurrence-wins dedupe for the assembled tree entries (Issue #158):
 * the ignored listing can repeat paths the untracked-directory fill already
 * produced (e.g. `untracked-dir/debug.log`), and `buildTree` dedupes
 * directories but would emit duplicate file rows for repeated file entries.
 */
function dedupeEntries(entries: TreeEntry[]): TreeEntry[] {
  const seen = new Set<string>();
  const out: TreeEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.relPath)) continue;
    seen.add(entry.relPath);
    out.push(entry);
  }
  return out;
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
 * Since Issue #144 the policy is the protocol table's `cacheable` column:
 * kitty is false, iTerm2 true (it renders its whole payload inline and carries
 * no id state), and a non-native render or a null protocol is trivially
 * cacheable.
 */
export function isCacheableRender(useNative: boolean, protocol: NativeProtocol | null): boolean {
  if (!useNative || protocol === null) return true;
  return NATIVE_PROTOCOL_RULES[protocol].cacheable;
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
      const verdict = file.imageVerdict;
      if (
        verdict?.kind === "rendered" &&
        verdict.renderer === "native" &&
        verdict.lines.join("").length > IMAGE_NATIVE_CACHE_MAX_CHARS
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
 * Support fingerprint for reflow arming (Issue #144; moved from navigator):
 * the knobs that change what a render looks like (effective tier, native
 * protocol, host width preference, chafa knobs). A fingerprint change on an
 * already-rendered image arms a debounced reflow; loading uses the variant
 * key for the cache.
 */
function supportFingerprint(s: ImageSupport): string {
  return [
    s.tier,
    s.nativeProtocol ?? "",
    String(s.hostImageWidthCells),
    s.config.binaryPath ?? "",
    s.config.colors,
    s.config.symbolsSet,
    s.config.dither,
    String(s.config.timeoutMs),
    String(s.config.cellWidth),
    String(s.config.maxRows),
  ].join(":");
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
  /**
   * The DISPLAYED image view's shape (Issue #144): null when nothing is
   * displayed or the file is not `kind: "image"`. `rendered` is a rendered
   * verdict carrying rows; `asCard` is the overlay's session-only `i` toggle
   * that hides those rows.
   */
  getImageView(): { rendered: boolean; asCard: boolean } | null;
  /**
   * Re-open the DISPLAYED file target through the normal `openTarget` path,
   * keeping scroll (Issue #144). No-op for commit and absent targets: the
   * reflow clock validates before calling, and a targetless request must not
   * become a load.
   */
  reflowOpenImage(): void;
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
  /**
   * Pane geometry drifted for a displayed image (Issue #144): debounce, then
   * re-validate at fire time and command the overlay to re-open its displayed
   * file through `reflowOpenImage`. The overlay only reports the drift; the
   * session owns the clock, the re-arm-while-loading rule and the arming on a
   * landed support snapshot.
   */
  imageViewChanged(): void;
  start(): void;
  refresh(): void;
  onActivity(): void;
  dispose(): void;
}

export function createSession(deps: SessionDeps): NavigatorSession {
  const cwd = deps.cwd;
  // Issue #158: the gitignore policy is fixed for the overlay's lifetime, like
  // every other setting — settings are read once per /navigator invocation.
  const respectGitignore = deps.settings.tree.respectGitignore;

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

  // Reflow clock (Issue #144): the session owns the debounce, the
  // re-arm-while-loading rule and the support-landing arming; the overlay
  // only detects pane-geometry drift (imageViewChanged) and executes the
  // re-open. `lastSupportFingerprint` is null until the first push, which
  // counts as changed (the deferred→resolved upgrade).
  let reflowTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingReflow: OpenTarget | null = null;
  let lastSupportFingerprint: string | null = null;
  /**
   * The in-flight IMAGE load's target, or null when none is (a commit load
   * sets it to null, matching the overlay's viewTarget semantics: a commit is
   * never a reflow target). A landed support snapshot arms against this
   * before the displayed target, so the FIRST image load of a session still
   * upgrades when support resolves mid-load (Issue #116 fix 3).
   */
  let inFlightImageTarget: OpenTarget | null = null;

  // One-shot tree truncation warning (Issue #108): the tree walks share a
  // single MAX_FS_ENTRIES cap; the first truncating walk warns immediately.
  // Same injected notifier instance as index.ts's, so the warning dedupe is
  // shared exactly as before the move.
  const noteTruncation = makeTreeTruncationWarner(deps.notifyWarning);

  /**
   * Per-load abort ownership (Issue #117 follow-up): every viewer load owns
   * one controller, and starting a load aborts the previous load's render —
   * the ONLY place one load aborts another load's work. The pipeline receives
   * its own load's signal, so a superseded load can never abort a newer
   * load's render (the #117 cascade).
   *
   * Completing a load releases the controller (Issue #144): a non-null
   * `currentImageLoad` therefore means exactly "a load is in flight", which
   * is the signal the reflow clock re-arms on. Overlapping loads release only
   * their own controller.
   */
  const beginImageLoad = (): AbortController => {
    currentImageLoad?.abort();
    const controller = new AbortController();
    currentImageLoad = controller;
    return controller;
  };

  const endImageLoad = (controller: AbortController): void => {
    if (currentImageLoad === controller) currentImageLoad = null;
  };

  /**
   * Arm the debounced reflow once (Issue #144): one timer at a time, so a
   * pending reflow absorbs every later trigger until it fires.
   */
  const armReflow = (target: OpenTarget): void => {
    if (closed) return;
    // Issue #205: a newer target always replaces the pending one. The timer
    // stays single (so repeats still coalesce), but the target captured for
    // the fire-time validation must be the newest — otherwise a geometry
    // change that lands after the displayed image moved on validates against
    // a stale target and drops the reflow entirely.
    pendingReflow = target;
    if (reflowTimer !== null) return;
    reflowTimer = setTimeout(() => {
      reflowTimer = null;
      const pending = pendingReflow;
      pendingReflow = null;
      if (closed || pending === null) return;
      // Issue #116 fix 4: never fire a reflow while a load is in flight —
      // re-arm the debounce instead. Firing would supersede the pending
      // load's controller and discard its work.
      if (currentImageLoad !== null) {
        armReflow(pending);
        return;
      }
      // Re-validate at fire time: the displayed target must still be the one
      // captured, and the view must still be an image.
      const displayed = deps.sink.getOpenTarget();
      if (displayed === null || !sameTarget(displayed, pending)) return;
      if (deps.sink.getImageView() === null) return;
      deps.sink.reflowOpenImage();
    }, IMAGE_RESIZE_DEBOUNCE_MS);
  };

  /**
   * Reflow arming on a landed support snapshot (Issue #144; moved from
   * navigator.setImageSupport). The target is the session's own in-flight
   * image target before the displayed one, so a support landing while the
   * first image load is still pending arms the upgrade. A carded view never
   * arms; an already-rendered displayed image arms only on a fingerprint
   * change.
   */
  const armReflowOnSupport = (support: ImageSupport): void => {
    const fingerprint = supportFingerprint(support);
    const changed = fingerprint !== lastSupportFingerprint;
    lastSupportFingerprint = fingerprint;
    if (closed || support.tier === "none") return;
    const target = inFlightImageTarget ?? deps.sink.getOpenTarget();
    if (target === null || target.kind !== "file" || !IMAGE_EXTENSIONS.has(extOf(target.relPath))) {
      return;
    }
    const view = deps.sink.getImageView();
    if (view !== null && view.asCard) return;
    const displayed = deps.sink.getOpenTarget();
    const viewIsRendered =
      view !== null && view.rendered && displayed !== null && sameTarget(displayed, target);
    if (!viewIsRendered || changed) armReflow(target);
  };

  /**
   * Pane geometry drifted for the displayed image (the overlay reported it):
   * capture the currently displayed target and debounce. No-op while no tier
   * exists (nothing can render) or while a reflow is already pending.
   */
  const imageViewChanged = (): void => {
    if (closed || imageSupport.tier === "none") return;
    const target = deps.sink.getOpenTarget();
    if (target === null) return;
    armReflow(target);
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
    // outlives the view that requested it. Issue #144: an image load also
    // publishes its target while in flight (the reflow arming reads it) and
    // releases the controller on completion, so a non-null `currentImageLoad`
    // means exactly "a load is running". Issue #182: a non-image load
    // publishes no target — it clears the field so the arming falls back to
    // the displayed image instead of shadowing it.
    const loadAbort = beginImageLoad();
    const isImage = IMAGE_EXTENSIONS.has(extOf(relPath));
    const inFlightTarget: OpenTarget | null = isImage ? { kind: "file", relPath } : null;
    inFlightImageTarget = inFlightTarget;
    try {
      const absPath = join(cwd, relPath);
      // Issue #136: the style key this load runs under, captured once per load.
      const styleKey = deps.styleKey?.();
      let statInfo: { isFile: boolean; sizeBytes: number; mtimeMs: number };
      try {
        const info = await stat(absPath);
        // One stat per load (Issue #144): the loader consumes this record
        // instead of statting the same path again.
        statInfo = { isFile: info.isFile(), sizeBytes: info.size, mtimeMs: info.mtimeMs };
      } catch {
        // Stat failed (deleted/permissions): let loadFile produce the error
        // card; drop any stale cache entry for this path.
        viewerCache.drop(relPath);
        return deps.loadFile(absPath, relPath);
      }
      const image = opts?.image;
      const s = imageSupport;
      // One decision per load (Issue #144): the snapshot + pane geometry
      // build ONE pipeline up front; its plan supplies the attempts, and the
      // variant, cacheability and renderer below all derive from that same
      // plan. Native first; chafa when the tier says so or as auto's
      // per-file fallback (spec §7.1, §7.3, D5).
      const pipeline =
        isImage && image !== undefined
          ? makeImagePipeline(s, image, { probeDecode: deps.kittyProbe, signal: loadAbort.signal })
          : null;
      const attempts = pipeline?.attempts ?? [];
      const variant =
        attempts.includes("native") && image !== undefined
          ? `native:${s.nativeProtocol}:${image.cols}x${image.rows}`
          : attempts.length > 0 && image !== undefined
            ? imageVariant(image, s)
            : "";
      const cacheable = isCacheableRender(attempts.includes("native"), s.nativeProtocol);
      const cached = viewerCache.lookup(relPath, {
        cacheable,
        mtimeMs: statInfo.mtimeMs,
        variant,
      });
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
      if (pipeline !== null && attempts.length > 0 && image !== undefined) {
        // The pipeline renders under the ONE snapshot captured at load start
        // (Issue #116 fix 1): a mid-load setImageSupport cannot make it
        // disagree with the plan made above. viewer.ts consumes one typed
        // outcome — the abort string is gone (Issue #144).
        file = await deps.loadFile(absPath, relPath, {
          image,
          imageRenderer: pipeline.render,
          stat: statInfo,
          ...(styleKey !== undefined ? { styleKey } : {}),
        });
      } else if (styleKey !== undefined) {
        file = await deps.loadFile(absPath, relPath, { stat: statInfo, styleKey });
      } else {
        file = await deps.loadFile(absPath, relPath, { stat: statInfo });
      }
      // Retention/eviction policy lives in createViewerCache (#109, #112,
      // D7): cacheable gate, mtime requirement, native over-cap carve-out,
      // and LRU eviction at capacity. Issue #184: a superseded load resolves
      // to the failure-free card, which must not enter the cache — the overlay
      // discards the result, but the entry would serve that card on a later
      // reopen at the same mtime + variant.
      if (!loadAbort.signal.aborted) viewerCache.store(relPath, { cacheable, variant, file });
      return file;
    } finally {
      if (inFlightImageTarget === inFlightTarget) inFlightImageTarget = null;
      endImageLoad(loadAbort);
    }
  };

  // v3 commit-diff loader: readCommitDiff returns *plain* diff lines plus
  // a stat; the theme is applied here (styleDiffLines) so git.ts stays
  // theme-free. Commits are immutable, so no cache for v1 — a bounded
  // `git show` per open is cheap.
  const loadCommit = async (shortHash: string): Promise<ViewerFile> => {
    // A commit diff is also a viewer load: opening one supersedes any
    // in-flight image render (Issue #117 follow-up). No image target is the
    // in-flight one while a commit loads (Issue #144), matching the overlay's
    // viewTarget semantics: a commit is never a reflow target.
    const loadAbort = beginImageLoad();
    inFlightImageTarget = null;
    try {
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
    } finally {
      endImageLoad(loadAbort);
    }
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
      // Support landing (Issue #144): arm the upgrade reflow against the
      // in-flight image target before the displayed one (#116 fix 3).
      armReflowOnSupport(support);
      scheduleRender();
    } catch (error) {
      // Issue #206: resolution is fire-and-forget from start()/refresh(); a
      // rejection here used to escape as an unhandled rejection. Report the one
      // bounded reason and swallow it — the finally clears supportResolving so a
      // later refresh resolves support again.
      const detail = error instanceof Error ? error.message : "unknown error";
      deps.notifyWarning(`image support resolution failed: ${detail}`.slice(0, 200));
    } finally {
      supportResolving = false;
    }
  };

  /**
   * Repository detection is invariant for the overlay's lifetime (Issue
   * #170): the first available `RepoInfo` is reused so an idle tick runs
   * four `readGitState` commands, not a fifth `rev-parse`. A failed
   * detection or porcelain read retires it, so a mid-session `git init`,
   * repo move or git failure is re-detected on the next tick.
   */
  let repoInfo: RepoInfo | null = null;

  /** The git read half of a tick: repo detection plus the porcelain state. */
  const readGit = async (): Promise<{ repo: RepoInfo; git: GitState }> => {
    const repo = repoInfo ?? (await detectRepo(cwd));
    const git = await readGitState(cwd, repo);
    // `error` covers the #107 status failure, where the state stays usable
    // (available: true) but the repo may have moved out from under the cache.
    repoInfo = repo.available && git.available && git.error === undefined ? repo : null;
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
   * entry added inside one (Issue #058). Expanded ignored (`!!`) dirs
   * join that set too (Issue #158).
   *
   * With `tree.respectGitignore` off the ignored listing is part of the
   * visible tree, so its path signature joins the probe: a top-level
   * ignored add/remove changes the tree without changing porcelain
   * (Issue #158). With the setting on the folded signature is empty, so
   * the probe string is byte-identical to the pre-#158 behavior.
   */
  const collectTreeProbe = async (git: GitState, ignored: TreeEntry[]): Promise<string> => {
    if (!git.available) return await collectFsProbe(cwd, collectExpanded(root));
    const ignoredSignature =
      respectGitignore || ignored.length === 0
        ? ""
        : ignored.map((entry) => entry.relPath + (entry.isDir ? "/" : "")).join("\n") + "\n";
    return gitTreeProbe(git) + "\n" + ignoredSignature + (await collectFsProbe(cwd, expandedUntrackedDirs(root)));
  };

  /** Collect the entries for a changed tick, source tag included. */
  const collectTreeEntries = async (
    git: GitState,
    repo: RepoInfo,
    ignored: TreeEntry[],
  ): Promise<{ entries: TreeEntry[]; source: "git" | "fs" }> => {
    let entries: TreeEntry[];
    let nextSource: "git" | "fs";
    if (git.available) {
      // Issue #146: one entry owns the path protocol — tracked files
      // (prefix-translated, outsiders dropped) first, then the untracked
      // `??` records, deduped tracked-first; the `?? dir/` slash is already
      // normalized to `isDir` at the porcelain boundary.
      const { entries: base, skipped } = await readGitTree(cwd, git, repo);
      // Issue #220: a path git holds but UTF-8 cannot express is dropped, not
      // mangled. Say so once — the injected notifier dedupes per message per
      // /navigator invocation, so a repeated tick stays quiet.
      if (skipped > 0) {
        deps.notifyWarning(`${skipped} path(s) are not valid UTF-8 and are not listed`);
      }
      // Issue #058: -unormal reports an untracked directory as a single
      // `?? dir/` record (no children). Fill those subtrees with the
      // same bounded filesystem walk the fs mode uses (depth cap,
      // IGNORED_NAMES, cycle guard) so the directory is a real,
      // expandable node. Keep it read-only: the `??` badge lives on the
      // directory row itself; filled children carry no per-file codes.
      const declaredDirs = base.filter((entry) => entry.isDir);
      let merged = base;
      let skip: TreeSkipPredicate | undefined;
      if (!respectGitignore) {
        // Issue #158 off-polarity: the ignored listing is part of the
        // visible tree (badged `!!` through the per-tick code map). Its
        // own directories join the subtree fill too, so `!!` dirs expand
        // into their (ignored) children, still with no per-file codes on
        // the filled rows — the existing `??` convention.
        merged = dedupeEntries([...base, ...ignored]);
        for (const entry of ignored) {
          if (entry.isDir && !declaredDirs.some((dir) => dir.relPath === entry.relPath)) {
            declaredDirs.push(entry);
          }
        }
      } else if (declaredDirs.length > 0) {
        // Issue #158 on-polarity: the untracked-dir fill must not surface
        // ignored children. One listing call, and only when a fill will
        // actually run (otherwise there is nothing to filter). The
        // predicate prunes the walk before an ignored entry is pushed or
        // descended into, so the shared budget is never spent on hidden
        // subtrees.
        const fillIgnored = await readIgnoredEntries(cwd, repo);
        if (fillIgnored.length > 0) skip = makeIgnoredSkip(fillIgnored);
      }
      // Issue #108: one shared budget across every untracked-dir walk,
      // so the concurrent per-dir calls draw from a single total cap
      // instead of multiplying it.
      const fsBudget = createTreeWalkBudget();
      const subtreeEntries = await Promise.all(
        declaredDirs.map((dir) => collectDirEntries(cwd, dir.relPath, fsBudget, skip)),
      );
      // Issue #158: the ignored listing can repeat paths the fill already
      // produced; buildTree would emit duplicate file rows for those.
      entries = dedupeEntries([...merged, ...subtreeEntries.flat()]);
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
      // filesystem walk (plan section 9, empty repository row). Git is
      // available here, so the ignore rules can still be resolved: with
      // the setting on, the fallback walk is filtered through the same
      // predicate; with it off the walk already shows everything.
      let skip: TreeSkipPredicate | undefined;
      if (respectGitignore) {
        const fallbackIgnored = await readIgnoredEntries(cwd, repo);
        if (fallbackIgnored.length > 0) skip = makeIgnoredSkip(fallbackIgnored);
      }
      const fsFallback = await collectFsEntries(cwd, skip ? { skip } : undefined);
      entries = fsFallback.entries;
      noteTruncation(fsFallback.truncated);
      nextSource = "fs";
    }
    return { entries, source: nextSource };
  };

  /** Install newly collected entries as the current tree (rebuild or re-stamp).
   *  `codes` is the tick's single derived code map (Issue #146). */
  const stampTree = (
    entries: TreeEntry[],
    codes: Map<string, string>,
    probe: string,
    expandedBefore: Set<string>,
  ): void => {
    const nextSignature = entries.map((entry) => entry.relPath + (entry.isDir ? "/" : "")).join("\n");
    const firstBuild = root === null;
    if (nextSignature !== signature || firstBuild) {
      const nextRoot = buildTree(cwd, entries, codes);
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
        applyGitCodes(root, codes);
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

      // Issue #146: one pure code map per tick, shared by the rebuild and the
      // unchanged-shape re-stamp branches below.
      const codes = gitCodeMap(git);
      // Issue #158: with the setting off, one ignored listing drives the
      // probe, the `!!` badge map and the merge. It is read once per tick
      // before the probe so a top-level ignored add/remove changes the probe
      // too; with the setting on it is read inside collectTreeEntries only
      // when an untracked-dir fill actually needs filtering.
      const ignored = !respectGitignore && git.available ? await readIgnoredEntries(cwd, repo) : [];
      if (closed) return;
      if (!respectGitignore) {
        for (const entry of ignored) codes.set(entry.relPath, "!!");
      }
      const probe = await collectTreeProbe(git, ignored);
      const treeChanged = root === null || probe !== treeProbe;

      if (treeChanged) {
        const expandedBefore = collectExpanded(root);
        const { entries, source } = await collectTreeEntries(git, repo, ignored);
        if (closed) return;
        stampTree(entries, codes, probe, expandedBefore);
        treeSource = source;
        treeProbe = probe;
      } else if (root) {
        if (probe !== lastStampedProbe) {
          applyGitCodes(root, codes);
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
      try {
        if (message !== lastError) {
          lastError = message;
          deps.notify(`pi-navigator: ${message}`);
        }
      } catch {
        // Issue #206: the notification must never break the loop — the poll only
        // reschedules while this promise keeps resolving.
      }
      // Issue #206: a failed tick is idle growth, never a base-interval retry.
      applyBackoff(false);
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
    // The reflow clock belongs to the session (Issue #144): disposal drops
    // any pending reflow outright.
    if (reflowTimer) {
      clearTimeout(reflowTimer);
      reflowTimer = null;
    }
    pendingReflow = null;
    currentImageLoad?.abort();
    currentImageLoad = null;
  };

  return { loadFile: loadFileCached, loadCommit, imageViewChanged, start, refresh, onActivity, dispose };
}
