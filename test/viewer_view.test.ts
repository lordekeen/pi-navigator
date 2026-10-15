/**
 * viewer_view.ts suites (Issue #064 view-model extraction): markdown
 * detection, content geometry, the pane renderer's branches, the header,
 * the image-card hint ladder, and the input bars. ViewerPaneView records
 * are hand-built; the identity theme passes text through for width
 * assertions, and a tone-tagging theme verifies which channel styled a row.
 */

import { describe, expect, it } from "vitest";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_PI_CHAFA_SUBSET, type ImageSupport } from "../images";
import { makeNavigatorTheme } from "../theme";
import type { DisplayRow } from "../viewer";
import { computeRows } from "../viewer";
import type { ImageVerdict, ViewerFile } from "../types";
import { buildMinimap } from "../minimap_view";
import type { MinimapSketch } from "../minimap_view";
import {
  buildInputBar,
  buildSearchBar,
  buildViewerHeader,
  canRenderMarkdown,
  imageCardHints,
  paneContentArea,
  paneContentWidth,
  renderViewerPane,
  viewerWindow,
  type ViewerPaneView,
} from "../viewer_view";

const identityTheme = makeNavigatorTheme({
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
} as never);

function viewerFile(partial: Partial<ViewerFile> = {}): ViewerFile {
  return { kind: "text", relPath: "src/main.ts", lines: [], ...partial };
}

/** A rendered image verdict fixture (Issue #143). */
function renderedVerdict(
  renderer: "native" | "chafa",
  lines: string[],
  cols = 40,
  rows = 12,
): ImageVerdict {
  return { kind: "rendered", renderer, lines, cols, rows };
}

/** A metadata-card image verdict, optionally carrying a renderer failure. */
function cardVerdict(
  failed?: { renderer: "native" | "chafa"; detail: string },
): ImageVerdict {
  return { kind: "card", ...(failed !== undefined ? { failed } : {}) };
}

function activeSupport(overrides: Partial<ImageSupport> = {}): ImageSupport {
  return {
    mode: "chafa",
    nativeProtocol: null,
    tier: "chafa",
    piChafa: { present: true, via: "settings" },
    chafa: { state: "ok", binary: "chafa", version: { major: 1, minor: 18 } },
    config: { ...DEFAULT_PI_CHAFA_SUBSET },
    hostShowImages: true,
    hostImageWidthCells: 60,
    ...overrides,
  };
}

/** Strict-native support fixture (mode native, kitty capable by default). */
function nativeSupport(overrides: Partial<ImageSupport> = {}): ImageSupport {
  return activeSupport({ mode: "native", nativeProtocol: "kitty", tier: "native", ...overrides });
}

/** A byte-stable kitty sequence row (3 fitted rows). */
const KITTY_SEQ = "\x1b_Ga=T,f=100,q=2,C=1,c=20,r=3,i=9;AAAA\x1b\\";

function paneView(partial: Partial<ViewerPaneView> = {}): ViewerPaneView {
  return {
    theme: identityTheme,
    focus: "viewer",
    home: "/home/u",
    focused: false,
    file: null,
    loading: false,
    switching: false,
    targetRelPath: null,
    diskChanged: false,
    searchMode: false,
    renderMarkdown: false,
    content: { kind: "none" },
    digits: 2,
    viewScroll: 0,
    scrollInfo: null,
    wrap: false,
    hscroll: 0,
    imageSupport: activeSupport(),
    imageGeometry: { cols: 40, rows: 12 },
    minimap: null,
    searchQuery: "",
    searchMatches: [],
    searchIndex: 0,
    ...partial,
  };
}

describe("canRenderMarkdown", () => {
  it("needs a text-like markdown file with retained raw text", () => {
    expect(canRenderMarkdown(viewerFile({ relPath: "README.md", rawText: "# hi" }))).toBe(true);
    expect(canRenderMarkdown(viewerFile({ kind: "diff", relPath: "commit:abc", rawText: "diff", commitHash: "abc" }))).toBe(false);
    expect(canRenderMarkdown(viewerFile({ relPath: "main.ts", rawText: "let x" }))).toBe(false);
    expect(canRenderMarkdown(null)).toBe(false);
  });
});

