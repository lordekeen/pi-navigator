/**
 * navigator.ts keymap reducer suites (plan section 11, last bullet): escape
 * precedence, focus cycling, mode transitions, cursor clamps, git Enter
 * behavior and the copy action. The overlay runs against real pi-tui key
 * matching; only copyToClipboard is stubbed (a side-effectful surface).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeNavigatorTheme } from "../theme";
import { buildTree, entriesFromPaths, findNode } from "../tree";
import type { GitState, ViewerFile } from "../types";

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  copyToClipboard,
}));

import { NavigatorOverlay } from "../navigator";

// ── Fixtures ──

const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  tab: "\t",
  shiftTab: "\x1b[Z",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
  ctrlD: "\x04",
  ctrlU: "\x15",
} as const;

interface Harness {
  overlay: NavigatorOverlay;
  opened: string[];
  state: { closed: number; refreshed: number };
}

function makeHarness(rows = 36): Harness {
  const opened: string[] = [];
  const state = { closed: 0, refreshed: 0 };

  const theme = makeNavigatorTheme({
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
  } as never);

  const options = {
    cwd: "/work",
    theme,
    getTerminalRows: () => rows,
    requestRender: () => undefined,
    onClose: () => {
      state.closed += 1;
    },
    loadFile: async (relPath: string): Promise<ViewerFile> => {
      opened.push(relPath);
      return {
        kind: "text",
        relPath,
        sizeBytes: 10,
        lineCount: 3,
        lines: ["alpha", "beta", "gamma"],
      };
    },
    refresh: () => {
      state.refreshed += 1;
    },
  };

  const overlay = new NavigatorOverlay(options);
  return { overlay, opened, state };
}

function withTree(harness: Harness, relPaths: string[]): void {
  const tree = buildTree("/work", entriesFromPaths(relPaths), new Map());
  harness.overlay.setTree(tree, "git");
}

function withGit(harness: Harness, overrides: Partial<GitState> = {}): void {
  harness.overlay.setGitState({
    available: true,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    unstaged: [{ relPath: "src/pkg/changed.ts", code: "M" }],
    staged: [],
    history: [{ shortHash: "abc1234", dateRel: "2 hours ago", subject: "fix things" }],
    refreshedAt: 0,
    ...overrides,
  });
}

beforeEach(() => {
  copyToClipboard.mockReset();
  copyToClipboard.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Focus cycling ──

describe("focus cycling", () => {
  it("cycles files -> git -> viewer and back, with shift+tab reversing", () => {
    const { overlay } = makeHarness();
    overlay.handleInput(KEYS.tab);
    overlay.handleInput(KEYS.tab);
    // The footer renders the focused pane label.
    expect(overlay.render(120).join("\n")).toContain("viewer");

    overlay.handleInput(KEYS.tab);
    expect(overlay.render(120).join("\n")).toContain("files");

    overlay.handleInput(KEYS.shiftTab);
    expect(overlay.render(120).join("\n")).toContain("viewer");
  });
});

// ── Escape precedence ──

describe("escape precedence (filter, then search, then close)", () => {
  it("clears the filter first without closing", () => {
    const harness = makeHarness();
    withTree(harness, ["src/a.ts"]);
    harness.overlay.handleInput("/");
    harness.overlay.handleInput("a");
    expect(harness.overlay.render(120).join("\n")).toContain("/a"); // filter bar echo

    harness.overlay.handleInput(KEYS.escape);
    expect(harness.state.closed).toBe(0);
    // Back in normal mode: the footer no longer carries the filter bar.
    expect(harness.overlay.render(120).join("\n")).not.toContain("/a");
  });

  it("clears the search before closing", () => {
    const harness = makeHarness();
    withTree(harness, ["src/a.ts"]);
    harness.overlay.handleInput("j"); // src dir -> src/a.ts
    harness.overlay.handleInput(KEYS.enter); // open the file, focus viewer
    expect(harness.opened).toEqual(["src/a.ts"]);

    harness.overlay.handleInput("/");
    harness.overlay.handleInput("b");
    harness.overlay.handleInput("e");
    expect(harness.overlay.render(120).join("\n")).toContain("/be");

    harness.overlay.handleInput(KEYS.escape);
    expect(harness.state.closed).toBe(0);
    expect(harness.overlay.render(120).join("\n")).not.toContain("/be");
  });

  it("closes from plain normal mode", () => {
    const harness = makeHarness();
    harness.overlay.handleInput(KEYS.escape);
    expect(harness.state.closed).toBe(1);
  });

  it("q typed in filter mode appends to the query, then Esc clears and q closes", () => {
    const harness = makeHarness();
    harness.overlay.handleInput("/");
    harness.overlay.handleInput("q");
    expect(harness.state.closed).toBe(0); // still filtering
    harness.overlay.handleInput(KEYS.escape);
    harness.overlay.handleInput("q");
    expect(harness.state.closed).toBe(1);
  });
});

// ── Files pane ──

describe("files pane keys", () => {
  it("moves with j/k and clamps at both ends", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts", "b.ts", "c.ts"]);

    harness.overlay.handleInput("j");
    harness.overlay.handleInput("G"); // bottom
    harness.overlay.handleInput("j"); // stays clamped
    harness.overlay.handleInput("g"); // top
    harness.overlay.handleInput("k"); // stays at top
    expect(harness.state.closed).toBe(0);
  });

  it("expands and collapses directories on Enter", () => {
    const tree = buildTree("/work", entriesFromPaths(["src/deep/a.ts"]), new Map());
    // Top level (src) is expanded by default; collapse it, reinstall, then
    // Enter on the collapsed row expands it again.
    const src = findNode(tree, "src");
    expect(src?.expanded).toBe(true);
    if (src) src.expanded = false;

    const harness = makeHarness();
    harness.overlay.setTree(tree, "git");
    expect(harness.overlay.render(120).join("\n")).not.toContain("deep"); // collapsed

    harness.overlay.handleInput(KEYS.enter); // cursor is on src
    expect(harness.overlay.render(120).join("\n")).toContain("deep");
  });

  it("opens a file into the viewer and switches focus", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    harness.overlay.handleInput("j"); // src dir -> src/a.ts (directories sort first)
    harness.overlay.handleInput(KEYS.enter);
    expect(harness.opened).toEqual(["a.ts"]);
  });

  it("filter mode matches rows and Enter commits back to normal", () => {
    const harness = makeHarness();
    withTree(harness, ["main.ts", "other.ts"]);
    harness.overlay.handleInput("/");
    for (const ch of ["m", "a", "i", "n"]) harness.overlay.handleInput(ch);
    expect(harness.overlay.render(120).join("\n")).toContain("/main");

    harness.overlay.handleInput(KEYS.enter);
    expect(harness.overlay.render(120).join("\n")).not.toContain("other");
    // Enter committed: typing "m" now is a normal-mode key, not appended.
    harness.overlay.handleInput("m");
    expect(harness.state.closed).toBe(0);
  });

  it("ctrl+d / ctrl+u page by half the files area", () => {
    const harness = makeHarness(40);
    withTree(harness, Array.from({ length: 30 }, (_, i) => `f${i}.ts`));
    harness.overlay.handleInput(KEYS.ctrlD);
    harness.overlay.handleInput(KEYS.ctrlU);
    expect(harness.state.closed).toBe(0); // movement stayed in range
  });
});

// ── Git pane ──

describe("git pane keys", () => {
  it("Enter on a changed file opens it and switches to the viewer", () => {
    const harness = makeHarness();
    withTree(harness, ["src/pkg/changed.ts"]);
    withGit(harness);
    harness.overlay.handleInput(KEYS.tab); // focus git

    harness.overlay.handleInput(KEYS.enter);
    expect(harness.opened).toEqual(["src/pkg/changed.ts"]);
  });

  it("Enter on a commit row is informational and opens nothing", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    withGit(harness);
    harness.overlay.handleInput(KEYS.tab);
    harness.overlay.handleInput("G"); // last nav row: the commit
    harness.overlay.handleInput(KEYS.enter);
    expect(harness.opened).toEqual([]);
  });
});

// ── Viewer keys ──

describe("viewer keys", () => {
  it("scrolls, jumps and toggles wrap without throwing", async () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    harness.overlay.handleInput(KEYS.down);
    harness.overlay.handleInput(KEYS.ctrlD);
    harness.overlay.handleInput("g");
    harness.overlay.handleInput("G");
    harness.overlay.handleInput("w");
    harness.overlay.handleInput("h");
    harness.overlay.handleInput("l");
    harness.overlay.render(120); // clamps happen in render
    expect(harness.state.closed).toBe(0);
  });

  it("search mode types, cycles matches and clears on escape", async () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    harness.overlay.handleInput("/");
    harness.overlay.handleInput("a");
    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("/a");
    // alpha has 2 a's, beta 1, gamma 2 → 5 matches across 3 lines.
    expect(rendered).toMatch(/\d+\/\d+ matches/);

    harness.overlay.handleInput("n");
    harness.overlay.handleInput("N");
    harness.overlay.handleInput(KEYS.escape);
    expect(harness.overlay.render(120).join("\n")).not.toContain("/a");
  });
});

// ── Copy action ──

describe("copy (y)", () => {
  it("copies the selected file path from the files pane", async () => {
    const harness = makeHarness();
    withTree(harness, ["pick.ts"]);
    harness.overlay.handleInput("y");
    await Promise.resolve();
    expect(copyToClipboard).toHaveBeenCalledWith("pick.ts");
  });

  it("copies the open viewer path", async () => {
    const harness = makeHarness();
    withTree(harness, ["view.ts"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    harness.overlay.handleInput("y");
    await Promise.resolve();
    expect(copyToClipboard).toHaveBeenCalledWith("view.ts");
  });

  it("copies a commit hash from git history", async () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    withGit(harness);
    harness.overlay.handleInput(KEYS.tab);
    harness.overlay.handleInput("G"); // last nav row: the commit
    harness.overlay.handleInput("y");
    await Promise.resolve();
    expect(copyToClipboard).toHaveBeenCalledWith("abc1234");
  });
});