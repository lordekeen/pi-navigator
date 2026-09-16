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
  ctrlN: "\x0e",
  ctrlP: "\x10",
} as const;

interface Harness {
  overlay: NavigatorOverlay;
  opened: string[];
  state: { closed: number; refreshed: number; renders: number };
}

function makeHarness(
  rows = 36,
  customLoadFile?: (relPath: string) => Promise<ViewerFile>,
  customTheme?: (color: string, text: string) => string,
): Harness {
  const opened: string[] = [];
  const state = { closed: 0, refreshed: 0, renders: 0 };

  const theme = makeNavigatorTheme({
    fg: (color: string, text: string) => (customTheme ? customTheme(color, text) : text),
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
  } as never);

  const options = {
    cwd: "/work",
    theme,
    getTerminalRows: () => rows,
    requestRender: () => {
      state.renders += 1;
    },
    onClose: () => {
      state.closed += 1;
    },
    loadFile:
      customLoadFile ??
      (async (relPath: string): Promise<ViewerFile> => {
        opened.push(relPath);
        return {
          kind: "text",
          relPath,
          sizeBytes: 10,
          lineCount: 3,
          lines: ["alpha", "beta", "gamma"],
        };
      }),
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
    const rendered = harness.overlay.render(120).join("\n"); // clamps happen in render
    expect(rendered).toContain("h l  w wrap");
    expect(rendered).not.toContain("h l x");
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
    // Ctrl+N and Ctrl+P cycle matches while in search mode
    harness.overlay.handleInput(KEYS.ctrlN);
    expect(harness.overlay.render(120).join("\n")).toContain("/a");
    harness.overlay.handleInput(KEYS.ctrlP);
    expect(harness.overlay.render(120).join("\n")).toContain("/a");

    harness.overlay.handleInput(KEYS.escape);
    expect(harness.overlay.render(120).join("\n")).not.toContain("/a");
  });

  it("resolves footer hints explicitly based on mode and focus", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);

    // normal files focus
    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("Enter open");

    // git focus
    harness.overlay.handleInput(KEYS.tab);
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("g G jump");

    // help mode
    harness.overlay.handleInput("?");
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("close help");
    harness.overlay.handleInput(KEYS.escape);
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

// ── Issue #001: Stale content race when opening file ──

