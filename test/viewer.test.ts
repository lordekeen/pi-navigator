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

import { IMAGE_ERROR_MAX_CHARS, MAX_HIGHLIGHT_LINES } from "../constants";
import {
  computeRows,
  decodeUtf8Head,
  expandTabs,
  extOf,
  formatSize,
  hardTruncate,
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
import type { ImageRenderer } from "../viewer";

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

  it("treats wide characters as two cells (Issue #059 cell model)", () => {
    // 日 occupies cells 0–1, 本 cells 2–3, 語 cells 4–5. A window inside a
    // glyph (no glyph's first cell falls in it) yields nothing.
    expect(sliceStyled("日本語", 1, 2)).toBe("");
    expect(sliceStyled("日本語", 2, 4)).toBe("本");
    expect(sliceStyled("日本語", 0, 2)).toBe("日");
  });
});

describe("hardTruncate", () => {
  it("passes exact-width (and shorter) text through untouched", () => {
    expect(hardTruncate("whole line", 10)).toBe("whole line");
    expect(hardTruncate("abc", 3)).toBe("abc");
    // A styled string that fits is returned as-is, escapes included.
    expect(hardTruncate("\x1b[31mred\x1b[0m", 3)).toBe("\x1b[31mred\x1b[0m");
    expect(hardTruncate("日本語", 6)).toBe("日本語"); // 2 cells per char
  });

  it("hard-cuts with no ellipsis and no bright-ellipsis reset pair (Issue #010)", () => {
    // truncateToWidth's default "..." ellipsis is wrapped in \x1b[0m resets
    // that render the dots bright; hardTruncate never emits an ellipsis, so
    // the reset+three-dot artifact is absent. Like sliceStyled, a cut is
    // reset-terminated so an open style cannot leak into later padding.
    const cut = hardTruncate("abcdef", 3);
    expect(cut).not.toContain("...");
    expect(cut).not.toMatch(/\x1b\[0m\.\.\./);
    expect(stripAnsi(cut)).toBe("abc");
    expect(visibleTextWidth(cut)).toBe(3);
    expect(hardTruncate("abcdef", 0)).toBe("");
  });

  it("keeps wide (CJK) characters whole and never overflows the width", () => {
    // 日/本/語 are two cells each. A cut inside a glyph keeps the previous
    // whole glyph and under-fills — never splits a grapheme, never +1.
    expect(stripAnsi(hardTruncate("日本語", 3))).toBe("日");
    expect(visibleTextWidth(hardTruncate("日本語", 3))).toBe(2);
    expect(visibleTextWidth(hardTruncate("日本語", 5))).toBe(4);
    expect(visibleTextWidth(hardTruncate("日本語", 5))).toBeLessThanOrEqual(5);
  });

  it("keeps a styled input's open style until the cut, then closes it", () => {
    // The \x1b[31m opens before the kept text and is still open at the cut;
    // the reset closes it there, exactly like sliceStyled's termination.
    expect(hardTruncate("\x1b[31mabcdef", 3)).toBe("\x1b[31mabc\x1b[0m");
    // A style that starts mid-string stays open through the kept suffix.
    expect(hardTruncate("abc\x1b[31mdef", 5)).toBe("abc\x1b[31mde\x1b[0m");
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

  it("maps haystack fold drift back to unfolded offsets (Issue #060 finding 2)", () => {
    // İ (U+0130) folds to i + combining dot, so the folded haystack is LONGER
    // than the styled one: folded indexOf offsets must map back to unfolded
    // spans. The v1 drift bug highlighted "bc" here.
    expect(markMatches("\u0130abc", "abc", match, current, -1)).toBe("\u0130<m>abc</m>");
    expect(markMatches("\u0130abc", "abc", match, current, 0)).toBe("\u0130<c>abc</c>");
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

  it("returns unfolded offsets when lowercasing changes the haystack length (Issue #060 finding 2)", () => {
    // "İabc" folds to "i̇abc" (len 5 vs 4); the match at folded 2..5 spans
    // unfolded 1..4 (the "abc" after the İ).
    expect(searchLines(["\u0130abc"], "abc")).toEqual([{ line: 0, start: 1, end: 4 }]);
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

  it("counts wide characters as two cells (Issue #059)", () => {
    expect(maxLineWidth({ ...file, lines: ["日本語"] })).toBe(6);
  });

  it("nowrap hscroll reaches a wide-char line's tail (Issue #059)", () => {
    // 日本語 occupies cells 0–5; slicing [2, 4) emits 本 whole. Under the v1
    // code-point model this window was attributed to code points 2..3.
    const rows = computeRows({ ...file, lines: ["日本語"] }, 2, false, 2);
    expect(rows.map((r) => r.text)).toEqual(["本"]);
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

  // ── Image renderer seam (chafa) ──

  /** Minimal PNG header fixture: stat-able and dimension-probeable. */
  async function writePng(name: string): Promise<string> {
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
    const path = join(dir, name);
    await writeFile(path, header);
    return path;
  }

  it("renders through the injected renderer on ok: chafa tier, rows, geometry, message preserved", async () => {
    const path = await writePng("pic.png");
    const renderer: ImageRenderer = async (_absPath, req) => ({
      ok: true,
      lines: ["\x1b[31m██\x1b[0m", "\x1b[32m░░\x1b[0m"],
      cols: req.cols,
      rows: req.rows,
    });
    const card = await loadFile(path, "pic.png");
    const file = await loadFile(path, "pic.png", {
      renderImage: renderer,
      image: { cols: 80, rows: 24 },
    });
    expect(file.kind).toBe("image");
    expect(file.imageTier).toBe("chafa");
    expect(file.imageLines).toEqual(["\x1b[31m██\x1b[0m", "\x1b[32m░░\x1b[0m"]);
    expect(file.imageCols).toBe(80);
    expect(file.imageRows).toBe(24);
    expect(file.lines).toEqual([]);
    expect(file.message).toBe(card.message);
    expect(file.mtimeMs).toBe(card.mtimeMs);
  });

  it("falls back to the metadata card with a bounded imageError when the renderer reports failure", async () => {
    const path = await writePng("sad.png");
    const renderer: ImageRenderer = async () => ({ ok: false, reason: "x".repeat(500) });
    const file = await loadFile(path, "sad.png", {
      renderImage: renderer,
      image: { cols: 40, rows: 10 },
    });
    expect(file.kind).toBe("image");
    expect(file.imageTier).toBe("metadata");
    expect(file.imageError).toBe("x".repeat(199) + "\u2026");
    expect(file.imageError?.length ?? 0).toBeLessThanOrEqual(200);
    expect(file.imageLines).toBeUndefined();
  });

  it("treats a throwing renderer as a failed render, never rejecting loadFile", async () => {
    const path = await writePng("boom.png");
    const file = await loadFile(path, "boom.png", {
      renderImage: async () => {
        throw new Error("chafa exploded");
      },
      image: { cols: 40, rows: 10 },
    });
    expect(file.kind).toBe("image");
    expect(file.imageTier).toBe("metadata");
    expect(file.imageError).toBe("chafa exploded");

    // A non-Error throw degrades to a generic bounded reason.
    const stringThrow = await loadFile(path, "boom.png", {
      renderImage: async () => {
        throw "not an error";
      },
      image: { cols: 40, rows: 10 },
    });
    expect(stringThrow.imageTier).toBe("metadata");
    expect(stringThrow.imageError).toBe("unexpected renderer failure");
  });

  it("keeps today's metadata card byte-for-byte when no renderer is injected", async () => {
    const path = await writePng("plain.png");
    const file = await loadFile(path, "plain.png");
    expect(file.kind).toBe("image");
    expect(file.imageTier).toBe("metadata");
    expect(file.message).toBe("64 B \u00b7 10x20");
    expect(file.sizeBytes).toBe(64);
    expect(file.lines).toEqual([]);
    expect(file.mtimeMs).toBeGreaterThan(0);
    // Byte-for-byte shape of the pre-chafa metadata card: no seam fields at all.
    expect(Object.keys(file).sort()).toEqual(
      ["imageTier", "kind", "lines", "message", "mtimeMs", "relPath", "sizeBytes"].sort(),
    );
  });

  // ── Native image renderer seam (§12.2) ──

  describe("loadFile native image seam (§12.2)", () => {
    it("renders through the native seam on ok: native tier, imageLines/cols/rows, empty lines, message preserved", async () => {
      const path = await writePng("native-ok.png");
      const card = await loadFile(path, "native-ok.png");
      const native: ImageRenderer = async (_absPath, req) => ({
        ok: true,
        lines: ["\x1b]10;…\x1b\\"],
        cols: req.cols,
        rows: req.rows,
      });
      const file = await loadFile(path, "native-ok.png", {
        renderNativeImage: native,
        image: { cols: 60, rows: 20 },
      });
      expect(file.kind).toBe("image");
      expect(file.imageTier).toBe("native");
      expect(file.imageLines).toEqual(["\x1b]10;…\x1b\\"]);
      expect(file.imageCols).toBe(60);
      expect(file.imageRows).toBe(20);
      expect(file.lines).toEqual([]);
      expect(file.message).toBe(card.message); // size + dimensions message intact
      expect(file.sizeBytes).toBe(64);
      expect(file.mtimeMs).toBe(card.mtimeMs);
      expect(file.imageError).toBeUndefined();
    });

    it("calls the native seam first and never the chafa seam when native succeeds", async () => {
      const path = await writePng("native-first.png");
      const order: string[] = [];
      const native: ImageRenderer = async () => {
        order.push("native");
        return { ok: true, lines: ["n"], cols: 1, rows: 1 };
      };
      const chafa: ImageRenderer = async () => {
        order.push("chafa");
        return { ok: true, lines: ["c"], cols: 1, rows: 1 };
      };
      const file = await loadFile(path, "native-first.png", {
        renderNativeImage: native,
        renderImage: chafa,
        image: { cols: 40, rows: 10 },
      });
      expect(order).toEqual(["native"]);
      expect(file.imageTier).toBe("native");
      expect(file.imageLines).toEqual(["n"]);
    });

    it("falls through native → chafa in order when native fails cleanly, landing on the chafa output", async () => {
      const path = await writePng("native-fallback.png");
      const order: string[] = [];
      const native: ImageRenderer = async () => {
        order.push("native");
        return { ok: false, reason: "terminal protocol unsupported" };
      };
      const chafa: ImageRenderer = async (_absPath, req) => {
        order.push("chafa");
        return { ok: true, lines: ["\x1b[32m██\x1b[0m"], cols: req.cols, rows: req.rows };
      };
      const file = await loadFile(path, "native-fallback.png", {
        renderNativeImage: native,
        renderImage: chafa,
        image: { cols: 30, rows: 8 },
      });
      expect(order).toEqual(["native", "chafa"]);
      expect(file.kind).toBe("image");
      expect(file.imageTier).toBe("chafa");
      expect(file.imageLines).toEqual(["\x1b[32m██\x1b[0m"]);
      expect(file.imageCols).toBe(30);
      expect(file.imageRows).toBe(8);
      expect(file.imageError).toBeUndefined();
    });

    it("returns a metadata card with the native reason when native fails cleanly and no chafa seam exists", async () => {
      const path = await writePng("native-only-fail.png");
      const file = await loadFile(path, "native-only-fail.png", {
        renderNativeImage: async () => ({ ok: false, reason: "no kitty graphics support" }),
        image: { cols: 40, rows: 10 },
      });
      expect(file.kind).toBe("image");
      expect(file.imageTier).toBe("metadata");
      expect(file.imageError).toBe("no kitty graphics support");
      expect(file.imageLines).toBeUndefined();
    });

    it("carries the chafa reason (not the native one) when both seams fail cleanly", async () => {
      const path = await writePng("both-fail.png");
      const file = await loadFile(path, "both-fail.png", {
        renderNativeImage: async () => ({ ok: false, reason: "native reason" }),
        renderImage: async () => ({ ok: false, reason: "chafa reason" }),
        image: { cols: 40, rows: 10 },
      });
      expect(file.kind).toBe("image");
      expect(file.imageTier).toBe("metadata");
      expect(file.imageError).toBe("chafa reason");
    });

    it("treats a throwing native seam as a hard failure: metadata card with the message, chafa never called", async () => {
      const path = await writePng("native-throw.png");
      let chafaCalled = false;
      const file = await loadFile(path, "native-throw.png", {
        renderNativeImage: async () => {
          throw new Error("native renderer exploded");
        },
        renderImage: async () => {
          chafaCalled = true;
          return { ok: true, lines: ["unused"], cols: 1, rows: 1 };
        },
        image: { cols: 40, rows: 10 },
      });
      expect(file.kind).toBe("image");
      expect(file.imageTier).toBe("metadata");
      expect(file.imageError).toBe("native renderer exploded");
      expect(chafaCalled).toBe(false);
      expect(file.imageLines).toBeUndefined();
    });

    it("bounds a long native clean-failure reason to IMAGE_ERROR_MAX_CHARS", async () => {
      const path = await writePng("native-long.png");
      const file = await loadFile(path, "native-long.png", {
        renderNativeImage: async () => ({ ok: false, reason: "x".repeat(300) }),
        image: { cols: 40, rows: 10 },
      });
      expect(file.kind).toBe("image");
      expect(file.imageTier).toBe("metadata");
      expect(file.imageError).toBe("x".repeat(IMAGE_ERROR_MAX_CHARS - 1) + "\u2026");
      expect(file.imageError?.length ?? 0).toBeLessThanOrEqual(IMAGE_ERROR_MAX_CHARS);
    });

    it("produces the plain metadata card with no imageError when only image opts are given (no seam)", async () => {
      const path = await writePng("no-seam.png");
      const bare = await loadFile(path, "no-seam.png");
      const file = await loadFile(path, "no-seam.png", { image: { cols: 40, rows: 10 } });
      expect(file.kind).toBe("image");
      expect(file.imageTier).toBe("metadata");
      expect(file.imageError).toBeUndefined();
      expect("imageError" in file).toBe(false);
      // Identical shape to the no-opts metadata card.
      expect({ ...file, mtimeMs: 0 }).toEqual({ ...bare, mtimeMs: 0 });
    });
  });

  it("ignores the image params on markdown files (rawText regression)", async () => {
    const path = join(dir, "doc.md");
    const content = "# Title\n\t- tab item\n";
    await writeFile(path, content);
    const file = await loadFile(path, "doc.md", {
      renderImage: async () => ({ ok: true, lines: ["unused"], cols: 1, rows: 1 }),
      image: { cols: 80, rows: 24 },
    });
    expect(file.kind).toBe("text");
    expect(file.rawText).toBe(content);
    expect(file.imageLines).toBeUndefined();
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