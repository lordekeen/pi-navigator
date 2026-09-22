/**
 * frame.ts suites (Issue #064 view-model extraction): overlay geometry,
 * split math, chrome helpers (padTo / joinLeftRight / shortPath /
 * truncateAndWidth), the hint tables, and the title/footer rows. The identity
 * theme passes text through unchanged, so width assertions run on plain
 * strings via the real pi-tui visibleWidth; a tone-tagging theme verifies
 * which theme channel a builder used without hardcoding colors.
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import { LEFT_COLUMN_HIDE_BELOW } from "../constants";
import {
  bodyRows,
  buildFooterRow,
  buildTitleRow,
  filesArea,
  FOCUS_HINTS,
  getFooterHint,
  isImageLine,
  joinLeftRight,
  leftColumnWidth,
  MODE_HINTS,
  overlayHeight,
  padTo,
  shortPath,
  splitRows,
  truncateAndWidth,
  useLeftColumn,
  viewerArea,
} from "../frame";
import { makeNavigatorTheme } from "../theme";
import type { GitState } from "../types";

const identityTheme = makeNavigatorTheme({
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
} as never);

/** Same shape, but every fg call tags the channel name — no hardcoded colors. */
const toneTheme = makeNavigatorTheme({
  fg: (c: string, t: string) => `${c}:${t}`,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
} as never);

function gitState(partial: Partial<GitState> = {}): GitState {
  return {
    available: true,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    unstaged: [],
    staged: [],
    history: [],
    refreshedAt: 0,
    ...partial,
  };
}

describe("overlay geometry", () => {
  it("overlayHeight: 85% of rows, never above rows-2, 0 falls back to 24", () => {
    expect(overlayHeight(24)).toBe(20); // floor(24*0.85)=20, min(20, 22)=20
    expect(overlayHeight(36)).toBe(30);
    expect(overlayHeight(1000)).toBe(850); // min(850, 998)
    expect(overlayHeight(0)).toBe(20); // fallback 24 rows -> 20
  });

  it("bodyRows: five chrome rows, floored at 4", () => {
    expect(bodyRows(30)).toBe(25);
    expect(bodyRows(5)).toBe(4);
  });
});

describe("left column", () => {
  it("leftColumnWidth clamps the 30% ratio into [24, 44]", () => {
    expect(leftColumnWidth(50)).toBe(24); // max(24, 15)
    expect(leftColumnWidth(300)).toBe(44); // min(44, 90)
    expect(leftColumnWidth(100)).toBe(30);
  });

  it("useLeftColumn gates on tree visibility, body size and inner width", () => {
    expect(useLeftColumn(100, 25, false)).toBe(false);
    expect(useLeftColumn(100, 7, true)).toBe(false); // body < 8
    expect(useLeftColumn(LEFT_COLUMN_HIDE_BELOW - 1, 25, true)).toBe(false);
    expect(useLeftColumn(100, 25, true)).toBe(true);
  });
});

describe("splitRows", () => {
  it("splits 55/45 with one separator row at a healthy body size", () => {
    const { filesH, gitH } = splitRows(25);
    expect(filesH).toBe(13);
    expect(gitH).toBe(11);
    expect(filesH + gitH + 1).toBe(25);
    expect(gitH).toBeGreaterThanOrEqual(4); // GIT_MIN_ROWS
  });

  it("keeps the plain split at the minimum body", () => {
    expect(splitRows(12)).toEqual({ filesH: 6, gitH: 5 });
  });

  it("hands the slack to the git pane when 55% leaves it under GIT_MIN_ROWS", () => {
    expect(splitRows(8)).toEqual({ filesH: 3, gitH: 4 });
  });
});

describe("pane areas", () => {
  it("filesArea(36) is 12 and viewerArea(36) is 24, both floored at 2", () => {
    expect(filesArea(36)).toBe(12); // max(2, splitRows(bodyRows(30)).filesH - 1)
    expect(viewerArea(36)).toBe(24); // max(2, bodyRows(30) - 1)
    expect(filesArea(36)).toBeGreaterThanOrEqual(2);
    expect(viewerArea(36)).toBeGreaterThanOrEqual(2);
  });
});

