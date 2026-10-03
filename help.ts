/**
 * /navigator help — durable transcript entry layout (pi-qdrant-memory parity).
 *
 * Pure module: no pi imports, no filesystem. `buildHelpLines` produces the
 * unthemed, aligned command list; index.ts styles it with makeNavigatorTheme
 * and delivers it as a durable entry via appendEntry + registerEntryRenderer.
 * The host truncates at the terminal edge — the extension never picks a
 * truncating width.
 */

import type { NavigatorLayout } from "./types";

export const HELP_ENTRY_TYPE = "navigator-help";

export interface NavigatorHelpData {
  cwd: string;
}

/** Command prefix shared by every subcommand row (completions strip it). */
export const NAVIGATOR_CMD_PREFIX = "/navigator ";

/**
 * The /navigator subcommands — one table driving the /navigator help rows,
 * the argument completions, and the arg parser together so the three cannot
 * drift (Issue #063 finding 5). `cmd` is the full command string;
 * `completionLabel` is the completion popup label; `desc` is shared verbatim
 * by the help rows and the completions. Rows carrying a `layout` open that
 * layout directly (Issue #119) — one-open selections that never write
 * settings; bare /navigator resolves the layout.default setting instead.
 */
export const NAVIGATOR_SUBCOMMANDS: readonly {
  cmd: string;
  desc: string;
  completionLabel: string;
  layout?: NavigatorLayout;
}[] = [
  { cmd: `${NAVIGATOR_CMD_PREFIX}all`, desc: "Open overlay with files and git panes (default)", completionLabel: "Open files + git + viewer overlay", layout: "files-git-viewer" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}files`, desc: "Open overlay with files pane only", completionLabel: "Open files + viewer overlay", layout: "files-viewer" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}git`, desc: "Open overlay with git panel only", completionLabel: "Open git + viewer overlay", layout: "git-viewer" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}settings`, desc: "Configure images, icons, viewer, tree, and layout behavior", completionLabel: "Open the settings menu" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}set`, desc: "set one config value, e.g. images.mode native", completionLabel: "Set a config value" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}help`, desc: "Show this command list", completionLabel: "Show the command list" },
];

/** The durable /navigator help rows (overlay command first, then subcommands). */
export const NAVIGATOR_COMMANDS: readonly { cmd: string; desc: string }[] = [
  { cmd: "/navigator", desc: "Open the read-only project navigator overlay" },
  ...NAVIGATOR_SUBCOMMANDS.map(({ cmd, desc }) => ({ cmd, desc })),
];

/**
 * The in-overlay `?` modal's keybinding table (19 rows, rendered by
 * composeHelp in navigator.ts, which projects [keys, description] from here).
 * `id` is a stable slug a test can assert equality against; key order and
 * wording are the rendered contract.
 */
export interface HelpKeyRow {
  id: string;
  keys: string;
  description: string;
}

export const NAVIGATOR_KEYBINDINGS: readonly HelpKeyRow[] = [
  { id: "cycle-focus", keys: "Tab / Shift+Tab", description: "cycle pane focus (visible panes)" },
  { id: "toggle-tree", keys: "t", description: "hide or show the left column" },
  { id: "move", keys: "j k / arrows", description: "move the cursor or scroll" },
  { id: "jump", keys: "g G / Home End", description: "jump to top or bottom" },
  { id: "half-page", keys: "Ctrl+d Ctrl+u", description: "half page; PgUp/PgDn also page" },
  { id: "open", keys: "Enter", description: "open file, commit diff, or toggle a directory/commit" },
  { id: "expand-collapse", keys: "l h / arrows", description: "expand or collapse a directory / commit family" },
  { id: "filter-search", keys: "/", description: "filter the tree, search the file" },
  { id: "match-nav", keys: "n N", description: "next/prev match (viewer)" },
  { id: "match-cycle", keys: "up/down, ^n/^p", description: "cycle matches (searching)" },
  { id: "wrap", keys: "w", description: "toggle word wrap" },
  { id: "markdown", keys: "m", description: "toggle markdown rendered / code view" },
  { id: "image", keys: "i", description: "toggle image rendering / metadata card" },
  { id: "scroll-h", keys: "h l", description: "horizontal scroll when wrap is off" },
  { id: "hidden", keys: ".", description: "toggle hidden files" },
  { id: "copy", keys: "y", description: "copy the selected path" },
  { id: "refresh", keys: "r", description: "refresh tree and git" },
  { id: "help", keys: "?", description: "this help" },
  { id: "close", keys: "q Esc", description: "close (Esc clears filter or search first)" },
];

export const HELP_HEADER_PREFIX = "pi-navigator \u2014 ";
export const HELP_COMMANDS_TITLE = "commands";
export const HELP_HINT = "inside the overlay: press ? for keys, q to close";

/**
 * Command column width: longest command + 2 (qdrant-memory parity).
 *
 * `.length` is correct here and deliberately *not* `visibleWidth`: this module
 * is pi-import-free by design (see the header), and every `cmd` is a plain
 * ASCII literal built from `/navigator` plus a subcommand token — so code-unit
 * length and visible width are identical for every value this can ever see.
 * Audited as Issue #135 L9 and justified rather than changed.
 */
export function helpCommandColumnWidth(): number {
  return Math.max(...NAVIGATOR_COMMANDS.map((row) => row.cmd.length), 0) + 2;
}

/**
 * The unthemed help layout (spec §6): branded header, `commands` title,
 * command column padded to the longest command + 2, dim descriptions, a
 * blank row, then the dim overlay hint.
 */
export function buildHelpLines(data: NavigatorHelpData): string[] {
  const width = helpCommandColumnWidth();
  const lines: string[] = [`${HELP_HEADER_PREFIX}${data.cwd}`, HELP_COMMANDS_TITLE];
  for (const row of NAVIGATOR_COMMANDS) {
    lines.push(`${row.cmd.padEnd(width)}${row.desc}`);
  }
  lines.push("", HELP_HINT);
  return lines;
}
