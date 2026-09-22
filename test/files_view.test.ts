/**
 * files_view.ts suites (Issue #064 view-model extraction): the row model
 * (buildFilesRows), the header and one file row. FileNode fixtures are
 * hand-built (no filesystem); the identity theme passes text through, so
 * width assertions use the real pi-tui visibleWidth, and a tone-tagging
 * theme verifies which theme channel styled a row.
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import { buildFileRow, buildFilesHeader, buildFilesRows, type FilesViewContext } from "../files_view";
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

  it("emits the mapped icon glyph only when the icon column is enabled", () => {
    const glyph = mapExtensionToIcon("src/util.ts", false);
    const withIcons = buildFileRow({ kind: "file", node: utilNode }, false, leftW, ctx({ enableIcons: true }));
    const withoutIcons = buildFileRow({ kind: "file", node: utilNode }, false, leftW, ctx());
    expect(withIcons).toContain(glyph);
    expect(withoutIcons).not.toContain(glyph);
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
