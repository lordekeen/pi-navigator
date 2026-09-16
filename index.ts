/**
 * pi-navigator — read-only project file navigator overlay for pi.
 *
 * Opens a centered overlay with a file tree, git state panel, and a
 * syntax-highlighted viewer. Launch via /navigator or ctrl+n.
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

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";

import { OVERLAY_OPTIONS, REFRESH_INTERVAL_MS } from "./constants";
import { detectRepo, gitCodeMap, gitTreeProbe, readGitState, readTrackedFiles, toCwdRelative } from "./git";
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
import type { FileNode, GitState } from "./types";
import { loadFile } from "./viewer";

type TuiLike = { terminal: { rows: number }; requestRender: () => void };

async function runNavigator(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
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
      let interval: ReturnType<typeof setInterval> | null = null;
      let closed = false;
      let inFlight = false;
      let lastError: string | null = null;

      /** Stop everything this overlay owns. Safe to call more than once. */
      const cleanup = (): void => {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
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

      const overlay = new NavigatorOverlay({
        cwd,
        theme,
        getTerminalRows: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
        onClose: close,
        loadFile: (relPath: string) => loadFile(join(cwd, relPath), relPath),
        refresh: () => {
          void refreshData().then(scheduleRender);
        },
      });

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
            } else if (root) {
              applyGitCodes(root, gitCodeMap(git));
            }
            treeSource = nextSource;
            treeProbe = probe;
          } else if (root) {
            applyGitCodes(root, gitCodeMap(git));
          }

          if (root && treeSource) overlay.setTree(root, treeSource);
          overlay.setGitState(git);
          lastError = null;

          const openRel = overlay.getOpenRelPath();
          if (openRel) {
            try {
              const info = await stat(join(cwd, openRel));
              const known = overlay.getOpenMtime();
              overlay.setDiskChanged(known !== undefined && Math.abs(info.mtimeMs - known) > 1);
            } catch {
              overlay.setDiskChanged(true);
            }
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

      void refreshData().then(scheduleRender);
      interval = setInterval(() => {
        void refreshData().then(scheduleRender);
      }, REFRESH_INTERVAL_MS);

      return {
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => {
          overlay.handleInput(data);
          scheduleRender();
        },
        invalidate: () => overlay.invalidate(),
        // The framework calls dispose() when it closes the overlay itself, so
        // the interval is cleared even if close() was never reached.
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
      await runNavigator(ctx);
    },
  });

  pi.registerShortcut("ctrl+n", {
    description: "Open pi-navigator",
    handler: async (ctx) => {
      await runNavigator(ctx);
    },
  });
}
