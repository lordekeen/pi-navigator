/**
 * pi-navigator — read-only project file navigator overlay for pi.
 *
 * Establishes the /navigator command grammar (Issue #061): bare opens a
 * centered overlay with a file tree, git state panel, and a syntax-highlighted
 * viewer; `settings` opens the settings menu (TUI only); `help` appends a
 * durable help entry; any other subcommand warns then shows help.
 *
 * Data ownership: this entry point owns all async work (git, tree collection,
 * file stats) and pushes results into the overlay through setters. The overlay
 * component itself never touches the filesystem. The refresh interval exists
 * only while the overlay is open and is cleared both by the overlay's own close
 * path and by the component's dispose() hook, so an externally closed overlay
 * cannot leak it.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";

import { getCapabilities, Text } from "@earendil-works/pi-tui";

import {
  IMAGE_EXTENSIONS,
  IMAGE_NATIVE_CACHE_MAX_CHARS,
  MAX_FS_ENTRIES,
  MAX_POLL_INTERVAL_MS,
  MAX_VIEWER_CACHE_ENTRIES,
  NAVIGATOR_IMAGES_ENV,
  NAVIGATOR_SETTINGS_FILE,
  OVERLAY_OPTIONS,
  REFRESH_INTERVAL_MS,
} from "./constants";
import {
  detectRepo,
  gitCodeMap,
  gitTreeProbe,
  readCommitDiff,
  readGitState,
  readTrackedFiles,
  toCwdRelative,
} from "./git";
import { ICONS_ENV } from "./icons";
import { buildHelpLines, HELP_COMMANDS_TITLE, HELP_HEADER_PREFIX, HELP_HINT, HELP_ENTRY_TYPE, helpCommandColumnWidth, NAVIGATOR_CMD_PREFIX, NAVIGATOR_SUBCOMMANDS, type NavigatorHelpData } from "./help";
import { makeDeferredImageSupport, resolveImageSupport, runChafaRender, runNativeRender, buildKittyProbeQuery, consumeKittyProbeReply, createKittyProbeState, type ImageSupport, type KittyProbeState, type KittyProbeVerdict, type NativeProtocol } from "./images";
import { loadNavigatorSettings, writeNavigatorSettings } from "./settings";
import { openSettingsMenu } from "./settings_menu";
import { styleDiffLines } from "./diff";
import { NavigatorOverlay } from "./navigator";
import { makeNavigatorTheme } from "./theme";
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
import type { FileNode, GitState, ViewerFile } from "./types";
import { extOf, loadFile, type LoadFileOptions } from "./viewer";

type TuiLike = {
  terminal: { rows: number; write: (data: string) => void };
  requestRender: () => void;
  addInputListener: (
    listener: (data: string) => { consume?: boolean; data?: string } | undefined,
  ) => () => void;
};

/**
 * Kitty decode probe (Issue #101, #102): one `a=q` query per mime, per
 * process, answered by the terminal's own input stream. The query transmits a
 * real 1x1 sample of that mime (all tagged `f=100`, matching pi-tui's own
 * encodeKitty) so a PNG probe cannot vouch for JPEG/WebP decodability. The
 * verdict is conservative — only an explicit error reply degrades native
 * rendering; "ok" confirms it; "no-reply" (timeout, or a mime with no probe
 * sample, or a terminal that does not answer queries, e.g. some partial kitty
 * implementations) keeps declared behavior so Konsole-style terminals cannot
 * regress. Memoized at module level: opening the navigator again reuses the
 * session's probe result.
 */
const KITTY_PROBE_TIMEOUT_MS = 250;
const kittyProbeCache = new Map<string, Promise<KittyProbeVerdict>>();

