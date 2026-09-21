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

export const NAVIGATOR_COMMANDS: readonly { cmd: string; desc: string }[] = [
  { cmd: "/navigator", desc: "open the read-only project navigator overlay" },
  { cmd: "/navigator settings", desc: "configure images, icons, viewer, and tree behavior" },
  { cmd: "/navigator help", desc: "show this command list" },
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