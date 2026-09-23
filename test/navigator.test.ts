/**
 * navigator.ts keymap reducer suites (plan section 11, last bullet): escape
 * precedence, focus cycling, mode transitions, cursor clamps, git Enter
 * behavior and the copy action. The overlay runs against real pi-tui key
 * matching; only copyToClipboard is stubbed (a side-effectful surface).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";

import { IMAGE_RESIZE_DEBOUNCE_MS } from "../constants";
import { DEFAULT_PI_CHAFA_SUBSET, resolveChafaGeometry, type ImageSupport } from "../images";
import { makeNavigatorTheme } from "../theme";
import { buildTree, entriesFromPaths, findNode } from "../tree";
import type { GitState, ViewerFile } from "../types";
import type { LoadFileOptions } from "../viewer";
import { imageCardHints } from "../viewer_view";

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

/** Active chafa support snapshot for the image suites (§12.4). */
function activeSupport(overrides: Partial<ImageSupport> = {}): ImageSupport {
  return {
    mode: "chafa",
    nativeProtocol: null,
    tier: "chafa",
    piChafa: { present: true, via: "settings" },
    chafa: { state: "ok", binary: "chafa", version: { major: 1, minor: 18 } },
    config: { ...DEFAULT_PI_CHAFA_SUBSET },
    hostShowImages: true,
    hostImageWidthCells: 60,
    ...overrides,
  };
}

/** Fake chafa render: imageTier "chafa" with imageRows plain rows. */
function chafaImage(relPath: string, imageCols = 40, imageRows = 12): ViewerFile {
  return {
    kind: "image",
    relPath,
    imageTier: "chafa",
    imageCols,
    imageRows,
    imageLines: Array.from({ length: imageRows }, (_, i) => `chafa-row-${i}`),
    lines: [],
    sizeBytes: 1024,
    message: "1.0 KB \u00b7 32x32",
  };
}

/** Fake metadata card (the pre-chafa image tier). */
function metadataImage(relPath: string): ViewerFile {
  return {
    kind: "image",
    relPath,
    imageTier: "metadata",
    lines: [],
    sizeBytes: 1024,
    message: "1.0 KB \u00b7 32x32",
  };
}

/** Strip ANSI escapes for content assertions (theme is identity in harnesses). */
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

interface Harness {
  overlay: NavigatorOverlay;
  opened: string[];
  /** Every loader call: (relPath, opts) — the opts carry the chafa geometry hint. */
  loads: Array<{ relPath: string; opts?: LoadFileOptions }>;
  state: { closed: number; refreshed: number; renders: number };
}