export function makeTuiKittyDecodeProbe(
  tui: TuiLike,
  opts?: { timeoutMs?: number; cache?: Map<string, Promise<KittyProbeVerdict>> },
): (mime: string) => Promise<KittyProbeVerdict> {
  const timeoutMs = opts?.timeoutMs ?? KITTY_PROBE_TIMEOUT_MS;
  // Injectable cache is a test seam only: production default stays the
  // module-level cache, so behavior is unchanged (Issue #102 timeout test).
  const cache = opts?.cache ?? kittyProbeCache;
  return (mime) => {
    let probe = cache.get(mime);
    if (probe === undefined) {
      probe = new Promise<KittyProbeVerdict>((resolve) => {
        const id = Math.floor(Math.random() * 0xffffffff) + 1;
        const query = buildKittyProbeQuery(id, mime);
        if (query === null) {
          // No probe sample for this mime (unreachable in production — the
          // runNativeRender kitty mime gate only ever asks for png/jpeg/webp,
          // which all have samples). Conservative "no-reply": keep declared
          // behavior and transmit nothing (Issue #102).
          resolve("no-reply");
          return;
        }
        const state: KittyProbeState = createKittyProbeState();
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: (() => void) | undefined;
        const settle = (verdict: KittyProbeVerdict): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          unsubscribe?.();
          resolve(verdict);
        };
        timer = setTimeout(() => settle("no-reply"), timeoutMs);
        unsubscribe = tui.addInputListener((data) => {
          if (settled) return undefined;
          const verdict = consumeKittyProbeReply(state, data, id);
          if (verdict === "ok" || verdict === "error") {
            settle(verdict);
            // Consume the completing chunk: it is the reply to our own query,
            // nothing for the key decoder. Partial chunks are left alone.
            return { consume: true };
          }
          return undefined;
        });
        // Write through the TUI's terminal so the query is ordered with
        // renders; the reply arrives on the same input stream the listener
        // watches — the same pattern as pi-tui's own terminal queries.
        tui.terminal.write(query);
      });
      cache.set(mime, probe);
    }
    return probe;
  };
}

/**
 * Pure argument routing for /navigator (Issue #061): the first whitespace
 * token decides, trailing tokens are ignored, matching is case-sensitive
 * lowercase (a `Settings` token is unknown).
 */
export type ParsedNavigatorArgs =
  | { readonly kind: "overlay" }
  | { readonly kind: "settings" }
  | { readonly kind: "help" }
  | { readonly kind: "unknown"; readonly raw: string };

export function parseNavigatorArgs(args: string): ParsedNavigatorArgs {
  const token = args.trim().split(/\s+/).filter(Boolean)[0];
  if (token === undefined) return { kind: "overlay" };
  // Subcommand tokens come from the shared help table (Issue #063 finding 5);
  // the kind and the token are the same identifier by construction.
  const known = NAVIGATOR_SUBCOMMANDS.some((sub) => sub.cmd.slice(NAVIGATOR_CMD_PREFIX.length) === token);
  if (known) return { kind: token as "settings" | "help" };
  return { kind: "unknown", raw: token };
}

/**
 * Argument completions for /navigator: settings / help, filtered by prefix.
 * Rows project from NAVIGATOR_SUBCOMMANDS (Issue #063 finding 5) so the
 * completion descriptions cannot drift from the /navigator help rows.
 */
export function navigatorCompletions(prefix: string): { value: string; label: string; description: string }[] | null {
  const items = NAVIGATOR_SUBCOMMANDS.map((sub) => ({
    value: sub.cmd.slice(NAVIGATOR_CMD_PREFIX.length),
    label: sub.completionLabel,
    description: sub.desc,
  }));
  const filtered = items.filter((item) => item.value.startsWith(prefix));
  return filtered.length > 0 ? filtered : null;
}

/**
 * Notify-once-per-invocation warning channel (§5.2 convention): prefixes
 * "pi-navigator: ", uses "warning" severity, and dedupes per call — the Set
 * is created here per factory call, so a later /navigator invocation warns
 * again for the same message instead of silently swallowing it.
 */
export function makeWarningNotifier(
  ui: Pick<ExtensionUIContext, "notify">,
): (message: string) => void {
  const emittedWarnings = new Set<string>();
  return (message: string): void => {
    if (emittedWarnings.has(message)) return;
    emittedWarnings.add(message);
    ui.notify("pi-navigator: " + message, "warning");
  };
}

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

