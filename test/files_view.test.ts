/**
 * files_view.ts suites (Issue #064 view-model extraction): the row model
 * (buildFilesRows), the header and one file row. FileNode fixtures are
 * hand-built (no filesystem); the identity theme passes text through, so
 * width assertions use the real pi-tui visibleWidth, and a tone-tagging
 * theme verifies which theme channel styled a row.
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import { buildFileRow, buildFilesHeader, buildFilesRows, filesEmptyRow, type FilesViewContext } from "../files_view";
import { mapExtensionToIcon } from "../icons";
import { makeNavigatorTheme } from "../theme";
import type { FileNode } from "../types";

const identityTheme = makeNavigatorTheme({
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
} as never);

const toneTheme = makeNavigatorTheme({
  fg: (c: string, t: string) => `${c}:${t}`,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
} as never);

function node(partial: Partial<FileNode> = {}): FileNode {
  return {
    name: "",
    lowerName: "",
    path: "",
    relPath: "",
    lowerRelPath: "",
    isDir: false,
    isSymlink: false,
    hidden: false,
    depth: 0,
    expanded: false,
    subtreeChanged: false,
    children: [],
    ...partial,
  };
}

const utilNode = node({
  name: "util.ts",
  lowerName: "util.ts",
  path: "/work/src/util.ts",
  relPath: "src/util.ts",
  lowerRelPath: "src/util.ts",
  depth: 1,
  gitCode: "M",
});
const helperNode = node({
  name: "helper.ts",
  lowerName: "helper.ts",
  path: "/work/src/helper.ts",
  relPath: "src/helper.ts",
  lowerRelPath: "src/helper.ts",
  depth: 1,
});
const readmeNode = node({
  name: "README.md",
  lowerName: "readme.md",
  path: "/work/README.md",
  relPath: "README.md",
  lowerRelPath: "readme.md",
  depth: 0,
});
const envNode = node({
  name: ".env",
  lowerName: ".env",
  path: "/work/.env",
  relPath: ".env",
  lowerRelPath: ".env",
  hidden: true,
  depth: 0,
});
const srcDir = node({
  name: "src",
  lowerName: "src",
  path: "/work/src",
  relPath: "src",
  lowerRelPath: "src",
  isDir: true,
  expanded: true,
  subtreeChanged: true,
  children: [utilNode, helperNode],
});
const docsDir = node({
  name: "docs",
  lowerName: "docs",
  path: "/work/docs",
  relPath: "docs",
  lowerRelPath: "docs",
  isDir: true,
  expanded: true,
  children: [],
});
const root = node({
  name: "work",
  lowerName: "work",
  path: "/work",
  relPath: "",
  lowerRelPath: "",
  isDir: true,
  expanded: true,
  children: [srcDir, readmeNode, envNode],
});

function ctx(partial: Partial<FilesViewContext> = {}): FilesViewContext {
  return {
    theme: identityTheme,
    enableIcons: false,
    filterQuery: "",
    openRelPath: null,
    filesCursor: 0,
    focus: "files",
    ...partial,
  };
}

describe("filesEmptyRow (Issue #129 empty state)", () => {
  it("names the filter query as the reason when one is active", () => {
    expect(filesEmptyRow(30, ctx({ filterQuery: "zzz" }))).toContain('no matches for "zzz"');
  });

  it("says 'no files' for a tree that is genuinely empty", () => {
    expect(filesEmptyRow(30, ctx())).toContain("no files");
  });

  it("pads to the pane width and cuts a long query cleanly (Issue #010)", () => {
    const row = filesEmptyRow(20, ctx({ filterQuery: "a".repeat(60) }));
    expect(visibleWidth(row)).toBe(20);
    expect(row).not.toMatch(/\x1b\[0m\.\.\./);
  });
});

describe("buildFilesRows", () => {
  it("returns no rows for a null root", () => {
    expect(buildFilesRows(null, "", false)).toEqual([]);
  });

  it("flattens visible children in order and skips hidden nodes by default", () => {
    const rows = buildFilesRows(root, "", false);
    expect(rows.map((r) => r.node.name)).toEqual(["src", "util.ts", "helper.ts", "README.md"]);
    expect(rows.map((r) => r.kind)).toEqual(["dir", "file", "file", "file"]);
  });

  it("shows hidden nodes when hidden is on", () => {
    const rows = buildFilesRows(root, "", true);
    expect(rows.map((r) => r.node.name)).toContain(".env");
  });

  it("delegates to filtered match rows when a query is active", () => {
    const rows = buildFilesRows(root, "util", false);
    expect(rows).toHaveLength(1);
    const match = rows[0]!;
    if (match.kind !== "match") throw new Error(`expected match row, got ${match.kind}`);
    expect(match.node.relPath).toBe("src/util.ts");
    expect(match.prefix).toBe("src/");
    expect(match.nameIndex).toBe(0);
  });
});

describe("buildFilesHeader", () => {
  it("hides the position counter on an empty tree instead of rendering 1/0 (Issue #129)", () => {
    const row = buildFilesHeader(30, 0, ctx({ filesCursor: 0 }));
    expect(row).not.toContain("1/0");
    expect(row).not.toContain("/"); // no counter at all, but the label survives
    expect(row).toContain("FILES");
    expect(visibleWidth(row)).toBe(30);
  });

  it("never shows a numerator above the denominator for any cursor position (Issue #129)", () => {
    for (const filesCursor of [0, 2, 3, 99]) {
      const row = buildFilesHeader(30, 3, ctx({ filesCursor }));
      const match = row.match(/(\d+)\/(\d+)/);
      expect(match, `cursor ${filesCursor}`).not.toBeNull();
      expect(Number(match![1])).toBeLessThanOrEqual(Number(match![2]));
    }
  });

  it("still reports zero matches while filtering", () => {
    expect(buildFilesHeader(30, 0, ctx({ filterQuery: "zzz" }))).toContain("0 matches");
  });

  it("pluralizes the match counter (Issue #195)", () => {
    const one = buildFilesHeader(30, 1, ctx({ filterQuery: "u" }));
    expect(one).toContain("1 match");
    expect(one).not.toContain("1 matches");
    expect(buildFilesHeader(30, 2, ctx({ filterQuery: "u" }))).toContain("2 matches");
  });

  it("shows a position counter while browsing and a match counter while filtering", () => {
    const browsing = buildFilesHeader(30, 3, ctx({ filesCursor: 0 }));
    expect(browsing).toContain("1/3");
    expect(browsing).not.toContain("matches");
    const filtering = buildFilesHeader(30, 2, ctx({ filterQuery: "util" }));
    expect(filtering).toContain("2 matches");
  });

  it("accents the FILES label when the pane has focus", () => {
    expect(buildFilesHeader(30, 3, { ...ctx(), theme: toneTheme, focus: "files" })).toContain("accent:FILES");
    expect(buildFilesHeader(30, 3, { ...ctx(), theme: toneTheme, focus: "git" })).toContain("dim:FILES");
  });
});

describe("buildFileRow", () => {
  const leftW = 40;

  it("renders ▾ for an expanded dir and ▸ for a collapsed one", () => {
    const expanded = buildFileRow({ kind: "dir", node: srcDir }, false, leftW, ctx());
    const collapsed = buildFileRow(
      { kind: "dir", node: { ...srcDir, expanded: false } },
      false,
      leftW,
      ctx(),
    );
    expect(expanded).toContain("\u25be");
    expect(collapsed).toContain("\u25b8");
    expect(expanded).toContain("src");
  });

  it("styles the open file through the theme accent channel", () => {
    const row = buildFileRow(
      { kind: "file", node: utilNode },
      false,
      leftW,
      { ...ctx(), theme: toneTheme, openRelPath: "src/util.ts" },
    );
    expect(row).toContain("accent:util.ts");
  });

  it("dims a hidden file through the theme dim channel", () => {
    const row = buildFileRow({ kind: "file", node: envNode }, false, leftW, {
      ...ctx(),
      theme: toneTheme,
    });
    expect(row).toContain("dim:.env");
  });

  it("appends the git status badge via codeText", () => {
    const row = buildFileRow({ kind: "file", node: utilNode }, false, leftW, {
      ...ctx(),
      theme: toneTheme,
    });
    expect(row).toContain("warning:M");
  });

  it("highlights the name hit and ellipsizes a long prefix on match rows", () => {
    const deepRel = "a/very/deeply/nested/folder/chain/util.ts";
    const deepNode = node({
      name: "util.ts",
      lowerName: "util.ts",
      path: `/work/${deepRel}`,
      relPath: deepRel,
      lowerRelPath: deepRel,
    });
    const row = buildFileRow(
      { kind: "match", node: deepNode, prefix: deepRel.slice(0, deepRel.length - "util.ts".length), nameIndex: 0 },
      false,
      60,
      ctx({ filterQuery: "util", theme: identityTheme }),
    );
    expect(row).toContain("\u2026"); // ellipsis past 18 chars of prefix
    // identity theme keeps the (highlighted) name intact so the full file name is rendered
    expect(row).toContain("util.ts");
    expect(visibleWidth(row)).toBeLessThanOrEqual(60); // row stays width-safe
  });

  it("styles the hit at the folded-to-original index (Issue #195)", () => {
    // "İ".toLowerCase() is two code units, so the folded index (2) is not the
    // original index (1); slicing the original name by the folded index used
    // to style "is.t" instead of "dris".
    const name = "\u0130dris.ts";
    const folded = name.toLowerCase();
    const hitNode = node({
      name,
      lowerName: folded,
      path: `/work/${name}`,
      relPath: name,
      lowerRelPath: folded,
    });
    const root = node({ name: "", isDir: true, relPath: "", children: [hitNode] });
    const rows = buildFilesRows(root, "dris", false);
    const match = rows.find((row) => row.kind === "match");
    if (match?.kind !== "match") throw new Error("expected a match row");
    const row = buildFileRow(match, false, 40, ctx({ filterQuery: "dris", theme: toneTheme }));
    expect(row).toContain("warning:dris");
    expect(row).not.toContain("warning:is.t");
  });

  it("never splits a ZWJ cluster when styling a match (Issue #214)", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const name = `a${family}b.txt`;
    const hitNode = node({
      name,
      lowerName: name.toLowerCase(),
      path: `/work/${name}`,
      relPath: name,
      lowerRelPath: name.toLowerCase(),
    });
    // The query matches INSIDE the family sequence, so a naive slice would put
    // SGR between its members: the terminal then paints four separate emoji,
    // two cells wider than the row budget.
    const row = buildFileRow(
      { kind: "match", node: hitNode, prefix: "", nameIndex: name.indexOf("\u{1F469}") },
      false,
      24,
      ctx({ filterQuery: "\u{1F469}", theme: toneTheme }),
    );
    expect(visibleWidth(row)).toBe(24);
    const span = row.slice(row.indexOf("\u{1F468}"), row.lastIndexOf("\u{1F466}"));
    expect(span).not.toContain("warning:");
    expect(span).not.toContain("bold:");
  });

  it("clips a long match prefix on grapheme boundaries (Issue #214)", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const prefix = "/" + family.repeat(30) + "/";
    const hitNode = node({
      name: "b.txt",
      lowerName: "b.txt",
      path: "/work/b.txt",
      relPath: "b.txt",
      lowerRelPath: "b.txt",
    });
    const row = buildFileRow(
      { kind: "match", node: hitNode, prefix, nameIndex: 0 },
      false,
      40,
      ctx({ filterQuery: "b", theme: toneTheme }),
    );
    expect(visibleWidth(row)).toBe(40);
    // The ellipsis must not be followed by a ZWJ, a lone low surrogate, or a
    // lone high surrogate — each means the cut landed inside a cluster.
    expect(row).not.toMatch(/\u2026(?:\u200D|[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF]))/u);
  });

  it("marks a changed directory with a rollup • twin and leaves an unchanged one bare", () => {
    const changedDir = buildFileRow({ kind: "dir", node: srcDir }, false, leftW, ctx());
    expect(changedDir).toContain(" \u2022"); // badge cell: space + marker
    const unchangedDir = buildFileRow({ kind: "dir", node: docsDir }, false, leftW, ctx());
    expect(unchangedDir).not.toContain("\u2022");
    // Icons-on: the twin lives in the badge cell, independent of the icon
    // column, so it renders in both modes.
    const withIcons = buildFileRow({ kind: "dir", node: srcDir }, false, leftW, ctx({ enableIcons: true }));
    expect(withIcons).toContain(" \u2022");
  });

  it("survives colour stripping: • is real text (identity theme) on the warning channel (tone theme)", () => {
    const plain = buildFileRow({ kind: "dir", node: srcDir }, false, leftW, ctx());
    expect(plain).toContain("\u2022"); // identity theme: the glyph is genuinely there
    const toned = buildFileRow({ kind: "dir", node: srcDir }, false, leftW, { ...ctx(), theme: toneTheme });
    expect(toned).toContain("warning:\u2022");
    expect(toned).toContain("warning:src");
    const unchangedToned = buildFileRow({ kind: "dir", node: docsDir }, false, leftW, { ...ctx(), theme: toneTheme });
    expect(unchangedToned).not.toContain("warning:");
  });

  it("keeps a changed directory row exactly leftW wide at the narrow tier", () => {
    for (const narrow of [24, 30, 44]) {
      const plain = buildFileRow({ kind: "dir", node: srcDir }, false, narrow, ctx());
      expect(visibleWidth(plain)).toBe(narrow);
      const selected = buildFileRow({ kind: "dir", node: srcDir }, true, narrow, ctx());
      expect(visibleWidth(selected)).toBe(narrow);
    }
  });

  it("keeps the file git-code badge behaviour unchanged and distinct from the dir twin", () => {
    const fileRow = buildFileRow({ kind: "file", node: utilNode }, false, leftW, { ...ctx(), theme: toneTheme });
    expect(fileRow).toContain("warning:M");
    expect(fileRow).not.toContain("\u2022");
    const dirRow = buildFileRow({ kind: "dir", node: srcDir }, false, leftW, ctx());
    expect(dirRow).toContain(" \u2022");
    expect(dirRow).not.toContain(" M"); // the twin is a bullet, never a git status code
    const cleanFile = buildFileRow({ kind: "file", node: helperNode }, false, leftW, ctx());
    expect(cleanFile).not.toContain("\u2022");
  });

  it("emits the mapped icon glyph only when the icon column is enabled", () => {
    const glyph = mapExtensionToIcon("src/util.ts", false);
    const withIcons = buildFileRow({ kind: "file", node: utilNode }, false, leftW, ctx({ enableIcons: true }));
    const withoutIcons = buildFileRow({ kind: "file", node: utilNode }, false, leftW, ctx());
    expect(withIcons).toContain(glyph);
    expect(withoutIcons).not.toContain(glyph);
  });

  it("renders a filename containing ESC without emitting it (Issue #201)", () => {
    const dirtyName = "a\u001b[31mb.txt";
    const dirtyFile = node({
      name: dirtyName,
      lowerName: dirtyName,
      path: `/work/${dirtyName}`,
      relPath: dirtyName,
      lowerRelPath: dirtyName,
    });
    const dirtyDir = node({
      name: "a\u001b[31mdir",
      lowerName: "a\u001b[31mdir",
      path: "/work/a\u001b[31mdir",
      relPath: "a\u001b[31mdir",
      lowerRelPath: "a\u001b[31mdir",
      isDir: true,
    });
    // Every branch that prints a name: file, dir, and the match row's
    // before/hit/after slices. None may leak a control byte, and each row
    // still fills the pane to exactly leftW.
    for (const row of [
      { kind: "file", node: dirtyFile } as const,
      { kind: "dir", node: dirtyDir } as const,
    ]) {
      const out = buildFileRow(row, false, 30, ctx());
      expect(out, row.kind).not.toContain("\u001b");
      expect(out, row.kind).toContain("[31m");
      expect(visibleWidth(out), row.kind).toBe(30);
    }
    const dirtyRoot = node({ name: "", isDir: true, relPath: "", children: [dirtyFile] });
    const match = buildFilesRows(dirtyRoot, "b", false).find((r) => r.kind === "match");
    if (match === undefined) throw new Error("expected a match row");
    const matched = buildFileRow(match, false, 30, ctx({ filterQuery: "b" }));
    expect(matched).not.toContain("\u001b");
    expect(matched).toContain("a[31mb.txt");
    expect(visibleWidth(matched)).toBe(30);
  });

  it("keeps every row width-safe, padded to exactly leftW when cursor-selected", () => {
    for (const leftWCase of [30, 44]) {
      for (const row of [...buildFilesRows(root, "", false), ...buildFilesRows(root, "util", false)]) {
        const plain = buildFileRow(row, false, leftWCase, ctx());
        expect(visibleWidth(plain)).toBeLessThanOrEqual(leftWCase);
        const selected = buildFileRow(row, true, leftWCase, ctx());
        expect(visibleWidth(selected)).toBe(leftWCase);
      }
    }
  });
});
