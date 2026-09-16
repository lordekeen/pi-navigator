/**
 * Render geometry suites — the executable half of QA checklist item 1
 * ("overlay opens centered ... with correct borders and no width overflow")
 * and the compact-notice half of item 11. render() is pure given state, so
 * the full frame, cards, modal and input bars are exercised at the real
 * terminal sizes without a terminal.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { MIN_OVERLAY_HEIGHT, MIN_OVERLAY_WIDTH } from "../constants";
import { makeNavigatorTheme } from "../theme";
import { buildTree, entriesFromPaths } from "../tree";
import type { GitState, ViewerFile } from "../types";
import { NavigatorOverlay } from "../navigator";

const KEYS = {
  down: "\x1b[B",
  tab: "\t",
  enter: "\r",
} as const;

interface Harness {
  overlay: NavigatorOverlay;
  rows: number;
}

function makeHarness(rows: number): Harness {
  const theme = makeNavigatorTheme({
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
  } as never);

  const overlay = new NavigatorOverlay({
    cwd: "/work/repo",
    theme,
    getTerminalRows: () => rows,
    requestRender: () => undefined,
    onClose: () => undefined,
    loadFile: async (relPath: string): Promise<ViewerFile> => ({
      kind: "text",
      relPath,
      sizeBytes: 2048,
      lineCount: 200,
      lines: [
        "const value = 'a long line that would overflow a narrow pane without clamping';",
        "\x1b[31mconst colored = 'red string'; // keeps escapes inside the pane\x1b[0m",
        "short",
      ],
    }),
    refresh: () => undefined,
  });

  overlay.setTree(
    buildTree(
      "/work/repo",
      entriesFromPaths([
        "src/main.ts",
        "src/utils/helper.ts",
        "README.md",
        "package.json",
        "docs/design/overview.md",
        "config/settings.json",
      ]),
      new Map([["src/main.ts", "M"]]),
    ),
    "git",
  );

  const git: GitState = {
    available: true,
    branch: "feature/long-branch-name-context",
    detached: false,
    ahead: 3,
    behind: 1,
    unstaged: [{ relPath: "src/main.ts", code: "M" }],
    staged: [{ relPath: "package.json", code: "A" }],
    history: [
      { shortHash: "a1b2c3d", dateRel: "2 hours ago", subject: "add navigator overlay with a long subject line" },
      { shortHash: "e4f5a6b", dateRel: "yesterday", subject: "fix sorting" },
    ],
    refreshedAt: 0,
  };
  overlay.setGitState(git);

  return { overlay, rows };
}

/** Assert every rendered line fits the requested width, at the given size. */
function expectWidthSafe(overlay: NavigatorOverlay, width: number): string[] {
  const lines = overlay.render(width);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    expect(visibleWidth(line), `line ${i} overflows width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
  }
  return lines;
}

describe("render width safety", () => {
  it("fits the frame at 120x36", () => {
    const harness = makeHarness(36);
    expectWidthSafe(harness.overlay, 120);
  });

  it("fits the frame at 100x28", () => {
    const harness = makeHarness(28);
    expectWidthSafe(harness.overlay, 100);
  });

  it("fits the frame at 80x24", () => {
    const harness = makeHarness(24);
    expectWidthSafe(harness.overlay, 80);
  });

  it("hides the left column below 72 inner columns (width 60)", () => {
    const harness = makeHarness(24);
    const lines = expectWidthSafe(harness.overlay, 60);
    // The left column's files pane is gone: no FILES header, viewer still there.
    expect(lines.join("\n")).not.toContain("FILES");
  });

  it("stays width-safe with help open, filter active and search active", () => {
    const harness = makeHarness(36);
    const { overlay } = harness;

    overlay.handleInput("?");
    expectWidthSafe(overlay, 120);
    // Close help by pressing ? again (help toggles off on ?).
    overlay.handleInput("?");
    expectWidthSafe(overlay, 120);

    overlay.handleInput("/");
    overlay.handleInput("src");
    expectWidthSafe(overlay, 120);

    overlay.handleInput(KEYS.enter); // back to normal
    overlay.handleInput(KEYS.enter); // open the first file (cursor on src dir? opens dir)
    overlay.handleInput(KEYS.tab); // viewer focus
    overlay.handleInput("/");
    overlay.handleInput("const");
    expectWidthSafe(overlay, 120);
  });

  it("help modal truncates descriptions without leaking a bright ellipsis out of the muted style", () => {
    // At a narrow width the longest help description truncates. truncateToWidth's
    // default "..." is wrapped in \x1b[0m resets; if those land inside the T.muted
    // span the ellipsis renders in bright default and breaks the dim modal. The
    // footer hint (joinLeftRight) has the same root cause. Render help at a width
    // that forces truncation and assert no reset+three-dot artifact appears, and
    // that the dim ellipsis indicator (…) is still shown.
    const harness = makeHarness(18);
    const { overlay } = harness;
    overlay.handleInput("?");
    const lines = overlay.render(50);
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i], `line ${i} has bright-ellipsis artifact`).not.toMatch(/\x1b\[0m\.\.\./);
    }
    // The longest description ("cycle pane focus (files, git, viewer)") is 37
    // cols; at width 50 the description column is 28, so it must truncate and
    // show the ellipsis indicator.
    expect(lines.some((l) => l.includes("\u2026"))).toBe(true);
    expectWidthSafe(overlay, 50);
  });

  it("renders the compact notice below the minimum height", () => {
    const harness = makeHarness(MIN_OVERLAY_HEIGHT - 1);
    const lines = expectWidthSafe(harness.overlay, 120);
    expect(lines.join("\n")).toContain("terminal too small");
  });

  it("renders the compact notice below the minimum width", () => {
    const harness = makeHarness(24);
    const lines = expectWidthSafe(harness.overlay, MIN_OVERLAY_WIDTH - 1);
    expect(lines.join("\n")).toContain("terminal too small");
  });

  it("renders the error card width-safe", async () => {
    const harness = makeHarness(36);
    harness.overlay.setTree(buildTree("/work/repo", entriesFromPaths(["broken.ts"]), new Map()), "git");
    let overlay: NavigatorOverlay;
    const theme = makeNavigatorTheme({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      underline: (text: string) => text,
      inverse: (text: string) => text,
    } as never);
    overlay = new NavigatorOverlay({
      cwd: "/work/repo",
      theme,
      getTerminalRows: () => 36,
      requestRender: () => undefined,
      onClose: () => undefined,
      loadFile: async (relPath: string): Promise<ViewerFile> => ({
        kind: "error",
        relPath,
        lines: [],
        message: "cannot read file (deleted or permission denied)",
      }),
      refresh: () => undefined,
    });
    overlay.setTree(buildTree("/work/repo", entriesFromPaths(["broken.ts"]), new Map()), "git");
    await overlay.openRelPath("broken.ts");
    const lines = expectWidthSafe(overlay, 120);
    expect(lines.join("\n")).toContain("Cannot read");
  });

  it("keeps a highlighted viewer file inside the pane with wrap on and off", async () => {
    const harness = makeHarness(36);
    await harness.overlay.openRelPath("src/main.ts");
    expectWidthSafe(harness.overlay, 100);
    harness.overlay.handleInput("w"); // wrap on
    expectWidthSafe(harness.overlay, 100);
    harness.overlay.handleInput("w"); // wrap off
    expectWidthSafe(harness.overlay, 100);
  });
});