/**
 * /navigator help — durable transcript entry layout (pi-qdrant-memory parity).
 *
 * Pure module: no pi imports, no filesystem. `buildHelpLines` produces the
 * unthemed, aligned command list; index.ts styles it with makeNavigatorTheme
 * and delivers it as a durable entry via appendEntry + registerEntryRenderer.
 * The host truncates at the terminal edge — the extension never picks a
 * truncating width.
 */

import type { Focus, InputMode, NavigatorLayout } from "./types";

export const HELP_ENTRY_TYPE = "navigator-help";

export interface NavigatorHelpData {
  cwd: string;
}

/** Command prefix shared by every subcommand row (completions strip it). */
export const NAVIGATOR_CMD_PREFIX = "/navigator ";

/**
 * The /navigator subcommands — one table driving the /navigator help rows,
 * the argument completions, and the arg parser together so the three cannot
 * drift (Issue #063 finding 5). `cmd` is the full command string; `desc` is
 * shared verbatim by the help rows; the completion popup labels each item with
 * the subcommand token itself and renders `completionDescription` as its
 * secondary column (Issue #139 — the host labels its own command and theme
 * items with the value the same way). Rows carrying a `layout` open that
 * layout directly (Issue #119) — one-open selections that never write
 * settings; bare /navigator resolves the layout.default setting instead.
 */
export const NAVIGATOR_SUBCOMMANDS: readonly {
  cmd: string;
  desc: string;
  completionDescription: string;
  layout?: NavigatorLayout;
}[] = [
  { cmd: `${NAVIGATOR_CMD_PREFIX}all`, desc: "Open overlay with files and git panes (default)", completionDescription: "Open files + git + viewer overlay", layout: "files-git-viewer" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}files`, desc: "Open overlay with files pane only", completionDescription: "Open files + viewer overlay", layout: "files-viewer" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}git`, desc: "Open overlay with git panel only", completionDescription: "Open git + viewer overlay", layout: "git-viewer" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}settings`, desc: "Configure images, icons, viewer, tree, and layout behavior", completionDescription: "Open the settings menu" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}set`, desc: "set one config value, e.g. images.mode native", completionDescription: "Set a config value" },
  { cmd: `${NAVIGATOR_CMD_PREFIX}help`, desc: "Show this command list", completionDescription: "Show the command list" },
];

/** The durable /navigator help rows (overlay command first, then subcommands). */
export const NAVIGATOR_COMMANDS: readonly { cmd: string; desc: string }[] = [
  { cmd: "/navigator", desc: "Open the read-only project navigator overlay" },
  ...NAVIGATOR_SUBCOMMANDS.map(({ cmd, desc }) => ({ cmd, desc })),
];

/**
 * A footer hint (Issue #137 §1, moved here in Issue #148): the keys and the
 * action they perform. `buildFooterRow` styles a pair `dim(keys) +
 * muted(" " + label)` — pi-main's keyHint shape — and `plainHint` flattens
 * the same pair for the input-bar placeholders, so the footer and the
 * placeholders cannot drift apart.
 */
export interface HintPair {
  keys: string;
  label: string;
}

/**
 * One row of the one key declaration (Issue #148). The `?` modal's projection
 * (`NAVIGATOR_KEYBINDINGS`), the footer/input-bar hint tables below, and the
 * dispatch-liveness suite all read this table, so a key spelling can no
 * longer be advertised without a row that carries it.
 *
 * `keys` is the modal display spelling; `footer` is the curated short form a
 * context advertises. The row owns the key spelling — a context ref may
 * override only the short label. `help: false` rows are contextual entries
 * the modal never shows (filter/search/help-mode verbs and released
 * non-modal forms): they exist so every advertised pair resolves to a row
 * without the modal growing a duplicate.
 */