async function runNavigator(pi: ExtensionAPI, ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("pi-navigator requires the interactive TUI", "warning");
    return;
  }

  const cwd = ctx.cwd;

  await ctx.ui.custom<null>(
    (tui: TuiLike, piTheme: Theme, _keybindings: unknown, done: (value: null) => void) => {
      // Overlay-local keys (j k, /, ? q) are hardcoded by convention per the
      // standards report section 2.5, as the reference overlay does; the
      // injected KeybindingsManager is accepted for signature compatibility and
      // deliberately not consulted.
      const theme = makeNavigatorTheme(piTheme);

      // Kitty decode probe (Issue #101): one a=q query per mime per process,
      // gating native renders on the terminal's own decode reply.
      const kittyProbe = makeTuiKittyDecodeProbe(tui);

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

      // ── Image support (optional chafa rendering) — resolved per invocation ──
      // Settings are read once here (never in the component, Issue #028/#039
      // pattern); warnings notify once per distinct message (§5.2).
      const agentDir = getAgentDir();
      const loaded = loadNavigatorSettings({
        userPath: join(agentDir, NAVIGATOR_SETTINGS_FILE),
        env: { images: process.env[NAVIGATOR_IMAGES_ENV], icons: process.env[ICONS_ENV] },
      });
      const notifyWarning = makeWarningNotifier(ctx.ui);
      // One-shot tree truncation warning (Issue #108): the tree walks share a
      // single MAX_FS_ENTRIES cap; the first truncating walk warns immediately.
      const noteTruncation = makeTreeTruncationWarner(notifyWarning);
      for (const warning of loaded.warnings) notifyWarning(warning);
      const imagePaths = {
        userSettings: join(agentDir, "settings.json"),
        projectSettings: join(cwd, ".pi", "settings.json"),
        agentDir,
      };
      // Deferred snapshot for overlay construction (D9): the overlay opens
      // immediately and imageSupport is upgraded when resolution lands.
      let imageSupport: ImageSupport = makeDeferredImageSupport(loaded.settings.images.mode);
      let supportResolving = false;
      let imageAbort: AbortController | null = null;

      /** Stop everything this overlay owns. Safe to call more than once. */
      const cleanup = (): void => {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        imageAbort?.abort();
        imageAbort = null;
        overlay.dispose();
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        cleanup();
        done(null);
      };

      const scheduleRender = (): void => {
        if (!closed) tui.requestRender();
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

      /**
       * Injected render seam (viewer.ts ImageRenderer contract): owns the
       * abort lifecycle (one controller per load; aborted on dispose and on
       * a newer load) and the chafa availability check. The result carries
       * the requested geometry back so the viewer stores imageCols/imageRows.
       */
      const renderImage = async (
        absPath: string,
        req: { cols: number; rows: number },
      ): Promise<{ ok: true; lines: string[]; cols: number; rows: number } | { ok: false; reason: string }> => {
        const support = imageSupport;
        if (support.chafa.state !== "ok") return { ok: false, reason: "chafa is not available" };
        imageAbort?.abort();
        const controller = new AbortController();
        imageAbort = controller;
        const out = await runChafaRender(absPath, req, {
          binary: support.chafa.binary,
          config: support.config,
          signal: controller.signal,
        });
        return out.ok ? { ok: true, lines: out.lines, cols: req.cols, rows: req.rows } : out;
      };

      /**
       * Injected native render seam (same ImageRenderer contract and abort
       * lifecycle as renderImage): owns the abort controller and gates on the
       * effective tier — a strict-native session with no capability rejects
       * cleanly so the loader can degrade per file under auto. runNativeRender
       * never throws; every failure is a bounded {ok:false}.
       */
      const renderNativeImage = async (
        absPath: string,
        req: { cols: number; rows: number },
      ): Promise<{ ok: true; lines: string[]; cols: number; rows: number } | { ok: false; reason: string }> => {
        const support = imageSupport;
        if (support.tier !== "native" || support.nativeProtocol === null) {
          return { ok: false, reason: "native rendering is not available" };
        }
        imageAbort?.abort();
        const controller = new AbortController();
        imageAbort = controller;
        return runNativeRender(absPath, req, {
          protocol: support.nativeProtocol,
          signal: controller.signal,
          probeDecode: kittyProbe,
        });
      };

      const loadFileCached = async (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> => {
        const absPath = join(cwd, relPath);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(absPath)).mtimeMs;
        } catch {
          // Stat failed (deleted/permissions): let loadFile produce the error
          // card; drop any stale cache entry for this path.
          viewerCache.drop(relPath);
          return loadFile(absPath, relPath);
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
        if (cached) return cached;
        let file: ViewerFile;
        if ((useNative || chafaSeam) && image) {
          file = await loadFile(absPath, relPath, {
            image,
            ...(useNative ? { renderNativeImage } : {}),
            ...(chafaSeam ? { renderImage } : {}),
          });
        } else {
          file = await loadFile(absPath, relPath);
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
        const diff = await readCommitDiff(cwd, shortHash);
        return {
          kind: "diff",
          relPath: `commit:${diff.shortHash}`,
          commitHash: diff.shortHash,
          parents: diff.parents,
          lineCount: diff.lines.length,
          lines: styleDiffLines(diff.lines, theme),
          notice: diff.notice,
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
          const support = await resolveImageSupport(pi, imagePaths, loaded.settings, {
            previous: imageSupport,
            onWarning: notifyWarning,
            // Host truth for the native ladder (D4): the alias-shared pi-tui
            // instance reports the terminal as the host sees it.
            capabilities: () => getCapabilities(),
          });
          if (closed) return;
          imageSupport = support;
          overlay.setImageSupport(support);
          scheduleRender();
        } finally {
          supportResolving = false;
        }
      };

      const overlay = new NavigatorOverlay({
        cwd,
        theme,
        getTerminalRows: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
        onClose: close,
        loadFile: loadFileCached,
        loadCommit,
        refresh: () => {
          currentPollDelay = REFRESH_INTERVAL_MS;
          void resolveSupport();
          void refreshData().then(() => {
            scheduleRender();
            scheduleNextPoll();
          });
        },
        // Env reads happen here, once, at overlay open; the component never
        // touches process.env (Issues #028, #039, #061). `enableIcons` and the
        // three initial-state options come from the env-resolved settings.
        enableIcons: loaded.settings.icons.enabled,
        home: process.env.HOME ?? process.env.USERPROFILE ?? "",
        // Deferred snapshot; upgraded via setImageSupport when resolution lands.
        imageSupport,
        initialShowHidden: loaded.settings.tree.showHidden,
        initialWrap: loaded.settings.viewer.wrap,
        initialRenderMarkdown: loaded.settings.viewer.markdown === "rendered",
      });

      // Fire-and-forget: the overlay opens immediately; a resolved snapshot
      // upgrades a displayed image card through setImageSupport (D9).
      void resolveSupport();

      const refreshData = async (): Promise<void> => {
        // One refresh at a time. A tick that fires while the previous one is
        // still awaiting git (several execFile calls, 3 s timeout each) is
        // dropped, so runs can never interleave or land out of order.
        if (closed || inFlight) return;
        inFlight = true;
        try {
          const repo = await detectRepo(cwd);
          const git: GitState = await readGitState(cwd, repo);
          if (closed) return;

          // Cheap change probe (plan section 7): the tree is only re-collected
          // when this string changes. Fs mode probes the modification times of
          // the expanded directories; git mode uses the porcelain-derived
          // signature. No full walk and no ls-files on an idle tick. In git
          // mode the mtimes of expanded UNTRACKED directories are folded in:
          // -unormal reports each as a single `?? dir/` record no matter its
          // contents, so the porcelain signature alone could never see an
          // entry added inside one (Issue #058).
          const probe = git.available
            ? gitTreeProbe(git) + "\n" + (await collectFsProbe(cwd, expandedUntrackedDirs(root)))
            : await collectFsProbe(cwd, collectExpanded(root));
          const treeChanged = root === null || probe !== treeProbe;

          if (treeChanged) {
            const expandedBefore = collectExpanded(root);
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
            if (closed) return;

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
            treeSource = nextSource;
            treeProbe = probe;
          } else if (root) {
            if (probe !== lastStampedProbe) {
              applyGitCodes(root, gitCodeMap(git));
              lastStampedProbe = probe;
            }
          }

          if (root && treeSource) overlay.setTree(root, treeSource);
          overlay.setGitState(git);
          lastError = null;

          const openRel = overlay.getOpenRelPath();
          let fileMtimeChanged = false;
          if (openRel) {
            // v3: a commit:<hash> viewer path is not a filesystem path — skip
            // the mtime poll (stat(join(cwd, "commit:abc1234")) would fail and
            // set a spurious diskChanged every tick).
            if (!openRel.startsWith("commit:")) {
              try {
                const info = await stat(join(cwd, openRel));
                if (overlay.getOpenRelPath() === openRel) {
                  const known = overlay.getOpenMtime();
                  const changed = known !== undefined && Math.abs(info.mtimeMs - known) > 1;
                  overlay.setDiskChanged(changed);
                  fileMtimeChanged = changed;
                }
              } catch {
                if (overlay.getOpenRelPath() === openRel) {
                  overlay.setDiskChanged(true);
                  fileMtimeChanged = true;
                }
              }
            }
          }

          // Dynamic polling backoff: if state changed, poll frequently (base delay);
          // if idle without changes, back off up to MAX_POLL_INTERVAL_MS (Issue #008).
          if (treeChanged || fileMtimeChanged) {
            currentPollDelay = REFRESH_INTERVAL_MS;
          } else {
            currentPollDelay = Math.min(MAX_POLL_INTERVAL_MS, currentPollDelay + 2000);
          }
        } catch (error) {
          if (closed) return;
          const message = error instanceof Error ? error.message : "refresh failed";
          // Notify once per distinct failure, not once per tick: a persistent
          // failure used to raise a warning every 3 s.
          if (message !== lastError) {
            lastError = message;
            ctx.ui.notify(`pi-navigator: ${message}`, "warning");
          }
        } finally {
          inFlight = false;
        }
      };

      void refreshData().then(() => {
        scheduleRender();
        scheduleNextPoll();
      });

      return {
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => {
          overlay.handleInput(data);
          scheduleRender();
          currentPollDelay = REFRESH_INTERVAL_MS;
          scheduleNextPoll();
        },
        invalidate: () => overlay.invalidate(),
        // The framework calls dispose() when it closes the overlay itself, so
        // the polling timer is cleared even if close() was never reached.
        dispose: cleanup,
      };
    },
    { overlay: true, overlayOptions: OVERLAY_OPTIONS },
  );
}

/**
 * /navigator settings (Issue #061): open the SettingsList menu over the FILE
 * view of the settings (loaded without env; env-shadowed rows are annotated
 * and the env still wins at the next open). Commit = atomic write → reload →
 * notify warnings; any throw becomes a bounded `{ok:false}` — the menu issues
 * the warning and reverts the row display.
 */
async function runSettings(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify("pi-navigator settings requires the interactive TUI", "warning");
    return;
  }

  const userPath = join(getAgentDir(), NAVIGATOR_SETTINGS_FILE);
  const notifyWarning = makeWarningNotifier(ctx.ui);

  const fileLoaded = loadNavigatorSettings({ userPath });
  for (const warning of fileLoaded.warnings) notifyWarning(warning);

  // Raw env presence decides the annotation (empty/whitespace = no override).
  const overrides: Record<string, string> = {};
  const imagesEnv = process.env[NAVIGATOR_IMAGES_ENV];
  if (imagesEnv !== undefined && imagesEnv.trim() !== "") overrides["images.mode"] = NAVIGATOR_IMAGES_ENV;
  const iconsEnv = process.env[ICONS_ENV];
  if (iconsEnv !== undefined && iconsEnv.trim() !== "") overrides["icons.enabled"] = ICONS_ENV;

  try {
    await openSettingsMenu(ctx.ui, {
      settings: fileLoaded.settings,
      overrides,
      commit: (next) => {
        try {
          writeNavigatorSettings(userPath, next);
          const reloaded = loadNavigatorSettings({ userPath });
          for (const warning of reloaded.warnings) notifyWarning(warning);
          return { ok: true, settings: reloaded.settings };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message.length <= 160 ? message : `${message.slice(0, 160)}…` };
        }
      },
      onWarning: (message) => ctx.ui.notify(message, "warning"),
    });
  } catch (error) {
    ctx.ui.notify(`pi-navigator: settings failed (${String(error)}).`, "warning");
  }
}