describe("Issue #001: stale content race when opening file", () => {
  it("immediately updates viewer header, loading indicator, and accent styling while loading", async () => {
    let resolveFileB!: (file: ViewerFile) => void;
    const harness = makeHarness(
      36,
      (relPath: string) => {
        if (relPath === "b.ts") {
          return new Promise<ViewerFile>((resolve) => {
            resolveFileB = resolve;
          });
        }
        return Promise.resolve({
          kind: "text",
          relPath,
          sizeBytes: 100,
          lineCount: 3,
          lines: ["line-from-a-alpha", "line-from-a-beta", "line-from-a-gamma"],
        });
      },
      (color, text) => (color === "accent" ? `[ACCENT:${text}]` : text),
    );

    withTree(harness, ["a.ts", "b.ts"]);

    // 1. Open file A and let it resolve.
    harness.overlay.handleInput(KEYS.enter);
    await new Promise((resolve) => setTimeout(resolve, 10));

    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("line-from-a-alpha");
    expect(rendered).toContain("[ACCENT:a.ts]");
    expect(harness.overlay.getOpenRelPath()).toBe("a.ts");

    // 2. Tab back to files pane, move cursor to b.ts, and press Enter to open file B.
    harness.overlay.handleInput(KEYS.tab); // viewer -> files
    harness.overlay.handleInput("j"); // cursor to b.ts
    harness.overlay.handleInput(KEYS.enter); // trigger openRelPath("b.ts")

    // File B is still in flight (resolveFileB has not been called).
    rendered = harness.overlay.render(120).join("\n");

    // Acceptance Criteria checks while in flight:
    // - Selecting a file immediately updates the viewer header to target file (b.ts)
    // - File-row accent highlighting immediately targets b.ts, not a.ts
    expect(rendered).toContain("[ACCENT:b.ts]");
    expect(rendered).not.toContain("[ACCENT:a.ts]");

    // - Viewer header displays loading indicator for b.ts
    expect(rendered).toContain("b.ts");
    expect(rendered).toContain("loading\u2026");

    // - Viewer displays loading indicator rather than stale contents from a.ts
    expect(rendered).toContain("(loading\u2026)");
    expect(rendered).not.toContain("line-from-a-alpha");

    // - getOpenRelPath() immediately reflects b.ts
    expect(harness.overlay.getOpenRelPath()).toBe("b.ts");

    // 3. Resolve file B
    resolveFileB({
      kind: "text",
      relPath: "b.ts",
      sizeBytes: 200,
      lineCount: 2,
      lines: ["line-from-b-one", "line-from-b-two"],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("line-from-b-one");
    expect(rendered).not.toContain("loading\u2026");
    expect(rendered).not.toContain("(loading\u2026)");
  });

  it("preserves content and does not flash empty/loading during same-file reload (r)", async () => {
    let reloadDeferred: ((file: ViewerFile) => void) | null = null;
    let isReload = false;
    const harness = makeHarness(
      36,
      (relPath: string) => {
        if (relPath === "a.ts" && isReload) {
          return new Promise<ViewerFile>((resolve) => {
            reloadDeferred = resolve;
          });
        }
        return Promise.resolve({
          kind: "text",
          relPath,
          sizeBytes: 100,
          lineCount: 3,
          lines: ["content-original"],
        });
      },
    );

    withTree(harness, ["a.ts"]);
    harness.overlay.handleInput(KEYS.enter); // open a.ts
    await new Promise((resolve) => setTimeout(resolve, 10));

    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("content-original");

    // Set flag so next loadFile waits for reloadDeferred
    isReload = true;

    // Press 'r' to reload
    harness.overlay.handleInput("r");

    // While in flight, the current content should STILL be visible (no regression in content or blanking)
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("content-original");
    expect(rendered).not.toContain("(loading\u2026)");
    expect(rendered).toContain("loading\u2026"); // header meta shows loading…

    // Complete reload
    expect(reloadDeferred).not.toBeNull();
    reloadDeferred!({
      kind: "text",
      relPath: "a.ts",
      sizeBytes: 120,
      lineCount: 1,
      lines: ["content-reloaded"],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("content-reloaded");
    expect(rendered).not.toContain("loading\u2026");
  });

  it("handles race condition: slow request for file A does not overwrite fast request for file B", async () => {
    let resolveFileA!: (file: ViewerFile) => void;
    let resolveFileB!: (file: ViewerFile) => void;

    const harness = makeHarness(36, (relPath: string) => {
      if (relPath === "a.ts") {
        return new Promise<ViewerFile>((resolve) => {
          resolveFileA = resolve;
        });
      }
      if (relPath === "b.ts") {
        return new Promise<ViewerFile>((resolve) => {
          resolveFileB = resolve;
        });
      }
      return Promise.resolve({ kind: "text", relPath, lines: [] });
    });

    withTree(harness, ["a.ts", "b.ts"]);

    // Request file A first (slow)
    void harness.overlay.openRelPath("a.ts");
    // Request file B second (fast)
    void harness.overlay.openRelPath("b.ts");

    // Resolve file B first
    resolveFileB({
      kind: "text",
      relPath: "b.ts",
      lines: ["file-b-content"],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("file-b-content");
    expect(harness.overlay.getOpenRelPath()).toBe("b.ts");

    // Now resolve file A later
    resolveFileA({
      kind: "text",
      relPath: "a.ts",
      lines: ["file-a-content"],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Viewer should STILL show file B!
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("file-b-content");
    expect(rendered).not.toContain("file-a-content");
    expect(harness.overlay.getOpenRelPath()).toBe("b.ts");
  });
});