/**
 * layout.ts suites (Issue #148 split out of frame.ts): overlay geometry,
 * left-column gates, the pane split, the pane areas and the layout
 * derivations. Pure math over constants.ts + types.ts, so no theme is needed
 * — the assertions are plain numbers and unions.
 */

import { describe, expect, it } from "vitest";

import { LEFT_COLUMN_HIDE_BELOW } from "../constants";
import {
  bodyRows,
  cycleFocus,
  filesArea,
  gitArea,
  initialFocus,
  layoutPanes,
  layoutRows,
  leftColumnWidth,
  overlayHeight,
  paneArea,
  splitRows,
  useLeftColumn,
  viewerArea,
  visiblePanes,
} from "../layout";
import { NAVIGATOR_LAYOUTS, type Focus } from "../types";

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

describe("paneArea (Issue #147)", () => {
  it("is a group's data rows: its header takes one, floored at 1", () => {
    expect(paneArea(0)).toBe(1);
    expect(paneArea(1)).toBe(1);
    expect(paneArea(2)).toBe(1);
    expect(paneArea(3)).toBe(2);
    expect(paneArea(13)).toBe(12);
  });
});

describe("pane areas", () => {
  it("filesArea(36, default) is 12 and viewerArea(36) is 24, both floored at 1", () => {
    expect(filesArea(36, "files-git-viewer")).toBe(12); // paneArea(splitRows(bodyRows(30)).filesH)
    expect(viewerArea(36)).toBe(24); // paneArea(bodyRows(30))
    expect(filesArea(36, "files-git-viewer")).toBeGreaterThanOrEqual(2);
    expect(viewerArea(36)).toBeGreaterThanOrEqual(2);
  });

  // Issue #119: the area follows the layout's files height; the floor keeps a
  // git-viewer session (filesH 0) safe if alignFilesCursor ever fires. Issue
  // #147: that floor is `paneArea`'s 1, the same expression render applies.
  it("filesArea follows the layout: full height in files-viewer, floor 1 in git-viewer (Issue #119)", () => {
    expect(filesArea(36, "files-viewer")).toBe(24); // paneArea(bodyRows(30))
    expect(filesArea(36, "git-viewer")).toBe(1); // paneArea(0) — the pane draws no data row
    expect(filesArea(24, "files-viewer")).toBe(bodyRows(overlayHeight(24)) - 1);
    expect(filesArea(24, "git-viewer")).toBe(1);
  });

  it("gitArea mirrors filesArea on the git group and floors at 1 for a hidden pane", () => {
    expect(gitArea(36, "files-git-viewer")).toBe(10); // paneArea(splitRows(25).gitH)
    expect(gitArea(36, "git-viewer")).toBe(24); // paneArea(bodyRows(30))
    expect(gitArea(36, "files-viewer")).toBe(1); // paneArea(0)
  });
});

// Issue #119 (D2): the layout model is pure layout.ts derivations; the
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
