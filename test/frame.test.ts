/**
 * frame.ts suites (Issue #064 view-model extraction; Issue #148 split): the
 * chrome helpers (padTo / joinLeftRight / shortPath / truncateAndWidth), the
 * frame assembly (composeFrame / buildCompactFrame / buildScrollbarBorder),
 * and the title/footer rows. The identity theme passes text through
 * unchanged, so width assertions run on plain strings via the real pi-tui
 * visibleWidth; a tone-tagging theme verifies which theme channel a builder
 * used without hardcoding colors. Layout math lives in layout.test.ts and
 * the hint tables in help.test.ts.
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  buildCompactFrame,
  buildFooterRow,
  buildScrollbarBorder,
  buildTitleRow,
  buildTopBorder,
  composeFrame,
  fitHint,
  FRAME_CORNERS,
  getFooterHint,
  isImageLine,
  joinLeftRight,
  leftBudget,
  padTo,
  shortPath,
  truncateAndWidth,
  type FrameView,
} from "../frame";
import { FOCUS_HINTS, MODE_HINTS, plainHint } from "../help";
import { makeNavigatorTheme } from "../theme";
import type { Focus, GitState, NavigatorLayout } from "../types";

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
    // The left segment fills exactly the composer's published budget, then
    // the one gap cell, then the right segment (Issue #147). hardTruncate
    // re-terminates the cut with a reset, hence the strip.
    const budget = leftBudget(20, right);
    expect(budget).toBe(9);
    const plain = out.replace("\x1b[0m", "");
    expect(plain.startsWith("x".repeat(budget))).toBe(true);
    expect(plain.slice(budget)).toBe(" " + right);
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

describe("leftBudget (Issue #147)", () => {
  it("is the widest left segment that leaves the right segment its one gap cell", () => {
    expect(leftBudget(20, "cd")).toBe(17); // joinLeftRight: maxLeft = 20 - 2 - 1
    expect(leftBudget(4, "abcd")).toBe(0); // floored, never negative
    expect(leftBudget(0, "")).toBe(0);
  });

  it("measures the right segment with visibleWidth, not its code-unit length", () => {
    // Styled text: 9 code units, 2 visible cells; and wide chars: 1 code
    // point, 2 cells each. A `.length` budget would under-count the former
    // and over-count the latter.
    expect(leftBudget(10, "\x1b[2mab\x1b[0m")).toBe(7); // 10 - 2 - 1
    expect(leftBudget(10, "\u65e5\u672c")).toBe(5); // 10 - 4 - 1
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

describe("getFooterHint markdown applicability (Issue #135 L1)", () => {
  it("drops the `m` pair from the viewer hint when the file cannot render markdown", () => {
    const hint = getFooterHint("normal", "viewer", { markdownApplicable: false });
    expect(hint).not.toContainEqual({ keys: "m", label: "mode" });
    expect(hint).toContainEqual({ keys: "w", label: "wrap" });
    expect(hint).toContainEqual({ keys: "/", label: "search" });
    // Removing a pair leaves neither a fragment nor a doubled separator.
    const text = plainHint(hint);
    expect(text).not.toContain("mode");
    expect(text).not.toContain("\u00b7 \u00b7");
    expect(text).not.toContain("  ");
  });

  it("keeps it when the file can render markdown, or when applicability is unknown", () => {
    expect(getFooterHint("normal", "viewer", { markdownApplicable: true })).toContainEqual({
      keys: "m",
      label: "mode",
    });
    expect(getFooterHint("normal", "viewer")).toContainEqual({ keys: "m", label: "mode" });
    // Other focuses and modes are unaffected either way.
    expect(getFooterHint("normal", "files", { markdownApplicable: false })).toBe(FOCUS_HINTS.files);
    expect(getFooterHint("filter", "viewer", { markdownApplicable: false })).toBe(MODE_HINTS.filter);
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

  it("hint tables are typed keys/label pairs carrying the same items (Issue #137 §1)", () => {
    expect(FOCUS_HINTS.files[0]).toEqual({ keys: "j k", label: "move" });
    // Label-less items gained the minimal action label.
    expect(FOCUS_HINTS.files).toContainEqual({ keys: "g G Home/End", label: "jump" });
    expect(FOCUS_HINTS.files).toContainEqual({ keys: "Tab", label: "pane" });
    expect(FOCUS_HINTS.viewer).toContainEqual({ keys: "Ctrl+d/u PgUp/PgDn", label: "page" });
    // Split items keep their keys on the left and action on the right.
    expect(FOCUS_HINTS.git).toContainEqual({ keys: "Enter", label: "open/diff" });
    expect(MODE_HINTS.search).toContainEqual({ keys: "type", label: "to search" });
    expect(MODE_HINTS.filter).toContainEqual({ keys: "type", label: "to filter" });
    expect(MODE_HINTS.help).toContainEqual({ keys: "q Esc ?", label: "close help" });
    for (const pairs of Object.values(FOCUS_HINTS)) {
      for (const pair of pairs) {
        expect(pair.keys).toBe(pair.keys.trim());
        expect(pair.label).toBe(pair.label.trim());
        expect(pair.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("buildTitleRow", () => {
  it("renders the subtitle row (path + branch/counters) at innerW 98 and fits the width", () => {
    const row = buildTitleRow(98, {
      theme: identityTheme,
      cwd: "/work/repo",
      home: "/home/u",
      git: gitState({ ahead: 2, behind: 1, unstaged: [{ relPath: "a.ts", code: "M" }, { relPath: "b.ts", code: "M" }, { relPath: "c.ts", code: "M" }] }),
    });
    expect(row).toContain("/work/repo");
    expect(row).toContain("main");
    expect(row).toContain("\u21912");
    expect(row).toContain("\u21931");
    expect(row).toContain("3 changed");
    // Issue #137 §2: the product name moved to the top-border pill; the
    // subtitle row must not repeat it.
    expect(row).not.toContain("pi-navigator");
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

describe("fitHint (Issue #135 L4, pair-aware since #137)", () => {
  const pairs = FOCUS_HINTS.files;

  it("returns the pairs unchanged when they fit", () => {
    expect(fitHint(pairs, 200)).toBe(pairs);
  });

  it("keeps only whole trailing pairs, never a fragment", () => {
    const fitted = fitHint(pairs, 30);
    expect(visibleWidth(plainHint(fitted))).toBeLessThanOrEqual(30);
    expect(fitted.length).toBeGreaterThan(0);
    for (const pair of fitted) expect(pairs).toContain(pair);
    // The pair's two cells always travel together.
    expect(fitted[0]).toEqual({ keys: "j k", label: "move" });
  });

  it("returns an empty list when not even the first pair fits", () => {
    expect(fitHint(pairs, 3)).toEqual([]);
    expect(fitHint(pairs, 0)).toEqual([]);
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

  it("drops whole trailing pairs at 80 columns rather than cutting one mid-phrase (Issue #135 L4, #137 §1)", () => {
    // innerW 78 is an 80-column terminal. Before the fit, joinLeftRight cut the
    // hint mid-item to make room for the pane labels. The identity theme is
    // required here: toneTheme's "channel:text" tags count as visible width, so
    // the budget arithmetic would be measured against inflated labels.
    const row = buildFooterRow(78, { theme: identityTheme, mode: "normal", focus: "files", notice: null });
    expect(visibleWidth(row)).toBeLessThanOrEqual(78);
    // The pane labels keep their place on the right...
    expect(row).toContain("files");
    expect(row).toContain("viewer");
    // ...the pairs that fit stay whole...
    expect(row).toContain("Tab pane");
    // ...and the first pair that does not fit takes the tail with it.
    expect(row).not.toContain("/ filter");
    expect(row).not.toContain("q close");
  });

  it("keeps the pairs intact when they fit (innerW 119) and sheds them whole at 98", () => {
    // The typed pairs render a few cells wider than the old two-space items,
    // and the close pair now bakes in the default cancel key (#137 §5):
    // the full files hint fits at innerW 119 but not at innerW 98, where it
    // sheds trailing pairs as units.
    const wide = buildFooterRow(119, { theme: identityTheme, mode: "normal", focus: "files", notice: null });
    expect(wide).toContain(plainHint(FOCUS_HINTS.files));
    const hundred = buildFooterRow(98, { theme: identityTheme, mode: "normal", focus: "files", notice: null });
    expect(hundred).toContain(". hidden");
    expect(hundred).not.toContain("? help");
    expect(visibleWidth(hundred)).toBeLessThanOrEqual(98);
  });

  it("advertises the default cancel key in the close pair of every focus table (Issue #137 §5)", () => {
    // `Esc` is baked into the tables — the default cancel binding, matching
    // help.ts — so a rendered footer shows `q Esc close` when the pair fits.
    for (const focus of ["files", "git", "viewer"] as const) {
      expect(FOCUS_HINTS[focus]).toContainEqual({ keys: "q Esc", label: "close" });
    }
    const row = buildFooterRow(120, { theme: identityTheme, mode: "normal", focus: "files", notice: null });
    expect(row).toContain("q Esc close");
    // The help-mode hint keeps its own close wording.
    const help = buildFooterRow(120, { theme: identityTheme, mode: "help", focus: "files", notice: null });
    expect(help).toContain("q Esc ? close help");
  });

  it("counts the baked-in `Esc` in the close pair's budget, dropping the pair whole when it no longer fits (Issue #137 §5)", () => {
    // "j k move · q close" is 18 cells and fits a budget of 18; the same
    // pairs with the baked-in key are "j k move · q Esc close" — 22 — and
    // the pair leaves whole rather than being cut mid-phrase.
    const plain = [
      { keys: "j k", label: "move" },
      { keys: "q", label: "close" },
    ];
    expect(visibleWidth(plainHint(plain))).toBe(18);
    expect(fitHint(plain, 18)).toEqual(plain);
    const baked = [
      { keys: "j k", label: "move" },
      { keys: "q Esc", label: "close" },
    ];
    expect(visibleWidth(plainHint(baked))).toBe(22);
    expect(fitHint(baked, 18)).toEqual([{ keys: "j k", label: "move" }]);
    expect(fitHint(baked, 22)).toEqual(baked);
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
    // left (the full git hint cannot fit at innerW 98 next to the labels),
    // so the contract is width-safety plus an intact pane-label segment — not
    // the untruncated hint.
    expect(row).toContain("dim:files  accent:git  dim:viewer");
    expect(visibleWidth(row)).toBeLessThanOrEqual(98);
  });

  // Issue #119: the pane-label list follows the layout, not the hide state.
  it("drops the panes a layout lacks from the footer labels (Issue #119)", () => {
    const labels = (layout: NavigatorLayout | undefined, focus: Focus): string =>
      buildFooterRow(120, { theme: toneTheme, mode: "normal", focus, notice: null, ...(layout ? { layout } : {}) });
    const all = labels(undefined, "files"); // omitted layout = default three panes
    expect(all).toContain("accent:files  dim:git  dim:viewer");
    const filesViewer = labels("files-viewer", "files");
    expect(filesViewer).toContain("accent:files  dim:viewer");
    expect(filesViewer).not.toContain("git");
    expect(visibleWidth(filesViewer)).toBeLessThanOrEqual(120);
    const gitViewer = labels("git-viewer", "git");
    expect(gitViewer).toContain("accent:git  dim:viewer");
    expect(gitViewer).not.toContain("files");
    expect(visibleWidth(gitViewer)).toBeLessThanOrEqual(120);
  });
});

describe("buildTopBorder (Issue #137 §2)", () => {
  it("exports the shared rounded corner set for every bordered surface", () => {
    expect(FRAME_CORNERS).toEqual({ tl: "\u256d", tr: "\u256e", bl: "\u2570", br: "\u256f" });
  });

  it("draws the title pill in the top border with a total width of innerW + 2", () => {
    const row = buildTopBorder(98, { theme: identityTheme, title: "pi-navigator" });
    expect(row.startsWith("\u256d\u2500\u2500")).toBe(true);
    expect(row).toContain(" pi-navigator ");
    expect(row.endsWith("\u256e")).toBe(true);
    expect(visibleWidth(row)).toBe(100);
    // fill = innerW - 2 - visibleWidth(" pi-navigator ")
    expect(row).toBe("\u256d\u2500\u2500 pi-navigator " + "\u2500".repeat(98 - 2 - 14) + "\u256e");
  });

  it("degrades to a plain rounded border when the pill cannot fit (fill < 1)", () => {
    const row = buildTopBorder(12, { theme: identityTheme, title: "pi-navigator" });
    expect(row).toBe("\u256d" + "\u2500".repeat(12) + "\u256e");
    expect(row).not.toContain("pi-navigator");
    // The smallest pill: fill === 1 at innerW 17.
    const tight = buildTopBorder(17, { theme: identityTheme, title: "pi-navigator" });
    expect(tight).toBe("\u256d\u2500\u2500 pi-navigator \u2500\u256e");
    expect(visibleWidth(tight)).toBe(19);
  });

  it("measures the pill with visibleWidth (wide characters never overflow) and styles through the theme", () => {
    const wide = buildTopBorder(20, { theme: identityTheme, title: "\u65e5\u672c\u8a9e" });
    expect(visibleWidth(wide)).toBe(22); // not `.length`: 3 chars are 6 cells.
    const row = buildTopBorder(40, { theme: identityTheme, title: "pi-navigator" });
    expect(visibleWidth(row)).toBe(42);
    const styled = buildTopBorder(40, { theme: toneTheme, title: "pi-navigator" });
    expect(styled).toContain("accent: pi-navigator ");
    expect(styled).not.toContain("\x1b");
  });
});

describe("buildCompactFrame (Issue #148)", () => {
  const noticeText = " terminal too small for pi-navigator - resize, or press Esc ";

  it("draws the three-line notice: rounded borders, warning text, clipped to width", () => {
    // The full notice fits at its own length + the two border cells.
    const width = noticeText.length + 2;
    const lines = buildCompactFrame(width, identityTheme);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("\u256d" + "\u2500".repeat(width - 2) + "\u256e");
    expect(lines[1]).toBe("\u2502" + noticeText + "\u2502");
    expect(lines[2]).toBe("\u2570" + "\u2500".repeat(width - 2) + "\u256f");
    for (const line of lines) expect(visibleWidth(line)).toBe(width);
  });

  it("clips every line when the terminal is narrower than the notice", () => {
    const lines = buildCompactFrame(10, identityTheme);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("\u256d" + "\u2500".repeat(8) + "\u256e");
    expect(lines[2]).toBe("\u2570" + "\u2500".repeat(8) + "\u256f");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
  });

  it("styles the notice through the theme's warning channel", () => {
    const lines = buildCompactFrame(noticeText.length + 2, toneTheme);
    expect(lines[1]).toContain("warning: terminal too small");
    expect(lines[0]).toContain("borderMuted:");
  });
});

describe("buildScrollbarBorder (Issue #148)", () => {
  // count 4 of total 8: thumbH = round(16/8) = 2, starting at rowOffset 1.
  const win = { rowOffset: 1, count: 4, scroll: 0, total: 8 };

  it("draws the frame cell when there is no window", () => {
    expect(buildScrollbarBorder(2, null, identityTheme)).toBe("\u2502");
  });

  it("draws the frame cell outside the window's row span", () => {
    expect(buildScrollbarBorder(0, win, identityTheme)).toBe("\u2502"); // rel -1
    expect(buildScrollbarBorder(5, win, identityTheme)).toBe("\u2502"); // rel 4 >= count
  });

  it("draws a proportional thumb: two cells at the top at scroll 0", () => {
    expect(buildScrollbarBorder(1, win, identityTheme)).toBe("\u2588");
    expect(buildScrollbarBorder(2, win, identityTheme)).toBe("\u2588");
    expect(buildScrollbarBorder(3, win, identityTheme)).toBe("\u2502");
    expect(buildScrollbarBorder(4, win, identityTheme)).toBe("\u2502");
  });

  it("slides the thumb to the bottom at full scroll", () => {
    const bottom = { ...win, scroll: 4 };
    // thumbStart = round((4 / 4) * (4 - 2)) = 2.
    expect(buildScrollbarBorder(1, bottom, identityTheme)).toBe("\u2502");
    expect(buildScrollbarBorder(3, bottom, identityTheme)).toBe("\u2588");
    expect(buildScrollbarBorder(4, bottom, identityTheme)).toBe("\u2588");
  });

  it("keeps at least a one-cell thumb and styles through the scrollbar channels", () => {
    const tall = { rowOffset: 0, count: 10, scroll: 0, total: 1000 };
    // thumbH = max(1, round(100 / 1000)) = 1.
    expect(buildScrollbarBorder(0, tall, identityTheme)).toBe("\u2588");
    expect(buildScrollbarBorder(1, tall, identityTheme)).toBe("\u2502");
    expect(buildScrollbarBorder(1, win, toneTheme)).toBe("scrollbarThumb:\u2588");
    expect(buildScrollbarBorder(3, win, toneTheme)).toBe("scrollbarTrack:\u2502");
    expect(buildScrollbarBorder(0, win, toneTheme)).toBe("borderMuted:\u2502"); // outside the window
  });
});

describe("composeFrame (Issue #148)", () => {
  const frameView = (overrides: Partial<FrameView> = {}): FrameView => ({
    theme: identityTheme,
    innerW: 24,
    body: 4,
    leftW: 4,
    filesH: 1,
    showSeparator: true,
    leftRows: ["aaaa", "bbbb", "cccc", "dddd"],
    rightRows: ["RRRR", "SSSS", "TTTT", "UUUU"],
    scrollWindow: null,
    title: { cwd: "/work/repo", git: null, home: "" },
    footerRow: "footer",
    ...overrides,
  });

  it("assembles the top border, title row and outer separator", () => {
    const lines = composeFrame(frameView());
    expect(lines).toHaveLength(9); // 4 body rows + 5 chrome rows
    expect(lines[0]).toBe(buildTopBorder(24, { theme: identityTheme, title: "pi-navigator" }));
    expect(lines[1]).toBe("\u2502 /work/repo" + " ".repeat(5) + " no git \u2502");
    expect(lines[2]).toBe("\u251c" + "\u2500".repeat(24) + "\u2524");
  });

  it("joins the left and right cells, drawing the separator row at filesH", () => {
    const lines = composeFrame(frameView());
    expect(lines[3]).toBe("\u2502aaaa\u2502RRRR\u2502"); // i = 0
    expect(lines[4]).toBe("\u251c\u2500\u2500\u2500\u2500\u2524SSSS\u2502"); // i === filesH
    expect(lines[5]).toBe("\u2502cccc\u2502TTTT\u2502");
    expect(lines[6]).toBe("\u2502dddd\u2502UUUU\u2502");
  });

  it("draws no separator row when the layout has none", () => {
    const lines = composeFrame(frameView({ showSeparator: false }));
    expect(lines.slice(3, 7)).toEqual([
      "\u2502aaaa\u2502RRRR\u2502",
      "\u2502bbbb\u2502SSSS\u2502",
      "\u2502cccc\u2502TTTT\u2502",
      "\u2502dddd\u2502UUUU\u2502",
    ]);
  });

  it("joins the right cell directly when the left column is hidden", () => {
    const lines = composeFrame(frameView({ leftRows: null, showSeparator: false }));
    expect(lines.slice(3, 7)).toEqual([
      "\u2502RRRR\u2502",
      "\u2502SSSS\u2502",
      "\u2502TTTT\u2502",
      "\u2502UUUU\u2502",
    ]);
  });

  it("draws the scrollbar in the right border column and the frame cell outside the window", () => {
    const lines = composeFrame(
      frameView({
        body: 5,
        showSeparator: false,
        leftRows: ["aaaa", "bbbb", "cccc", "dddd", "eeee"],
        rightRows: ["RRRR", "SSSS", "TTTT", "UUUU", "VVVV"],
        scrollWindow: { rowOffset: 1, count: 3, scroll: 0, total: 6 },
      }),
    );
    expect(lines[3]).toBe("\u2502aaaa\u2502RRRR\u2502"); // rel -1: frame
    expect(lines[4]).toBe("\u2502bbbb\u2502SSSS\u2588"); // rel 0: thumb
    expect(lines[5]).toBe("\u2502cccc\u2502TTTT\u2588"); // rel 1: thumb
    expect(lines[6]).toBe("\u2502dddd\u2502UUUU\u2502"); // rel 2: track
    expect(lines[7]).toBe("\u2502eeee\u2502VVVV\u2502"); // rel 3 >= count: frame
  });

  it("wraps the footer row and closes the bottom border", () => {
    const lines = composeFrame(frameView());
    expect(lines[7]).toBe("\u2502footer\u2502");
    expect(lines[8]).toBe("\u2570" + "\u2500".repeat(24) + "\u256f");
  });
});
