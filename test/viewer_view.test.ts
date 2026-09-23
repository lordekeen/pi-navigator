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
import type { ViewerFile } from "../types";
import {
  buildInputBar,
  buildSearchBar,
  buildViewerHeader,
  canRenderMarkdown,
  imageCardHints,
  paneContentArea,
  paneContentWidth,
  renderViewerPane,
  type ViewerPaneView,
} from "../viewer_view";

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

function viewerFile(partial: Partial<ViewerFile> = {}): ViewerFile {
  return { kind: "text", relPath: "src/main.ts", lines: [], ...partial };
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
    renderedMode: false,
    mdContent: null,
    display: null,
    digits: 2,
    viewScroll: 0,
    wrap: false,
    hscroll: 0,
    imageLines: null,
    imageAsCard: false,
    imageSupport: activeSupport(),
    imageGeometry: { cols: 40, rows: 12 },
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
    const image = viewerFile({ kind: "image", relPath: "pic.png", imageTier: "chafa", lines: [] });
    const rows = renderViewerPane(paneView({ file: image, imageLines: ["chafa-row-0", "chafa-row-1"] }), width, 4);
    expect(rows).toHaveLength(5); // header + area rows
    expect(rows[1]).toContain("chafa-row-0");
    expect(visibleWidth(rows[1]!)).toBe(width);
    expect(visibleWidth(rows[3]!)).toBe(width); // beyond the payload: blank, still padded
  });

  it("emits native rows verbatim with right-side space fill only", () => {
    const image = viewerFile({ kind: "image", relPath: "pic.png", imageTier: "native", lines: [] });
    const rows = renderViewerPane(
      paneView({ file: image, imageLines: [KITTY_SEQ, "", ""], imageSupport: nativeSupport() }),
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
    const rows = renderViewerPane(paneView({ file: bad }), width, 10);
    expect(rows[0]).toContain("locked"); // header path
    expect(rows.some((row) => row.includes("\u250c"))).toBe(true); // ┌
    expect(rows.some((row) => row.includes("\u2514"))).toBe(true); // └
    expect(rows.some((row) => row.includes("Cannot read"))).toBe(true);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  });

  it("renders text rows with a gutter: blank for wrap continuations, line+1 for source rows", () => {
    const display: DisplayRow[] = [
      { line: null, text: "wrapped-continuation" },
      { line: 5, text: "hello" },
    ];
    const rows = renderViewerPane(paneView({ file: viewerFile(), display }), width, 3);
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
    const rows = renderViewerPane(paneView({ file: md, renderedMode: true, mdContent: ["<styled>", null] }), width, 3);
    expect(rows[1]).toContain("<styled>");
    expect(rows[1]!.startsWith(" ")).toBe(true); // one-space lead-in before the styled row
    expect(visibleWidth(rows[1]!)).toBe(width);
    expect(rows[2]!.trim()).toBe(""); // null entry = blank row
    expect(visibleWidth(rows[2]!)).toBe(width); // still padded to the pane width
  });

  // Issue #103: an image with no rendered lines must route to the metadata
  // card, never fall through to the text-like gutter and line numbering.
  it("routes a chafa image with imageLines: null to the metadata card", () => {
    const image = viewerFile({ kind: "image", relPath: "pic.png", imageTier: "chafa", lines: [] });
    const rows = renderViewerPane(paneView({ file: image, imageLines: null }), width, 10);
    expect(rows.some((row) => row.includes("\u250c"))).toBe(true); // card top border
    expect(rows.join("\n")).toContain("Image"); // card title
  });

  it("routes a chafa image with an empty imageLines array to the metadata card", () => {
    const image = viewerFile({ kind: "image", relPath: "pic.png", imageTier: "chafa", lines: [] });
    const rows = renderViewerPane(paneView({ file: image, imageLines: [] }), width, 10);
    expect(rows.some((row) => row.includes("\u250c"))).toBe(true);
    expect(rows.join("\n")).toContain("Image");
    expect(rows.join("\n")).not.toContain("chafa-row-");
  });

  it("routes a native-tier image without lines to the metadata card", () => {
    const image = viewerFile({ kind: "image", relPath: "pic.png", imageTier: "native", lines: [] });
    const rows = renderViewerPane(
      paneView({ file: image, imageLines: null, imageSupport: nativeSupport() }),
      width,
      10,
    );
    expect(rows.some((row) => row.includes("\u250c"))).toBe(true);
  });

  it("still renders image rows, not a card, for a chafa image with non-empty lines", () => {
    const image = viewerFile({ kind: "image", relPath: "pic.png", imageTier: "chafa", lines: [] });
    const rows = renderViewerPane(paneView({ file: image, imageLines: ["chafa-row-0", "chafa-row-1"] }), width, 4);
    expect(rows.some((row) => row.includes("\u250c"))).toBe(false);
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
      imageTier: "native",
      imageLines: [KITTY_SEQ],
      lines: [],
    });
    const kitty = buildViewerHeader(
      paneView({ file: image, imageLines: [KITTY_SEQ], imageSupport: nativeSupport() }),
      70,
    );
    expect(kitty).toContain("kitty");
    expect(kitty).toContain("i card");

    const iterm = buildViewerHeader(
      paneView({
        file: image,
        imageLines: [KITTY_SEQ],
        imageSupport: nativeSupport({ nativeProtocol: "iterm2" }),
      }),
      70,
    );
    expect(iterm).toContain("iterm2");

    const card = buildViewerHeader(
      paneView({ file: image, imageLines: [KITTY_SEQ], imageAsCard: true, imageSupport: nativeSupport() }),
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
});