describe("padTo", () => {
  it("pads short strings, hard-cuts long ones, and never splits a wide char", () => {
    expect(padTo("ab", 5)).toBe("ab   ");
    expect(visibleWidth(padTo("abcdef", 4))).toBe(4);
    const wide = "日本語テスト"; // 5 chars, 10 cells
    const cut = padTo(wide, 6);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(6);
    // hardTruncate re-terminates a cut with a trailing reset, so strip it
    // before checking the prefix relationship (no split code unit).
    expect(wide.startsWith(cut.replace(/\x1b\[0m$/, ""))).toBe(true);
    expect(cut.length).toBeGreaterThan(0);
  });
});

describe("joinLeftRight", () => {
  it("sacrifices the left side so the right side survives intact", () => {
    const left = "x".repeat(30);
    const right = "right-tail";
    const out = joinLeftRight(left, right, 20);
    expect(out.endsWith(right)).toBe(true);
    expect(visibleWidth(out)).toBeLessThanOrEqual(20);
  });

  it("keeps both sides and fills the gap when everything fits", () => {
    const out = joinLeftRight("ab", "cd", 10);
    expect(out.startsWith("ab")).toBe(true);
    expect(out.endsWith("cd")).toBe(true);
    expect(visibleWidth(out)).toBe(10);
  });

  it("passes a native image row through unchanged on either side", () => {
    const kitty = "\x1b_Ga=T,f=100,q=2,C=1,c=20,r=5,i=7;AAAA\x1b\\" + " ".repeat(12);
    const iterm2 = "\x1b]1337;File=inline=1;size=9;width=20:AAAA\x07";
    expect(joinLeftRight("left", kitty, 40)).toBe(kitty);
    expect(joinLeftRight(kitty, "right", 40)).toBe(kitty);
    expect(joinLeftRight("left", iterm2, 40)).toBe(iterm2);
    expect(joinLeftRight(iterm2, "right", 40)).toBe(iterm2);
  });
});

describe("isImageLine", () => {
  it("recognizes the kitty APC and iTerm2 OSC-1337 prefixes, not plain or styled text", () => {
    expect(isImageLine("\x1b_Ga=T,f=100,q=2,C=1,c=20,r=5,i=1;AAAA\x1b\\")).toBe(true);
    expect(isImageLine("\x1b]1337;File=inline=1;size=9;width=20:AAAA\x07")).toBe(true);
    expect(isImageLine("plain text")).toBe(false);
    expect(isImageLine("\x1b[31mstyled\x1b[0m")).toBe(false);
    expect(isImageLine("")).toBe(false);
  });
});

describe("truncateAndWidth", () => {
  it("cuts to maxWidth and reports the measured width of the result", () => {
    const fit = truncateAndWidth("hello", 10);
    expect(fit.text).toBe("hello");
    expect(fit.width).toBe(visibleWidth("hello"));
    const cut = truncateAndWidth("abcdefgh", 4);
    expect(cut.width).toBeLessThanOrEqual(4);
    expect(cut.width).toBe(visibleWidth(cut.text));
  });
});

describe("shortPath", () => {
  it("tildes the home prefix, leaves foreign paths alone, ellipsizes long ones", () => {
    expect(shortPath("/home/u/proj", "/home/u")).toBe("~/proj");
    expect(shortPath("/other/proj", "/home/u")).toBe("/other/proj");
    const long = "/x" + "y".repeat(58); // 60 chars
    const out = shortPath(long, "/home/u");
    expect(out.startsWith("\u2026")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(48);
  });
});

describe("getFooterHint", () => {
  it("normal mode picks the focus hint; modal modes pick the mode hint", () => {
    expect(getFooterHint("normal", "files")).toBe(FOCUS_HINTS.files);
    expect(getFooterHint("normal", "git")).toBe(FOCUS_HINTS.git);
    expect(getFooterHint("normal", "viewer")).toBe(FOCUS_HINTS.viewer);
    expect(getFooterHint("help", "files")).toBe(MODE_HINTS.help);
    expect(getFooterHint("filter", "files")).toBe(MODE_HINTS.filter);
    expect(getFooterHint("search", "viewer")).toBe(MODE_HINTS.search);
  });
});

describe("buildTitleRow", () => {
  it("renders branch + counters at innerW 98 and fits the width", () => {
    const row = buildTitleRow(98, {
      theme: identityTheme,
      cwd: "/work/repo",
      home: "/home/u",
      git: gitState({ ahead: 2, behind: 1, unstaged: [{ relPath: "a.ts", code: "M" }, { relPath: "b.ts", code: "M" }, { relPath: "c.ts", code: "M" }] }),
    });
    expect(row).toContain("main");
    expect(row).toContain("\u21912");
    expect(row).toContain("\u21931");
    expect(row).toContain("3 changed");
    expect(visibleWidth(row)).toBeLessThanOrEqual(98);
  });

  it("falls back to 'no git' when git is unavailable", () => {
    const row = buildTitleRow(98, {
      theme: identityTheme,
      cwd: "/work",
      home: "/home/u",
      git: gitState({ available: false }),
    });
    expect(row).toContain("no git");
    expect(row).not.toContain("main");
    expect(visibleWidth(row)).toBeLessThanOrEqual(98);
  });
});

describe("buildFooterRow", () => {
  it("shows the notice instead of pane labels when a notice is set", () => {
    const row = buildFooterRow(98, {
      theme: toneTheme,
      mode: "normal",
      focus: "files",
      notice: "terminal too small",
    });
    expect(row).toContain("terminal too small");
    expect(row).not.toContain("viewer");
    expect(visibleWidth(row)).toBeLessThanOrEqual(98);
  });

  it("labels the panes and accents the focused one via the theme", () => {
    const row = buildFooterRow(98, {
      theme: toneTheme,
      mode: "normal",
      focus: "git",
      notice: null,
    });
    expect(row).toContain("accent:git"); // focused pane is accent+bold
    expect(row).toContain("dim:files");
    expect(row).toContain("dim:viewer");
    // joinLeftRight guarantees the right side (pane labels) and truncates the
    // left (the 84-cell git hint cannot fit at innerW 98 next to the labels),
    // so the contract is width-safety plus an intact pane-label segment — not
    // the untruncated hint.
    expect(row).toContain("dim:files  accent:git  dim:viewer");
    expect(visibleWidth(row)).toBeLessThanOrEqual(98);
  });
});
