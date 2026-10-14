/**
 * minimap_view.ts suite (Issue #165): folding, the viewport band, both
 * encodings, and width safety. The theme is a tag-ANSI stub so a test can tell
 * which tone painted a row without the tag affecting `visibleWidth`.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { buildMinimap, renderMinimap, type MinimapInput } from "../minimap_view";
import type { NavigatorTheme } from "../theme";
import { stripAnsi } from "../viewer";

const INK = "\x1b[38;5;11m";
const BAND = "\x1b[48;5;12m";
const MUTED = "\x1b[38;5;8m";
const ACCENT = "\x1b[38;5;6m";
const ADD = "\x1b[38;5;9m";
const REM = "\x1b[38;5;13m";
const CTX = "\x1b[38;5;14m";

function makeTheme(): NavigatorTheme {
  const plain = (t: string): string => t;
  return {
    accent: (t) => `${ACCENT}${t}\x1b[39m`,
    muted: (t) => `${MUTED}${t}\x1b[39m`,
    dim: plain,
    success: plain,
    warning: plain,
    error: plain,
    text: plain,
    bold: plain,
    selectedBg: (t) => `${BAND}${t}\x1b[49m`,
    searchMatch: plain,
    searchCurrent: plain,
    frame: plain,
    scrollbarTrack: plain,
    scrollbarThumb: (t) => `${INK}${t}\x1b[39m`,
    diffAdded: (t) => `${ADD}${t}\x1b[39m`,
    diffRemoved: (t) => `${REM}${t}\x1b[39m`,
    diffContext: (t) => `${CTX}${t}\x1b[39m`,
    syntax: (code, t) => `\x1b[${code}m${t}\x1b[39m`,
  };
}

function input(over: Partial<MinimapInput> = {}): MinimapInput {
  return {
    texts: [],
    area: 4,
    width: 6,
    encoding: "braille",
    palette: "mono",
    diff: false,
    theme: makeTheme(),
    ...over,
  };
}

function lines(n: number): string[] {
  return Array.from({ length: n }, () => "x");
}

function banded(rows: readonly string[]): boolean[] {
  return rows.map((row) => row.includes(BAND));
}

describe("buildMinimap folding (Bresenham blocks)", () => {
  it("folds 100 rows into 28 contiguous blocks of s or s+1 rows", () => {
    const sketch = buildMinimap(input({ texts: lines(100), area: 28 }));
    expect(sketch).not.toBeNull();
    const blocks = sketch!.blocks;
    expect(blocks).toHaveLength(28);
    expect(blocks[0]!.start).toBe(0);
    expect(blocks[blocks.length - 1]!.end).toBe(100);
    let total = 0;
    for (let k = 0; k < blocks.length; k += 1) {
      const block = blocks[k]!;
      const size = block.end - block.start;
      expect(size === 3 || size === 4).toBe(true);
      if (k > 0) expect(block.start).toBe(blocks[k - 1]!.end);
      total += size;
    }
    expect(total).toBe(100);
  });

  it("maps a file that exactly fills the pane to no map", () => {
    expect(buildMinimap(input({ texts: lines(4), area: 4 }))).toBeNull();
    expect(buildMinimap(input({ texts: lines(5), area: 4 }))).not.toBeNull();
  });

  it("is deterministic for the same input", () => {
    const texts = ["a", " b ", "c"];
    expect(buildMinimap(input({ texts, area: 2, width: 5 }))).toEqual(
      buildMinimap(input({ texts, area: 2, width: 5 })),
    );
  });
});

describe("renderMinimap band", () => {
  it("puts the band on the last block when the viewport ends the file", () => {
    const sketch = buildMinimap(input({ texts: lines(10), area: 5 }))!;
    expect(banded(renderMinimap(sketch, 8, 2, makeTheme()))).toEqual([false, false, false, false, true]);
  });

  it("covers every block the viewport touches", () => {
    const sketch = buildMinimap(input({ texts: lines(20), area: 5 }))!;
    // Blocks of 4: [0,4) [4,8) [8,12) [12,16) [16,20). Viewport 3..9 touches 0,1,2.
    expect(banded(renderMinimap(sketch, 3, 6, makeTheme()))).toEqual([true, true, true, false, false]);
  });

  it("paints nothing when the viewport has no rows", () => {
    const sketch = buildMinimap(input({ texts: lines(10), area: 5 }))!;
    expect(banded(renderMinimap(sketch, 0, 0, makeTheme()))).toEqual([false, false, false, false, false]);
  });
});

describe("braille encoding", () => {
  it("renders the discriminating spatial vectors", () => {
    // A one-block map of four display rows: dot row == display row.
    const bottomLeft = buildMinimap(input({ texts: [" ", " ", " ", "x"], area: 1, width: 1 }))!;
    expect(stripAnsi(bottomLeft.rows[0]!)).toBe("\u2840"); // dot 7
    const twoLeft = buildMinimap(input({ texts: [" ", " ", "x", "x"], area: 1, width: 1 }))!;
    expect(stripAnsi(twoLeft.rows[0]!)).toBe("\u2844"); // dots 3 and 7
  });

  it("emits blank cells as U+2800 so the column never shifts", () => {
    const sketch = buildMinimap(input({ texts: ["", "", "", ""], area: 1, width: 3 }))!;
    expect(stripAnsi(sketch.rows[0]!)).toBe("\u2800\u2800\u2800");
  });
});

describe("bars encoding", () => {
  it("starts the block at the first ink bucket, not column 0", () => {
    const sketch = buildMinimap(input({ texts: ["  xx  xx", "   "], area: 1, width: 4, encoding: "bars" }))!;
    expect(stripAnsi(sketch.rows[0]!)).toBe(" \u2588\u2588\u2588");
  });

  it("emits spaces for a blank block", () => {
    const sketch = buildMinimap(input({ texts: ["   ", "   "], area: 1, width: 3, encoding: "bars" }))!;
    expect(stripAnsi(sketch.rows[0]!)).toBe("   ");
  });

  it("does not let a capped long line erase a short line's ink", () => {
    const sketch = buildMinimap(
      input({ texts: ["x".repeat(600), "", "ab", "", ""], area: 4, width: 6, encoding: "bars" }),
    )!;
    expect(stripAnsi(sketch.rows[2]!)).toBe("\u2588     ");
  });
});

describe("width safety", () => {
  it("keeps every row exactly width columns, both encodings", () => {
    for (const encoding of ["braille", "bars"] as const) {
      for (const width of [4, 6, 12]) {
        const sketch = buildMinimap(
          input({ texts: ["a".repeat(50), " ", "  x  ", ""], area: 3, width, encoding }),
        )!;
        expect(sketch.rows).toHaveLength(3);
        for (const row of sketch.rows) expect(visibleWidth(row)).toBe(width);
      }
    }
  });

  it("measures a wide (CJK) glyph without shifting the row", () => {
    const sketch = buildMinimap(input({ texts: ["  \u4e2d\u6587", " "], area: 1, width: 4, encoding: "bars" }))!;
    expect(stripAnsi(sketch.rows[0]!)).toBe(" \u2588\u2588\u2588");
    expect(visibleWidth(sketch.rows[0]!)).toBe(4);
  });
});

describe("mono ink tone", () => {
  it("paints ink in the scrollbar thumb tone", () => {
    const sketch = buildMinimap(input({ texts: ["x", " "], area: 1, width: 3, encoding: "bars" }))!;
    expect(sketch.rows[0]!.startsWith(INK)).toBe(true);
  });
});

describe("diff mirror (mono)", () => {
  const cases: Array<[string, string]> = [
    ["+++ b/x", MUTED],
    ["--- a/x", MUTED],
    ["diff --git a/x b/x", MUTED],
    ["index 123..456 100644", MUTED],
    ["new file mode 100644", MUTED],
    ["deleted file mode 100644", MUTED],
    ["Binary files a/x and b/x differ", MUTED],
    ["@@ -1 +1 @@", ACCENT],
    ["+added line", ADD],
    ["-removed line", REM],
    [" context line", CTX],
    ["commit subject with no prefix", CTX],
  ];

  it.each(cases)("paints %j with its diff tone", (line, tone) => {
    const sketch = buildMinimap(
      input({ texts: [line, " "], area: 1, width: 2, encoding: "bars", diff: true }),
    )!;
    expect(sketch.rows[0]!.startsWith(tone)).toBe(true);
  });
});

describe("syntax palette", () => {
  it("votes the dominant colour by character count", () => {
    const styled = "\x1b[38;5;1maa\x1b[39m\x1b[38;5;2mbcd\x1b[39m";
    const sketch = buildMinimap(
      input({ texts: [styled, " "], area: 1, width: 2, encoding: "bars", palette: "syntax" }),
    )!;
    expect(sketch.rows[0]!.startsWith("\x1b[38;5;2m")).toBe(true);
  });

  it("takes the block's max-ink row as the representative", () => {
    const long = `\x1b[38;5;3m${"y".repeat(40)}\x1b[39m`;
    const short = "\x1b[38;5;4mzz\x1b[39m";
    const sketch = buildMinimap(
      input({ texts: [short, long], area: 1, width: 2, encoding: "bars", palette: "syntax" }),
    )!;
    expect(sketch.rows[0]!.startsWith("\x1b[38;5;3m")).toBe(true);
  });

  it("falls back to the ink tone when the row has no colour", () => {
    const sketch = buildMinimap(
      input({ texts: ["plain", " "], area: 1, width: 2, encoding: "bars", palette: "syntax" }),
    )!;
    expect(sketch.rows[0]!.startsWith(INK)).toBe(true);
  });

  it("falls back to the diff mirror for an uncoloured diff row", () => {
    const sketch = buildMinimap(
      input({ texts: ["+x", " "], area: 1, width: 2, encoding: "bars", palette: "syntax", diff: true }),
    )!;
    expect(sketch.rows[0]!.startsWith(ADD)).toBe(true);
  });
});
