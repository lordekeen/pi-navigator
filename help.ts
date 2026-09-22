/**
 * /navigator help — durable transcript entry layout (pi-qdrant-memory parity).
 *
 * Pure module: no pi imports, no filesystem. `buildHelpLines` produces the
 * unthemed, aligned command list; index.ts styles it with makeNavigatorTheme
 * and delivers it as a durable entry via appendEntry + registerEntryRenderer.
 * The host truncates at the terminal edge — the extension never picks a
 * truncating width.
 */

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
 * by the help rows and the completions.
 */
export const NAVIGATOR_SUBCOMMANDS: readonly { cmd: string; desc: string; completionLabel: string }[] = [
  { cmd: `${NAVIGATOR_CMD_PREFIX}settings`, desc: "configure images, icons, viewer, and tree behavior", completionLabel: "Open the settings menu" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}help`, desc: "show this command list", completionLabel: "Show the command list" },
];

/** The durable /navigator help rows (overlay command first, then subcommands). */
export const NAVIGATOR_COMMANDS: readonly { cmd: string; desc: string }[] = [
  { cmd: "/navigator", desc: "open the read-only project navigator overlay" },
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
  { id: "cycle-focus", keys: "Tab / Shift+Tab", description: "cycle pane focus (files, git, viewer)" },
  { id: "toggle-tree", keys: "t", description: "toggle the file tree" },
  { id: "move", keys: "j k / arrows", description: "move the cursor or scroll" },
  { id: "jump", keys: "g G", description: "jump to top or bottom" },
  { id: "half-page", keys: "Ctrl+d Ctrl+u", description: "half page" },
  { id: "open", keys: "Enter", description: "open file / commit diff, or toggle a directory / commit family" },
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

/** Command column width: longest command + 2 (qdrant-memory parity). */
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