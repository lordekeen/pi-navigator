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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_HIGHLIGHT_LINES } from "../constants";
import type { RenderOutcome } from "../images";
import type { ImageVerdict, ViewerFile } from "../types";
import {
  computeRows,
  decodeUtf8Head,
  expandTabs,
  extOf,
  formatSize,
  hardTruncate,
  inkRuns,
  imageDimensions,
  isMarkdownPath,
  loadFile,
  markMatches,
  maxLineWidth,
  restyleViewerFile,
  searchLines,
  sliceStyled,
  stripAnsi,
  visibleTextWidth,
} from "../viewer";
import type { ImageRenderer } from "../viewer";

// Stat-call counter (Issue #144): the loader must not stat a path the session
// already statted. The mock delegates to the real fs; only the call count is
// observed.
const statLog = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: ((...args: Parameters<typeof actual.stat>) => {
      statLog.calls += 1;
      return actual.stat(...args);
    }) as typeof actual.stat,
  };
});

// The highlighter input log (Issue #136): `restyleViewerFile` must re-run the
// highlighter on exactly the retained `styleText`. The real highlighter stays
// in place — its output is what the pipeline tests exercise — and the wrapper
// only records the code it was asked to highlight.
const highlightLog = vi.hoisted(() => ({ inputs: [] as string[] }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    highlightCode: (code: string, lang?: string) => {
      highlightLog.inputs.push(code);
      return actual.highlightCode(code, lang);
    },
  };
});

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

  it("preserves OSC sequences without splitting mid-sequence (Issue #083)", () => {
    const text = "\x1b]8;;https://example.com\x07ClickHere\x1b]8;;\x07";
    const sliced = sliceStyled(text, 0, 5);
    expect(sliced).toBe("\x1b]8;;https://example.com\x07Click\x1b[0m");
    expect(visibleTextWidth(sliced)).toBe(5);
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

  it("treats non-ASCII Unicode uppercase as smart-case (Issue #091)", () => {
    // Turkish dotted capital I (\u0130, length 1) is uppercase: triggers case-sensitive search
    expect(markMatches("a\u0130b", "\u0130", match, current, -1)).toBe("a<m>\u0130</m>b");
    expect(markMatches("a\u0069\u0307b", "\u0130", match, current, -1)).toBe("a\u0069\u0307b");
    // Cyrillic / Greek uppercase triggers smart-case
    expect(markMatches("Ωmega", "Ω", match, current, -1)).toBe("<m>Ω</m>mega");
    expect(markMatches("ωmega", "Ω", match, current, -1)).toBe("ωmega");
    expect(markMatches("Ωmega", "ω", match, current, -1)).toBe("<m>Ω</m>mega");
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

  it("treats non-ASCII Unicode uppercase as smart-case in searchLines (Issue #091)", () => {
    expect(searchLines(["a\u0130b"], "\u0130")).toEqual([{ line: 0, start: 1, end: 2 }]);
    expect(searchLines(["a\u0069\u0307b"], "\u0130")).toEqual([]);
    expect(searchLines(["Ωmega"], "Ω")).toEqual([{ line: 0, start: 0, end: 1 }]);
    expect(searchLines(["ωmega"], "Ω")).toEqual([]);
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

  it("estimates the shown text's tokens with pi's chars/4 heuristic", async () => {
    const path = join(dir, "tokens.ts");
    await writeFile(path, "const answer = 42;"); // 18 chars -> 5
    const file = await loadFile(path, "tokens.ts");
    expect(file.kind).toBe("text");
    expect(file.tokens).toBe(5);
  });

  it("detects binary content by NUL byte", async () => {
    const path = join(dir, "blob.bin");
    await writeFile(path, Buffer.from([0x61, 0x00, 0x62, 0x63]));
    const file = await loadFile(path, "blob.bin");
    expect(file.kind).toBe("binary");
    expect(file.message).toContain("binary");
    expect(file.sizeBytes).toBe(4);
    expect(file.tokens).toBeUndefined();
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
    expect(file.imageVerdict).toEqual({ kind: "card" });
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
    // The count covers the displayed head, not the unread tail.
    const shownHead = Array.from({ length: MAX_HIGHLIGHT_LINES }, (_, i) => `line ${i}`).join("\n");
    expect(file.tokens).toBe(Math.ceil(shownHead.length / 4));
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

  /** A one-call image renderer stand-in (the loader makes exactly one call). */
  const imageRenderer = (render: () => Promise<RenderOutcome>): ImageRenderer => render;

  /** The rendered verdict, failing the test when the load produced a card. */
  function rendered(file: ViewerFile): Extract<ImageVerdict, { kind: "rendered" }> {
    const verdict = file.imageVerdict;
    if (verdict?.kind !== "rendered") {
      throw new Error(`expected a rendered verdict, got ${JSON.stringify(verdict)}`);
    }
    return verdict;
  }

  /** The card's failure entry, failing the test when the card carries none. */
  function failed(file: ViewerFile): { renderer: "native" | "chafa"; detail: string } {
    const verdict = file.imageVerdict;
    if (verdict?.kind !== "card" || verdict.failed === undefined) {
      throw new Error(`expected a failed card verdict, got ${JSON.stringify(verdict)}`);
    }
    return verdict.failed;
  }

  it("maps an ok outcome to the rendered verdict: renderer, rows, captured geometry, message preserved", async () => {
    const path = await writePng("pic.png");
    const card = await loadFile(path, "pic.png");
    const file = await loadFile(path, "pic.png", {
      image: { cols: 80, rows: 24 },
      imageRenderer: imageRenderer(async () => ({
        kind: "ok",
        renderer: "chafa",
        lines: ["\x1b[31m██\x1b[0m", "\x1b[32m░░\x1b[0m"],
        cols: 80,
        rows: 24,
      })),
    });
    expect(file.kind).toBe("image");
    const verdict = rendered(file);
    expect(verdict.renderer).toBe("chafa");
    expect(verdict.lines).toEqual(["\x1b[31m██\x1b[0m", "\x1b[32m░░\x1b[0m"]);
    expect(verdict.cols).toBe(80);
    expect(verdict.rows).toBe(24);
    expect(file.lines).toEqual([]);
    expect(file.message).toBe(card.message);
    expect(file.mtimeMs).toBe(card.mtimeMs);
  });

  it("maps a native ok outcome's geometry verbatim: the pipeline already stamped the request", async () => {
    const path = await writePng("native-ok.png");
    const file = await loadFile(path, "native-ok.png", {
      image: { cols: 60, rows: 20 },
      // pi-tui's aspect-fitted geometry is the pipeline's business; the outcome
      // carries the captured request and the loader keeps it as-is.
      imageRenderer: imageRenderer(async () => ({
        kind: "ok",
        renderer: "native",
        lines: ["\x1b]10;…\x1b\\"],
        cols: 60,
        rows: 20,
      })),
    });
    const verdict = rendered(file);
    expect(verdict.renderer).toBe("native");
    expect(verdict.lines).toEqual(["\x1b]10;…\x1b\\"]);
    expect(verdict.cols).toBe(60);
    expect(verdict.rows).toBe(20);
  });

  it("maps a failed outcome to the metadata card with the bounded failure", async () => {
    const path = await writePng("sad.png");
    const file = await loadFile(path, "sad.png", {
      image: { cols: 40, rows: 10 },
      imageRenderer: imageRenderer(async () => ({
        kind: "failed",
        renderer: "chafa",
        reason: "x".repeat(500),
      })),
    });
    expect(file.kind).toBe("image");
    expect(file.imageVerdict?.kind).toBe("card");
    const failure = failed(file);
    expect(failure).toEqual({ renderer: "chafa", detail: "x".repeat(199) + "\u2026" });
    expect(failure.detail.length).toBeLessThanOrEqual(200);
  });

  it("maps an aborted outcome to a card with NO failure (the load is discarded upstream)", async () => {
    const path = await writePng("aborted.png");
    const file = await loadFile(path, "aborted.png", {
      image: { cols: 40, rows: 10 },
      imageRenderer: imageRenderer(async () => ({ kind: "aborted" })),
    });
    expect(file.kind).toBe("image");
    // A supersession is not a renderer failure: no `failed` entry at all.
    expect(file.imageVerdict).toEqual({ kind: "card" });
  });

  it("treats a throwing renderer override as a failure-free card, never rejecting loadFile", async () => {
    // The pipeline never throws by contract; an override that does must not
    // reject the load (the defensive branch).
    const path = await writePng("boom.png");
    const file = await loadFile(path, "boom.png", {
      image: { cols: 40, rows: 10 },
      imageRenderer: async () => {
        throw new Error("pipeline exploded");
      },
    });
    expect(file.kind).toBe("image");
    expect(file.imageVerdict).toEqual({ kind: "card" });
  });

  it("keeps today's metadata card byte-for-byte without a renderer", async () => {
    const path = await writePng("plain.png");
    const file = await loadFile(path, "plain.png");
    expect(file.kind).toBe("image");
    expect(file.imageVerdict).toEqual({ kind: "card" });
    expect(file.message).toBe("64 B \u00b7 10x20");
    expect(file.sizeBytes).toBe(64);
    expect(file.lines).toEqual([]);
    expect(file.mtimeMs).toBeGreaterThan(0);
    // Byte-for-byte shape of the pre-chafa metadata card: one verdict field,
    // no tier/lines/geometry/error fields.
    expect(Object.keys(file).sort()).toEqual(
      ["imageVerdict", "kind", "lines", "message", "mtimeMs", "relPath", "sizeBytes"].sort(),
    );
  });

  // ── Loader contract details (Issue #144) ──

  describe("loadFile image loader contract (Issue #144)", () => {
    it("runs no renderer when the geometry hint is absent", async () => {
      const path = await writePng("no-geometry.png");
      let called = false;
      const file = await loadFile(path, "no-geometry.png", {
        imageRenderer: async () => {
          called = true;
          return { kind: "ok", renderer: "chafa", lines: ["unused"], cols: 1, rows: 1 };
        },
      });
      expect(called).toBe(false);
      expect(file.imageVerdict).toEqual({ kind: "card" });
    });

    it("produces the plain metadata card without a failure when only image opts are given (no renderer)", async () => {
      const path = await writePng("no-seam.png");
      const bare = await loadFile(path, "no-seam.png");
      const file = await loadFile(path, "no-seam.png", { image: { cols: 40, rows: 10 } });
      expect(file.kind).toBe("image");
      expect(file.imageVerdict).toEqual({ kind: "card" });
      expect(file.imageVerdict !== undefined && "failed" in file.imageVerdict).toBe(false);
      // Identical shape to the no-opts metadata card.
      expect({ ...file, mtimeMs: 0 }).toEqual({ ...bare, mtimeMs: 0 });
    });

    it("performs no second stat when the session supplies the record", async () => {
      const path = await writePng("stat-handoff.png");
      statLog.calls = 0;
      const file = await loadFile(path, "stat-handoff.png", {
        stat: { isFile: true, sizeBytes: 64, mtimeMs: 1234 },
      });
      expect(statLog.calls).toBe(0);
      expect(file.kind).toBe("image");
      expect(file.sizeBytes).toBe(64);
      expect(file.mtimeMs).toBe(1234);
      expect(file.message).toContain("64 B");
    });

    it("falls back to its own stat when no record is supplied", async () => {
      const path = await writePng("own-stat.png");
      statLog.calls = 0;
      const file = await loadFile(path, "own-stat.png");
      expect(statLog.calls).toBe(1);
      expect(file.sizeBytes).toBe(64);
    });

    it("uses the supplied stat's isFile instead of touching the disk", async () => {
      const path = await writePng("not-a-file.png");
      statLog.calls = 0;
      const file = await loadFile(path, "not-a-file.png", {
        stat: { isFile: false, sizeBytes: 1, mtimeMs: 1 },
      });
      expect(file.kind).toBe("error");
      expect(file.message).toBe("not a regular file");
      expect(statLog.calls).toBe(0);
    });
  });

  it("ignores the image params on markdown files (rawText regression)", async () => {
    const path = join(dir, "doc.md");
    const content = "# Title\n\t- tab item\n";
    await writeFile(path, content);
    const file = await loadFile(path, "doc.md", {
      imageRenderer: async () => ({ kind: "ok", renderer: "chafa", lines: ["unused"], cols: 1, rows: 1 }),
      image: { cols: 80, rows: 24 },
    });
    expect(file.kind).toBe("text");
    expect(file.rawText).toBe(content);
    expect(file.imageVerdict).toBeUndefined();
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

// ── Issue #136: retained highlight source + restyle ──

describe("style retention and restyleViewerFile (Issue #136)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-nav-restyle-"));
    highlightLog.inputs.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("retains styleText and styleKey on a highlighted text file", async () => {
    const path = join(dir, "code.ts");
    await writeFile(path, "const x = 1;\n// note");
    const file = await loadFile(path, "code.ts", { styleKey: "key-A" });
    expect(file.kind).toBe("text");
    expect(file.styleKey).toBe("key-A");
    // styleText is exactly the string the highlighter was handed (CR-
    // normalized and tab-expanded), proven independently by the input log.
    expect(file.styleText).toBe(highlightLog.inputs.at(-1));
    expect(file.styleText).toBe("const x = 1;\n// note");
    // rawText semantics are untouched: this is not a markdown file.
    expect(file.rawText).toBeUndefined();
  });

  it("retains the tab-expanded text, not the raw source", async () => {
    const path = join(dir, "tabs.ts");
    await writeFile(path, "const x = 1;\t// tab");
    const file = await loadFile(path, "tabs.ts");
    expect(file.styleText).toBe("const x = 1;    // tab"); // tab stop 4 from column 12
    expect(file.styleText).toBe(highlightLog.inputs.at(-1));
  });

  it("leaves styleText/styleKey absent for an unknown-language file", async () => {
    const path = join(dir, "notes.txt");
    await writeFile(path, "plain\ntext");
    const file = await loadFile(path, "notes.txt", { styleKey: "key-A" });
    expect(file.kind).toBe("text");
    expect(file.styleText).toBeUndefined();
    expect(file.styleKey).toBeUndefined();
    expect(file.lines).toEqual(["plain", "text"]);
  });

  it("retains the capped head as styleText for a truncated file", async () => {
    const path = join(dir, "huge.ts");
    const lines = Array.from({ length: MAX_HIGHLIGHT_LINES + 10 }, (_, i) => `const v${i} = ${i};`);
    await writeFile(path, lines.join("\n"));
    const file = await loadFile(path, "huge.ts", { styleKey: "key-A" });
    expect(file.kind).toBe("truncated");
    expect(file.styleKey).toBe("key-A");
    expect(file.styleText?.split("\n")).toHaveLength(MAX_HIGHLIGHT_LINES);
    expect(file.styleText?.split("\n")[0]).toBe("const v0 = 0;");
    expect(file.styleText).toBe(highlightLog.inputs.at(-1));
  });

  it("returns a new object re-highlighted from styleText under the new key", () => {
    const file: ViewerFile = {
      kind: "text",
      relPath: "code.ts",
      lines: ["<stale>"],
      styleText: "const x = 1;",
      styleKey: "key-A",
    };
    const out = restyleViewerFile(file, "key-B");
    expect(out).not.toBe(file);
    expect(out.styleKey).toBe("key-B");
    expect(out.styleText).toBe("const x = 1;");
    expect(out.lines).not.toEqual(["<stale>"]);
    expect(stripAnsi(out.lines[0] ?? "")).toBe("const x = 1;");
    // The re-highlight runs on exactly the retained text. No other input.
    expect(highlightLog.inputs).toEqual(["const x = 1;"]);
  });

  it("returns the same reference when the key already matches", () => {
    const file: ViewerFile = {
      kind: "text",
      relPath: "code.ts",
      lines: ["x"],
      styleText: "x",
      styleKey: "key-A",
    };
    expect(restyleViewerFile(file, "key-A")).toBe(file);
    expect(highlightLog.inputs).toEqual([]);
  });

  it("returns the same reference when styleText is absent", () => {
    const file: ViewerFile = { kind: "text", relPath: "notes.txt", lines: ["plain"], styleKey: "key-A" };
    expect(restyleViewerFile(file, "key-B")).toBe(file);
    expect(highlightLog.inputs).toEqual([]);
  });

  it("restyles truncated files too, keeping every other field", () => {
    const file: ViewerFile = {
      kind: "truncated",
      relPath: "huge.ts",
      lines: ["<stale>"],
      styleText: "const x = 1;",
      styleKey: "key-A",
      notice: "Truncated view: too many lines.",
      lineCount: 99,
      sizeBytes: 1234,
      mtimeMs: 42,
    };
    const out = restyleViewerFile(file, "key-B");
    expect(out.kind).toBe("truncated");
    expect(out.notice).toBe("Truncated view: too many lines.");
    expect(out.lineCount).toBe(99);
    expect(out.sizeBytes).toBe(1234);
    expect(out.mtimeMs).toBe(42);
    expect(out.styleKey).toBe("key-B");
    expect(out.lines).not.toEqual(["<stale>"]);
  });
});

describe("inkRuns (Issue #165)", () => {
  it("returns one run with no colour for plain text", () => {
    expect(inkRuns("plain text")).toEqual([{ text: "plain text", color: null }]);
  });

  it("tags runs with the active indexed foreground and resets on 39", () => {
    expect(inkRuns("\x1b[38;5;240mfoo\x1b[39mbar")).toEqual([
      { text: "foo", color: "38;5;240" },
      { text: "bar", color: null },
    ]);
  });

  it("keeps the foreground across bold and resets it on 0", () => {
    expect(inkRuns("\x1b[1m\x1b[38;2;1;2;3mabc\x1b[0m\x1b[1mde")).toEqual([
      { text: "abc", color: "38;2;1;2;3" },
      { text: "de", color: null },
    ]);
  });

  it("ignores backgrounds and non-colour codes", () => {
    // A background change does not touch the foreground, so the run continues.
    expect(inkRuns("\x1b[48;5;9mx\x1b[49my")).toEqual([{ text: "xy", color: null }]);
    expect(inkRuns("\x1b[7;4mz")).toEqual([{ text: "z", color: null }]);
  });

  it("strips non-SGR escapes without treating them as colour", () => {
    expect(inkRuns("\x1b]8;;http://x\x07link\x1b]8;;\x07")).toEqual([{ text: "link", color: null }]);
  });

  it("carries a mid-sequence colour set in one SGR list", () => {
    expect(inkRuns("\x1b[1;38;5;42mab")).toEqual([{ text: "ab", color: "38;5;42" }]);
  });
});