export interface KeyBinding {
  id: string;
  keys: string;
  description?: string;
  /** Included in the `?` modal's projection (NAVIGATOR_KEYBINDINGS). */
  help: boolean;
  /** Footer / input-bar short form; required for every context-referenced row. */
  footer?: { keys: string; label: string };
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { id: "cycle-focus", keys: "Tab / Shift+Tab", description: "cycle pane focus (visible panes)", help: true, footer: { keys: "Tab", label: "pane" } },
  { id: "toggle-tree", keys: "t", description: "hide or show the left column", help: true },
  { id: "move", keys: "j k / arrows", description: "move the cursor or scroll", help: true, footer: { keys: "j k", label: "move" } },
  { id: "jump", keys: "g G / Home End", description: "jump to top or bottom", help: true, footer: { keys: "g G Home/End", label: "jump" } },
  { id: "half-page", keys: "Ctrl+d Ctrl+u", description: "half page; PgUp/PgDn also page", help: true, footer: { keys: "Ctrl+d/u PgUp/PgDn", label: "page" } },
  { id: "open", keys: "Enter", description: "open file, commit diff, or toggle a directory/commit", help: true, footer: { keys: "Enter", label: "open" } },
  { id: "expand-collapse", keys: "l h / arrows", description: "expand or collapse a directory / commit family", help: true, footer: { keys: "l h", label: "family" } },
  { id: "filter-search", keys: "/", description: "filter the tree, search the file", help: true, footer: { keys: "/", label: "filter" } },
  { id: "match-nav", keys: "n N", description: "next/prev match (viewer)", help: true },
  { id: "match-cycle", keys: "up/down, ^n/^p", description: "cycle matches (searching)", help: true },
  { id: "wrap", keys: "w", description: "toggle word wrap", help: true, footer: { keys: "w", label: "wrap" } },
  { id: "markdown", keys: "m", description: "toggle markdown rendered / code view", help: true, footer: { keys: "m", label: "mode" } },
  { id: "image", keys: "i", description: "toggle image rendering / metadata card", help: true },
  { id: "scroll-h", keys: "h l", description: "horizontal scroll when wrap is off", help: true },
  { id: "hidden", keys: ".", description: "toggle hidden files", help: true, footer: { keys: ".", label: "hidden" } },
  { id: "copy", keys: "y", description: "copy the selected path", help: true },
  { id: "refresh", keys: "r", description: "refresh tree and git", help: true },
  { id: "help", keys: "?", description: "this help", help: true, footer: { keys: "?", label: "help" } },
  { id: "minimap", keys: "v", description: "toggle the viewer minimap", help: true, footer: { keys: "v", label: "map" } },
  { id: "close", keys: "q Esc", description: "close (Esc clears filter or search first)", help: true, footer: { keys: "q Esc", label: "close" } },
  // Contextual entries the modal never shows (Issue #148). Each carries the
  // footer form its mode advertises; `keys` is the same spelling the footer
  // uses because no modal row exists to hold it.
  { id: "type-to-filter", keys: "type", help: false, footer: { keys: "type", label: "to filter" } },
  { id: "cycle-filter", keys: "up/down", help: false, footer: { keys: "up/down", label: "move" } },
  { id: "first-last", keys: "Home/End", help: false, footer: { keys: "Home/End", label: "first/last" } },
  { id: "apply", keys: "Enter", help: false, footer: { keys: "Enter", label: "apply" } },
  { id: "clear", keys: "Esc", help: false, footer: { keys: "Esc", label: "clear" } },
  { id: "type-to-search", keys: "type", help: false, footer: { keys: "type", label: "to search" } },
  { id: "cycle-search", keys: "up/down", help: false, footer: { keys: "up/down", label: "match" } },
  { id: "help-scroll", keys: "j k", help: false, footer: { keys: "j k", label: "scroll" } },
  { id: "help-page", keys: "PgUp/PgDn", help: false, footer: { keys: "PgUp/PgDn", label: "page" } },
  { id: "help-top-bottom", keys: "Home/End", help: false, footer: { keys: "Home/End", label: "top/bottom" } },
  { id: "help-close", keys: "q Esc ?", help: false, footer: { keys: "q Esc ?", label: "close help" } },
];

/**
 * The in-overlay `?` modal's keybinding table (19 rows, rendered by
 * composeHelp in navigator.ts, which projects [keys, description] from here).
 * `id` is a stable slug a test can assert equality against; key order and
 * wording are the rendered contract. Derived from `KEY_BINDINGS` (Issue #148),
 * so the modal and the footer cannot diverge on a key spelling.
 */
export interface HelpKeyRow {
  id: string;
  keys: string;
  description: string;
}

/**
 * The modal projection's row predicate (Issue #191): a `help: true` row is
 * only projectable when it actually carries a `description`, because the type
 * predicate asserts one. Testing `help` alone would let a future row without
 * one render the literal `undefined` in the modal / HELP_ROWS.
 */
export function isHelpRow(row: KeyBinding): row is KeyBinding & { description: string } {
  return row.help === true && row.description !== undefined;
}

export const NAVIGATOR_KEYBINDINGS: readonly HelpKeyRow[] = KEY_BINDINGS.filter(isHelpRow).map(
  ({ id, keys, description }) => ({ id, keys, description }),
);