describe("Issue #116: native failure reason on a rendered chafa image", () => {
  const chafaImage = viewerFile({
    kind: "image",
    relPath: "pics/sample.png",
    imageTier: "chafa",
    imageLines: ["\u2588"],
    imageCols: 40,
    imageRows: 1,
    sizeBytes: 1024,
    message: "1.0 KB",
  });

  it("surfaces the fallback reason as a dim suffix next to the chafa badge", () => {
    const file = { ...chafaImage, imageError: "image exceeds the 4 MiB native rendering cap" };
    const header = buildViewerHeader(paneView({ file, imageLines: file.imageLines }), 120);
    expect(header).toContain("chafa \u00b7 i card");
    expect(header).toContain("image exceeds the 4 MiB native rendering cap");
    // The whole meta block rides the dim channel (T.dim wraps the join).
    const toned = buildViewerHeader(
      paneView({ file, imageLines: file.imageLines, theme: toneTheme }),
      120,
    );
    expect(toned).toContain("dim:1.0 KB · chafa · i card · image exceeds the 4 MiB native rendering cap");
  });

  it("shows no suffix when the rendered image carries no error", () => {
    const header = buildViewerHeader(paneView({ file: chafaImage, imageLines: chafaImage.imageLines }), 120);
    expect(header).toContain("chafa \u00b7 i card");
    expect(header).not.toContain("4 MiB");
    expect(header).not.toContain("failed:");
  });

  it("truncates the suffix to keep the header width-safe at every pane width", () => {
    for (const width of [120, 100, 80, 60, 40]) {
      const file = { ...chafaImage, imageError: "x".repeat(200) };
      const header = buildViewerHeader(paneView({ file, imageLines: file.imageLines }), width);
      expect(visibleWidth(header), `header overflows width ${width}`).toBeLessThanOrEqual(width);
      // The left path keeps cells: the suffix never eats the whole header.
      expect(header).toContain("chafa \u00b7 i card");
      if (width >= 60) expect(header).toContain("x".repeat(10)); // reason visibly present
    }
  });
});

describe("imageCardHints", () => {
  const image = viewerFile({ kind: "image", relPath: "pic.png", imageTier: "metadata", lines: [] });
  const geometry = { cols: 40, rows: 12 };

  it("walks the priority ladder and returns nothing when chafa is fully ok", () => {
    expect(imageCardHints({ ...image, imageError: "boom" }, activeSupport(), geometry)).toEqual(["chafa failed: boom"]);
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

  it("follows the strict-native ladder and labels failures with the renderer", () => {
    const png = viewerFile({ kind: "image", relPath: "pic.png", imageTier: "metadata", lines: [] });
    const failed = { ...png, imageError: "boom" };
    const native = nativeSupport();

    // Failure label: strict native names the protocol; auto names chafa when
    // the chafa seam was available, else the protocol.
    expect(imageCardHints(failed, native, geometry)).toEqual(["kitty failed: boom"]);
    expect(
      imageCardHints(failed, activeSupport({ mode: "auto", nativeProtocol: "kitty", tier: "native" }), geometry),
    ).toEqual(["chafa failed: boom"]);
    expect(
      imageCardHints(
        failed,
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

    // Supported format under a capable strict-native session: no hint.
    expect(imageCardHints(png, native, geometry)).toEqual([]);
    // A non-PNG on kitty and an unsupported format on iTerm2 get format hints.
    expect(imageCardHints({ ...png, relPath: "pic.jpg" }, native, geometry)).toEqual([
      "kitty rendering needs PNG - chafa or auto can render this format",
    ]);
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