describe("paneContentWidth", () => {
  it("renders markdown without a gutter; text reserves one; no file uses the bare pane", () => {
    const mdFile = viewerFile({ relPath: "README.md", rawText: "# hi", lineCount: 120 });
    const rendered = paneContentWidth(mdFile, true, 60);
    expect(rendered).toEqual({ contentW: 58, digits: 0 });

    const textFile = viewerFile({ lineCount: 123 }); // 3 digits
    const text = paneContentWidth(textFile, false, 60);
    expect(text).toEqual({ contentW: 60 - 2 - (3 + 1 + 2), digits: 3 });

    const none = paneContentWidth(null, false, 60);
    expect(none).toEqual({ contentW: 58, digits: 0 });
  });

  it("falls back to lines.length for the digit count when lineCount is absent", () => {
    const text = paneContentWidth(viewerFile({ lines: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"] }), false, 60);
    expect(text.digits).toBe(2);
  });
});

describe("paneContentArea", () => {
  it("reserves one row per active notice", () => {
    const truncated = viewerFile({ kind: "truncated", notice: "output truncated" });
    expect(paneContentArea(10, truncated, true)).toEqual({ noticeRows: 2, contentArea: 8 });
    expect(paneContentArea(10, viewerFile(), false)).toEqual({ noticeRows: 0, contentArea: 10 });
  });
});

describe("renderViewerPane", () => {
  const width = 40;

  it("shows (loading…) then (select a file) for the empty branches, padded to the area", () => {
    const loading = renderViewerPane(paneView({ loading: true }), width, 5);
    expect(loading).toHaveLength(6); // header row first, then the area rows
    expect(loading[0]).toContain("(no file)");
    expect(loading[1]).toContain("(loading\u2026)");
    expect(visibleWidth(loading[1]!)).toBe(width);

    const empty = renderViewerPane(paneView(), width, 5);
    expect(empty).toHaveLength(6);
    expect(empty[0]).toContain("(no file)");
    expect(empty[1]).toContain("(select a file)");
  });

  it("renders pre-styled chafa rows, padded/truncated to the pane width", () => {
    const image = viewerFile({
      kind: "image",
      relPath: "pic.png",
      imageVerdict: renderedVerdict("chafa", ["chafa-row-0", "chafa-row-1"]),
      lines: [],
    });
    const rows = renderViewerPane(
      paneView({ file: image, content: { kind: "image-lines", lines: ["chafa-row-0", "chafa-row-1"] } }),
      width,
      4,
    );
    expect(rows).toHaveLength(5); // header + area rows
    expect(rows[1]).toContain("chafa-row-0");
    expect(visibleWidth(rows[1]!)).toBe(width);
    expect(visibleWidth(rows[3]!)).toBe(width); // beyond the payload: blank, still padded
  });

  it("emits native rows verbatim with right-side space fill only", () => {
    const image = viewerFile({
      kind: "image",
      relPath: "pic.png",
      imageVerdict: renderedVerdict("native", [KITTY_SEQ, "", ""]),
      lines: [],
    });
    const rows = renderViewerPane(
      paneView({ file: image, content: { kind: "image-lines", lines: [KITTY_SEQ, "", ""] }, imageSupport: nativeSupport() }),
      width,
      4,
    );
    // The sequence row is unreduced: sequence bytes first, then pane padding.
    expect(rows[1]).toBe(KITTY_SEQ + " ".repeat(width));
    // Filler rows are empty at the boundary and become blank pane rows.
    expect(rows[2]).toBe(" ".repeat(width));
    expect(rows[3]).toBe(" ".repeat(width));
    expect(visibleWidth(rows[1]!)).toBe(width);
  });

  it("draws the card box border rows for error files", () => {
    const bad = viewerFile({ kind: "error", relPath: "locked.ts", message: "EACCES" });
    const rows = renderViewerPane(paneView({ file: bad, content: { kind: "card" } }), width, 10);
    expect(rows[0]).toContain("locked"); // header path
    expect(rows.some((row) => row.includes("\u256d"))).toBe(true); // ╭ (card top, rounded #137)
    expect(rows.some((row) => row.includes("\u2570"))).toBe(true); // ╰ (card bottom)
    expect(rows.some((row) => row.includes("Cannot read"))).toBe(true);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  });

  it("renders text rows with a gutter: blank for wrap continuations, line+1 for source rows", () => {
    const display: DisplayRow[] = [
      { line: null, text: "wrapped-continuation" },
      { line: 5, text: "hello" },
    ];
    const rows = renderViewerPane(paneView({ file: viewerFile(), content: { kind: "display", rows: display } }), width, 3);
    expect(rows).toHaveLength(4); // header + 3 content rows
    // null line: digits(2) spaces + separator space -> "   " before the │
    expect(rows[1]).toContain("\u2502");
    expect(rows[1]).toContain("wrapped-continuation");
    // line 5 -> String(6).padStart(2) = " 6" then the separator space -> " 6 "
    expect(rows[2]).toContain(" 6 ");
    expect(rows[2]).toContain("\u2502");
    expect(rows[2]).toContain("hello");
  });

  it("renders pre-styled markdown rows, with null entries as blank rows", () => {
    const md = viewerFile({ kind: "text", relPath: "README.md", rawText: "# hi" });
    const rows = renderViewerPane(paneView({ file: md, content: { kind: "markdown", rows: ["<styled>", null] } }), width, 3);
    expect(rows[1]).toContain("<styled>");
    expect(rows[1]!.startsWith(" ")).toBe(true); // one-space lead-in before the styled row
    expect(visibleWidth(rows[1]!)).toBe(width);
    expect(rows[2]!.trim()).toBe(""); // null entry = blank row
    expect(visibleWidth(rows[2]!)).toBe(width); // still padded to the pane width
  });

  // Issue #103: an image the class did not render shows the metadata card,
  // never the text-like gutter and line numbering. The zero-line → card
  // decision lives in navigator.ts and stays pinned by its #103 test; the
  // producer can no longer emit an empty `image-lines` (Issue #149), so the
  // old null-rows and empty-rows cases fold into this one card case.
  it("routes an image with card content to the metadata card", () => {
    const image = viewerFile({
      kind: "image",
      relPath: "pic.png",
      imageVerdict: renderedVerdict("chafa", ["chafa-row-0"]),
      lines: [],
    });
    const rows = renderViewerPane(paneView({ file: image, content: { kind: "card" } }), width, 10);
    expect(rows.some((row) => row.includes("\u256d"))).toBe(true); // card top border
    expect(rows.join("\n")).toContain("Image"); // card title
    expect(rows.join("\n")).not.toContain("chafa-row-");
  });

  it("routes a native-rendered image with card content to the metadata card", () => {
    const image = viewerFile({
      kind: "image",
      relPath: "pic.png",
      imageVerdict: renderedVerdict("native", [KITTY_SEQ]),
      lines: [],
    });
    const rows = renderViewerPane(
      paneView({ file: image, content: { kind: "card" }, imageSupport: nativeSupport() }),
      width,
      10,
    );
    expect(rows.some((row) => row.includes("\u256d"))).toBe(true);
  });

  it("still renders image rows, not a card, for a rendered image with non-empty lines", () => {
    const image = viewerFile({
      kind: "image",
      relPath: "pic.png",
      imageVerdict: renderedVerdict("chafa", ["chafa-row-0", "chafa-row-1"]),
      lines: [],
    });
    const rows = renderViewerPane(paneView({ file: image, content: { kind: "image-lines", lines: ["chafa-row-0", "chafa-row-1"] } }), width, 4);
    expect(rows.some((row) => row.includes("\u256d"))).toBe(false);
    expect(rows[1]).toContain("chafa-row-0");
  });
});

describe("buildViewerHeader", () => {
  it("prefixes commit diffs with the short hash", () => {
    const diff = viewerFile({ kind: "diff", relPath: "commit:abc1234", commitHash: "abc1234" });
    expect(buildViewerHeader(paneView({ file: diff }), 60)).toContain("commit abc1234");
  });

  it("badges a native render with its protocol and the i card affordance", () => {
    const image = viewerFile({
      kind: "image",
      relPath: "pic.png",
      imageVerdict: renderedVerdict("native", [KITTY_SEQ]),
      lines: [],
    });
    const kitty = buildViewerHeader(
      paneView({ file: image, content: { kind: "image-lines", lines: [KITTY_SEQ] }, imageSupport: nativeSupport() }),
      70,
    );
    expect(kitty).toContain("kitty");
    expect(kitty).toContain("i card");

    const iterm = buildViewerHeader(
      paneView({
        file: image,
        content: { kind: "image-lines", lines: [KITTY_SEQ] },
        imageSupport: nativeSupport({ nativeProtocol: "iterm2" }),
      }),
      70,
    );
    expect(iterm).toContain("iterm2");

    const card = buildViewerHeader(
      paneView({ file: image, content: { kind: "card" }, imageSupport: nativeSupport() }),
      70,
    );
    expect(card).toContain("i render");
    expect(card).not.toContain("i card");
  });

  it("carries the wrap / column / loading meta badges", () => {
    const wrap = buildViewerHeader(paneView({ file: viewerFile(), wrap: true }), 60);
    expect(wrap).toContain("wrap");
    const hscrolled = buildViewerHeader(paneView({ file: viewerFile(), hscroll: 8 }), 60);
    expect(hscrolled).toContain("col 9"); // 1-based column badge, unclamped at this layer
    const loading = buildViewerHeader(
      paneView({ file: null, loading: true, switching: true, targetRelPath: "src/other.ts" }),
      60,
    );
    expect(loading).toContain("loading\u2026");
    expect(loading).toContain("src/other.ts");
  });

  it("shows the estimated token count when present and omits it otherwise", () => {
    const withTokens = buildViewerHeader(paneView({ file: viewerFile({ tokens: 1234 }) }), 60);
    expect(withTokens).toContain("~1234 tok");
    const withoutTokens = buildViewerHeader(paneView({ file: viewerFile() }), 60);
    expect(withoutTokens).not.toContain(" tok");
  });
});


describe("imageCardHints", () => {
  const image = viewerFile({ kind: "image", relPath: "pic.png", imageVerdict: cardVerdict(), lines: [] });
  const geometry = { cols: 40, rows: 12 };

  it("walks the priority ladder and returns nothing when chafa is fully ok", () => {
    expect(
      imageCardHints(
        { ...image, imageVerdict: cardVerdict({ renderer: "chafa", detail: "boom" }) },
        activeSupport(),
        geometry,
      ),
    ).toEqual(["chafa failed: boom"]);
    expect(imageCardHints(image, activeSupport(), null)).toEqual(["pane too small for a rendered image"]);
    expect(
      imageCardHints(image, activeSupport({ piChafa: { present: false, via: "none" } }), geometry),
    ).toEqual(["optional: install chafa + pi-chafa (pi install npm:pi-chafa)"]);
    expect(imageCardHints(image, activeSupport({ chafa: { state: "missing", detail: "" } }), geometry)).toEqual([
      "chafa not found - install it, or set CHAFA_BIN / binaryPath",
    ]);
    expect(imageCardHints(image, activeSupport({ chafa: { state: "too-old", detail: "1.8.2" } }), geometry)).toEqual([
      "chafa is older than 1.10 - upgrade to render images",
    ]);
    expect(imageCardHints(image, activeSupport({ chafa: { state: "error", detail: "exit 1" } }), geometry)).toEqual([
      "chafa probe failed: exit 1",
    ]);
    expect(imageCardHints(image, activeSupport({ chafa: { state: "deferred" } }), geometry)).toEqual(["checking image support\u2026"]);
    expect(imageCardHints(image, activeSupport({ mode: "off", tier: "none" }), geometry)).toEqual([
      "optional: enable images.mode=chafa, native, or auto to render images here",
    ]);
    expect(imageCardHints(image, activeSupport({ hostShowImages: false }), geometry)).toEqual([
      "terminal.showImages is false - image rendering disabled",
    ]);
    expect(imageCardHints(image, activeSupport(), geometry)).toEqual([]);
  });

  it("follows the strict-native ladder and labels failures with the verdict's renderer", () => {
    const png = viewerFile({ kind: "image", relPath: "pic.png", imageVerdict: cardVerdict(), lines: [] });
    const chafaFailed = {
      ...png,
      imageVerdict: cardVerdict({ renderer: "chafa", detail: "boom" }),
    };
    const nativeFailed = {
      ...png,
      imageVerdict: cardVerdict({ renderer: "native", detail: "boom" }),
    };
    const native = nativeSupport();

    // The verdict records who failed, so the label needs no mode/probe state:
    // native failures name the protocol (when known), chafa failures name chafa.
    expect(imageCardHints(nativeFailed, native, geometry)).toEqual(["kitty failed: boom"]);
    expect(
      imageCardHints(nativeFailed, activeSupport({ mode: "auto", nativeProtocol: "kitty", tier: "native" }), geometry),
    ).toEqual(["kitty failed: boom"]);
    expect(
      imageCardHints(chafaFailed, activeSupport({ mode: "auto", nativeProtocol: "kitty", tier: "native" }), geometry),
    ).toEqual(["chafa failed: boom"]);
    expect(imageCardHints(chafaFailed, activeSupport(), geometry)).toEqual(["chafa failed: boom"]);
    // Auto without an available chafa probe: a native failure is still native.
    expect(
      imageCardHints(
        nativeFailed,
        activeSupport({
          mode: "auto",
          nativeProtocol: "kitty",
          tier: "native",
          piChafa: { present: false, via: "none" },
          chafa: { state: "deferred" },
        }),
        geometry,
      ),
    ).toEqual(["kitty failed: boom"]);

    // The pane and host gates outrank the native-specific states (a render
    // error outranks both, per the ladder's first rung).
    expect(imageCardHints(png, native, null)).toEqual(["pane too small for a rendered image"]);
    expect(imageCardHints(png, nativeSupport({ hostShowImages: false }), geometry)).toEqual([
      "terminal.showImages is false - image rendering disabled",
    ]);

    // Supported formats under a capable strict-native session: no hint.
    expect(imageCardHints(png, native, geometry)).toEqual([]);
    expect(imageCardHints({ ...png, relPath: "pic.jpg" }, native, geometry)).toEqual([]);
    expect(imageCardHints({ ...png, relPath: "pic.webp" }, native, geometry)).toEqual([]);
    expect(imageCardHints({ ...png, relPath: "pic.gif" }, native, geometry)).toEqual([]);
    // An unsupported format on kitty and on iTerm2 gets format hints.
    expect(
      imageCardHints({ ...png, relPath: "pic.bmp" }, native, geometry),
    ).toEqual(["this image format cannot be rendered natively - use chafa or auto"]);
    expect(
      imageCardHints({ ...png, relPath: "pic.bmp" }, nativeSupport({ nativeProtocol: "iterm2" }), geometry),
    ).toEqual(["this image format cannot be rendered natively - use chafa or auto"]);
    // No capability under strict native: the unsupported-terminal hint.
    expect(imageCardHints(png, activeSupport({ mode: "native", nativeProtocol: null, tier: "none" }), geometry)).toEqual([
      "this terminal does not support kitty/iTerm2 - use auto or chafa",
    ]);
  });
});

describe("input bars", () => {
  it("emits the cursor marker before the fake cursor only when focused", () => {
    const focused = buildInputBar("q", "hint", null, 40, { theme: identityTheme, focused: true });
    expect(focused.startsWith(" /q")).toBe(true);
    expect(focused.includes(CURSOR_MARKER)).toBe(true);
    expect(focused.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length).toBe(focused.indexOf("\u2588"));

    const unfocused = buildInputBar("q", "hint", null, 40, { theme: identityTheme, focused: false });
    expect(unfocused).not.toContain(CURSOR_MARKER);
    expect(unfocused).toContain("\u2588");
    expect(visibleWidth(unfocused)).toBeLessThanOrEqual(40);
  });

  it("buildSearchBar shows the match counter while a query is active", () => {
    const bar = buildSearchBar(
      paneView({
        searchMode: true,
        focused: true,
        searchQuery: "foo",
        searchMatches: [
          { line: 0, start: 0, end: 3 },
          { line: 1, start: 0, end: 3 },
          { line: 2, start: 0, end: 3 },
        ],
        searchIndex: 1,
      }),
      60,
    );
    expect(bar).toContain("2/3 matches");
  });
});

describe("viewerWindow (Issue #147)", () => {
  it("clamps an overshooting scroll request to the last full window and records the window", () => {
    const win = viewerWindow({
      requestedScroll: 100,
      requestedHscroll: 0,
      total: 40,
      count: 10,
      rowOffset: 2,
    });
    expect(win.viewScroll).toBe(30); // 40 - 10
    // The window carries the clamped offset, so the readout and the border
    // scrollbar cannot report a different position than the body rows.
    expect(win.scrollWindow).toEqual({ rowOffset: 2, count: 10, scroll: 30, total: 40 });
  });

  it("produces no scrollbar window when the content fits the pane", () => {
    const exact = viewerWindow({ requestedScroll: 0, requestedHscroll: 0, total: 10, count: 10, rowOffset: 1 });
    expect(exact.viewScroll).toBe(0);
    expect(exact.scrollWindow).toBeNull();
    const under = viewerWindow({ requestedScroll: 0, requestedHscroll: 0, total: 3, count: 10, rowOffset: 1 });
    expect(under.scrollWindow).toBeNull();
  });

  it("passes the requested offsets through when the branch declares no clamp", () => {
    const win = viewerWindow({ requestedScroll: 7, requestedHscroll: 3 });
    expect(win.viewScroll).toBe(7);
    expect(win.hscroll).toBe(3);
    expect(win.scrollWindow).toBeNull();
  });

  it("clamps hscroll only when a ceiling is given", () => {
    expect(viewerWindow({ requestedScroll: 0, requestedHscroll: 12, maxHscroll: 5 }).hscroll).toBe(5);
    expect(viewerWindow({ requestedScroll: 0, requestedHscroll: 12 }).hscroll).toBe(12);
  });

  it("clamps negative requests to 0 on the clamped paths", () => {
    const win = viewerWindow({
      requestedScroll: -3,
      requestedHscroll: -2,
      total: 40,
      count: 10,
      maxHscroll: 5,
      rowOffset: 1,
    });
    expect(win.viewScroll).toBe(0);
    expect(win.hscroll).toBe(0);
    expect(win.scrollWindow).toEqual({ rowOffset: 1, count: 10, scroll: 0, total: 40 });
  });

  it("keeps a native image's pinned scroll at 0 without a readout window", () => {
    // The native branch passes requestedScroll 0 with the image's totals; the
    // clamp must keep the pin exact, and no rowOffset means no scrollbar.
    const win = viewerWindow({ requestedScroll: 0, requestedHscroll: 4, total: 40, count: 10 });
    expect(win.viewScroll).toBe(0);
    expect(win.hscroll).toBe(4);
    expect(win.scrollWindow).toBeNull();
  });
});

describe("viewer minimap composition (Issue #165)", () => {
  /** A tiny sketch stand-in: the pane only reads `blocks`, `rows` and `area`. */
  function sketch(n: number): MinimapSketch {
    return {
      blocks: Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1 })),
      rows: Array.from({ length: n }, (_, i) => `<map${i}>`),
      area: n,
    };
  }

  function displayFile(count: number): ViewerFile {
    return {
      kind: "text",
      relPath: "a.ts",
      lineCount: count,
      lines: Array.from({ length: count }, (_, i) => `line ${i}`),
    };
  }

  it("carves the map columns on the body rows and appends one map row each", () => {
    const file = displayFile(10);
    const rows = computeRows(file, 30, false, 0);
    const lines = renderViewerPane(
      paneView({
        file,
        content: { kind: "display", rows },
        digits: 2,
        minimap: { sketch: sketch(6), width: 6 },
      }),
      40,
      6,
    );
    // Header + six body rows, each exactly the pane width.
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(visibleWidth(line)).toBe(40);
    // Every body row ends with its map glyphs; the header does not.
    for (let i = 1; i <= 6; i += 1) expect(lines[i]).toContain(`<map${i - 1}>`);
    expect(lines[0]).not.toContain("<map");
  });

  it("keeps the header full width when the map owns columns (D7)", () => {
    const file = displayFile(10);
    const withMap = renderViewerPane(
      paneView({ file, content: { kind: "display", rows: computeRows(file, 34, false, 0) }, digits: 2, minimap: { sketch: sketch(6), width: 6 } }),
      40,
      6,
    );
    const without = renderViewerPane(
      paneView({ file, content: { kind: "display", rows: computeRows(file, 40, false, 0) }, digits: 2 }),
      40,
      6,
    );
    expect(withMap[0]).toBe(without[0]);
  });

  it("bands exactly the map rows beside the visible content (mid-file window, §9)", () => {
    // The real engine, a real fold: 40 display rows into 6 map rows. Viewed from
    // row 10, the window [10, 16) intersects blocks 1 (rows 6-12) and 2 (13-19),
    // so exactly those two map rows carry the band — and the content rows beside
    // them are display rows 10-15.
    const BAND = "\x1b[48;5;9m";
    const banded = makeNavigatorTheme({
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => `${BAND}${t}\x1b[49m`,
      bold: (t: string) => t,
      underline: (t: string) => t,
      inverse: (t: string) => t,
    } as never);
    const file = displayFile(40);
    const texts = file.lines;
    const sketch = buildMinimap({
      texts,
      area: 6,
      width: 6,
      encoding: "braille",
      palette: "mono",
      diff: false,
      theme: banded,
    });
    expect(sketch).not.toBeNull();
    const lines = renderViewerPane(
      paneView({
        theme: banded,
        file,
        content: { kind: "display", rows: computeRows(file, 30, false, 0) },
        digits: 2,
        viewScroll: 10,
        minimap: { sketch: sketch!, width: 6 },
      }),
      40,
      6,
    );
    const body = lines.slice(1, 7);
    // The content beside the map really is the window the band describes.
    for (let i = 0; i < 6; i += 1) expect(body[i]).toContain(`line ${10 + i}`);
    expect(body.map((line) => line.includes(BAND))).toEqual([false, true, true, false, false, false]);
  });

  it("puts a frame-tone divider between the content and the map, once per line", () => {
    // The divider is the same `│` the line-number gutter uses (frame tone), so
    // the map reads as a second margin. Display rows therefore carry two —
    // the gutter's and the map's — while rendered markdown, which has no
    // gutter, carries exactly one.
    const toneTheme = makeNavigatorTheme({
      fg: (color: string, t: string) => `fg:${color}(${t})`,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
      underline: (t: string) => t,
      inverse: (t: string) => t,
    } as never);
    const FRAME_DIVIDER = "fg:borderMuted(\u2502)";
    const count = (line: string): number => line.split(FRAME_DIVIDER).length - 1;

    const file = displayFile(10);
    const display = renderViewerPane(
      paneView({
        theme: toneTheme,
        file,
        content: { kind: "display", rows: computeRows(file, 30, false, 0) },
        digits: 2,
        minimap: { sketch: sketch(6), width: 6 },
      }),
      40,
      6,
    );
    for (const line of display.slice(1, 7)) expect(count(line)).toBe(2);
    expect(count(display[0]!)).toBe(0); // the header keeps the full width (D7)

    const md = viewerFile({ relPath: "README.md", rawText: "# hi", lines: ["# hi"] });
    const markdown = renderViewerPane(
      paneView({
        theme: toneTheme,
        file: md,
        renderMarkdown: true,
        content: { kind: "markdown", rows: Array.from({ length: 6 }, (_, i) => `row ${i}`) },
        digits: 0,
        minimap: { sketch: sketch(6), width: 6 },
      }),
      40,
      6,
    );
    for (const line of markdown.slice(1, 7)) expect(count(line)).toBe(1);
  });

  it("widens the content back when the map is off", () => {
    const file = displayFile(10);
    const rows = computeRows(file, 40, false, 0);
    const lines = renderViewerPane(
      paneView({ file, content: { kind: "display", rows }, digits: 2, minimap: null }),
      40,
      3,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(40);
    expect(lines.join("\n")).not.toContain("<map");
  });
});