export default function (pi: ExtensionAPI): void {
  // Durable help entry renderer (Issue #061): delivered via appendEntry +
  // registerEntryRenderer, never ctx.ui.notify. Restored/old entries with no
  // data fall back to an empty cwd.
  pi.registerEntryRenderer<NavigatorHelpData>(HELP_ENTRY_TYPE, (entry, _options, theme) => {
    const cwd = entry.data?.cwd ?? "";
    const T = makeNavigatorTheme(theme);
    const lines = buildHelpLines({ cwd });
    const width = helpCommandColumnWidth();
    const styled = lines.map((line) => {
      if (line === "") return line;
      if (line === HELP_COMMANDS_TITLE) return T.bold(line);
      if (line === HELP_HINT) return T.dim(line);
      if (line.startsWith(HELP_HEADER_PREFIX)) {
        return T.accent(HELP_HEADER_PREFIX) + T.dim(line.slice(HELP_HEADER_PREFIX.length));
      }
      // Command row: padded command column plain, description dim.
      return line.slice(0, width) + T.dim(line.slice(width));
    });
    return new Text(styled.join("\n"));
  });

  pi.registerCommand("navigator", {
    description: "Open the read-only project navigator; /navigator settings opens the settings menu, /navigator help shows commands",
    getArgumentCompletions: (prefix: string) => navigatorCompletions(prefix),
    handler: async (args, ctx) => {
      const parsed = parseNavigatorArgs(args);
      switch (parsed.kind) {
        case "overlay":
          await runNavigator(pi, ctx);
          return;
        case "settings":
          await runSettings(ctx);
          return;
        case "help":
          pi.appendEntry(HELP_ENTRY_TYPE, { cwd: ctx.cwd });
          return;
        case "unknown":
          ctx.ui.notify(`pi-navigator: unknown subcommand \"${parsed.raw}\"`, "warning");
          pi.appendEntry(HELP_ENTRY_TYPE, { cwd: ctx.cwd });
          return;
      }
    },
  });
}