/**
 * One context's ordered reference to a binding row (Issue #148): the row owns
 * the key spelling, `label` overrides only the short form this context
 * advertises (`open` → "open/diff" in git; `move` → "scroll" in the viewer;
 * `filter-search` → "search").
 */
export interface HintRef {
  id: string;
  label?: string;
}

/**
 * Resolve a context's ordered refs to the footer's typed pairs (Issue #148).
 * A ref that names no row — or a row with no footer form — is a programming
 * error and throws, so a free key string can never enter a hint table.
 */
export function resolveBindings(refs: readonly HintRef[]): HintPair[] {
  return refs.map((ref) => {
    const footer = KEY_BINDINGS.find((row) => row.id === ref.id)?.footer;
    if (footer === undefined) {
      throw new Error(`hint ref "${ref.id}" has no KEY_BINDINGS row with a footer form`);
    }
    return { keys: footer.keys, label: ref.label ?? footer.label };
  });
}

/**
 * The normal-mode hint contexts: which bindings the footer (and the input-bar
 * placeholders, via MODE_BINDINGS) advertises per focus, in order. Width
 * budget: the longest hint plus the pane labels must fit the inner width at a
 * 100-column terminal (98) so the focus indicator never gets truncated off
 * the footer (render test enforces this at 120, 100, 80). Issue #127 added
 * the Home/End and PgUp/PgDn aliases; the footer is a curated subset (the
 * help modal lists every binding), so hints that no longer fit were dropped
 * whole rather than left to truncate mid-phrase. Issue #137 §1: items are
 * typed pairs; an item that carries no action word of its own (`g G
 * Home/End`, bare `Tab`) gets the minimal label naming its effect. Issue #137
 * §5: the close pair advertises the default cancel key baked into the tables
 * (`q Esc`), matching the modal; remaps of `tui.select.cancel` still close
 * because input goes through `matchesCancel`.
 */
export const FOCUS_BINDINGS: Record<Focus, readonly HintRef[]> = {
  files: [
    { id: "move" },
    { id: "open" },
    { id: "jump" },
    { id: "cycle-focus" },
    { id: "filter-search" },
    { id: "hidden" },
    { id: "help" },
    { id: "close" },
  ],
  git: [
    { id: "move" },
    { id: "open", label: "open/diff" },
    { id: "expand-collapse" },
    { id: "jump" },
    { id: "help" },
    { id: "close" },
  ],
  viewer: [
    { id: "move", label: "scroll" },
    { id: "half-page" },
    { id: "wrap" },
    { id: "markdown" },
    { id: "minimap" },
    { id: "filter-search", label: "search" },
    { id: "help" },
    { id: "close" },
  ],
};

/** The modal modes' hint contexts (Issue #148); same contract as
 *  FOCUS_BINDINGS. */
export const MODE_BINDINGS: Record<Exclude<InputMode, "normal">, readonly HintRef[]> = {
  filter: [
    { id: "type-to-filter" },
    { id: "cycle-filter" },
    { id: "first-last" },
    { id: "apply" },
    { id: "clear" },
  ],
  search: [
    { id: "type-to-search" },
    { id: "cycle-search" },
    { id: "apply" },
    { id: "clear" },
  ],
  help: [
    { id: "help-scroll" },
    { id: "help-page" },
    { id: "help-top-bottom" },
    { id: "help-close" },
  ],
};

/**
 * The resolved normal-mode hint pairs, byte-identical to the pre-#148 table:
 * derived from FOCUS_BINDINGS at module load so a pair cannot exist without a
 * binding row.
 */
export const FOCUS_HINTS: Record<Focus, HintPair[]> = {
  files: resolveBindings(FOCUS_BINDINGS.files),
  git: resolveBindings(FOCUS_BINDINGS.git),
  viewer: resolveBindings(FOCUS_BINDINGS.viewer),
};

/** The resolved modal-mode hint pairs (filter/search/help), derived from
 *  MODE_BINDINGS at module load (Issue #148). */
export const MODE_HINTS: Record<Exclude<InputMode, "normal">, HintPair[]> = {
  filter: resolveBindings(MODE_BINDINGS.filter),
  search: resolveBindings(MODE_BINDINGS.search),
  help: resolveBindings(MODE_BINDINGS.help),
};

/**
 * Flatten hint pairs to plain text — `keys + " " + label` joined by `" · "`
 * (Issue #137 §1). The input-bar placeholders use this so they cannot drift
 * from the footer tables, and width budgets measure the same text the footer
 * renders.
 */
export function plainHint(pairs: HintPair[]): string {
  return pairs.map((pair) => `${pair.keys} ${pair.label}`).join(" \u00b7 ");
}

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
