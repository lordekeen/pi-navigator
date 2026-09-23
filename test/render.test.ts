/**
 * Render geometry suites — the executable half of QA checklist item 1
 * ("overlay opens centered ... with correct borders and no width overflow")
 * and the compact-notice half of item 11. render() is pure given state, so
 * the full frame, cards, modal and input bars are exercised at the real
 * terminal sizes without a terminal.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
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

import { mapExtensionToIcon } from "../icons";
import { MIN_OVERLAY_HEIGHT, MIN_OVERLAY_WIDTH } from "../constants";
import type { NavigatorSettings } from "../settings";
import { openSettingsMenu, type SettingsMenuDeps, type SettingsMenuTheme, type SettingsMenuUi } from "../settings_menu";
import { DEFAULT_PI_CHAFA_SUBSET, type ImageSupport } from "../images";
import { makeNavigatorTheme } from "../theme";
import { buildTree, entriesFromPaths } from "../tree";
import type { GitState, ViewerFile } from "../types";
import type { LoadFileOptions } from "../viewer";
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

function makeHarness(rows: number, enableIcons = false): Harness {
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
    enableIcons,
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

  it("stays width-safe with Nerd Font icons enabled (Issue #060 finding 6)", () => {
    const harness = makeHarness(36, true);
    const lines = expectWidthSafe(harness.overlay, 120);
    expect(lines.join("\n")).toContain(mapExtensionToIcon("README.md", false));
    expectWidthSafe(harness.overlay, 100);
    expectWidthSafe(harness.overlay, 80);
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

  it("hides empty git group rows and stays width-safe (Issue #029)", () => {
    const harness = makeHarness(24);
    const { overlay } = harness;
    overlay.setGitState({
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [],
      staged: [],
      history: [
        { shortHash: "a1b2c3d", dateRel: "2h ago", subject: "a commit subject that is long enough to need truncation in the left pane" },
      ],
      refreshedAt: 0,
    });

    const lines = expectWidthSafe(overlay, 80);
    const joined = lines.join("\n");
    expect(joined).not.toContain("Unstaged");
    expect(joined).not.toContain("Staged");
    expect(joined).toContain("Clean");
    expect(joined).toContain("History");

    // Populated lists restore the group rows and stay width-safe.
    overlay.setGitState({
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [{ relPath: "src/a.ts", code: "M" }],
      staged: [{ relPath: "src/b.ts", code: "A" }],
      history: [],
      refreshedAt: 0,
    });
    const populated = expectWidthSafe(overlay, 80);
    const joinedP = populated.join("\n");
    expect(joinedP).toContain("Unstaged (1)");
    expect(joinedP).toContain("Staged (1)");
    expect(joinedP).not.toContain("Clean");
  });

  it("shows the git status error group row width-safe with a visible ellipsis (Issue #113)", () => {
    // The 57-cell error label used to overflow the left pane until padTo
    // clipped it mid-word with no ellipsis, hiding "(press r to retry)". The
    // group row must now carry a visible ellipsis at every suite size.
    const sizes: Array<[width: number, rows: number]> = [
      [120, 36],
      [100, 28],
      [80, 24],
      [74, 24], // narrowest left-column width the suite renders
    ];
    for (const [width, rows] of sizes) {
      const harness = makeHarness(rows);
      harness.overlay.setGitState({
        available: true,
        branch: "main",
        detached: false,
        ahead: 0,
        behind: 0,
        unstaged: [],
        staged: [],
        history: [],
        error: "git status failed \u2014 changes not listed (press r to retry)",
        refreshedAt: 0,
      });
      const lines = expectWidthSafe(harness.overlay, width);
      // The git header shows the dim error text too, but only the group row
      // carries the fix's ellipsis; pre-fix both are clipped with none.
      expect(lines.find((l) => l.includes("git status failed") && l.includes("\u2026")), `width ${width}`).toBeTruthy();
    }
  });

  it("stays width-safe with an expanded commit family (Issue #030)", () => {
    const harness = makeHarness(30);
    const { overlay } = harness;
    overlay.setGitState({
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [],
      staged: [],
      history: [
        { shortHash: "bbb2222", parents: ["aaa1111", "ccc3333"], dateRel: "2h ago", subject: "merge the feature into main with a long subject" },
        { shortHash: "aaa1111", parents: ["9998888"], dateRel: "3h ago", subject: "ancestor one with yet another long subject line" },
        { shortHash: "ccc3333", parents: [], dateRel: "4h ago", subject: "feature root" },
        { shortHash: "9998888", parents: [], dateRel: "5h ago", subject: "base" },
      ],
      refreshedAt: 0,
    });
    overlay.handleInput("\t"); // focus git
    overlay.handleInput(KEYS.enter); // open the first (merge) commit's diff in the viewer
    // Family expansion is on l (v3). Tab back to git (cursor stays on the
    // first nav row: bbb2222), expand its family, then expand the in-history
    // parent aaa1111 to get a depth-2 row.
    overlay.handleInput(KEYS.tab);
    overlay.handleInput("l"); // expand bbb2222 -> aaa1111, ccc3333 at depth 1
    overlay.handleInput("j"); // bbb -> aaa1111 (commit-child)
    overlay.handleInput("l"); // expand aaa1111 -> 9998888 at depth 2
    expectWidthSafe(overlay, 80);
  });

  it("stays width-safe with the Nerd Font icon column on (Issue #028)", () => {
    const harness = makeHarness(24, true);
    const { overlay } = harness;
    const lines = expectWidthSafe(overlay, 80);
    // With icons on, the icon column + the one-time tofu notice both appear;
    // the whole frame must remain width-safe at all sizes.
    expect(lines.join("\n")).toContain("nerd icons on");

    expectWidthSafe(overlay, 120);
    expectWidthSafe(overlay, 100);
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

  it("truncates file-tree, git-panel and card rows without a bright ellipsis", async () => {
    // truncateToWidth injects \x1b[0m resets around its default "..." ellipsis
    // (independent of theme). When a styled or soon-to-be-styled string is
    // truncated, the reset closes the open style and "..." leaks in bright
    // default. This exercises the file-tree row, git file row, git commit
    // subject, and binary/image/error card body paths at a width that forces
    // truncation, asserting no reset+three-dot artifact appears anywhere.
    const harness = makeHarness(30);
    const { overlay } = harness;
    overlay.setTree(
      buildTree(
        "/work/repo",
        entriesFromPaths([
          "src/components/ReallyLongComponentNameHere.tsx",
          "src/utils/anotherVeryLongHelperModuleName.ts",
          "docs/nested/deeply/very-long-documentation-file.md",
        ]),
        new Map([["src/components/ReallyLongComponentNameHere.tsx", "M"]]),
      ),
      "git",
    );
    overlay.setGitState({
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [
        { relPath: "src/components/ReallyLongComponentNameHere.tsx", code: "M" },
        { relPath: "src/utils/anotherVeryLongHelperModuleName.ts", code: "M" },
      ],
      staged: [{ relPath: "src/components/ReallyLongComponentNameHere.tsx", code: "A" }],
      history: [
        { shortHash: "a1b2c3d", dateRel: "2h ago", subject: "this is a very long commit subject line that will definitely need truncation in a narrow left pane" },
        { shortHash: "e4f5a6b", dateRel: "yesterday", subject: "fix: another overlong subject line describing a refactor of the module system internals" },
      ],
      refreshedAt: 0,
    });

    // 74 cols: left column just appears (~24 wide) so file/git rows truncate.
    const treeLines = overlay.render(74);
    for (let i = 0; i < treeLines.length; i++) {
      expect(treeLines[i], `tree line ${i} has bright-ellipsis artifact`).not.toMatch(/\x1b\[0m\.\.\./);
    }

    // Jump to the bottom of the git panel to surface the history rows.
    overlay.handleInput("\t"); // files -> git
    overlay.handleInput("G");
    const gitLines = overlay.render(74);
    for (let i = 0; i < gitLines.length; i++) {
      expect(gitLines[i], `git line ${i} has bright-ellipsis artifact`).not.toMatch(/\x1b\[0m\.\.\./);
    }

    // Binary card with a long message that forces the card body to truncate.
    const cardTheme = makeNavigatorTheme({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      underline: (text: string) => text,
      inverse: (text: string) => text,
    } as never);
    const cardOverlay = new NavigatorOverlay({
      cwd: "/work/repo",
      theme: cardTheme,
      getTerminalRows: () => 24,
      requestRender: () => undefined,
      onClose: () => undefined,
      loadFile: async (relPath: string): Promise<ViewerFile> => ({
        kind: "binary",
        relPath,
        sizeBytes: 999999,
        mtimeMs: 0,
        lines: [],
        message: "999.9 KB \u00b7 binary content not rendered and a long extra clause to force truncation here",
      }),
      refresh: () => undefined,
    });
    cardOverlay.setTree(buildTree("/work/repo", entriesFromPaths(["src/very/long/path/to/the/binary/file.bin"]), new Map()), "git");
    cardOverlay.setGitState({
      available: true, branch: "main", detached: false, ahead: 0, behind: 0,
      unstaged: [], staged: [], history: [], refreshedAt: 0,
    });
    await cardOverlay.openRelPath("src/very/long/path/to/the/binary/file.bin");
    const cardLines = cardOverlay.render(60);
    for (let i = 0; i < cardLines.length; i++) {
      expect(cardLines[i], `card line ${i} has bright-ellipsis artifact`).not.toMatch(/\x1b\[0m\.\.\./);
    }
    expectWidthSafe(cardOverlay, 60);
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
    expectWidthSafe(overlay, 100);
    expectWidthSafe(overlay, 80);
    expectWidthSafe(overlay, 60);
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

  it("renders a commit diff viewer file width-safe at all suite sizes (v3)", async () => {
    const theme = makeNavigatorTheme({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      underline: (text: string) => text,
      inverse: (text: string) => text,
    } as never);
    // Diff ViewerFile with styled +/-, a hunk header, and a very long added
    // line that must truncate without leaking a bright ellipsis.
    const styledDiff: ViewerFile = {
      kind: "diff",
      relPath: "commit:a1b2c3d",
      commitHash: "a1b2c3d",
      parents: ["e4f5a6b"],
      lineCount: 8,
      lines: [
        "diff --git a/src/main.ts b/src/main.ts",
        "index 0000000..1111111 100644",
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        "@@ -1,1 +1,2 @@",
        "-const value = 'old'",
        "+const value = 'a very very very long new line that needs to truncate cleanly" +
          " and stay inside the pane without a bright ellipsis artifact'",
        " context line",
      ],
      notice: "commit a1b2c3d \u00b7 1 file \u00b7 +4 \u22122",
    };
    const overlay = new NavigatorOverlay({
      cwd: "/work/repo",
      theme,
      getTerminalRows: () => 36,
      requestRender: () => undefined,
      onClose: () => undefined,
      loadFile: async (relPath: string): Promise<ViewerFile> => ({ kind: "text", relPath, lines: [] }),
      loadCommit: async (_shortHash: string): Promise<ViewerFile> => styledDiff,
      refresh: () => undefined,
    });
    overlay.setTree(buildTree("/work/repo", entriesFromPaths(["src/main.ts"]), new Map()), "git");
    overlay.setGitState({
      available: true, branch: "main", detached: false, ahead: 0, behind: 0,
      unstaged: [], staged: [], history: [], refreshedAt: 0,
    });

    // Open the diff via the same injection the loader uses.
    await overlay.openCommit("a1b2c3d");
    const lines = expectWidthSafe(overlay, 120);
    const joined = lines.join("\n");
    expect(joined).toContain("commit a1b2c3d");
    expect(joined).toContain("\u00b7 1 file");
    // The notice row renders (T.dim summary, no bright-ellipsis artifact).
    expect(joined).toContain("+4 \u22122");

    expectWidthSafe(overlay, 100);
    expectWidthSafe(overlay, 80);

    // No reset+three-dot leak on the long styled + line.
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i], `diff line ${i} leaks bright ellipsis`).not.toMatch(/\x1b\[0m\.\.\./);
    }
  });

  it("glues the Nerd Font icon to the label at every depth (Issue #031)", () => {
    // Regression: the icon used to sit at a fixed column right after the
    // cursor arrow, so nested entries showed their glyph on the left edge
    // while the indented name/marker floated to the right — visually
    // disconnected. The icon must now sit immediately before the marker/name,
    // moving with the indent so it always belongs to its row.
    const harness = makeHarness(36, true);
    const { overlay } = harness;
    overlay.setTree(
      buildTree(
        "/work/repo",
        entriesFromPaths(["src/components/Button.tsx", "README.md"]),
        new Map(),
      ),
      "git",
    );
    // `src` is depth-0 so it is expanded by default; `components` is depth-1
    // and collapsed (marker ▸). That depth-1 collapsed row is enough to catch
    // the fixed-column regression — no key input needed.
    const lines = expectWidthSafe(overlay, 120);
    const dirGlyph = mapExtensionToIcon("", true);
    const fileGlyph = mapExtensionToIcon("src/components/Button.tsx", false);

    // Strip ANSI escapes to reason about plain column positions.
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

    const srcRow = lines.find((l) => /src/.test(l) && l.includes(dirGlyph));
    const componentsRow = lines.find((l) => /components/.test(l) && l.includes(dirGlyph));
    expect(srcRow, "src dir row not found").toBeDefined();
    expect(componentsRow, "components dir row not found").toBeDefined();

    const plainSrc = strip(srcRow!);
    const plainComponents = strip(componentsRow!);
    // `src` (depth 0): glyph sits after the cursor gap and before the marker.
    const glyphInSrc = plainSrc.indexOf(dirGlyph);
    const markerInSrc = plainSrc.indexOf("\u25be");
    expect(glyphInSrc, "src glyph must precede the marker").toBeLessThan(markerInSrc);
    expect(glyphInSrc, "src glyph must sit after the cursor gap").toBeGreaterThan(1);

    // `components` (depth 1): the glyph must sit AFTER the 2-space indent, not
    // at the fixed left column it used to occupy. border(1) + cursor/gap(2) +
    // indent(2) = column 5 is the earliest the glyph may appear.
    const glyphInComponents = plainComponents.indexOf(dirGlyph);
    expect(
      glyphInComponents,
      "components (depth 1) glyph must sit after the 2-space indent, not at the fixed left column",
    ).toBeGreaterThanOrEqual(5);
    // The collapsed marker (▸) must follow the glyph, proving the icon is
    // glued to the label rather than floating at the left edge.
    const markerInComponents = plainComponents.indexOf("\u25b8");
    expect(markerInComponents, "components collapsed marker not found").toBeGreaterThan(-1);
    expect(glyphInComponents, "components glyph must precede the marker").toBeLessThan(markerInComponents);

    // Sanity: once `components` is expanded, the nested file glyph also renders
    // glued to its name at depth 2 (after the 4-space indent).
    overlay.handleInput(KEYS.down); // src -> components
    overlay.handleInput(KEYS.enter); // expand components
    const expanded = expectWidthSafe(overlay, 120);
    const fileRow = expanded.find((l) => /Button\.tsx/.test(l) && l.includes(fileGlyph));
    expect(fileRow, "Button.tsx file row not found").toBeDefined();
    const plainFile = strip(fileRow!);
    const glyphInFile = plainFile.indexOf(fileGlyph);
    const nameInFile = plainFile.indexOf("Button.tsx");
    expect(glyphInFile, "file glyph must precede the name").toBeLessThan(nameInFile);
    expect(glyphInFile, "file glyph (depth 2) must sit after the 4-space indent").toBeGreaterThanOrEqual(7);
  });
});

describe("rendered markdown width safety", () => {
  const richMarkdown = [
    "# This is a very long heading that should wrap or be truncated safely without overflowing the pane width",
    "",
    "A regular paragraph with **bold text**, *italic text*, and [a long markdown link with descriptive text](https://example.com/very/long/url/path/here).",
    "",
    "## Lists and Nesting",
    "- Top level item 1 with lots of words to trigger automatic word wrapping inside the reader layout",
    "- Top level item 2",
    "  - Nested sub-item A with additional details",
    "  - Nested sub-item B",
    "",
    "## Code Block",
    "```typescript",
    "const greeting: string = 'Hello, this is a very long code line inside a fenced block that should be padded and fit cleanly';",
    "function add(a: number, b: number): number { return a + b; }",
    "```",
    "",
    "## Table",
    "| Column 1 | Column 2 | Column 3 |",
    "| --- | --- | --- |",
    "| Cell 1A with long content | Cell 1B | Cell 1C |",
    "| Cell 2A | Cell 2B with long text | Cell 2C |",
    "",
  ].join("\n");

  function makeMarkdownHarness(rows: number): NavigatorOverlay {
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
        sizeBytes: Buffer.byteLength(richMarkdown),
        lineCount: richMarkdown.split("\n").length,
        lines: richMarkdown.split("\n"),
        rawText: richMarkdown,
      }),
      refresh: () => undefined,
    });

    overlay.setTree(
      buildTree("/work/repo", entriesFromPaths(["README.md"]), new Map()),
      "fs",
    );

    return overlay;
  }

  it("renders rich markdown width-safely at 120x36", async () => {
    const overlay = makeMarkdownHarness(36);
    await overlay.openRelPath("README.md");
    // Switch focus to viewer and toggle rendered mode
    overlay.handleInput(KEYS.tab);
    overlay.handleInput(KEYS.tab);
    overlay.handleInput("m");

    const lines = expectWidthSafe(overlay, 120);
    expect(lines.join("\n")).toContain("m code");
    expect(lines.join("\n")).not.toMatch(/\x1b\[0m\.\.\./);
  });

  it("renders rich markdown width-safely at 100x28 and keeps footer focus indicators intact", async () => {
    const overlay = makeMarkdownHarness(28);
    await overlay.openRelPath("README.md");
    overlay.handleInput(KEYS.tab);
    overlay.handleInput(KEYS.tab);
    overlay.handleInput("m");

    const lines = expectWidthSafe(overlay, 100);
    const footer = lines[lines.length - 2] ?? "";
    expect(footer).toContain("viewer");
    expect(footer).toContain("files");
    expect(footer).toContain("git");
    expect(lines.join("\n")).not.toMatch(/\x1b\[0m\.\.\./);
  });

  it("renders rich markdown width-safely at 80x24", async () => {
    const overlay = makeMarkdownHarness(24);
    await overlay.openRelPath("README.md");
    overlay.handleInput(KEYS.tab);
    overlay.handleInput(KEYS.tab);
    overlay.handleInput("m");

    const lines = expectWidthSafe(overlay, 80);
    expect(lines.join("\n")).not.toMatch(/\x1b\[0m\.\.\./);
  });

  it("renders rich markdown width-safely at 60 columns (narrow screen)", async () => {
    const overlay = makeMarkdownHarness(24);
    await overlay.openRelPath("README.md");
    overlay.handleInput(KEYS.tab);
    overlay.handleInput(KEYS.tab);
    overlay.handleInput("m");

    const lines = expectWidthSafe(overlay, 60);
    expect(lines.join("\n")).not.toMatch(/\x1b\[0m\.\.\./);
  });

  it("renders search highlights inside pane bounds in rendered mode", async () => {
    const overlay = makeMarkdownHarness(28);
    await overlay.openRelPath("README.md");
    overlay.handleInput(KEYS.tab);
    overlay.handleInput(KEYS.tab);
    overlay.handleInput("m");

    // Search for a term that occurs in headings and code
    overlay.handleInput("/");
    for (const char of "long") {
      overlay.handleInput(char);
    }
    const lines = expectWidthSafe(overlay, 100);
    expect(lines.join("\n")).toContain("/long");
    expect(lines.join("\n")).not.toMatch(/\x1b\[0m\.\.\./);
  });
});
describe("settings menu render width safety (Issue #061)", () => {
  function makeSettingsHarness() {
    let component: { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void } | undefined;
    let resolveReady!: () => void;
    let resolveClosed!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const theme: SettingsMenuTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const ui: SettingsMenuUi = {
      custom: <T>(
        factory: (tui: unknown, th: SettingsMenuTheme, keybindings: unknown, done: (result: T) => void) => unknown,
      ): Promise<T> => {
        const result = factory({}, theme, {}, () => resolveClosed());
        component = result as { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void };
        resolveReady();
        return closed as unknown as Promise<T>;
      },
    };
    const deps: SettingsMenuDeps = {
      settings: {
        version: 1,
        images: { mode: "off" },
        icons: { enabled: false },
        viewer: { wrap: false, markdown: "code" },
        tree: { showHidden: false },
      } as NavigatorSettings,
      overrides: { "images.mode": "PI_NAV_IMAGES", "icons.enabled": "PI_NAV_ICONS" },
      commit: (next: NavigatorSettings): { ok: true; settings: NavigatorSettings } => ({ ok: true, settings: next }),
      onWarning: () => undefined,
    };
    const menu = openSettingsMenu(ui, deps);
    return {
      ready,
      getComponent: (): { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void } | undefined => component,
      closed: closed.then(() => menu),
    };
  }

  it("renders the settings menu width-safely at every suite size and a narrow width", async () => {
    const sizes = [
      [120, 36],
      [100, 28],
      [80, 24],
      [44, 20],
    ] as const;
    for (const [width, rows] of sizes) {
      void rows;
      const harness = makeSettingsHarness();
      await harness.ready;
      const component = harness.getComponent();
      expect(component, "settings menu did not render").toBeDefined();
      const lines = component!.render(width);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        expect(visibleWidth(line), `settings line ${i} overflows width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
      }
      const joined = lines.join("\n");
      expect(joined).toContain("pi-navigator \u00b7 settings");
      expect(joined).toContain("changes apply the next time /navigator opens");
      // The override annotation may wrap across lines — assert stable fragments.
      expect(joined).toContain("overridden by");
      expect(joined).toContain("PI_NAV_IMAGES (env wins)");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        expect(line, `line ${i} contains a carriage return`).not.toContain("\r");
        // The SettingsList truncates its OWN hint line with pi-tui's internal
        // default ellipsis (issue #010 applies to navigator's own truncations),
        // so only width-safety and the SGR-only whitelist are enforced here.
        expect(line, `line ${i} has a non-SGR escape: ${JSON.stringify(line)}`).not.toMatch(/\x1b(?!\[[0-9;]*m)/);
      }
      harness.getComponent()?.handleInput?.("\x1b"); // close: nothing is written
      await harness.closed;
    }
  });
});

describe("chafa image render width safety (§12.5)", () => {
  const activeChafaSupport = (): ImageSupport => ({
    mode: "chafa",
    nativeProtocol: null,
    tier: "chafa",
    piChafa: { present: true, via: "settings" },
    chafa: { state: "ok", binary: "chafa", version: { major: 1, minor: 18 } },
    config: { ...DEFAULT_PI_CHAFA_SUBSET },
    hostShowImages: true,
    hostImageWidthCells: 60,
  });

  // Synthetic SANITIZED chafa payload (post-sanitizer imageLines): an
  // exact-fit line, an over-wide line, a line without a trailing reset,
  // nested SGR colors, and a wide CJK glyph. Every escape is SGR-only by
  // construction (§8).
  const CHAFA_PAYLOAD: string[] = [
    "\x1b[31m" + "\u2588".repeat(60) + "\x1b[0m", // exact fit at the preferred cell width
    "\x1b[32m" + "\u2588".repeat(200) + "\x1b[0m", // over-wide: hard-cut at the pane width
    "\x1b[33mno trailing reset", // sanitizer guarantees resets; the branch stays safe regardless
    "\x1b[1;35mouter \x1b[2;36mnested \x1b[0m inner\x1b[0m", // nested SGR colors
    "\u754c".repeat(26), // wide CJK glyphs: 52 cells, truncation must be column-aware
  ];

  function makeChafaHarness(rows: number, support: ImageSupport, imageError?: string): NavigatorOverlay {
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
      loadFile: async (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> => {
        if (!opts?.image) {
          return { kind: "image", relPath, imageTier: "metadata", lines: [], sizeBytes: 1024, message: "1.0 KB \u00b7 40x40", mtimeMs: 0 };
        }
        return {
          kind: "image",
          relPath,
          imageTier: "chafa",
          imageLines: CHAFA_PAYLOAD,
          imageCols: opts.image.cols,
          imageRows: opts.image.rows,
          lines: [],
          sizeBytes: 1024,
          message: "1.0 KB \u00b7 40x40",
          ...(imageError !== undefined ? { imageError } : {}),
          mtimeMs: 0,
        };
      },
      refresh: () => undefined,
      imageSupport: support,
    });

    overlay.setTree(buildTree("/work/repo", entriesFromPaths(["sample.png"]), new Map()), "git");
    return overlay;
  }

  it("renders a sanitized chafa payload width-safely at every suite size", async () => {
    const sizes = [
      [120, 36],
      [100, 28],
      [80, 24],
      [60, 24],
      [50, 24],
    ] as const;
    for (const [width, rows] of sizes) {
      const overlay = makeChafaHarness(rows, activeChafaSupport());
      overlay.render(width); // first frame records the pane snapshot
      await overlay.openRelPath("sample.png");
      const lines = overlay.render(width);
      // The chafa rows actually reached the frame.
      expect(lines.join("\n"), `chafa payload missing at ${width}`).toContain("\x1b[31m");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        expect(visibleWidth(line), `line ${i} overflows width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
        expect(line, `line ${i} contains a carriage return`).not.toContain("\r");
        // Every escape in the frame is a plain SGR (`\x1b[…m`): no cursor
        // ops, no OSC/DCS, no lone ESC (spec §8 whitelist).
        expect(line, `line ${i} has a non-SGR escape: ${JSON.stringify(line)}`).not.toMatch(/\x1b(?!\[[0-9;]*m)/);
        // No bright-ellipsis artifact: truncateToWidth's default "..." reset
        // pair must never leak into a chafa row (Issue #010).
        expect(line, `line ${i} leaks a bright ellipsis`).not.toMatch(/\x1b\[0m\.\.\./);
      }
    }
  });

  it("keeps a chafa fallback reason in the header width-safe at every suite size (Issue #116 fix 2)", async () => {
    // A native render can fail cleanly and fall through to chafa; the reason is
    // now kept on the rendered file and shown as a dim header suffix. It must
    // never push a row past the pane width — the failure this pins is exactly
    // the width-safety class this suite exists for.
    const reason =
      "image exceeds the 4 MiB native rendering cap, which is a deliberately long reason to force clamping";
    const sizes = [
      [120, 36],
      [100, 28],
      [80, 24],
      [60, 24],
      [50, 24],
    ] as const;
    for (const [width, rows] of sizes) {
      const overlay = makeChafaHarness(rows, activeChafaSupport(), reason);
      overlay.render(width); // first frame records the pane snapshot
      await overlay.openRelPath("sample.png");
      const joined = expectWidthSafe(overlay, width).join("\n");
      // The art still rendered: the reason is additive, never a card.
      expect(joined, `chafa payload missing at ${width}`).toContain("\x1b[31m");
      expect(joined, `card hints leaked at ${width}`).not.toContain("optional:");
      // The header only carries the reason where the pane has budget for it
      // (the suffix is deliberately budgeted, then clamped); at the widest size
      // it must be there in full prefix form.
      if (width === 120) expect(joined, "reason missing at 120").toContain("4 MiB");
    }
  });

  it("renders a card-only frame when image rendering is not active", async () => {
    // Inactive support (mode off) is the real card-only path: openRelPath
    // passes no image opts, so the loader serves the metadata card and no
    // chafa payload can reach the frame.
    const overlay = makeChafaHarness(24, { ...activeChafaSupport(), mode: "off", tier: "none" });
    await overlay.openRelPath("sample.png");
    const lines = expectWidthSafe(overlay, 60);
    const joined = lines.join("\n");
    expect(joined).toContain("Image"); // the metadata card title
    expect(joined).not.toContain("\u2588"); // no exact-fit / over-wide payload rows
    expect(joined).not.toContain("\u754c"); // no CJK payload row
    // Truncation injects SGR resets (allowed); no other escape may appear.
    expect(joined).not.toMatch(/\x1b(?!\[[0-9;]*m)/);
  });
});

describe("native image render width safety (§12.4)", () => {
  const NATIVE_SEQ = "\x1b_Ga=T,f=100,q=2,C=1,c=20,r=3,i=12345;AAAA\x1b\\";

  const nativeSupport = (): ImageSupport => ({
    mode: "native",
    nativeProtocol: "kitty",
    tier: "native",
    piChafa: { present: false, via: "none" },
    chafa: { state: "deferred" },
    config: { ...DEFAULT_PI_CHAFA_SUBSET },
    hostShowImages: true,
    hostImageWidthCells: 60,
  });

  function makeNativeHarness(rows: number): NavigatorOverlay {
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
      loadFile: async (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> => {
        if (!opts?.image) {
          return { kind: "image", relPath, imageTier: "metadata", lines: [], sizeBytes: 1024, message: "1.0 KB \u00b7 40x40", mtimeMs: 0 };
        }
        return {
          kind: "image",
          relPath,
          imageTier: "native",
          imageLines: [NATIVE_SEQ, "", ""],
          imageCols: opts.image.cols,
          imageRows: opts.image.rows,
          lines: [],
          sizeBytes: 1024,
          message: "1.0 KB \u00b7 40x40",
          mtimeMs: 0,
        };
      },
      refresh: () => undefined,
      imageSupport: nativeSupport(),
    });

    overlay.setTree(buildTree("/work/repo", entriesFromPaths(["sample.png"]), new Map()), "git");
    return overlay;
  }

  it("keeps the kitty sequence byte-identical and every row width-safe at every suite size", async () => {
    const sizes = [
      [120, 36],
      [100, 28],
      [80, 24],
      [60, 24],
      [50, 24],
    ] as const;
    for (const [width, rows] of sizes) {
      const overlay = makeNativeHarness(rows);
      overlay.render(width); // first frame records the pane snapshot
      await overlay.openRelPath("sample.png");
      const lines = expectWidthSafe(overlay, width);
      // The sequence reached the frame byte-identically: no truncation, no
      // reordering by any width helper in the pane/frame path.
      expect(lines.join("\n"), `sequence missing at ${width}`).toContain(NATIVE_SEQ);
      for (let i = 0; i < lines.length; i++) {
        expect(lines[i] ?? "", `line ${i} contains a carriage return`).not.toContain("\r");
      }
    }
  });

  it("serves a card-only frame when the pane geometry is refused (narrow terminal)", async () => {
    const overlay = makeNativeHarness(24);
    overlay.render(60); // records a valid pane snapshot
    await overlay.openRelPath("sample.png");
    expect(overlay.render(60).join("\n")).toContain(NATIVE_SEQ);
    // The compact-notice frame below MAX_OVERLAY_WIDTH must not leak the
    // sequence: the loader is never asked for an image at that size.
    const narrow = overlay.render(MIN_OVERLAY_WIDTH - 1);
    expect(narrow.join("\n")).not.toContain(NATIVE_SEQ);
  });
});