function makeHarness(
  rows = 36,
  customLoadFile?: (relPath: string, opts?: LoadFileOptions) => Promise<ViewerFile>,
  customTheme?: (color: string, text: string) => string,
  loadCommit?: (shortHash: string) => Promise<ViewerFile>,
  imageSupport?: ImageSupport,
): Harness {
  const opened: string[] = [];
  const loads: Array<{ relPath: string; opts?: LoadFileOptions }> = [];
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
      (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> => {
        loads.push({ relPath, opts });
        if (customLoadFile) return customLoadFile(relPath, opts);
        opened.push(relPath);
        return Promise.resolve({
          kind: "text",
          relPath,
          sizeBytes: 10,
          lineCount: 3,
          lines: ["alpha", "beta", "gamma"],
        });
      },
    ...(loadCommit ? { loadCommit } : {}),
    refresh: () => {
      state.refreshed += 1;
    },
    ...(imageSupport !== undefined ? { imageSupport } : {}),
  };

  const overlay = new NavigatorOverlay(options);
  return { overlay, opened, loads, state };
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

// ── Tree mutation invalidates the files rows cache ──

describe("tree mutations invalidate the files rows cache (Issue #064 finding 2)", () => {
  // The shape is render → mutate → render: the first render(120) populates
  // filesRowsCache, so the second render can only reflect the mutation if the
  // entry point bumped treeVersion. A post-mutation-only render would pass by
  // accident (the cache would be cold and recomputed anyway).

  it("l and right expand a collapsed directory after a render", () => {
    const tree = buildTree("/work", entriesFromPaths(["src/deep/a.ts"]), new Map());
    // Setup-only collapse, before any render (same as the Enter test above).
    const src = findNode(tree, "src");
    expect(src?.expanded).toBe(true);
    if (src) src.expanded = false;

    const harness = makeHarness();
    harness.overlay.setTree(tree, "git");

    // Render first: the rows cache now holds the collapsed rows.
    expect(harness.overlay.render(120).join("\n")).not.toContain("deep");

    harness.overlay.handleInput("l"); // cursor sits on the collapsed src
    expect(harness.overlay.render(120).join("\n")).toContain("deep");

    // Collapse again (cache hot with the expanded rows), then expand through
    // the arrow binding — the same funnel must invalidate either way.
    harness.overlay.handleInput("h");
    expect(harness.overlay.render(120).join("\n")).not.toContain("deep");
    harness.overlay.handleInput(KEYS.right);
    expect(harness.overlay.render(120).join("\n")).toContain("deep");
  });

  it("h and left collapse an expanded directory after a render", () => {
    const harness = makeHarness();
    withTree(harness, ["src/deep/a.ts"]); // src is expanded by default

    // Render first: the cache now holds the expanded rows.
    expect(harness.overlay.render(120).join("\n")).toContain("deep");

    harness.overlay.handleInput("h"); // cursor sits on the expanded src
    expect(harness.overlay.render(120).join("\n")).not.toContain("deep");

    // Re-expand through the arrow binding, then collapse through it too.
    harness.overlay.handleInput(KEYS.right);
    expect(harness.overlay.render(120).join("\n")).toContain("deep");
    harness.overlay.handleInput(KEYS.left);
    expect(harness.overlay.render(120).join("\n")).not.toContain("deep");
  });

  it("git-pane Enter expands the file's collapsed ancestor via expandTo, visible after switching back", () => {
    // other.ts only ever renders in the files pane — the git pane carries
    // changed.ts and the viewer header echoes its own path, so a second file
    // is the unambiguous signal that the files pane re-expanded src.
    const tree = buildTree("/work", entriesFromPaths(["src/pkg/changed.ts", "src/pkg/other.ts"]), new Map());
    const src = findNode(tree, "src");
    expect(src?.expanded).toBe(true);
    if (src) src.expanded = false; // setup-only collapse, before any render

    const harness = makeHarness();
    harness.overlay.setTree(tree, "git");
    withGit(harness); // unstaged row: src/pkg/changed.ts

    // Render first with the ancestor collapsed: the cache is populated and
    // src's children are nowhere on screen.
    expect(harness.overlay.render(120).join("\n")).not.toContain("other.ts");

    harness.overlay.handleInput(KEYS.tab); // focus git; cursor lands on the file row
    harness.overlay.handleInput(KEYS.enter); // expandTo(src/pkg node) + open the file
    expect(harness.opened).toEqual(["src/pkg/changed.ts"]);

    harness.overlay.handleInput(KEYS.shiftTab); // viewer -> git
    harness.overlay.handleInput(KEYS.shiftTab); // git -> files
    // The files pane must show src's children again — a stale cache would
    // still render src collapsed here.
    expect(harness.overlay.render(120).join("\n")).toContain("other.ts");
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
    const harness = makeHarness(80);
    withTree(harness, ["a.ts"]);
    const deep: Array<{ shortHash: string; parents: string[]; dateRel: string; subject: string }> = [];
    // An octopus merge with 20 direct parents in history exceeding FAMILY_MAX_ROWS (16).
    const parentHashes: string[] = [];
    for (let i = 1; i <= 20; i++) {
      parentHashes.push("p" + i.toString().padStart(6, "0"));
    }
    deep.push({
      shortHash: "c000000",
      parents: parentHashes,
      dateRel: "1h ago",
      subject: "octopus merge",
    });
    for (const p of parentHashes) {
      deep.push({
        shortHash: p,
        parents: [],
        dateRel: "2h ago",
        subject: "parent " + p,
      });
    }
    withGit(harness, { unstaged: [], staged: [], history: deep });
    const overlay = harness.overlay;
    overlay.handleInput(KEYS.tab); // focus git
    overlay.handleInput(KEYS.enter); // expand the first commit (history[0])
    const rendered = overlay.render(120);
    const joined = rendered.join("\n");
    // FAMILY_MAX_ROWS (16) caps the added family rows; the 20 direct parents
    // must be capped at 16, followed by the explicit truncation notice.
    const childRows = joined.split("\n").filter((l) => l.includes("      p"));
    expect(childRows.length).toBe(16);
    expect(joined).toContain("… more ancestors (narrow the view");
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
    expect(rendered).toContain("w wrap  m mode");
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

// ── Multi-char paste & non-BMP input (Issue #105) ──

describe("printable text (Issue #105): paste, surrogate pairs, control rejection", () => {
  const ROCKET = "\u{1F680}"; // 🚀 — UTF-16 surrogate pair, .length === 2

  it("pastes a multi-char string into the filter and the search, appending it whole", async () => {
    // Filter mode: whole pasted chunk lands in the query, not dropped.
    const harness = makeHarness();
    withTree(harness, ["src/a.ts"]);
    harness.overlay.handleInput("/");
    harness.overlay.handleInput("needle");
    expect(harness.overlay.render(120).join("\n")).toContain("/needle");
    harness.overlay.dispose();

    // Search mode: same paste behavior in the viewer search bar.
    const search = makeHarness();
    withTree(search, ["a.ts"]);
    search.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    search.overlay.handleInput("/");
    search.overlay.handleInput("needle");
    expect(search.overlay.render(120).join("\n")).toContain("/needle");
    search.overlay.dispose();
  });

  it("accepts an emoji (surrogate pair) in the search and the filter", async () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    harness.overlay.handleInput("/"); // search mode (viewer focus)
    harness.overlay.handleInput(ROCKET);
    expect(harness.overlay.render(120).join("\n")).toContain(ROCKET);

    harness.overlay.handleInput(KEYS.escape);
    harness.overlay.handleInput(KEYS.tab); // viewer -> files
    harness.overlay.handleInput("/"); // filter mode
    harness.overlay.handleInput(ROCKET);
    expect(harness.overlay.render(120).join("\n")).toContain(ROCKET);
    harness.overlay.dispose();
  });

  it("backspace after an emoji removes the whole surrogate pair (no lone surrogate)", async () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    harness.overlay.handleInput("/"); // search mode
    harness.overlay.handleInput(ROCKET);
    harness.overlay.handleInput(KEYS.backspace);
    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain(ROCKET);
    expect(rendered).not.toMatch(/[\ud800-\udfff]/); // no lone high/low surrogate

    harness.overlay.handleInput(KEYS.escape);
    harness.overlay.handleInput(KEYS.tab); // viewer -> files
    harness.overlay.handleInput("/"); // filter mode
    harness.overlay.handleInput(ROCKET);
    harness.overlay.handleInput(KEYS.backspace);
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain(ROCKET);
    expect(rendered).not.toMatch(/[\ud800-\udfff]/);
    harness.overlay.dispose();
  });

  it("rejects escape-sequence chunks in the filter and the search", async () => {
    const chunk = "\x1b[1;5A"; // e.g. a ctrl-arrow sequence — not a named filter/search key

    const harness = makeHarness();
    withTree(harness, ["src/a.ts"]);
    harness.overlay.handleInput("/");
    harness.overlay.handleInput(chunk);
    expect(harness.overlay.render(120).join("\n")).not.toContain(chunk);
    harness.overlay.handleInput("x"); // still typing normally after the rejected chunk
    expect(harness.overlay.render(120).join("\n")).toContain("/x");
    harness.overlay.dispose();

    const search = makeHarness();
    withTree(search, ["a.ts"]);
    search.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    search.overlay.handleInput("/");
    search.overlay.handleInput(chunk);
    expect(search.overlay.render(120).join("\n")).not.toContain(chunk);
    search.overlay.handleInput("x");
    expect(search.overlay.render(120).join("\n")).toContain("/x");
    search.overlay.dispose();
  });

  it("rejects DEL (0x7f) chunks in the filter", () => {
    const harness = makeHarness();
    withTree(harness, ["src/a.ts"]);
    harness.overlay.handleInput("/");
    harness.overlay.handleInput("\x7f\x7f"); // a pasted DEL chunk, not the backspace key
    expect(harness.overlay.render(120).join("\n")).not.toContain("\x7f");
    harness.overlay.handleInput("x");
    expect(harness.overlay.render(120).join("\n")).toContain("/x");
    harness.overlay.dispose();
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

  it("copies clean commit hash when focused on viewer with commit diff (Issue #049)", async () => {
    const harness = makeHarness(24, undefined, undefined, async (hash) => ({
      kind: "diff",
      relPath: `commit:${hash}`,
      commitHash: hash,
      lines: ["diff content"],
    }));
    await harness.overlay.openCommit("abc1234");
    harness.overlay.handleInput(KEYS.tab); // files -> git
    harness.overlay.handleInput(KEYS.tab); // git -> viewer
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
    await vi.waitFor(() => {
      expect(harness.overlay.render(120).join("\n")).toContain("line-from-a-alpha");
    });

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
    await vi.waitFor(() => {
      expect(harness.overlay.render(120).join("\n")).toContain("line-from-b-one");
    });

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
    await vi.waitFor(() => {
      expect(harness.overlay.render(120).join("\n")).toContain("content-original");
    });

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
    await vi.waitFor(() => {
      expect(harness.overlay.render(120).join("\n")).toContain("content-reloaded");
    });

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
    await vi.waitFor(() => {
      expect(harness.overlay.render(120).join("\n")).toContain("file-b-content");
    });

    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("file-b-content");
    expect(harness.overlay.getOpenRelPath()).toBe("b.ts");

    // Now resolve file A later
    resolveFileA({
      kind: "text",
      relPath: "a.ts",
      lines: ["file-a-content"],
    });
    await vi.waitFor(() => {
      expect(harness.overlay.getOpenRelPath()).toBe("b.ts");
    });

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

  it("does not abbreviate sibling home-prefixed paths (Issue #060 finding 1)", () => {
    // home /Users/testuser vs cwd /Users/testuserfake/project: bare
    // startsWith matched the prefix and rendered "~fake/project" — a path
    // that does not exist. The home boundary must require a path separator.
    const theme = makeNavigatorTheme({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    } as never);
    const overlay = new NavigatorOverlay({
      cwd: "/Users/testuserfake/project",
      theme,
      home: "/Users/testuser",
      getTerminalRows: () => 24,
      requestRender: () => undefined,
      onClose: () => undefined,
      loadFile: async () => ({ kind: "text", relPath: "a.txt", lines: [] }),
      refresh: () => undefined,
    });
    const rendered = overlay.render(120).join("\n");
    expect(rendered).toContain("/Users/testuserfake/project");
    expect(rendered).not.toContain("~fake");
  });
});

describe("nowrap wide-char hscroll (Issue #059)", () => {
  it("unlocks hscroll on a wide-char line and reaches the tail", async () => {
    // 60 distinct CJK chars = 120 terminal cells. Under the v1 code-point
    // model maxLineWidth was 60, maxH clamped to 0 and hscroll stayed pinned:
    // the tail was unreachable. With cell counting, maxH > 0 and `l` reaches
    // the last glyph.
    const harness = makeHarness(36, async () => ({
      kind: "text",
      relPath: "wide.txt",
      sizeBytes: 240,
      lineCount: 1,
      lines: [Array.from({ length: 60 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("")],
    }));
    const { overlay } = harness;
    withTree(harness, ["wide.txt"]);
    overlay.handleInput(KEYS.enter); // opens wide.txt, focus moves to viewer
    await Promise.resolve(); // let the async load settle
    expect(overlay.render(120).join("\n")).not.toContain("\u4e3b"); // tail glyph off-pane
    for (let i = 0; i < 40; i++) overlay.handleInput("l");
    const lines = overlay.render(120);
    for (let i = 0; i < lines.length; i++) {
      expect(visibleWidth(lines[i] ?? ""), `line ${i} overflows 120: ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(120);
    }
    expect(lines.join("\n")).toContain("\u4e3b"); // tail glyph reachable
  });
});

describe("Issue #065: col badge follows the clamped offset", () => {
  it("reports the offset the body rows use, never the requested overshoot", async () => {
    const harness = makeHarness(36, async () => ({
      kind: "text",
      relPath: "wide.txt",
      sizeBytes: 240,
      lineCount: 1,
      lines: [Array.from({ length: 60 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("")],
    }));
    const { overlay } = harness;
    withTree(harness, ["wide.txt"]);
    overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    // `l` adds 4 unclamped per press, so these 40 presses request 160 cells of
    // scroll on a line with far less overflow; the render clamps it. Before the
    // fix the badge reported the requested offset (col 161) while the body sat
    // at the clamped one.
    for (let i = 0; i < 40; i++) overlay.handleInput("l");
    const rendered = overlay.render(120).join("\n");
    const match = rendered.match(/col (\d+)/);
    expect(match).not.toBeNull();
    const col = Number(match![1]);
    expect(col).toBeGreaterThan(1);
    expect(col).toBeLessThan(161);
    expect(rendered).toContain(`col ${col}`);
    expect(rendered).not.toContain("col 161");
  });

  it("shows no badge and does not scroll a file that cannot overflow the pane", async () => {
    const harness = makeHarness(24, async () => ({
      kind: "text",
      relPath: "narrow.txt",
      sizeBytes: 10,
      lineCount: 1,
      lines: ["short line"],
    }));
    const { overlay } = harness;
    withTree(harness, ["narrow.txt"]);
    overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    overlay.handleInput("l");
    overlay.handleInput("l");
    const rendered = overlay.render(120).join("\n");
    expect(rendered).not.toContain("col ");
  });
});

describe("Issue #048: reloadOpenFile on commit diff", () => {
  it("reloads commit diff without routing to loadFile or crashing into error card", async () => {
    let commitLoads = 0;
    const loadCalls: string[] = [];
    const harness = makeHarness(
      24,
      async (relPath) => {
        loadCalls.push(relPath);
        return { kind: "text", relPath, lines: ["file-content"] };
      },
      undefined,
      async (hash) => {
        commitLoads += 1;
        return {
          kind: "diff",
          relPath: `commit:${hash}`,
          commitHash: hash,
          lines: ["+diff-line-1", "+diff-line-2", "+diff-line-3"],
        };
      },
    );

    await harness.overlay.openCommit("abc1234");
    expect(commitLoads).toBe(1);
    expect(loadCalls).toEqual([]);

    // Trigger reload via "r" key
    harness.overlay.handleInput("r");
    await Promise.resolve();

    // Must reload commit via loadCommit, not loadFile
    expect(commitLoads).toBe(2);
    expect(loadCalls).toEqual([]);

    // Viewer still displays the diff and not an error
    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("diff-line-1");
    expect(rendered).not.toContain("unexpected read failure");
  });

  it("preserves scroll position when refreshing active commit diff", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `+diff-line-${i}`);
    const harness = makeHarness(
      24,
      undefined,
      undefined,
      async (hash) => ({
        kind: "diff",
        relPath: `commit:${hash}`,
        commitHash: hash,
        lines,
      }),
    );

    await harness.overlay.openCommit("abc1234");
    // Switch focus to viewer and scroll down
    harness.overlay.handleInput(KEYS.tab);
    harness.overlay.handleInput(KEYS.tab);
    harness.overlay.handleInput("j");
    harness.overlay.handleInput("j");
    harness.overlay.handleInput("j");

    const bodyBefore = harness.overlay.render(120).slice(0, -2).join("\n");
    harness.overlay.handleInput("r");
    await Promise.resolve();
    const bodyAfter = harness.overlay.render(120).slice(0, -2).join("\n");

    expect(bodyAfter).toBe(bodyBefore);
  });
});

describe("Issue #050: viewer header commit transition", () => {
  it("renders 'commit <hash>' instead of 'commit:<hash>' while diff load is in flight", () => {
    let resolveCommit!: (file: ViewerFile) => void;
    const harness = makeHarness(
      24,
      undefined,
      undefined,
      () =>
        new Promise<ViewerFile>((resolve) => {
          resolveCommit = resolve;
        }),
    );

    void harness.overlay.openCommit("abc1234");
    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("commit abc1234");
    expect(rendered).not.toContain("commit:abc1234");

    resolveCommit({
      kind: "diff",
      relPath: "commit:abc1234",
      commitHash: "abc1234",
      lines: ["+diff content"],
    });
  });
});

describe("markdown rendered view", () => {
  const mdFile: ViewerFile = {
    kind: "text",
    relPath: "README.md",
    sizeBytes: 100,
    lineCount: 4,
    lines: ["# Heading", "", "- bullet point", "regular text"],
    rawText: "# Heading\n\n- bullet point\nregular text",
  };

  it("toggles between code view and rendered view with m key", async () => {
    const harness = makeHarness(24, async (p) => (p === "README.md" ? mdFile : { kind: "text", relPath: p, lines: [] }));
    withTree(harness, ["README.md"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    // Default code view: header shows 'm render', body has gutter border │
    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("m render");
    expect(rendered).toContain("│");

    // Press 'm': toggles to rendered view
    harness.overlay.handleInput("m");
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("m code");
    expect(rendered).not.toContain("m render");

    // Press 'm' again: toggles back to code view
    harness.overlay.handleInput("m");
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("m render");
    expect(rendered).not.toContain("m code");
  });

  it("shows notice and rejects toggle on non-markdown files", async () => {
    const harness = makeHarness();
    withTree(harness, ["a.ts"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain("m render");
    expect(rendered).not.toContain("m code");

    harness.overlay.handleInput("m");
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("rendered view only available for markdown files");
    expect(rendered).not.toContain("m code");
  });

  it("shows notice and rejects toggle on commit diffs", async () => {
    const harness = makeHarness(
      24,
      undefined,
      undefined,
      async (hash) => ({
        kind: "diff",
        relPath: `commit:${hash}`,
        commitHash: hash,
        lines: ["diff --git a/README.md b/README.md", "+# New heading"],
      }),
    );

    await harness.overlay.openCommit("abc1234");
    harness.overlay.handleInput(KEYS.tab);
    harness.overlay.handleInput(KEYS.tab);

    harness.overlay.handleInput("m");
    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("rendered view only available for markdown files");
    expect(rendered).not.toContain("m code");
  });

  it("resets hscroll on mode toggle and makes w wrap toggle a no-op while rendered", async () => {
    // The fixture's first line is wider than the viewer pane, so hscroll is
    // real here: since Issue #065 the badge reports the *clamped* offset, so a
    // file that cannot scroll can no longer stand in for a scrolled one.
    const longHeading = "# " + "wide heading ".repeat(12);
    const mdWide: ViewerFile = {
      kind: "text",
      relPath: "README.md",
      sizeBytes: 400,
      lineCount: 2,
      lines: [longHeading, "tail line"],
      rawText: `${longHeading}\ntail line`,
    };
    const harness = makeHarness(24, async () => mdWide);
    withTree(harness, ["README.md"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    // Scroll horizontally in code view: two 4-cell steps are well inside this
    // line's overflow, so the body scrolls and the badge reports the offset the
    // body was rendered at (8 + 1).
    harness.overlay.handleInput("l");
    harness.overlay.handleInput("l");
    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("col 9");

    // Switch to rendered view: hscroll resets
    harness.overlay.handleInput("m");
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain("col ");

    // Pressing 'w' in rendered view is a no-op (wrap stays off in code view, not shown in header)
    harness.overlay.handleInput("w");
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain("· wrap");

    // Switch back to code view and verify wrap is still off
    harness.overlay.handleInput("m");
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain("· wrap");
  });

  it("supports in-file search, cycling matches, and jumping in rendered mode", async () => {
    const harness = makeHarness(24, async () => mdFile);
    withTree(harness, ["README.md"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    // Switch to rendered view
    harness.overlay.handleInput("m");

    // Start search for "bullet"
    harness.overlay.handleInput("/");
    for (const char of "bullet") {
      harness.overlay.handleInput(char);
    }
    let rendered = harness.overlay.render(120).join("\n");
    expect(rendered).toContain("/bullet");
    expect(rendered).toContain("1/1 matches");

    // Apply search to return to normal mode
    harness.overlay.handleInput(KEYS.enter);

    // Cycle match in normal mode using n / N
    harness.overlay.handleInput("n");
    harness.overlay.handleInput("N");

    // Open search again and escape
    harness.overlay.handleInput("/");
    harness.overlay.handleInput(KEYS.escape);
    rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain("/bullet");
  });

  it("allows mode toggle on .mdx, .mkd, and .mdown files (#055)", async () => {
    const mdxFile: ViewerFile = {
      kind: "text",
      relPath: "doc.mdx",
      lines: ["# MDX Heading"],
      rawText: "# MDX Heading",
    };
    const harness = makeHarness(24, async () => mdxFile);
    withTree(harness, ["doc.mdx"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    expect(harness.overlay.render(120).join("\n")).toContain("m render");
    harness.overlay.handleInput("m");
    expect(harness.overlay.render(120).join("\n")).toContain("m code");
  });

  it("clamps searchIndex when toggling into rendered mode produces fewer matches (#052)", async () => {
    const fileWithFewerRenderedMatches: ViewerFile = {
      kind: "text",
      relPath: "test.md",
      lines: ["item 1", "item 2", "item 3", "item 4", "item 5", "item 6"],
      rawText: "item 1 and item 2 only",
    };
    const harness = makeHarness(24, async () => fileWithFewerRenderedMatches);
    withTree(harness, ["test.md"]);
    harness.overlay.handleInput(KEYS.enter);
    await vi.waitFor(() => {
      expect(harness.overlay.render(120).join("\n")).toContain("item 1");
    });

    harness.overlay.handleInput("/");
    for (const ch of "item") {
      harness.overlay.handleInput(ch);
    }
    expect(harness.overlay.render(120).join("\n")).toContain("1/6 matches");

    for (let i = 0; i < 5; i++) {
      harness.overlay.handleInput(KEYS.down);
    }
    expect(harness.overlay.render(120).join("\n")).toContain("6/6 matches");
    expect(harness.overlay.getSearchState()).toEqual({ query: "item", index: 5, total: 6 });

    harness.overlay.handleInput(KEYS.enter);

    // Toggle to rendered view (2 matches): searchIndex must be clamped (#052).
    harness.overlay.handleInput("m");
    harness.overlay.render(120);

    // Directly assert searchIndex was clamped from 5 to 1 without re-typing query (#093)
    expect(harness.overlay.getSearchState()).toEqual({ query: "item", index: 1, total: 2 });

    // Cycling match navigates within the clamped range [0, 1]
    harness.overlay.handleInput("n");
    expect(harness.overlay.getSearchState()).toEqual({ query: "item", index: 0, total: 2 });
    harness.overlay.handleInput("N");
    expect(harness.overlay.getSearchState()).toEqual({ query: "item", index: 1, total: 2 });
  });

  it("guards horizontal scroll keys in rendered markdown mode (#053)", async () => {
    const harness = makeHarness(24, async () => mdFile);
    withTree(harness, ["README.md"]);
    harness.overlay.handleInput(KEYS.enter);
    await vi.waitFor(() => {
      expect(harness.overlay.render(120).join("\n")).toContain("Heading");
    });

    // Toggle to rendered view
    harness.overlay.handleInput("m");
    const frameRendered = harness.overlay.render(120);

    // Pressing h, l, left, right in rendered mode are no-ops: touch() is not called and horizontal scroll is untouched
    harness.overlay.handleInput("h");
    harness.overlay.handleInput("l");
    harness.overlay.handleInput(KEYS.left);
    harness.overlay.handleInput(KEYS.right);

    // Render cache survived: returns the exact same array reference
    expect(harness.overlay.render(120)).toBe(frameRendered);

    // Render pass in rendered mode does not introduce hscroll
    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain("col ");

    // In code view, horizontal scroll keys still work and invalidate render cache
    harness.overlay.handleInput("m");
    const frameCode = harness.overlay.render(120);

    harness.overlay.handleInput("l");
    // touch() was called: render cache was invalidated and re-derived
    expect(harness.overlay.render(120)).not.toBe(frameCode);
  });

  it("invokes Markdown render at most once per render pass (#054)", async () => {
    const harness = makeHarness(24, async () => mdFile);
    withTree(harness, ["README.md"]);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    harness.overlay.handleInput("m");

    const spy = vi.spyOn(Markdown.prototype, "render");
    harness.overlay.render(120);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
// ── Chafa image rendering (§12.4) ──

describe("chafa image rendering", () => {
  /** Content row `bodyIndex` of a frame rendered at the default harness size. */
  const bodyRow = (lines: string[], bodyIndex: number): string => {
    // lines[0..2] are top border, title and separator; lines[3] is the viewer
    // header, so content row 0 is lines[4].
    const row = strip(lines[4 + bodyIndex] ?? "");
    // The right pane sits between the last separator and the closing frame
    // border; the left/right split row uses `┤`, other rows use `│`.
    const end = row.length - 1;
    const start = Math.max(row.lastIndexOf("\u2502", end - 1), row.lastIndexOf("\u2524", end - 1)) + 1;
    return row.slice(start, end).trimEnd();
  };

  it("opens a chafa image with pane-derived geometry and renders width-safe rows without a gutter", async () => {
    const harness = makeHarness(
      36,
      async (relPath, opts): Promise<ViewerFile> => chafaImage(relPath, opts?.image?.cols ?? 40, opts?.image?.rows ?? 24),
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120); // first frame: records lastViewerLayout
    harness.overlay.handleInput(KEYS.enter); // open sample.png
    await Promise.resolve();

    // At 120×36 the viewer pane is 82×24; the chafa preference (60 cols) caps
    // the geometry, the pane caps the rows.
    expect(harness.loads[0]?.relPath).toBe("sample.png");
    expect(harness.loads[0]?.opts?.image).toEqual({ cols: 60, rows: 24 });

    const lines = harness.overlay.render(120);
    // Content row 0 starts directly after the frame border: no gutter column.
    expect(bodyRow(lines, 0)).toBe("chafa-row-0");
    expect(bodyRow(lines, 23)).toBe("chafa-row-23");
    // Every row is exactly the frame width (content padded to rightW).
    for (let i = 0; i < lines.length; i++) {
      expect(visibleWidth(lines[i] ?? ""), `line ${i} overflows`).toBe(120);
    }
    expect(lines.join("\n")).toContain("chafa \u00b7 i card");
  });

  it("scrolls and clamps to the image height on j, G and Ctrl+d", async () => {
    const harness = makeHarness(
      36,
      async (relPath): Promise<ViewerFile> => chafaImage(relPath, 40, 40), // 40 rows, taller than the 24-row area
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    harness.overlay.handleInput("G"); // bottom: clamp at 40 - 24 = 16
    let lines = harness.overlay.render(120);
    expect(bodyRow(lines, 0)).toBe("chafa-row-16");
    expect(bodyRow(lines, 23)).toBe("chafa-row-39");

    harness.overlay.handleInput("j"); // stays clamped
    lines = harness.overlay.render(120);
    expect(bodyRow(lines, 23)).toBe("chafa-row-39");

    harness.overlay.handleInput(KEYS.ctrlD); // +12 → 28 → clamped back to 16
    lines = harness.overlay.render(120);
    expect(bodyRow(lines, 0)).toBe("chafa-row-16");

    harness.overlay.handleInput("g"); // top
    lines = harness.overlay.render(120);
    expect(bodyRow(lines, 0)).toBe("chafa-row-0");
  });

  it("fills blank rows below a short rendered image", async () => {
    const harness = makeHarness(
      36,
      async (relPath, opts): Promise<ViewerFile> => chafaImage(relPath, opts?.image?.cols ?? 40, 12),
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    const lines = harness.overlay.render(120);
    expect(bodyRow(lines, 11)).toBe("chafa-row-11"); // last image row
    expect(bodyRow(lines, 12)).toBe(""); // blank fill below the image
    expect(bodyRow(lines, 23)).toBe("");
  });

  it("toggles between render and card with i, and resets the toggle on file change", async () => {
    const harness = makeHarness(
      36,
      async (relPath, opts): Promise<ViewerFile> => chafaImage(relPath, opts?.image?.cols ?? 40, 40),
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["sample.png", "other.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter); // sample.png
    await Promise.resolve();

    let joined = harness.overlay.render(120).join("\n");
    expect(joined).toContain("chafa-row-0");
    expect(joined).toContain("chafa \u00b7 i card");

    // i → metadata card (header badge flips, no reload).
    harness.overlay.handleInput("i");
    joined = harness.overlay.render(120).join("\n");
    expect(joined).not.toContain("chafa-row-");
    expect(joined).toContain("i render");
    expect(harness.loads).toHaveLength(1);

    // i → back to the render.
    harness.overlay.handleInput("i");
    joined = harness.overlay.render(120).join("\n");
    expect(joined).toContain("chafa-row-0");
    expect(joined).toContain("chafa \u00b7 i card");
    expect(harness.loads).toHaveLength(1);

    // File change while the card is showing resets imageAsCard (D8): the new
    // file opens as a render, not as a card.
    harness.overlay.handleInput("i"); // sample.png → card
    harness.overlay.handleInput(KEYS.tab); // viewer -> files
    harness.overlay.handleInput("j"); // sample.png -> other.png
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    joined = harness.overlay.render(120).join("\n");
    expect(joined).toContain("chafa-row-0");
    expect(harness.loads).toHaveLength(2);
  });

  it("re-requests the render when i is pressed on a card under active support", async () => {
    const loads: Array<{ relPath: string; opts?: LoadFileOptions }> = [];
    let serveCard = true;
    const harness = makeHarness(
      36,
      async (relPath, opts): Promise<ViewerFile> => {
        loads.push({ relPath, opts });
        if (serveCard) return metadataImage(relPath);
        return chafaImage(relPath, opts?.image?.cols ?? 40, opts?.image?.rows ?? 40);
      },
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter); // loader serves a card
    await Promise.resolve();
    expect(loads).toHaveLength(1);
    expect(harness.overlay.render(120).join("\n")).toContain("i render");

    serveCard = false;
    harness.overlay.handleInput("i"); // card + active support → re-request the render
    await Promise.resolve();
    expect(loads).toHaveLength(2);
    expect(loads[1]?.opts?.image).toEqual({ cols: 60, rows: 24 });
    expect(harness.overlay.render(120).join("\n")).toContain("chafa-row-0");
  });

  it("makes w, h, l, arrows, n and N inert on a rendered image and explains / is unavailable", async () => {
    const harness = makeHarness(
      36,
      async (relPath): Promise<ViewerFile> => chafaImage(relPath, 40, 40),
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await vi.waitFor(() => {
      expect(harness.overlay.render(120).join("\n")).toContain("chafa-row-0");
    });

    const frameBefore = harness.overlay.render(120);

    // Inert keys never touch(): the render cache survives (Issue #053 pattern).
    for (const key of ["w", "h", "l", KEYS.left, KEYS.right, "n", "N"]) {
      harness.overlay.handleInput(key);
    }
    expect(harness.overlay.render(120)).toBe(frameBefore);

    const rendered = harness.overlay.render(120).join("\n");
    expect(rendered).not.toContain("· wrap");
    expect(rendered).not.toContain("col ");

    // Scroll keys still work and update the viewport.
    harness.overlay.handleInput("G");
    expect(harness.overlay.render(120).join("\n")).toContain("chafa-row-39");

    // / explains search is unavailable and does not enter search mode.
    harness.overlay.handleInput("/");
    expect(harness.overlay.render(120).join("\n")).toContain("search is not available for rendered images");
    harness.overlay.handleInput("q");
    expect(harness.state.closed).toBe(1);
  });

  it("upgrades a deferred support: card first, then re-renders with geometry after the debounce", async () => {
    vi.useFakeTimers();
    try {
      const loads: Array<{ relPath: string; opts?: LoadFileOptions }> = [];
      const harness = makeHarness(
        36,
        async (relPath, opts): Promise<ViewerFile> => {
          loads.push({ relPath, opts });
          return opts?.image ? chafaImage(relPath, opts.image.cols, opts.image.rows) : metadataImage(relPath);
        },
      );
      withTree(harness, ["sample.png"]);
      harness.overlay.render(120); // layout recorded before the open
      harness.overlay.handleInput(KEYS.enter); // support is deferred → metadata card
      await Promise.resolve();
      expect(loads[0]?.opts).toBeUndefined();
      expect(harness.overlay.render(120).join("\n")).toContain("Image");

      harness.overlay.setImageSupport(activeSupport());
      expect(loads).toHaveLength(1); // debounced: no immediate re-request
      vi.advanceTimersByTime(IMAGE_RESIZE_DEBOUNCE_MS);
      await Promise.resolve();
      expect(loads).toHaveLength(2);
      expect(loads[1]?.opts?.image).toEqual({ cols: 60, rows: 24 });
      expect(harness.overlay.render(120).join("\n")).toContain("chafa-row-23");
      harness.overlay.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders at a new pane geometry after the debounce and cancels the reflow on dispose", async () => {
    vi.useFakeTimers();
    try {
      const loads: Array<{ relPath: string; opts?: LoadFileOptions }> = [];
      const support = activeSupport({
        config: { ...DEFAULT_PI_CHAFA_SUBSET, cellWidth: 100, maxRows: 50 },
      });
      const harness = makeHarness(
        36,
        async (relPath, opts): Promise<ViewerFile> => {
          loads.push({ relPath, opts });
          return chafaImage(relPath, opts?.image?.cols ?? 40, opts?.image?.rows ?? 24);
        },
        undefined,
        undefined,
        support,
      );
      withTree(harness, ["sample.png"]);
      harness.overlay.render(120);
      harness.overlay.handleInput(KEYS.enter);
      await Promise.resolve();
      // Width 120 → rightW 82; preferred 100 → geometry {82, 24}.
      expect(loads[0]?.opts?.image).toEqual({ cols: 82, rows: 24 });

      // "Resize": a render at another width is a fresh pass (cache miss).
      harness.overlay.render(100);
      expect(loads).toHaveLength(1); // debounce: nothing yet
      vi.advanceTimersByTime(IMAGE_RESIZE_DEBOUNCE_MS);
      await Promise.resolve();
      expect(loads).toHaveLength(2);
      expect(loads[1]?.opts?.image).toEqual({ cols: 68, rows: 24 });

      // Stable at the new geometry: no further re-request.
      harness.overlay.render(100);
      vi.advanceTimersByTime(IMAGE_RESIZE_DEBOUNCE_MS);
      await Promise.resolve();
      expect(loads).toHaveLength(2);

      // A pending reflow is cancelled by dispose().
      harness.overlay.render(80); // rightW 53 → schedules a reflow
      expect(loads).toHaveLength(2);
      harness.overlay.dispose();
      vi.advanceTimersByTime(IMAGE_RESIZE_DEBOUNCE_MS * 2);
      await Promise.resolve();
      expect(loads).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the header badge only when support is active", async () => {
    const harness = makeHarness(36, async (relPath, opts): Promise<ViewerFile> => chafaImage(relPath, opts?.image?.cols ?? 40, 12));
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    const joined = harness.overlay.render(120).join("\n");
    expect(joined).not.toContain("i render");
    expect(joined).not.toContain("i card");
  });

  it("guides the metadata card per support state (§9)", async () => {
    const cases: Array<{ name: string; support: ImageSupport; expects: string[]; absent: string[] }> = [
      {
        name: "active",
        support: activeSupport(),
        expects: [],
        absent: ["optional:", "chafa failed", "pane too small", "install chafa", "terminal.showImages"],
      },
      {
        name: "mode off",
        support: activeSupport({ mode: "off", tier: "none" }),
        expects: ["optional: enable images.mode=chafa, native, or auto to render images here"],
        absent: [],
      },
      {
        name: "pi-chafa absent",
        support: activeSupport({ piChafa: { present: false, via: "none" }, tier: "none" }),
        expects: ["optional: install chafa + pi-chafa (pi install npm:pi-chafa)"],
        absent: [],
      },
      {
        name: "chafa missing",
        support: activeSupport({ chafa: { state: "missing", detail: "not found" }, tier: "none" }),
        expects: ["chafa not found - install it, or set CHAFA_BIN / binaryPath"],
        absent: [],
      },
      {
        name: "chafa too old",
        support: activeSupport({ chafa: { state: "too-old", detail: "old" }, tier: "none" }),
        expects: ["chafa is older than 1.10 - upgrade to render images"],
        absent: [],
      },
      {
        name: "chafa probe error",
        support: activeSupport({ chafa: { state: "error", detail: "bogus" }, tier: "none" }),
        expects: ["chafa probe failed: bogus"],
        absent: [],
      },
      {
        name: "still resolving",
        support: activeSupport({ chafa: { state: "deferred" }, tier: "none" }),
        expects: ["checking image support\u2026"],
        absent: [],
      },
      {
        name: "host images disabled",
        support: activeSupport({ hostShowImages: false, tier: "none" }),
        expects: ["terminal.showImages is false - image rendering disabled"],
        absent: [],
      },
    ];

    for (const c of cases) {
      const harness = makeHarness(36, async (relPath) => metadataImage(relPath), undefined, undefined, c.support);
      withTree(harness, ["sample.png"]);
      harness.overlay.render(120);
      harness.overlay.handleInput(KEYS.enter);
      await Promise.resolve();
      const joined = harness.overlay.render(120).join("\n");
      for (const expected of c.expects) {
        expect(joined, `${c.name}: missing hint "${expected}"`).toContain(expected);
      }
      for (const absent of c.absent) {
        expect(joined, `${c.name}: unexpected hint "${absent}"`).not.toContain(absent);
      }
      harness.overlay.dispose();
    }
  });

  it("shows the chafa failure reason on the fallback card", async () => {
    const harness = makeHarness(
      36,
      async (relPath): Promise<ViewerFile> => ({ ...metadataImage(relPath), imageError: "render aborted" }),
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    expect(harness.overlay.render(120).join("\n")).toContain("chafa failed: render aborted");
    harness.overlay.dispose();
  });

  it("hints pane-too-small when the pane rejects the render geometry", () => {
    const file = metadataImage("sample.png");
    const support = activeSupport();
    // The caller resolves the pane snapshot through resolveChafaGeometry (§7.2)
    // and passes null when the pane rejects the render; imageCardHints ladders
    // from the resolved geometry.
    const geometryFor = (pane: { cols: number; rows: number }): { cols: number; rows: number } | null => {
      const resolved = resolveChafaGeometry({
        paneCols: pane.cols,
        paneRows: pane.rows,
        preferredCols: support.config.cellWidth,
        maxRows: support.config.maxRows,
      });
      return resolved.ok ? { cols: resolved.cols, rows: resolved.rows } : null;
    };
    // No pane snapshot (nothing laid out): geometry unknown → pane hint.
    expect(imageCardHints(file, support, null)).toEqual(["pane too small for a rendered image"]);
    // A pane below IMAGE_CELLS_MIN resolves to null and also rejects (§7.2).
    expect(imageCardHints(file, support, geometryFor({ cols: 10, rows: 24 }))).toEqual([
      "pane too small for a rendered image",
    ]);
    // An acceptable pane geometry renders the image with no hint.
    expect(imageCardHints(file, support, geometryFor({ cols: 60, rows: 24 }))).toEqual([]);
  });

  it("renders the metadata card, never the text gutter, for a chafa image with no rendered lines (#103)", async () => {
    const harness = makeHarness(
      36,
      async (relPath): Promise<ViewerFile> => ({ ...chafaImage(relPath), imageLines: [] }),
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["empty.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    const lines = harness.overlay.render(120);
    const joined = lines.join("\n");
    expect(joined).toContain("Image"); // card title — the pre-fix text path rendered blank rows
    expect(joined).not.toContain("chafa-row-");
    // No text-like gutter or line numbers in any frame row.
    for (const line of lines) {
      expect(line).not.toMatch(/^\s*\d+ \u2502/);
    }
    harness.overlay.dispose();
  });
});

// ── Native image rendering (§12.4) ──

describe("native image rendering", () => {
  const KITTY_ROW = "\x1b_Ga=T,f=100,q=2,C=1,c=20,r=3,i=77;AAAA\x1b\\";

  /** Native ViewerFile whose recorded geometry is the REQUEST (viewer.ts). */
  function nativeImage(relPath: string, cols = 20, rows = 3): ViewerFile {
    return {
      kind: "image",
      relPath,
      imageTier: "native",
      imageCols: cols,
      imageRows: rows,
      imageLines: [KITTY_ROW, "", ""],
      lines: [],
      sizeBytes: 1024,
      message: "1.0 KB \u00b7 32x32",
    };
  }

  function nativeSupport(overrides: Partial<ImageSupport> = {}): ImageSupport {
    return activeSupport({ mode: "native", nativeProtocol: "kitty", tier: "native", hostImageWidthCells: 100, ...overrides });
  }

  /** Loader that mirrors viewer.ts: native rows, request geometry recorded. */
  const nativeLoader = async (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> =>
    opts?.image ? nativeImage(relPath, opts.image.cols, opts.image.rows) : metadataImage(relPath);

  it("opens with min(pane, hostImageWidthCells) geometry and renders the sequence", async () => {
    const harness = makeHarness(36, nativeLoader, undefined, undefined, nativeSupport({ hostImageWidthCells: 30 }));
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120); // records the pane snapshot (rightW = 82)
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    expect(harness.loads[0]?.opts?.image).toEqual({ cols: 30, rows: 24 });
    const joined = harness.overlay.render(120).join("\n");
    expect(joined).toContain(KITTY_ROW);
    expect(joined).toContain("kitty \u00b7 i card");
  });

  it("honors the pane when it is narrower than the host preference", async () => {
    const harness = makeHarness(36, nativeLoader, undefined, undefined, nativeSupport());
    withTree(harness, ["sample.png"]);
    harness.overlay.render(80); // rightW = 53 < hostImageWidthCells 100
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    expect(harness.loads[0]?.opts?.image).toEqual({ cols: 53, rows: 24 });
  });

  it("hides a native render with i without reloading, then re-renders it with a fresh id (#112)", async () => {
    // A fresh kitty id per render, mirroring allocateImageId().
    let renders = 0;
    const freshIdLoader = (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> => {
      renders += 1;
      if (!opts?.image) return Promise.resolve(metadataImage(relPath));
      return Promise.resolve({
        ...nativeImage(relPath, opts.image.cols, opts.image.rows),
        imageLines: [`\x1b_Ga=T,f=100,q=2,C=1,c=20,r=3,i=${100 + renders};AAAA\x1b\\`, "", ""],
      });
    };
    const harness = makeHarness(36, freshIdLoader, undefined, undefined, nativeSupport());
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    expect(harness.overlay.render(120).join("\n")).toContain("i=101");

    // Hide: a pure state flip — the stored rows are only hidden, no reload.
    harness.overlay.handleInput("i");
    let joined = harness.overlay.render(120).join("\n");
    expect(joined).not.toContain("i=101");
    expect(joined).toContain("i render");
    expect(harness.loads).toHaveLength(1);

    // Show again: re-rendered with a NEW id. Re-emitting i=101 would make
    // pi-tui place the image without re-transmitting it, leaving the pane
    // blank because the card frame dropped the placement.
    harness.overlay.handleInput("i");
    await Promise.resolve();
    joined = harness.overlay.render(120).join("\n");
    expect(joined).toContain("i=102");
    expect(joined).not.toContain("i=101");
    expect(joined).toContain("kitty \u00b7 i card");
    expect(harness.loads).toHaveLength(2);
  });

  it("leaves a chafa roundtrip reload-free (plain text rows re-emit safely)", async () => {
    const harness = makeHarness(
      36,
      async (relPath, opts): Promise<ViewerFile> => chafaImage(relPath, opts?.image?.cols ?? 40, 40),
      undefined,
      undefined,
      activeSupport(),
    );
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();
    harness.overlay.handleInput("i");
    harness.overlay.handleInput("i");
    const joined = harness.overlay.render(120).join("\n");
    expect(joined).toContain("chafa-row-0");
    expect(harness.loads).toHaveLength(1);
  });

  it("pins scroll: j/k/g/G/Ctrl+d/Ctrl+u leave a native frame unchanged", async () => {
    const harness = makeHarness(36, nativeLoader, undefined, undefined, nativeSupport());
    withTree(harness, ["sample.png"]);
    harness.overlay.render(120);
    harness.overlay.handleInput(KEYS.enter);
    await Promise.resolve();

    const before = harness.overlay.render(120).join("\n");
    for (const key of ["j", "k", "g", "G", KEYS.ctrlD, KEYS.ctrlU]) {
      harness.overlay.handleInput(key);
    }
    const after = harness.overlay.render(120).join("\n");
    expect(after).toBe(before);
    expect(after).toContain(KITTY_ROW);
  });

  it("upgrades a deferred snapshot: card first, then native after the debounce", async () => {
    vi.useFakeTimers();
    try {
      const loads: Array<{ relPath: string; opts?: LoadFileOptions }> = [];
      const harness = makeHarness(36, async (relPath, opts): Promise<ViewerFile> => {
        loads.push({ relPath, opts });
        return opts?.image ? nativeImage(relPath, opts.image.cols, opts.image.rows) : metadataImage(relPath);
      });
      withTree(harness, ["sample.png"]);
      harness.overlay.render(120);
      harness.overlay.handleInput(KEYS.enter); // deferred support → metadata card
      await Promise.resolve();
      expect(loads[0]?.opts).toBeUndefined();
      expect(harness.overlay.render(120).join("\n")).toContain("Image");

      harness.overlay.setImageSupport(nativeSupport());
      expect(loads).toHaveLength(1); // debounced
      vi.advanceTimersByTime(IMAGE_RESIZE_DEBOUNCE_MS);
      await Promise.resolve();
      expect(loads).toHaveLength(2);
      expect(loads[1]?.opts?.image).toEqual({ cols: 82, rows: 24 });
      expect(harness.overlay.render(120).join("\n")).toContain(KITTY_ROW);
      harness.overlay.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders once at a new pane geometry and then stays stable (no reflow loop)", async () => {
    vi.useFakeTimers();
    try {
      const loads: Array<{ relPath: string; opts?: LoadFileOptions }> = [];
      const harness = makeHarness(36, async (relPath, opts): Promise<ViewerFile> => {
        loads.push({ relPath, opts });
        return opts?.image ? nativeImage(relPath, opts.image.cols, opts.image.rows) : metadataImage(relPath);
      }, undefined, undefined, nativeSupport());
      withTree(harness, ["sample.png"]);
      harness.overlay.render(120); // rightW 82
      harness.overlay.handleInput(KEYS.enter);
      await Promise.resolve();
      expect(loads[0]?.opts?.image).toEqual({ cols: 82, rows: 24 });

      // "Resize" to 100 wide: one debounced re-render at the new geometry.
      harness.overlay.render(100); // rightW 68
      expect(loads).toHaveLength(1);
      vi.advanceTimersByTime(IMAGE_RESIZE_DEBOUNCE_MS);
      await Promise.resolve();
      expect(loads).toHaveLength(2);
      expect(loads[1]?.opts?.image).toEqual({ cols: 68, rows: 24 });

      // Stable at the new geometry: the recorded request matches, so no loop.
      harness.overlay.render(100);
      vi.advanceTimersByTime(IMAGE_RESIZE_DEBOUNCE_MS * 3);
      await Promise.resolve();
      expect(loads).toHaveLength(2);
      harness.overlay.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
