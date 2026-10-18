/**
 * help_view.ts suites (Issue #064 view-model extraction): how many help
 * rows fit, the scroll limit, and the modal composition written into the
 * caller's line buffer. The identity theme passes text through, so width
 * assertions use the real pi-tui visibleWidth.
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import { composeHelp, helpMaxScroll, helpVisibleRows } from "../help_view";
import { makeNavigatorTheme } from "../theme";

const identityTheme = makeNavigatorTheme({
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
} as never);

const HELP_ROWS: Array<[string, string]> = Array.from({ length: 30 }, (_, i) => [
  `key${i}`,
  `desc line ${i}`,
]);

describe("helpVisibleRows", () => {
  it("fits body-4 rows, floored at 1 and capped by the row count", () => {
    expect(helpVisibleRows(25, 30)).toBe(21);
    expect(helpVisibleRows(6, 30)).toBe(2); // max(1, 6-4)=2
    expect(helpVisibleRows(30, 2)).toBe(2); // capped by length
  });
});

describe("helpMaxScroll", () => {
  it("is the scrollable slack, never negative", () => {
    expect(helpMaxScroll(30, 21)).toBe(9);
    expect(helpMaxScroll(2, 2)).toBe(0);
  });
});

describe("composeHelp", () => {
  const innerW = 40;
  const body = 25;
  const line = `|${"-".repeat(38)}|`; // 40-wide buffer row, borders included

  function compose(helpScroll: number, helpRows = HELP_ROWS): { lines: string[]; modified: number[] } {
    const lines = Array.from({ length: 30 }, () => line);
    composeHelp(lines, innerW, body, { theme: identityTheme, helpRows, helpScroll });
    const modified = lines.map((l, i) => [i, l] as const).filter(([, l]) => l !== line).map(([i]) => i);
    return { lines, modified };
  }

  it("composes at innerW 3 without throwing (Issue #217)", () => {
    const lines = ["", "", "", "", "", ""];
    expect(() =>
      composeHelp(lines, 3, 6, { theme: identityTheme, helpRows: HELP_ROWS, helpScroll: 0 }),
    ).not.toThrow();
  });

  it("writes the box into the centered row range, every line width-safe", () => {
    const { lines, modified } = compose(9);
    // boxW = min(innerW-2, 66) = 38, visibleRows = 21, boxH = 24, startRow = 0
    expect(modified).toHaveLength(24);
    expect(modified[0]).toBe(3); // top border row
    expect(modified.at(-1)).toBe(26); // bottom border row
    expect(lines[3]!.includes("\u256d")).toBe(true);
    expect(lines[26]!.includes("\u2570")).toBe(true);
    for (const row of modified) {
      const lineRow = lines[row]!;
      expect(lineRow.startsWith("\u2502")).toBe(true);
      expect(lineRow.endsWith("\u2502")).toBe(true);
      // interior between the frame bars fits the inner width
      expect(visibleWidth(lineRow.slice(1, -1))).toBeLessThanOrEqual(innerW);
    }
  });

  it("scrolls the key rows by the clamped offset and leaves other rows untouched", () => {
    const { lines, modified } = compose(9);
    const firstKeyRow = lines[5]!; // 3 + startRow(0) + 2 (top border, title)
    expect(lines[4]).toContain("pi-navigator \u2014 keys"); // branded title row
    expect(firstKeyRow).toContain(`key${9}`); // first visible key = helpRows[helpScroll]
    expect(lines[6]).toContain("key10");
    for (const row of modified) {
      expect(row).toBeGreaterThanOrEqual(3);
      expect(row).toBeLessThanOrEqual(26);
    }
    for (const outside of [0, 1, 2, 27, 28, 29]) {
      expect(lines[outside]).toBe(line);
    }
  });
});
