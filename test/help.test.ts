/**
 * help.ts + index.ts command-routing suites (Issue #061): the pure
 * buildHelpLines layout (branded header, `commands` title, command column
 * padded to longest + 2, hint) and parseNavigatorArgs routing. The pi
 * surface is mocked the same way the other suites that pull navigator.ts do;
 * index.ts is imported for the pure parser and completions, navigator.ts for
 * the HELP_ROWS projection.
 */

import { describe, expect, it, vi } from "vitest";

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  copyToClipboard,
  getMarkdownTheme: () => ({
    heading: (t: string) => t,
    link: (t: string) => t,
    linkUrl: (t: string) => t,
    code: (t: string) => t,
    codeBlock: (t: string) => t,
    codeBlockBorder: (t: string) => t,
    quote: (t: string) => t,
    quoteBorder: (t: string) => t,
    hr: (t: string) => t,
    listBullet: (t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    strikethrough: (t: string) => t,
    highlightCode: (code: string) => code.split("\n"),
  }),
}));

import {
  buildHelpLines,
  HELP_COMMANDS_TITLE,
  HELP_HEADER_PREFIX,
  HELP_HINT,
  helpCommandColumnWidth,
  NAVIGATOR_COMMANDS,
  NAVIGATOR_CMD_PREFIX,
  NAVIGATOR_KEYBINDINGS,
  NAVIGATOR_SUBCOMMANDS,
} from "../help";
import { navigatorCompletions, parseNavigatorArgs } from "../index";
import { HELP_ROWS } from "../navigator";

describe("buildHelpLines", () => {
  it("produces the exact layout: header, commands title, aligned rows, blank, hint", () => {
    const cwd = "/work/repo";
    const lines = buildHelpLines({ cwd });
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe(`pi-navigator \u2014 ${cwd}`);
    expect(lines[0]).toBe(`${HELP_HEADER_PREFIX}${cwd}`);
    expect(lines[1]).toBe(HELP_COMMANDS_TITLE);
    expect(lines[2]).toBe("/navigator".padEnd(helpCommandColumnWidth()) + "Open the read-only project navigator overlay");
    expect(lines[3]).toBe("/navigator all".padEnd(helpCommandColumnWidth()) + "Open overlay with files and git panes (default)");
    expect(lines[4]).toBe("/navigator files".padEnd(helpCommandColumnWidth()) + "Open overlay with files pane only");
    expect(lines[5]).toBe("/navigator git".padEnd(helpCommandColumnWidth()) + "Open overlay with git panel only");
    expect(lines[6]).toBe("/navigator settings".padEnd(helpCommandColumnWidth()) + "Configure images, icons, viewer, tree, and layout behavior");
    expect(lines[7]).toBe("/navigator set".padEnd(helpCommandColumnWidth()) + "set one config value, e.g. images.mode native");
    expect(lines[8]).toBe("/navigator help".padEnd(helpCommandColumnWidth()) + "Show this command list");
    expect(lines[9]).toBe("");
    expect(lines[10]).toBe(HELP_HINT);
  });

  it("aligns the command column to the longest command plus 2", () => {
    const longest = Math.max(...NAVIGATOR_COMMANDS.map((row) => row.cmd.length));
    expect(helpCommandColumnWidth()).toBe(longest + 2);
    expect(longest).toBe("/navigator settings".length);
    expect(helpCommandColumnWidth()).toBe(21);
    const lines = buildHelpLines({ cwd: "/work/repo" });
    // Every row: the padded command column, then the description.
    for (let i = 0; i < NAVIGATOR_COMMANDS.length; i++) {
      const row = NAVIGATOR_COMMANDS[i];
      expect(lines[i + 2]).toBe(`${(row?.cmd ?? "").padEnd(helpCommandColumnWidth())}${row?.desc ?? ""}`);
    }
  });

  it("renders the header with an empty cwd for restored entries", () => {
    const lines = buildHelpLines({ cwd: "" });
    expect(lines[0]).toBe("pi-navigator \u2014 ");
    expect(lines[0]).toBe(HELP_HEADER_PREFIX);
  });

  it("lists every command row in the documented order", () => {
    expect(NAVIGATOR_COMMANDS.map((row) => row.cmd)).toEqual([
      "/navigator",
      "/navigator all",
      "/navigator files",
      "/navigator git",
      "/navigator settings",
      "/navigator set",
      "/navigator help",
    ]);
  });
});

