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
  buildTopBorder,
  cycleFocus,
  filesArea,
  FOCUS_HINTS,
  fitHint,
  FRAME_CORNERS,
  getFooterHint,
  initialFocus,
  isImageLine,
  joinLeftRight,
  layoutPanes,
  layoutRows,
  leftColumnWidth,
  MODE_HINTS,
  overlayHeight,
  padTo,
  plainHint,
  shortPath,
  splitRows,
  truncateAndWidth,
  useLeftColumn,
  viewerArea,
  visiblePanes,
  type HintPair,
} from "../frame";
import { makeNavigatorTheme } from "../theme";
import { NAVIGATOR_LAYOUTS, type Focus, type GitState, type NavigatorLayout } from "../types";

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
  it("filesArea(36, default) is 12 and viewerArea(36) is 24, both floored at 2", () => {
    expect(filesArea(36, "files-git-viewer")).toBe(12); // max(2, splitRows(bodyRows(30)).filesH - 1)
    expect(viewerArea(36)).toBe(24); // max(2, bodyRows(30) - 1)
    expect(filesArea(36, "files-git-viewer")).toBeGreaterThanOrEqual(2);
    expect(viewerArea(36)).toBeGreaterThanOrEqual(2);
  });

  // Issue #119: the area follows the layout's files height; the floor keeps a
  // git-viewer session (filesH 0) safe if alignFilesCursor ever fires.
  it("filesArea follows the layout: full height in files-viewer, floor 2 in git-viewer (Issue #119)", () => {
    expect(filesArea(36, "files-viewer")).toBe(24); // max(2, bodyRows(30) - 1)
    expect(filesArea(36, "git-viewer")).toBe(2); // max(2, 0 - 1)
    expect(filesArea(24, "files-viewer")).toBe(bodyRows(overlayHeight(24)) - 1);
    expect(filesArea(24, "git-viewer")).toBe(2);
  });
});

// Issue #119 (D2): the layout model is pure frame.ts derivations; the
// component only calls them.
describe("layout derivations (Issue #119)", () => {
  it("NAVIGATOR_LAYOUTS is the closed union in canonical order", () => {
    expect(NAVIGATOR_LAYOUTS).toEqual(["files-git-viewer", "files-viewer", "git-viewer"]);
  });

  it("layoutPanes reports pane presence per layout", () => {
    expect(layoutPanes("files-git-viewer")).toEqual({ files: true, git: true });
    expect(layoutPanes("files-viewer")).toEqual({ files: true, git: false });
    expect(layoutPanes("git-viewer")).toEqual({ files: false, git: true });
  });

  it("layoutRows delegates the default layout to splitRows and hands single panes the full body", () => {
    expect(layoutRows(25, "files-git-viewer")).toEqual(splitRows(25));
    expect(layoutRows(25, "files-git-viewer")).toEqual({ filesH: 13, gitH: 11 });
    expect(layoutRows(25, "files-viewer")).toEqual({ filesH: 25, gitH: 0 });
    expect(layoutRows(25, "git-viewer")).toEqual({ filesH: 0, gitH: 25 });
    // Minimum body rows: no arithmetic underflows.
    expect(layoutRows(bodyRows(0), "files-viewer")).toEqual({ filesH: 4, gitH: 0 });
    expect(layoutRows(bodyRows(0), "git-viewer")).toEqual({ filesH: 0, gitH: 4 });
    expect(layoutRows(8, "files-git-viewer")).toEqual(splitRows(8)); // splitRows clamps
  });

  it("visiblePanes orders the focusable panes with the viewer last", () => {
    expect(visiblePanes("files-git-viewer")).toEqual(["files", "git", "viewer"]);
    expect(visiblePanes("files-viewer")).toEqual(["files", "viewer"]);
    expect(visiblePanes("git-viewer")).toEqual(["git", "viewer"]);
  });

  it("initialFocus is the pane the layout opens with", () => {
    expect(initialFocus("files-git-viewer")).toBe("files");
    expect(initialFocus("files-viewer")).toBe("files");
    expect(initialFocus("git-viewer")).toBe("git");
  });

  it("cycleFocus wraps forward within the visible panes", () => {
    expect(cycleFocus("files", 1, "files-git-viewer")).toBe("git");
    expect(cycleFocus("git", 1, "files-git-viewer")).toBe("viewer");
    expect(cycleFocus("viewer", 1, "files-git-viewer")).toBe("files");
    expect(cycleFocus("files", 1, "files-viewer")).toBe("viewer");
    expect(cycleFocus("viewer", 1, "files-viewer")).toBe("files");
    expect(cycleFocus("git", 1, "git-viewer")).toBe("viewer");
    expect(cycleFocus("viewer", 1, "git-viewer")).toBe("git");
  });

  it("cycleFocus reverses with Shift+Tab and recovers an invisible focus", () => {
    expect(cycleFocus("viewer", -1, "files-git-viewer")).toBe("git");
    expect(cycleFocus("files", -1, "files-git-viewer")).toBe("viewer");
    expect(cycleFocus("viewer", -1, "files-viewer")).toBe("files");
    expect(cycleFocus("git", -1, "git-viewer")).toBe("viewer");
    // A focus the layout does not render (e.g. carried over from another
    // layout) lands on the first visible pane instead of crashing.
    expect(cycleFocus("git" as Focus, 1, "files-viewer")).toBe("files");
    expect(cycleFocus("files" as Focus, -1, "git-viewer")).toBe("git");
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

describe("plainHint (Issue #137 §1)", () => {
  it("joins `keys label` pairs with ' · ' for placeholder text", () => {
    const pairs: HintPair[] = [
      { keys: "type", label: "to search" },
      { keys: "Esc", label: "clear" },
    ];
    expect(plainHint(pairs)).toBe("type to search \u00b7 Esc clear");
    expect(plainHint([])).toBe("");
    expect(plainHint(MODE_HINTS.help)).toBe(
      "j k scroll \u00b7 PgUp/PgDn page \u00b7 Home/End top/bottom \u00b7 q Esc ? close help",
    );
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
