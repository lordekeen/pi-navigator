/**
 * tree.ts suites: directory-map assembly, ordering, depth caps, ignore rules,
 * symlink guards, expansion preservation, filtering and the navigation
 * helpers (plan section 11, second and third bullets). Filesystem-backed
 * cases run against real tmpdir fixtures.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_TREE_DEPTH } from "../constants";
import {
  applyGitCodes,
  buildTree,
  collectExpanded,
  collectFsEntries,
  collectFsProbe,
  entriesFromPaths,
  expandAncestors,
  filterRows,
  findNode,
  flattenVisible,
  hasChanges,
  moveCursor,
  pageJump,
  reapplyExpansion,
  walkTree,
} from "../tree";

const CWD = "/work";

function entries(relPaths: string[]): ReturnType<typeof entriesFromPaths> {
  return entriesFromPaths(relPaths);
}

// ── buildTree ──

describe("buildTree", () => {
  it("orders directories first, then files, by locale collation", () => {
    const tree = buildTree(
      CWD,
      [
        { relPath: "z-file.txt", isDir: false, symlink: false },
        { relPath: "aaa", isDir: true, symlink: false },
        { relPath: "mid", isDir: true, symlink: false },
        { relPath: "a-file.txt", isDir: false, symlink: false },
      ],
      new Map(),
    );
    expect(tree.children.map((n) => n.name)).toEqual(["aaa", "mid", "a-file.txt", "z-file.txt"]);
  });

  it("sorts files with numeric suffixes naturally (Issue #044)", () => {
    const tree = buildTree(
      CWD,
      [
        { relPath: "file10.ts", isDir: false, symlink: false },
        { relPath: "file2.ts", isDir: false, symlink: false },
        { relPath: "file1.ts", isDir: false, symlink: false },
      ],
      new Map(),
    );
    expect(tree.children.map((n) => n.name)).toEqual(["file1.ts", "file2.ts", "file10.ts"]);
  });

  it("creates intermediate directories on demand and keeps declared-empty ones", () => {
    const tree = buildTree(
      CWD,
      [
        { relPath: "src/main.ts", isDir: false, symlink: false },
        { relPath: "src/utils.ts", isDir: false, symlink: false },
        { relPath: "emptydir", isDir: true, symlink: false },
      ],
      new Map(),
    );
    const src = tree.children.find((n) => n.name === "src");
    expect(src?.isDir).toBe(true);
    expect(src?.children.map((n) => n.name)).toEqual(["main.ts", "utils.ts"]);
    const empty = tree.children.find((n) => n.name === "emptydir");
    expect(empty?.children).toEqual([]);
  });

  it("normalizes backslashes and leading ./", () => {
    const tree = buildTree(CWD, entries(["a\\b.txt", "./c.txt"]), new Map());
    const a = tree.children.find((n) => n.name === "a");
    expect(a?.children[0]?.relPath).toBe("a/b.txt");
    expect(tree.children.find((n) => n.name === "c.txt")?.relPath).toBe("c.txt");
  });

  it("caps path depth at MAX_TREE_DEPTH", () => {
    // Node depth (root = -1) may reach MAX_TREE_DEPTH: 6 dirs + a file (7
    // segments, file at depth 6) is accepted; one deeper level is not.
    const atCap = Array.from({ length: MAX_TREE_DEPTH }, (_, i) => `d${i}`).join("/") + "/f.txt";
    const over = Array.from({ length: MAX_TREE_DEPTH + 1 }, (_, i) => `d${i}`).join("/") + "/f.txt";
    const tree = buildTree(CWD, entries([atCap, over]), new Map());
    const found: string[] = [];
    walkTree(tree, (n) => {
      found.push(n.relPath);
    });
    expect(found).toContain(atCap);
    expect(found).not.toContain(over);
  });

  it("keeps directories when a file claims the same path, and stamps git codes", () => {
    const tree = buildTree(
      CWD,
      [
        { relPath: "dup", isDir: true, symlink: false },
        { relPath: "dup", isDir: false, symlink: false },
        { relPath: "src/main.ts", isDir: false, symlink: false },
      ],
      new Map([["src/main.ts", "M"]]),
    );
    const dup = tree.children.find((n) => n.name === "dup");
    expect(dup?.isDir).toBe(true);
    expect(dup?.children).toEqual([]);
    expect(findNode(tree, "src/main.ts")?.gitCode).toBe("M");
  });

  it("marks dot entries hidden", () => {
    const tree = buildTree(CWD, entries([".env", ".github/workflows.yml", "visible.txt"]), new Map());
    expect(findNode(tree, ".env")?.hidden).toBe(true);
    const github = findNode(tree, ".github");
    expect(github?.hidden).toBe(true);
    expect(findNode(tree, "visible.txt")?.hidden).toBe(false);
  });

  it("expands only the top level by default", () => {
    const tree = buildTree(CWD, entries(["src/main.ts"]), new Map());
    const src = findNode(tree, "src");
    expect(src?.expanded).toBe(true); // depth 0
    expect(findNode(tree, "src/main.ts")).not.toBeNull();
  });
});

describe("applyGitCodes", () => {
  it("stamps and clears file codes without rebuilding", () => {
    const tree = buildTree(CWD, entries(["a.ts", "b.ts"]), new Map([["a.ts", "M"]]));
    applyGitCodes(tree, new Map([["b.ts", "??"]]));
    expect(findNode(tree, "a.ts")?.gitCode).toBeUndefined();
    expect(findNode(tree, "b.ts")?.gitCode).toBe("??");
    // Directories keep no codes even when present in the map.
    applyGitCodes(tree, new Map([["a.ts", "A"]]));
    expect(findNode(tree, "a.ts")?.gitCode).toBe("A");
  });
});

// ── Filesystem walk ──

describe("collectFsEntries", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-nav-fs-"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "deep1/deep2/deep3/deep4/deep5/deep6/deep7"), { recursive: true });
    await writeFile(join(dir, "readme.md"), "hi\n");
    await writeFile(join(dir, "src/main.ts"), "code\n");
    await writeFile(join(dir, "deep1/deep2/deep3/deep4/deep5/deep6/deep7/leaf.txt"), "deep\n");
    await writeFile(join(dir, "src/deep2.txt"), "x\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("walks the tree with posix rel paths", async () => {
    const out = await collectFsEntries(dir);
    const rels = out.map((e) => e.relPath).sort();
    expect(rels).toEqual([
      "deep1",
      "deep1/deep2",
      "deep1/deep2/deep3",
      "deep1/deep2/deep3/deep4",
      "deep1/deep2/deep3/deep4/deep5",
      "deep1/deep2/deep3/deep4/deep5/deep6",
      "deep1/deep2/deep3/deep4/deep5/deep6/deep7",  // depth cap: recursed into, children not listed

      "readme.md",
      "src",
      "src/deep2.txt",
      "src/main.ts",
    ]);
    expect(out.find((e) => e.relPath === "src")?.isDir).toBe(true);
  });

  it("skips IGNORED_NAMES directories entirely", async () => {
    await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules/pkg/index.js"), "x\n");
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git/config"), "x\n");
    await mkdir(join(dir, "dist"));
    await writeFile(join(dir, "dist/bundle.js"), "x\n");

    const out = await collectFsEntries(dir);
    const rels = out.map((e) => e.relPath);
    expect(rels).not.toContain("node_modules");
    expect(rels).not.toContain("node_modules/pkg/index.js");
    expect(rels).not.toContain(".git");
    expect(rels).not.toContain("dist");
    expect(rels).toContain("src/main.ts");
  });

  it("includes dot entries (flagged at render time, not skipped here)", async () => {
    await writeFile(join(dir, ".env"), "x\n");
    await mkdir(join(dir, ".config"));
    await writeFile(join(dir, ".config/settings.json"), "{}");

    const out = await collectFsEntries(dir);
    const rels = out.map((e) => e.relPath);
    expect(rels).toContain(".env");
    expect(rels).toContain(".config");
    expect(rels).toContain(".config/settings.json");
  });

  it("keeps a symlink cycle as a leaf entry without recursing", async () => {
    await symlink(dir, join(dir, "loop"));
    const out = await collectFsEntries(dir);
    const loop = out.find((e) => e.relPath === "loop");
    expect(loop?.symlink).toBe(true);
    // Only the link entry itself, no duplicated children under it.
    const rels = out.map((e) => e.relPath);
    expect(rels.filter((r) => r.startsWith("loop/"))).toEqual([]);
  });

  it("keeps broken symlinks as leaves", async () => {
    await symlink(join(dir, "does-not-exist"), join(dir, "broken"));
    const out = await collectFsEntries(dir);
    expect(out.find((e) => e.relPath === "broken")).toMatchObject({ symlink: true, isDir: false });
  });

  it("treats a symlink to a directory as a directory entry (ancestor-guarded)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pi-nav-out-"));
    try {
      await symlink(outside, join(dir, "external"));
      await writeFile(join(outside, "x.txt"), "x\n");
      const out = await collectFsEntries(dir);
      const external = out.find((e) => e.relPath === "external");
      expect(external?.isDir).toBe(true);
      expect(out.find((e) => e.relPath === "external/x.txt")).toBeDefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("collectFsProbe", () => {
  it("changes when an expanded directory's mtime changes and not otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-nav-probe-"));
    try {
      await mkdir(join(dir, "src"));
      const before = await collectFsProbe(dir, new Set(["src"]));
      expect(before).toContain("src:");
      expect(before).toContain(":");

      await new Promise((resolve) => setTimeout(resolve, 20));
      const unchanged = await collectFsProbe(dir, new Set(["src"]));
      expect(unchanged).toBe(before);

      await writeFile(join(dir, "src/added.txt"), "x\n");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const after = await collectFsProbe(dir, new Set(["src"]));
      expect(after).not.toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks missing directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-nav-probe-missing-"));
    try {
      expect(await collectFsProbe(dir, new Set(["ghost"]))).toContain("ghost:missing");
      expect(await collectFsProbe(dir, new Set())).not.toContain("missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Expansion preservation ──

describe("reapplyExpansion", () => {
  it("expands the top level on first build and honors the remembered set after", () => {
    const build = () => buildTree(CWD, entries(["src/util.ts"]), new Map());

    const first = build();
    reapplyExpansion(first, collectExpanded(null), 0);
    expect(findNode(first, "src")?.expanded).toBe(true);

    // User collapses the top-level directory.
    const src = findNode(first, "src");
    if (src) src.expanded = false;
    const remembered = collectExpanded(first);

    const second = build();
    reapplyExpansion(second, remembered, -1);
    expect(findNode(second, "src")?.expanded).toBe(false);
  });

  it("keeps deeper expansions across rebuilds", () => {
    const tree = buildTree(CWD, entries(["a/b/c.ts"]), new Map());
    reapplyExpansion(tree, new Set(), 0);
    const b = findNode(tree, "a/b");
    if (b) b.expanded = true;
    const remembered = collectExpanded(tree);

    const rebuilt = buildTree(CWD, entries(["a/b/c.ts"]), new Map());
    reapplyExpansion(rebuilt, remembered, -1);
    expect(findNode(rebuilt, "a")?.expanded).toBe(true); // depth 0 via remembered? No:
    // a was never collapsed here: it was expanded by defaultDepth 0 on first
    // build and IS in the remembered set (collectExpanded includes it).
    expect(remembered.has("a")).toBe(true);
    expect(findNode(rebuilt, "a/b")?.expanded).toBe(true);
  });
});

// ── Visibility and filtering ──

describe("flattenVisible", () => {
  it("skips hidden entries unless showHidden, and walks expanded dirs", () => {
    const tree = buildTree(CWD, entries([".env", "src/main.ts"]), new Map());
    reapplyExpansion(tree, new Set(["src"]), 0);

    expect(flattenVisible(tree, false).map((r) => r.node.relPath)).toEqual(["src", "src/main.ts"]);
    // Directories sort before files, so .env trails the src subtree.
    expect(flattenVisible(tree, true).map((r) => r.node.relPath)).toEqual(["src", "src/main.ts", ".env"]);

    const src = findNode(tree, "src");
    if (src) src.expanded = false;
    expect(flattenVisible(tree, true).map((r) => r.node.relPath)).toEqual(["src", ".env"]);
  });
});

describe("filterRows", () => {
  it("ranks name matches above path-only matches and keeps the prefix", () => {
    const tree = buildTree(CWD, entries(["src/util.ts", "src.js"]), new Map());
    const rows = filterRows(tree, "src", true);
    // src.js matches by name (nameIndex 0) and ranks above the path match.
    expect(rows.map((r) => r.node.relPath)).toEqual(["src.js", "src/util.ts"]);
    expect(rows[0]?.nameIndex).toBe(0);
    expect(rows[1]?.nameIndex).toBe(-1);
    expect(rows[1]?.prefix).toBe("src/");
  });

  it("matches case-insensitively", () => {
    const tree = buildTree(CWD, entries(["README.md"]), new Map());
    expect(filterRows(tree, "readme", true).map((r) => r.node.relPath)).toEqual(["README.md"]);
  });

  it("returns nothing for an empty query and respects showHidden", () => {
    const tree = buildTree(CWD, entries([".env", "app.ts"]), new Map());
    expect(filterRows(tree, "", true)).toEqual([]);
    expect(filterRows(tree, "env", false)).toEqual([]);
    expect(filterRows(tree, "env", true).map((r) => r.node.relPath)).toEqual([".env"]);
  });
});

describe("navigation helpers", () => {
  it("clamps moveCursor into range", () => {
    expect(moveCursor(5, 0, -1)).toBe(0);
    expect(moveCursor(5, 4, 1)).toBe(4);
    expect(moveCursor(0, 0, 1)).toBe(0);
    expect(moveCursor(5, 2, 2)).toBe(4);
  });

  it("pageJump moves half the pane height", () => {
    expect(pageJump(10, 0, 1, 8)).toBe(4); // ceil(8/2)
    expect(pageJump(10, 9, -1, 8)).toBe(5);
    expect(pageJump(10, 0, -1, 8)).toBe(0);
  });

  it("expandAncestors opens the chain up to the root", () => {
    const tree = buildTree(CWD, entries(["a/b/c.ts"]), new Map());
    reapplyExpansion(tree, new Set(), 0);
    const c = findNode(tree, "a/b/c.ts");
    // Collapse everything first.
    walkTree(tree, (n) => {
      if (n.isDir) n.expanded = false;
    });
    if (c) expandAncestors(c);
    expect(findNode(tree, "a")?.expanded).toBe(true);
    expect(findNode(tree, "a/b")?.expanded).toBe(true);
  });

  it("findNode resolves paths and the root", () => {
    const tree = buildTree(CWD, entries(["a/b.ts"]), new Map());
    expect(findNode(tree, "")?.name).toBe(".");
    expect(findNode(tree, "a/b.ts")?.name).toBe("b.ts");
    expect(findNode(tree, "nope")).toBeNull();
  });

  it("hasChanges sees descendant codes", () => {
    const tree = buildTree(CWD, entries(["a/b.ts"]), new Map([["a/b.ts", "M"]]));
    expect(hasChanges(tree)).toBe(true);
    if (tree.children[0]) {
      expect(hasChanges(tree.children[0])).toBe(true);
    }
    expect(hasChanges(buildTree(CWD, entries(["a/b.ts"]), new Map()))).toBe(false);
  });
});

describe("walkTree", () => {
  it("visits siblings in forward order (Issue #046)", () => {
    const tree = buildTree(
      CWD,
      [
        { relPath: "a.ts", isDir: false, symlink: false },
        { relPath: "b.ts", isDir: false, symlink: false },
        { relPath: "c.ts", isDir: false, symlink: false },
      ],
      new Map(),
    );
    const visited: string[] = [];
    walkTree(tree, (n) => {
      visited.push(n.name);
    });
    expect(visited).toEqual([".", "a.ts", "b.ts", "c.ts"]);
  });
});