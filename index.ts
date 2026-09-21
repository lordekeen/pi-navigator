/**
 * pi-navigator — read-only project file navigator overlay for pi.
 *
 * Opens a centered overlay with a file tree, git state panel, and a
 * syntax-highlighted viewer. Launch via /navigator.
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
  type Theme,
} from "@earendil-works/pi-coding-agent";

import {
  IMAGE_EXTENSIONS,
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
import { ICONS_ENV, parseEnableIcons } from "./icons";
import { makeDeferredImageSupport, resolveImageSupport, runChafaRender, type ImageSupport } from "./images";
import { loadNavigatorSettings } from "./settings";
import { styleDiffLines } from "./diff";
import { NavigatorOverlay } from "./navigator";
import { makeNavigatorTheme } from "./theme";
import {
  applyGitCodes,
  buildTree,
  collectExpanded,
  collectFsEntries,
  collectFsProbe,
  entriesFromPaths,
  reapplyExpansion,
  type TreeEntry,
} from "./tree";
import type { FileNode, GitState, ViewerFile } from "./types";
import { extOf, loadFile, type LoadFileOptions } from "./viewer";

type TuiLike = { terminal: { rows: number }; requestRender: () => void };

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
        env: { images: process.env[NAVIGATOR_IMAGES_ENV] },
      });
      const emittedWarnings = new Set<string>();
      const notifyWarning = (message: string): void => {
        if (emittedWarnings.has(message)) return;
        emittedWarnings.add(message);
        ctx.ui.notify("pi-navigator: " + message, "warning");
      };
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
      // change. Bounded by MAX_VIEWER_CACHE_ENTRIES (oldest insertion evicted).
      // Chafa renders add a variant key (D11) so a geometry or knob change is
      // a cache miss; non-image entries keep variant "" and behave as today.
      const viewerCache = new Map<string, { mtimeMs: number; variant: string; file: ViewerFile }>();

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

      const loadFileCached = async (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> => {
        const absPath = join(cwd, relPath);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(absPath)).mtimeMs;
        } catch {
          // Stat failed (deleted/permissions): let loadFile produce the error
          // card; drop any stale cache entry for this path.
          viewerCache.delete(relPath);
          return loadFile(absPath, relPath);
        }
        const image = opts?.image;
        const isImage = IMAGE_EXTENSIONS.has(extOf(relPath));
        const useChafa = isImage && image !== undefined && imageSupport.active;
        const variant = useChafa && image ? imageVariant(image, imageSupport) : "";
        const cached = viewerCache.get(relPath);
        if (cached && Math.abs(cached.mtimeMs - mtimeMs) <= 1 && cached.variant === variant) {
          return cached.file;
        }
        let file: ViewerFile;
        if (useChafa && image) {
          file = await loadFile(absPath, relPath, { image, renderImage });
        } else {
          file = await loadFile(absPath, relPath);
        }
        // Cache only results that carry an mtime (text/binary/image/truncated);
        // error cards have none and are cheap to rebuild.
        if (file.mtimeMs !== undefined) {
          if (viewerCache.size >= MAX_VIEWER_CACHE_ENTRIES) {
            const oldest = viewerCache.keys().next();
            if (!oldest.done) viewerCache.delete(oldest.value);
          }
          viewerCache.set(relPath, { mtimeMs: file.mtimeMs, variant, file });
        }
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
        // touches process.env (Issues #028, #039).
        enableIcons: parseEnableIcons(process.env[ICONS_ENV]),
        home: process.env.HOME ?? process.env.USERPROFILE ?? "",
        // Deferred snapshot; upgraded via setImageSupport when resolution lands.
        imageSupport,
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
          // signature. No full walk and no ls-files on an idle tick.
          const probe = git.available ? gitTreeProbe(git) : await collectFsProbe(cwd, collectExpanded(root));
          const treeChanged = root === null || probe !== treeProbe;

          if (treeChanged) {
            const expandedBefore = collectExpanded(root);
            let entries: TreeEntry[];
            let nextSource: "git" | "fs";
            if (git.available) {
              const tracked = toCwdRelative(await readTrackedFiles(cwd), repo.prefix);
              const untracked = git.unstaged.filter((file) => file.code === "??").map((file) => file.relPath);
              entries = entriesFromPaths(Array.from(new Set([...tracked, ...untracked])));
              nextSource = "git";
            } else {
              entries = await collectFsEntries(cwd);
              nextSource = "fs";
            }
            if (git.available && entries.length === 0) {
              // Fresh repository: git has nothing to list, so fall back to the
              // filesystem walk (plan section 9, empty repository row).
              entries = await collectFsEntries(cwd);
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

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("navigator", {
    description: "Open the read-only project navigator (file tree, git state, viewer)",
    handler: async (_args, ctx) => {
      await runNavigator(pi, ctx);
    },
  });
}