describe("parseNavigatorArgs", () => {
  it("routes the bare invocation to the overlay", () => {
    expect(parseNavigatorArgs("")).toEqual({ kind: "overlay" });
    expect(parseNavigatorArgs("   ")).toEqual({ kind: "overlay" });
  });

  it("routes settings", () => {
    expect(parseNavigatorArgs("settings")).toEqual({ kind: "settings" });
    expect(parseNavigatorArgs("  settings  ")).toEqual({ kind: "settings" });
  });

  it("routes help", () => {
    expect(parseNavigatorArgs("help")).toEqual({ kind: "help" });
    expect(parseNavigatorArgs(" help ")).toEqual({ kind: "help" });
  });

  it("routes the three layout subcommands to the layout kind with their layout (Issue #119)", () => {
    expect(parseNavigatorArgs("all")).toEqual({ kind: "layout", layout: "files-git-viewer" });
    expect(parseNavigatorArgs("files")).toEqual({ kind: "layout", layout: "files-viewer" });
    expect(parseNavigatorArgs("git")).toEqual({ kind: "layout", layout: "git-viewer" });
    expect(parseNavigatorArgs(" files ")).toEqual({ kind: "layout", layout: "files-viewer" });
  });

  it("rejects trailing tokens instead of ignoring them (Issue #134)", () => {
    expect(parseNavigatorArgs("settings extra tokens")).toEqual({
      kind: "extra",
      sub: "settings",
      extra: ["extra", "tokens"],
    });
    expect(parseNavigatorArgs("help whatever")).toEqual({ kind: "extra", sub: "help", extra: ["whatever"] });
    expect(parseNavigatorArgs("all extra")).toEqual({ kind: "extra", sub: "all", extra: ["extra"] });
    // `set` takes two values, so a third token is the rejected one.
    expect(parseNavigatorArgs("set viewer.wrap on now")).toEqual({ kind: "extra", sub: "set", extra: ["now"] });
    // Without trailing tokens the subcommand keeps its own kind.
    expect(parseNavigatorArgs("settings")).toEqual({ kind: "settings" });
  });

  it("reports unknown subcommands with the offending token", () => {
    expect(parseNavigatorArgs("bogus")).toEqual({ kind: "unknown", raw: "bogus" });
    expect(parseNavigatorArgs("clear")).toEqual({ kind: "unknown", raw: "clear" });
    expect(parseNavigatorArgs("foo bar")).toEqual({ kind: "unknown", raw: "foo" });
  });

  it("matches case-sensitively (a Settings token is unknown)", () => {
    expect(parseNavigatorArgs("Settings")).toEqual({ kind: "unknown", raw: "Settings" });
    expect(parseNavigatorArgs("HELP")).toEqual({ kind: "unknown", raw: "HELP" });
    expect(parseNavigatorArgs("SETTINGS")).toEqual({ kind: "unknown", raw: "SETTINGS" });
  });
});

// Issue #063 finding 5: the subcommand table in help.ts is the single source
// for the help rows, the completions, and the parser. These assertions fail if
// any surface drifts back to a hand-maintained copy.

describe("navigatorCompletions", () => {
  it("projects NAVIGATOR_SUBCOMMANDS verbatim, in table order", () => {
    expect(navigatorCompletions("")).toEqual(
      NAVIGATOR_SUBCOMMANDS.map((sub) => ({
        value: sub.cmd.slice(NAVIGATOR_CMD_PREFIX.length),
        label: sub.completionLabel,
        description: sub.desc,
      })),
    );
    const rows = navigatorCompletions("");
    expect(rows).not.toBeNull();
    // Documented order: the three layout openers, then settings, set, then help.
    expect(rows?.map((row) => row.value)).toEqual(["all", "files", "git", "settings", "set", "help"]);
  });

  it("filters by prefix and returns an empty array for no match (Issue #134)", () => {
    // "se" prefixes both settings and set (Issue #131).
    expect(navigatorCompletions("se")).toEqual([
      { value: "settings", label: "Open the settings menu", description: "Configure images, icons, viewer, tree, and layout behavior" },
      { value: "set", label: "Set a config value", description: "set one config value, e.g. images.mode native" },
    ]);
    expect(navigatorCompletions("he")).toEqual([
      { value: "help", label: "Show the command list", description: "Show this command list" },
    ]);
    expect(navigatorCompletions("f")).toEqual([
      { value: "files", label: "Open files + viewer overlay", description: "Open overlay with files pane only" },
    ]);
    expect(navigatorCompletions("zz")).toEqual([]);
  });
});

describe("single-source derivations (Issue #063 finding 5)", () => {
  it("parses every subcommand token to its own kind (layout rows carry their layout, Issue #119)", () => {
    for (const sub of NAVIGATOR_SUBCOMMANDS) {
      const token = sub.cmd.slice(NAVIGATOR_CMD_PREFIX.length);
      if (sub.layout !== undefined) {
        expect(parseNavigatorArgs(token)).toEqual({ kind: "layout", layout: sub.layout });
      } else {
        expect(parseNavigatorArgs(token)).toEqual({ kind: token });
      }
    }
    expect(parseNavigatorArgs("bogus")).toEqual({ kind: "unknown", raw: "bogus" });
  });

  it("NAVIGATOR_COMMANDS is the bare overlay row followed by the subcommand table projection", () => {
    expect(NAVIGATOR_COMMANDS).toEqual([
      { cmd: "/navigator", desc: "Open the read-only project navigator overlay" },
      ...NAVIGATOR_SUBCOMMANDS.map(({ cmd, desc }) => ({ cmd, desc })),
    ]);
  });

  it("HELP_ROWS is the keybinding table projected to [keys, description], in the original order", () => {
    expect(HELP_ROWS).toEqual(NAVIGATOR_KEYBINDINGS.map((row) => [row.keys, row.description]));
    expect(HELP_ROWS).toHaveLength(19);
    expect(HELP_ROWS[0]).toEqual(["Tab / Shift+Tab", "cycle pane focus (visible panes)"]);
    expect(HELP_ROWS[HELP_ROWS.length - 1]).toEqual(["q Esc", "close (Esc clears filter or search first)"]);
  });

  it("keybinding ids are unique", () => {
    const ids = NAVIGATOR_KEYBINDINGS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});