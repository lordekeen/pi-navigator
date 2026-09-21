/**
 * help.ts + index.ts command-routing suites (Issue #061): the pure
 * buildHelpLines layout (branded header, `commands` title, command column
 * padded to longest + 2, hint) and parseNavigatorArgs routing. The pi
 * surface is mocked the same way the other suites that pull navigator.ts do;
 * index.ts is imported only for the pure parser.
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
} from "../help";
import { parseNavigatorArgs } from "../index";

describe("buildHelpLines", () => {
  it("produces the exact layout: header, commands title, aligned rows, blank, hint", () => {
    const cwd = "/work/repo";
    const lines = buildHelpLines({ cwd });
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe(`pi-navigator \u2014 ${cwd}`);
    expect(lines[0]).toBe(`${HELP_HEADER_PREFIX}${cwd}`);
    expect(lines[1]).toBe(HELP_COMMANDS_TITLE);
    expect(lines[2]).toBe("/navigator".padEnd(helpCommandColumnWidth()) + "open the read-only project navigator overlay");
    expect(lines[3]).toBe("/navigator settings".padEnd(helpCommandColumnWidth()) + "configure images, icons, viewer, and tree behavior");
    expect(lines[4]).toBe("/navigator help".padEnd(helpCommandColumnWidth()) + "show this command list");
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe(HELP_HINT);
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
      "/navigator settings",
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

  it("ignores trailing tokens after the first subcommand", () => {
    expect(parseNavigatorArgs("settings extra tokens")).toEqual({ kind: "settings" });
    expect(parseNavigatorArgs("help whatever")).toEqual({ kind: "help" });
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