/**
 * viewer.ts suites: tab expansion, UTF-8 head decoding, styled slicing,
 * smart-case search and match marking, caps and binary/image detection through
 * the real loadFile pipeline on tmpdir fixtures (plan section 11, fourth and
 * fifth bullets). Highlighting runs against the real pi-coding-agent
 * highlighter; wrap math against the real pi-tui wrapTextWithAnsi.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_HIGHLIGHT_LINES } from "../constants";
import {
  computeRows,
  decodeUtf8Head,
  expandTabs,
  extOf,
  formatSize,
  imageDimensions,
  isMarkdownPath,
  loadFile,
  markMatches,
  maxLineWidth,
  searchLines,
  sliceStyled,
  stripAnsi,
  visibleTextWidth,
} from "../viewer";

// ── Text helpers ──

describe("expandTabs", () => {
  it("expands tabs to the next tab stop, column aware", () => {
    expect(expandTabs("a\tb", 4)).toBe("a   b"); // column 1 -> 3 spaces
    expect(expandTabs("\t", 4)).toBe("    ");
    expect(expandTabs("ab\t", 4)).toBe("ab  ");
    expect(expandTabs("abcd\t", 4)).toBe("abcd    "); // wraps to the next stop
  });

  it("supports a custom width and leaves tab-free lines untouched", () => {
    expect(expandTabs("a\tb", 2)).toBe("a b");
    expect(expandTabs("no tabs", 4)).toBe("no tabs");
  });
});

describe("decodeUtf8Head", () => {
  it("drops a trailing lead byte of a cut 2-byte sequence", () => {
    const head = Buffer.from("héllo", "utf8").subarray(0, 2); // 'h' + lead of é
    expect(decodeUtf8Head(head)).toBe("h");
  });

  it("drops a cut 3-byte sequence", () => {
    const full = Buffer.from("日本語", "utf8");
    expect(decodeUtf8Head(full.subarray(0, 4))).toBe("日"); // lead of 本 cut
    expect(decodeUtf8Head(full)).toBe("日本語");
  });

  it("keeps a whole 4-byte emoji but drops a cut one", () => {
    const full = Buffer.from("😀😀", "utf8");
    expect(decodeUtf8Head(full.subarray(0, 4))).toBe("😀");
    expect(decodeUtf8Head(full.subarray(0, 6))).toBe("😀"); // second one cut at byte 2/4
  });

  it("passes ASCII heads through unchanged", () => {
    expect(decodeUtf8Head(Buffer.from("plain ascii"))).toBe("plain ascii");
  });
});

describe("stripAnsi / visibleTextWidth / sliceStyled", () => {
  it("strips CSI and OSC sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe("link");
  });

  it("measures visible width without the escapes", () => {
    expect(visibleTextWidth("\x1b[1;32mbold-green\x1b[0m")).toBe("bold-green".length);
  });

  it("slices styled text, preserving escapes and terminating the style", () => {
    const styled = "\x1b[31mHello\x1b[0m";
    const sliced = sliceStyled(styled, 1, 3);
    expect(sliced).toBe("\x1b[31mel\x1b[0m");
    expect(visibleTextWidth(sliced)).toBe(2);
  });

  it("counts wide characters as one cell (v1 approximation)", () => {
    const sliced = sliceStyled("日本語", 1, 2);
    expect(sliced).toBe("本");
  });
});

// ── Search and marking ──

describe("markMatches", () => {
  const match = (s: string) => `<m>${s}</m>`;
  const current = (s: string) => `<c>${s}</c>`;

  it("marks all occurrences and styles the Nth as current", () => {
    // currentOccurrence=0 styles the first match as current (Issue #025).
    expect(markMatches("aXa", "a", match, current, 0)).toBe("<c>a</c>X<m>a</m>");
    // currentOccurrence=-1 means no match on this line is current.
    expect(markMatches("aXa", "a", match, current, -1)).toBe("<m>a</m>X<m>a</m>");
  });

  it("styles the 2nd occurrence as current when currentOccurrence=1", () => {
    // Two matches on one line: the 2nd should be current (Issue #025).
    expect(markMatches("aaXaa", "aa", match, current, 1)).toBe("<m>aa</m>X<c>aa</c>");
  });

  it("is smart-case: an uppercase query matches only real case", () => {
    expect(markMatches("fooBar", "bar", match, current, -1)).toBe("foo<m>Bar</m>");
    expect(markMatches("foobar", "Bar", match, current, -1)).toBe("foobar");
  });

  it("uses needle.length when lowercased query has different length (Issue #035)", () => {
    // Turkish dotted capital I (\u0130, length 1) lowercases to i + combining dot (\u0069\u0307, length 2)
    expect(markMatches("a\u0069\u0307b", "\u0130", match, current, -1)).toBe("a<m>\u0069\u0307</m>b");
  });

  it("returns the text unchanged for an empty query", () => {
    expect(markMatches("abc", "", match, current, -1)).toBe("abc");
  });
});

describe("searchLines", () => {
  it("finds all non-overlapping matches with offsets", () => {
    expect(searchLines(["abc x", "y abc"], "abc")).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 1, start: 2, end: 5 },
    ]);
  });

  it("skips overlapping occurrences", () => {
    expect(searchLines(["aaa"], "aa")).toEqual([{ line: 0, start: 0, end: 2 }]);
  });

  it("is smart-case", () => {
    expect(searchLines(["abc", "AbC"], "AbC")).toEqual([{ line: 1, start: 0, end: 3 }]);
  });

  it("returns no matches for an empty query", () => {
    expect(searchLines(["abc"], "")).toEqual([]);
  });
});

describe("extOf / formatSize / imageDimensions", () => {
  it("extracts a lowercase extension", () => {
    expect(extOf("a.txt")).toBe("txt");
    expect(extOf("A.TXT")).toBe("txt");
    expect(extOf("dir/a.tar.gz")).toBe("gz");
    expect(extOf("noext")).toBe("");
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("dir/.editorconfig")).toBe("");
    expect(extOf(".hidden.txt")).toBe("txt");
  });

  it("formats byte sizes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1048576)).toBe("1.0 MB");
    expect(formatSize(undefined)).toBe("");
  });

  it("reads PNG and GIF dimensions from the header", () => {
    const png = Buffer.alloc(24);
    png[0] = 0x89;
    png.write("PNG", 1);
    png[4] = 0x0d;
    png[5] = 0x0a;
    png[6] = 0x1a;
    png[7] = 0x0a;
    png.writeUInt32BE(13, 8); // IHDR length
    png.write("IHDR", 12);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(imageDimensions(png)).toBe("640x480");

    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0);
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(imageDimensions(gif)).toBe("320x200");

    expect(imageDimensions(Buffer.from("not an image"))).toBeUndefined();
    expect(imageDimensions(Buffer.alloc(4))).toBeUndefined();
  });
});

// ── Display rows ──

describe("computeRows / maxLineWidth", () => {
  const file = {
    kind: "text" as const,
    relPath: "a.ts",
    sizeBytes: 10,
    lineCount: 2,
    lines: ["aaaa", "bb"],
  };

  it("wraps into chunks with continuation rows when wrap is on", () => {
    const rows = computeRows(file, 3, true, 0);
    expect(rows.map((r) => r.text)).toEqual(["aaa", "a", "bb"]);
    expect(rows.map((r) => r.line)).toEqual([0, null, 1]);
  });

  it("clips per line with a horizontal offset when wrap is off", () => {
    const rows = computeRows(file, 3, false, 1);
    expect(rows.map((r) => r.text)).toEqual(["aaa", "b"]);
  });

  it("returns no rows for a zero width", () => {
    expect(computeRows(file, 0, true, 0)).toEqual([]);
  });

  it("measures the longest visible line", () => {
    expect(maxLineWidth({ ...file, lines: ["\x1b[31mshort\x1b[0m", "this-is-longer"] })).toBe(14);
  });
});

// ── loadFile pipeline (real files) ──

describe("loadFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-nav-load-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("normalizes CRLF line endings so carriage returns never reach the renderer", async () => {
    // A \r in a rendered line resets the terminal cursor to column 0 and the
    // row's padding then overwrites the gutter/border, breaking the overlay.
    // CRLF source files (this repo's own .ts files) hit this on every open.
    const path = join(dir, "crlf.ts");
    await writeFile(path, "// comment\r\nconst x = 1;"); // no trailing newline: exactly 2 lines
    const file = await loadFile(path, "crlf.ts");
    expect(file.kind).toBe("text");
    for (const line of file.lines) {
      expect(line).not.toContain("\r");
    }
    expect(stripAnsi(file.lines[0] ?? "")).toBe("// comment");
    expect(stripAnsi(file.lines[1] ?? "")).toBe("const x = 1;");
    expect(file.lineCount).toBe(2);
  });

  it("loads a small text file with highlighted lines and a line count", async () => {
    const path = join(dir, "sample.ts");
    await writeFile(path, "// comment\nconst x = 1;"); // no trailing newline: exactly 2 lines
    const file = await loadFile(path, "sample.ts");
    expect(file.kind).toBe("text");
    expect(file.lineCount).toBe(2);
    expect(file.lines).toHaveLength(2);
    expect(stripAnsi(file.lines[0] ?? "")).toBe("// comment");
  });

  it("detects binary content by NUL byte", async () => {
    const path = join(dir, "blob.bin");
    await writeFile(path, Buffer.from([0x61, 0x00, 0x62, 0x63]));
    const file = await loadFile(path, "blob.bin");
    expect(file.kind).toBe("binary");
    expect(file.message).toContain("binary");
    expect(file.sizeBytes).toBe(4);
  });

  it("shows an image metadata card with dimensions", async () => {
    const path = join(dir, "pic.png");
    const header = Buffer.alloc(64);
    header[0] = 0x89;
    header.write("PNG", 1);
    header[4] = 0x0d;
    header[5] = 0x0a;
    header[6] = 0x1a;
    header[7] = 0x0a;
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12);
    header.writeUInt32BE(10, 16);
    header.writeUInt32BE(20, 20);
    await writeFile(path, header);
    const file = await loadFile(path, "pic.png");
    expect(file.kind).toBe("image");
    expect(file.imageTier).toBe("metadata");
    expect(file.message).toContain("10x20");
  });

  it("truncates at the line cap with a notice, keeping a cheap line count", async () => {
    const path = join(dir, "huge.txt");
    await writeFile(path, Array.from({ length: MAX_HIGHLIGHT_LINES + 100 }, (_, i) => `line ${i}`).join("\n"));
    const file = await loadFile(path, "huge.txt");
    expect(file.kind).toBe("truncated");
    expect(file.lines).toHaveLength(MAX_HIGHLIGHT_LINES);
    expect(file.lineCount).toBe(MAX_HIGHLIGHT_LINES + 100);
    expect(file.notice).toContain("Truncated view:");
  });

  it("truncates at the byte cap without ever reading the whole file", async () => {
    const path = join(dir, "big.bin");
    // 1.5 MB of text: over the 1 MB highlight cap, under test memory concerns.
    const chunk = "x".repeat(1024 * 1024);
    await writeFile(path, chunk + chunk.slice(0, 512 * 1024));
    const file = await loadFile(path, "big.txt");
    expect(file.sizeBytes).toBe(1.5 * 1024 * 1024);
    expect(file.kind).toBe("truncated");
    expect(file.lines.length).toBeLessThanOrEqual(MAX_HIGHLIGHT_LINES);
    expect(file.lineCount).toBeUndefined(); // whole file was never read
  });

  it("returns an error card for a missing file", async () => {
    const file = await loadFile(join(dir, "nope.ts"), "nope.ts");
    expect(file.kind).toBe("error");
    expect(file.message).toBeTruthy();
  });

  it("attaches rawText with unexpanded tabs on markdown files", async () => {
    const path = join(dir, "doc.md");
    const content = "# Title\n\t- Item with tab\n";
    await writeFile(path, content);
    const file = await loadFile(path, "doc.md");
    expect(file.kind).toBe("text");
    expect(file.rawText).toBe("# Title\n\t- Item with tab\n");
    expect(file.rawText).toContain("\t");
    expect(file.lines[1]).not.toContain("\t");
  });

  it("normalizes CRLF in rawText on markdown files", async () => {
    const path = join(dir, "crlf.markdown");
    const content = "# Title\r\nline 1\r\nline 2";
    await writeFile(path, content);
    const file = await loadFile(path, "crlf.markdown");
    expect(file.kind).toBe("text");
    expect(file.rawText).toBe("# Title\nline 1\nline 2");
    expect(file.rawText).not.toContain("\r");
  });

  it("attaches capped head rawText on truncated markdown files", async () => {
    const path = join(dir, "huge.md");
    const lines = Array.from({ length: MAX_HIGHLIGHT_LINES + 50 }, (_, i) => `## Heading ${i}`);
    await writeFile(path, lines.join("\n"));
    const file = await loadFile(path, "huge.md");
    expect(file.kind).toBe("truncated");
    expect(file.rawText).toBeDefined();
    expect(file.rawText?.split("\n")).toHaveLength(MAX_HIGHLIGHT_LINES);
    expect(file.rawText?.split("\n")[0]).toBe("## Heading 0");
    expect(file.rawText?.split("\n")[MAX_HIGHLIGHT_LINES - 1]).toBe(`## Heading ${MAX_HIGHLIGHT_LINES - 1}`);
  });

  it("leaves rawText undefined on non-markdown files", async () => {
    const tsPath = join(dir, "code.ts");
    await writeFile(tsPath, "const x = 1;");
    const tsFile = await loadFile(tsPath, "code.ts");
    expect(tsFile.rawText).toBeUndefined();

    const binPath = join(dir, "data.bin");
    await writeFile(binPath, Buffer.from([0, 1, 2]));
    const binFile = await loadFile(binPath, "data.bin");
    expect(binFile.rawText).toBeUndefined();
  });

  it("attaches rawText on extended markdown extensions (.mdx, .mkd, .mdown)", async () => {
    for (const ext of ["mdx", "mkd", "mdown"]) {
      const p = join(dir, `sample.${ext}`);
      await writeFile(p, `# Heading in ${ext}\n\ncontent`);
      const file = await loadFile(p, `sample.${ext}`);
      expect(file.rawText).toBe(`# Heading in ${ext}\n\ncontent`);
    }
  });
});

describe("isMarkdownPath", () => {
  it("identifies markdown files by extension", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/spec.markdown")).toBe(true);
    expect(isMarkdownPath("NOTES.MD")).toBe(true);
    expect(isMarkdownPath("SRC.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("component.mdx")).toBe(true);
    expect(isMarkdownPath("doc.mkd")).toBe(true);
    expect(isMarkdownPath("guide.mdown")).toBe(true);
    expect(isMarkdownPath("PAGE.MDX")).toBe(true);
    expect(isMarkdownPath("PAGE.MKD")).toBe(true);
    expect(isMarkdownPath("PAGE.MDOWN")).toBe(true);
    expect(isMarkdownPath("src/main.ts")).toBe(false);
    expect(isMarkdownPath("data.json")).toBe(false);
    expect(isMarkdownPath("plain.txt")).toBe(false);
    expect(isMarkdownPath(".md")).toBe(false);
    expect(isMarkdownPath("noext")).toBe(false);
    expect(isMarkdownPath("archive.md5")).toBe(false);
  });
});