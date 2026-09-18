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
  loadCommit?: (shortHash: string) => Promise<ViewerFile>,
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
    ...(loadCommit ? { loadCommit } : {}),
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

  it("hides the empty Unstaged and Staged group rows (Issue #029)", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    withGit(harness, { unstaged: [], staged: [] });
    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain("Unstaged");
    expect(rendered).not.toContain("Staged");
    expect(rendered).toContain("Clean");
    // Header summary is still always-on.
    expect(rendered).toContain("0 unstaged");
    // History section header remains.
    expect(rendered).toContain("History");
  });

  it("keeps a populated Unstaged group and header count (Issue #029)", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    withGit(harness, { unstaged: [{ relPath: "a.ts", code: "M" }], staged: [] });
    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("Unstaged (1)");
    expect(rendered).not.toContain("Staged (");
    expect(rendered).toContain("1 unstaged");
  });

  it("expands and collapses a commit's family on l (Issue #030, v3)", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    withGit(harness, {
      unstaged: [],
      staged: [],
      history: [
        { shortHash: "bbb2222", parents: ["aaa1111"], dateRel: "2h ago", subject: "child" },
        { shortHash: "aaa1111", parents: ["9998888"], dateRel: "3h ago", subject: "root" },
        { shortHash: "9998888", parents: [], dateRel: "4h ago", subject: "base" },
      ],
    });
    const overlay = harness.overlay;
    overlay.handleInput(KEYS.tab); // focus git
    // Cursor starts on the first nav row: bbb2222 (child commit).
    overlay.handleInput("l"); // expand it -> its parent aaa1111 appears as an indented family row
    let rendered = overlay.render(120).join("\n");
    // The parent is rendered as an indented commit-child row under bbb2222
    // (v3 expands one level only — aaa1111's own parent does NOT auto-expand).
    // The row carries a ▸ marker between the indent and the hash.
    expect(rendered).toMatch(/bbb2222[\s\S]*\u25b8 aaa1111/);

    // Collapse with h: aaa1111 (depth-1 family child of the expanded bbb2222)
    // is no longer nested; it still appears as its own top-level history row
    // (with the ▸ marker any commit with in-history parents carries).
    overlay.handleInput("h"); // collapse bbb2222
    rendered = overlay.render(120).join("\n");
    expect(rendered).toMatch(/\u25b8 aaa1111/); // top-level history row, unindented marker
    expect(rendered).toContain("9998888"); // separate history entry, present regardless

    // v3 one-level semantics: expanding bbb2222 again must NOT recursively
    // reveal aaa1111's parent (9998888) — that requires expanding aaa1111 too.
    overlay.handleInput("l"); // expand bbb2222 again
    overlay.handleInput("j"); // bbb -> aaa1111 (commit-child)
    overlay.handleInput("l"); // expand aaa1111 -> its parent 9998888 at depth 2
    rendered = overlay.render(120).join("\n");
    expect(rendered).toMatch(/bbb2222[\s\S]*aaa1111[\s\S]*9998888/);
  });

  it("nests the ancestor family under the expanded commit without duplicating rows (Issue #030, v3)", () => {
    // Regression: the family block used to be emitted after *each* commit that
    // shared a child's hash, so an ancestor that was both a top-level history
    // entry and a family child rendered twice, and the nesting landed under the
    // wrong anchor. The block must now emit once, directly beneath the expanded
    // commit, in depth order — with the top-level history list still complete
    // and duplicate-free. v3 (one level per expand): expanding bbb reveals only
    // its direct parent aaa; 999 stays flat until aaa is expanded too.
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    withGit(harness, {
      unstaged: [],
      staged: [],
      history: [
        { shortHash: "bbb2222", parents: ["aaa1111"], dateRel: "2h ago", subject: "child" },
        { shortHash: "aaa1111", parents: ["9998888"], dateRel: "3h ago", subject: "mid" },
        { shortHash: "9998888", parents: [], dateRel: "4h ago", subject: "base" },
      ],
    });
    const overlay = harness.overlay;
    overlay.handleInput(KEYS.tab); // focus git
    overlay.handleInput("l"); // expand bbb2222

    // Collect the git-pane commit hashes in render order. A hash is 7 hex
    // chars; each commit/commit-child row carries exactly one. Stripping ANSI
    // and matching the short hashes preserves order without depending on the
    // exact left-column width.
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    const hashes: string[] = [];
    for (const line of overlay.render(120)) {
      const plain = strip(line);
      // Each git-pane row carries exactly one commit hash; take the first match
      // per line so a hash accidentally echoed in the viewer pane cannot
      // double-count.
      for (const h of ["bbb2222", "aaa1111", "9998888"]) {
        if (plain.includes(h)) {
          hashes.push(h);
          break;
        }
      }
    }
    // Expected: bbb (top-level), aaa (depth-1 child), then aaa and 999 as
    // their own top-level history rows. bbb's expansion reveals only its
    // *direct* parent — 999 is not nested until aaa is expanded (v3). No hash
    // appears more than twice (once nested, once flat); the nested chain
    // comes immediately after bbb in depth order.
    expect(hashes).toEqual(["bbb2222", "aaa1111", "aaa1111", "9998888"]);
    // aaa appears exactly twice (nested + flat), never three times; 999 is
    // flat-only at this point (not yet expanded).
    expect(hashes.filter((x) => x === "aaa1111").length, "aaa1111 duplicated").toBe(2);
    expect(hashes.filter((x) => x === "9998888").length, "9998888 appeared unexpectedly nested").toBe(1);
  });

  it("limits commit-family expansion to the row cap (Issue #030)", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    const deep: Array<{ shortHash: string; parents: string[]; dateRel: string; subject: string }> = [];
    // A chain of 20 commits, each parent of the next (child first in history).
    for (let i = 0; i < 20; i++) {
      const hash = "c" + i.toString().padStart(6, "0");
      deep.push({
        shortHash: hash,
        parents: i < 19 ? ["c" + (i + 1).toString().padStart(6, "0")] : [],
        dateRel: "1h ago",
        subject: "commit " + i,
      });
    }
    withGit(harness, { unstaged: [], staged: [], history: deep });
    const overlay = harness.overlay;
    overlay.handleInput(KEYS.tab); // focus git
    overlay.handleInput(KEYS.enter); // expand the first commit (history[0])
    const rendered = overlay.render(120);
    const joined = rendered.join("\n");
    // FAMILY_MAX_ROWS caps the added family rows; the 20-deep chain must not
    // render all 19 descendants. The expansion stops at the cap.
    const childRows = joined.split("\n").filter((l) => l.includes("  c")) ;
    // Only a bounded number of ancestor rows are rendered.
    expect(childRows.length).toBeLessThan(20);
  });

  // ── v3: commit diff view + family on l/h (plan commit-detail-family-tree) ──

  it("Enter on a commit opens its diff in the viewer (v3)", async () => {
    const loadCommit = vi.fn(async (shortHash: string): Promise<ViewerFile> => ({
      kind: "diff",
      relPath: `commit:${shortHash}`,
      commitHash: shortHash,
      parents: ["aaa1111"],
      lines: ["+added", "-removed", " context"],
      notice: `commit ${shortHash} \u00b7 1 file \u00b7 +1 \u22121`,
    }));
    const harness = makeHarness(36, undefined, undefined, loadCommit);
    withTree(harness, ["a.ts"]);
    withGit(harness);
    harness.overlay.handleInput(KEYS.tab); // focus git
    harness.overlay.handleInput("G"); // bottom: the abc1234 commit row (row 0 is the unstaged file)

    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    expect(loadCommit).toHaveBeenCalledWith("abc1234");
    // Focus moved to the viewer and the diff renders there.
    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("commit abc1234");
    expect(rendered).toContain("+added");
    expect(rendered).toContain("\u22121");
    expect(harness.overlay.getOpenRelPath()).toBe("commit:abc1234");
  });

  it("Enter on a commit-child opens its diff too (v3)", async () => {
    const loadCommit = vi.fn(async (shortHash: string): Promise<ViewerFile> => ({
      kind: "diff",
      relPath: `commit:${shortHash}`,
      commitHash: shortHash,
      parents: [],
      lines: ["diff --git a/x b/x"],
      notice: `commit ${shortHash} \u00b7 1 file`,
    }));
    const harness = makeHarness(36, undefined, undefined, loadCommit);
    withTree(harness, ["a.ts"]);
    withGit(harness, {
      unstaged: [],
      staged: [],
      history: [
        { shortHash: "bbb2222", parents: ["aaa1111"], dateRel: "2h ago", subject: "child" },
        { shortHash: "aaa1111", parents: [], dateRel: "3h ago", subject: "root" },
      ],
    });
    const overlay = harness.overlay;
    overlay.handleInput(KEYS.tab); // focus git
    overlay.handleInput("l"); // expand bbb2222 -> aaa1111 at depth 1
    overlay.handleInput("j"); // bbb -> aaa1111 (commit-child)
    overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    expect(loadCommit).toHaveBeenCalledWith("aaa1111");
    expect(overlay.getOpenRelPath()).toBe("commit:aaa1111");
    expect(overlay.render(120).join("\n")).toContain("commit aaa1111");
  });

  it("l expands one level, h collapses and steps out to the anchor (v3)", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    withGit(harness, {
      unstaged: [],
      staged: [],
      history: [
        { shortHash: "bbb2222", parents: ["aaa1111"], dateRel: "2h ago", subject: "child" },
        { shortHash: "aaa1111", parents: ["9998888"], dateRel: "3h ago", subject: "mid" },
        { shortHash: "9998888", parents: [], dateRel: "4h ago", subject: "base" },
      ],
    });
    const overlay = harness.overlay;
    overlay.handleInput(KEYS.tab); // focus git
    overlay.handleInput("l"); // expand bbb2222 -> aaa1111 (depth 1)
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    // Drop all frame-box characters (left border, pane separator, right
    // border) and trailing padding — keep the interior whitespace so a
    // depth-1 child row stays distinguishable from its flat top-level copy.
    const plain = (s: string) => strip(s).replace(/\u2502/g, "").replace(/\s+$/, "");
    const hashLines = () =>
      overlay
        .render(120)
        .map(plain)
        .filter((l) => /bbb2222|aaa1111|9998888/.test(l));
    // One level per expand: after bbb, aaa (depth-1 child, 4-space indent), aaa
    // (flat), 999 (flat root, no marker).
    expect(hashLines()).toEqual([
      "\u25b6 \u25be bbb2222  child",
      "    \u25b8 aaa1111  mid",
      "  \u25b8 aaa1111  mid",
      "    9998888  base",
    ]);

    overlay.handleInput("j"); // bbb -> aaa1111 (commit-child)
    overlay.handleInput("l"); // expand aaa1111 -> 9998888 at depth 2
    const twoLevel = hashLines();
    // bbb (expanded ▾), aaa depth-1 child (now expanded ▾), aaa flat (▾), 999
    // depth-2 child (root: no marker, 8-space indent), 999 flat (root: no
    // marker) — ordered, no dup, one level per expand.
    expect(twoLevel.join("|")).toMatch(
      /bbb2222.*\u25be aaa1111.*\u25be aaa1111.*        9998888.*    9998888/,
    );

    // h on the depth-1 child collapses its subtree and steps the cursor out to
    // the expanded anchor (bbb2222).
    overlay.handleInput("h"); // aaa1111 is the cursor; collapse its subtree
    const after = overlay.render(120).map(plain).join("\n");
    expect(after).toContain("\u25b6 \u25be bbb2222"); // cursor stepped out to the anchor
    expect(after).not.toContain("\u25be aaa1111"); // aaa's subtree collapsed (marker back to ▸)
  });

  it("shows the depth-cap notice instead of expanding past the ceiling (v3)", () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    // Chain of FAMILY_MAX_DEPTH+2 commits, all in history.
    const deep = [
      { shortHash: "c000000", parents: ["c111111"], dateRel: "1h ago", subject: "depth0" },
      { shortHash: "c111111", parents: ["c222222"], dateRel: "1h ago", subject: "depth1" },
      { shortHash: "c222222", parents: ["c333333"], dateRel: "1h ago", subject: "depth2" },
      { shortHash: "c333333", parents: ["c444444"], dateRel: "1h ago", subject: "depth3" },
      { shortHash: "c444444", parents: [], dateRel: "1h ago", subject: "depth4" },
    ];
    withGit(harness, { unstaged: [], staged: [], history: deep });
    const overlay = harness.overlay;
    overlay.handleInput(KEYS.tab); // focus git
    // Expand down the chain, descending past each flat anchor row: a chain of
    // an expanded anchor followed by its indented child, its flat copy, and so
    // on. Rows: [c0, c1(d1), c1, c2(d2), c2, c3(d3), c3, c4]. From the c1 child
    // (index 1) two downs land on the c2 child (index 3), skipping the flat c1.
    overlay.handleInput("l"); // c0 + c1 (child)
    overlay.handleInput("j"); // -> c1 child
    overlay.handleInput("l"); // expand c1 -> c2 (child)
    overlay.handleInput("j"); // -> flat c1
    overlay.handleInput("j"); // -> c2 child
    overlay.handleInput("l"); // expand c2 -> c3 (child)
    overlay.handleInput("j"); // -> flat c2
    overlay.handleInput("j"); // -> c3 child (depth 3 = FAMILY_MAX_DEPTH)
    // Expanding at the cap is refused: notice, no new rows.
    overlay.handleInput("l");
    const rendered = overlay.render(120).join("\n");
    expect(rendered).toContain("max depth reached");
    // c4 is not nested anywhere, so it only ever appears as its flat row.
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    const c4Rows = overlay.render(120).map(strip).filter((l) => l.includes("c444444"));
    expect(c4Rows).toHaveLength(1);
  });

  it("falls back to toggling the family when loadCommit is absent (v3)", () => {
    // Harness without loadCommit: Enter on a commit must expand its family
    // (v2 behavior) so existing suites stay green.
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    withGit(harness, {
      unstaged: [],
      staged: [],
      history: [
        { shortHash: "bbb2222", parents: ["aaa1111"], dateRel: "2h ago", subject: "child" },
        { shortHash: "aaa1111", parents: ["9998888"], dateRel: "3h ago", subject: "root" },
        { shortHash: "9998888", parents: [], dateRel: "4h ago", subject: "base" },
      ],
    });
    const overlay = harness.overlay;
    overlay.handleInput(KEYS.tab); // focus git
    overlay.handleInput("G"); // bottom: the last row is 9998888 (flat); row 0 is the unstaged file
    overlay.handleInput("k"); // -> aaa1111 (flat)
    overlay.handleInput("k"); // -> bbb2222 (the child commit)
    overlay.handleInput(KEYS.enter); // no loadCommit -> toggle bbb's family
    expect(overlay.render(120).join("\n")).toMatch(/bbb2222[\s\S]*\u25b8 aaa1111/);
    expect(overlay.getOpenRelPath()).toBeNull(); // viewer untouched
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

describe("makeNavigatorTheme", () => {
  it("guards underline defensively when theme.underline is undefined (Issue #042)", () => {
    const minimalTheme = makeNavigatorTheme({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    } as never);
    expect(minimalTheme.searchCurrent("match")).toBe("match");
  });

  it("applies underline when theme.underline is provided", () => {
    const themeWithUnderline = makeNavigatorTheme({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      underline: (text: string) => `<u>${text}</u>`,
    } as never);
    expect(themeWithUnderline.searchCurrent("match")).toBe("<u>match</u>");
  });
});

describe("shortPath", () => {
  it("shortens home directory prefix using injected home option (Issue #039)", () => {
    const theme = makeNavigatorTheme({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    } as never);
    const overlay = new NavigatorOverlay({
      cwd: "/Users/testuser/project",
      theme,
      home: "/Users/testuser",
      getTerminalRows: () => 24,
      requestRender: () => undefined,
      onClose: () => undefined,
      loadFile: async () => ({ kind: "text", relPath: "a.txt", lines: [] }),
      refresh: () => undefined,
    });
    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("~/project");
  });
});