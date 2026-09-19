# pi-navigator — Rendered Markdown View Implementation Plan

**Status:** Implemented (v0.5.0 — shipped in `6d07f43`)  
**Spec Reference:** [`docs/specs/markdown-rendered-view.md`](file:///home/jhonny/Sources/pi-navigator/docs/specs/markdown-rendered-view.md) (rev. 2)  
**Target Version:** 0.5.0 (Minor version bump from 0.4.2)  
**Scope:** In-viewer toggle (`m`) between syntax-highlighted source code view and rich terminal rendered Markdown view using native `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` components, with complete search, scroll, caching, and width-safety integration.

---

## §0 — Grounding & Verified Facts

- **`Markdown` Component** (`@earendil-works/pi-tui`):
  - `new Markdown(text, paddingX, paddingY, theme, defaultTextStyle?, options?)`
  - `md.setText(string)`: sets input markdown; resets internal cache.
  - `md.render(width)`: returns `string[]` of formatted, ANSI-styled lines pre-padded and wrapped to `width`.
  - Replaces tabs with 3 spaces before parsing CommonMark AST (`text.replace(/\t/g, "   ")`).
- **`getMarkdownTheme()`** (`@earendil-works/pi-coding-agent`):
  - Returns `MarkdownTheme` using the active pi theme (`mdHeading`, `mdCode`, `mdCodeBlock`, `mdQuote`, `mdListBullet`, etc.).
  - Implements `highlightCode: (code, lang) => string[]` via `cli-highlight` (theme-aware per-language syntax coloring in fenced code blocks).
  - In an interactive session, `initTheme()` is already called by pi. In headless test runners (Vitest), calling `getMarkdownTheme()` throws `Theme not initialized. Call initTheme() first.` unless mocked or initialized.
- **`NavigatorOverlay` Component State** (`navigator.ts`):
  - Pure synchronous TUI component. All async fs/git reads remain in `index.ts`/`viewer.ts`.
  - Input loop runs on every keystroke (`handleInput` → `touch()` → `requestRender()`).
  - Existing caches: `markedCache`, `maxLineWidthCache`, `rowsCache`, `searchVersion`.
  - Key `m` is currently unclaimed in normal mode and in `handleViewerInput` (`navigator.ts:815-850`).
- **Footer Budget** (`navigator.ts:76-83, 1086-1108`):
  - At a 100-column terminal (98 inner columns), `joinLeftRight` guarantees the right-hand pane labels (`files  git  viewer` ~25 cols).
  - The left hint string must fit in ~71 columns to avoid truncation. Replacing `h l` with `m mode` preserves the 71-column length exactly:
    `"j k scroll  Ctrl+d/u  w wrap  m mode  / search  n N  Tab  ? help  q close"` (71 chars).
- **Commit Diff Contract (G1)** (`navigator.ts:325-345`, `index.ts:159-170`):
  - Git commit diffs are opened as `ViewerFile` with `kind: "diff"` and `relPath: "commit:<hash>"`.
  - Diffs are unified patches (`+`/`-`/`@@`) and must never be rendered as markdown, even if the commit touches `.md` files.

---

## §1 — Phase 1: Data Contract & Loader (`types.ts`, `viewer.ts`)

### 1.1 `ViewerFile` Type Extension (`types.ts`)
Extend [`ViewerFile`](file:///home/jhonny/Sources/pi-navigator/types.ts#L102-L122):

```typescript
export interface ViewerFile {
  kind: ViewerKind;
  relPath: string;
  sizeBytes?: number;
  lineCount?: number;
  mtimeMs?: number;
  lines: string[];
  notice?: string;
  message?: string;
  imageTier?: "metadata" | "native" | "chafa";
  commitHash?: string;
  parents?: string[];

  /**
   * Unexpanded, CR-normalized source text for alternative renderers
   * (e.g. rendered Markdown). Retained only for markdown files of kind
   * "text" or "truncated". Undefined for diff, binary, image, error, and
   * non-markdown source files.
   */
  rawText?: string;
}
```

### 1.2 Extension Helper & Loader Pipeline (`viewer.ts`)
1. Export path predicate:
   ```typescript
   export function isMarkdownPath(relPath: string): boolean {
     const ext = extOf(relPath);
     return ext === "md" || ext === "markdown";
   }
   ```
2. In `loadFile(absPath, relPath)` (`viewer.ts:245-347`):
   - At line 318, `raw` is normalized: `raw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");`.
   - Capture `raw` **before `expandTabs`**.
   - If `isMarkdownPath(relPath)`:
     - For `overBytes || overLines` (`kind: "truncated"`):
       Attach `rawText: raw.split("\n").slice(0, MAX_HIGHLIGHT_LINES).join("\n")`.
     - For normal text files (`kind: "text"`):
       Attach `rawText: raw`.
   - For all non-markdown files: do not attach `rawText` (stays `undefined`).

---

## §2 — Phase 2: Component State, Eligibility & Keybindings (`navigator.ts`)

### 2.1 State & Eligibility Guard
Add state and eligibility helper to [`NavigatorOverlay`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L121):

```typescript
private viewRenderMarkdown = false;

private canRenderMarkdown(file: ViewerFile | null): boolean {
  return (
    file !== null &&
    file.kind !== "diff" &&
    file.rawText !== undefined &&
    isMarkdownPath(file.relPath)
  );
}
```

### 2.2 Keybinding `m` in `handleViewerInput`
In `handleViewerInput(data: string)` (`navigator.ts:815-850`):

```typescript
} else if (data === "m") {
  if (this.canRenderMarkdown(this.viewFile)) {
    this.viewRenderMarkdown = !this.viewRenderMarkdown;
    this.viewHscroll = 0; // rendered mode is wrap-only

    // Full cache invalidation protocol:
    this.rowsCache = null;
    this.markedCache = null;
    this.mdCache = null;
    this.searchDirty = true;
    this.searchMatches = [];
    this.searchMatchLines.clear();
    this.searchVersion++;

    this.touch();
  } else {
    this.showNotice("rendered view only available for markdown files");
  }
  return;
```

### 2.3 Behavior of `w` (Wrap Toggle) in Rendered Mode
When `this.viewRenderMarkdown && this.canRenderMarkdown(this.viewFile)` is active:
- Pressing `w` is a no-op (rendered markdown is pre-wrapped to `contentW`). `touch()` is skipped.

---

## §3 — Phase 3: Render Caching & Formatting Pipeline (`navigator.ts`)

### 3.1 Instance Cache Fields
```typescript
private mdRenderer: Markdown | null = null;
private mdCache: {
  file: ViewerFile;
  width: number;
  lines: string[];
} | null = null;
```

### 3.2 Memoized Markdown Line Generator
```typescript
private getRenderedMarkdownLines(file: ViewerFile, width: number): string[] {
  if (width <= 0) return [];
  if (this.mdCache && this.mdCache.file === file && this.mdCache.width === width) {
    return this.mdCache.lines;
  }
  if (!this.mdRenderer) {
    this.mdRenderer = new Markdown("", 0, 0, getMarkdownTheme());
  }
  this.mdRenderer.setText(file.rawText ?? "");
  const rawLines = this.mdRenderer.render(width);

  // Width safety clamp: pad to width and prevent bright ellipsis leakage
  const lines = rawLines.map((line) => {
    const vw = visibleWidth(line);
    return vw < width ? line + " ".repeat(width - vw) : truncateToWidth(line, width, "");
  });

  this.mdCache = { file, width, lines };
  return lines;
}
```

---

## §4 — Phase 4: Layout & In-File Search Integration (`navigator.ts`)

### 4.1 Right Pane Rendering (`buildRightRows`)
In `buildRightRows(rightW: number, body: number)`:

```typescript
const isSwitching = this.viewLoading && this.viewTargetRelPath !== null && this.viewTargetRelPath !== this.viewFile?.relPath;
const file = isSwitching ? null : this.viewFile;

// Cards (binary, image, error) branch unchanged...

const T = this.T;
const canRender = this.canRenderMarkdown(file);
const useRendered = canRender && this.viewRenderMarkdown;

let noticeRows = 0;
if ((file.kind === "truncated" || file.kind === "diff") && file.notice) noticeRows += 1;
if (this.diskChanged) noticeRows += 1;

let contentW: number;
let digits = 0;
if (useRendered) {
  // Clean Reader Layout: 1-col left padding, 1-col right padding
  contentW = Math.max(10, rightW - 2);
  this.viewHscroll = 0;
} else {
  // Code Layout: line numbers gutter
  digits = Math.max(2, String(file.lineCount ?? file.lines.length).length);
  const gutterW = digits + 1;
  contentW = Math.max(10, rightW - 2 - (gutterW + 2));
}
const contentArea = Math.max(1, area - noticeRows);

// Notices (truncated, diff, diskChanged) render unchanged...
```

### 4.2 Branching Between Code & Rendered Lines
```typescript
if (useRendered) {
  const mdLines = this.getRenderedMarkdownLines(file, contentW);

  // Search indexing on rendered lines:
  if (this.searchDirty || this.searchQuery) {
    this.recomputeSearchOnLines(mdLines);
  }

  // Jump to match:
  if (this.searchJump && this.searchMatches.length > 0) {
    const currentMatch = this.searchMatches[this.searchIndex];
    if (currentMatch) {
      this.viewScroll = Math.max(0, currentMatch.line - Math.floor(contentArea / 2));
    }
    this.searchJump = false;
  }
  this.viewScroll = Math.max(0, Math.min(this.viewScroll, Math.max(0, mdLines.length - contentArea)));

  // Viewport slice and match marking
  for (let i = 0; i < contentArea; i++) {
    const lineIdx = this.viewScroll + i;
    const rawLine = mdLines[lineIdx];
    if (rawLine === undefined) {
      rows.push(this.padTo("", rightW));
      continue;
    }

    let styledLine = rawLine;
    if (this.searchQuery && this.searchMatches.length > 0) {
      styledLine = this.markLineMatches(styledLine, lineIdx);
    }
    // 1-space margin on the left
    rows.push(this.padTo(" " + styledLine, rightW));
  }
} else {
  // Existing code-view pipeline (computeRows, gutter, hscroll) unchanged
}
```

### 4.3 Search Helpers for Rendered Rows
Refactor search matching so it can target an arbitrary line buffer:
- `recomputeSearch()`: checks `useRendered` to pick either `file.lines` or cached `mdLines`.
- `markLineMatches(line, lineIdx)`: counts occurrences and calls `markMatches(line, query, T.searchMatch, T.searchCurrent, occurrence)`.

---

## §5 — Phase 5: Chrome, Indicators & Help Modal

### 5.1 Viewer Header Mode Badge (`buildViewerHeader`)
In `buildViewerHeader(rightW: number)`:
When `this.canRenderMarkdown(file)` is true:
- Append mode token: `this.viewRenderMarkdown ? T.dim("m code") : T.dim("m render")` (or `[m code]` / `[m render]`).
- For non-markdown files: omit the token completely.

### 5.2 Footer Hints (`FOCUS_HINTS.viewer`)
Update the static hint in `FOCUS_HINTS`:
```typescript
viewer: "j k scroll  Ctrl+d/u  w wrap  m mode  / search  n N  Tab  ? help  q close",
```
- Fits exactly in 71 columns, preserving the 100-column footer width budget test.

### 5.3 Help Modal (`HELP_ROWS`)
Add key description:
```typescript
["m", "toggle markdown rendered / code view"],
```

---

## §6 — Phase 6: Test Matrix & Verification Plan

### 6.1 Unit Tests (`test/viewer.test.ts`)
- `isMarkdownPath`: returns true for `.md`, `.markdown`, uppercase `.MD`; false for `.ts`, `.txt`, `.json`, etc.
- `loadFile`:
  - Preserves `rawText` on `sample.md` with original unexpanded tabs.
  - Preserves `rawText` on CRLF markdown (CRs stripped, LFs kept).
  - Preserves head slice `rawText` on truncated markdown.
  - Leaves `rawText` undefined on `sample.ts` and `blob.bin`.

### 6.2 Reducer / Component Tests (`test/navigator.test.ts`)
- **Test Harness Setup**: In `vi.mock("@earendil-works/pi-coding-agent")`, stub `getMarkdownTheme`:
  ```typescript
  getMarkdownTheme: () => ({
    heading: (t: string) => t,
    link: (t: string) => t,
    linkUrl: (t: string) => t,
    code: (t: string) => t,
    codeBlock: (t: string) => t,
    codeBlockBorder: (t: string) => t,
    quote: (t: string) => t,
    quoteBorder: (t: string) => t,
    hr: (t: string) => t,
    listBullet: (t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    strikethrough: (t: string) => t,
    highlightCode: (code: string) => code.split("\n"),
  }),
  ```
- **Test Cases**:
  - `m` toggles `viewRenderMarkdown` when viewing a markdown file.
  - `m` shows notice and does not toggle when viewing `.ts`.
  - `m` shows notice when viewing a commit diff (`kind: "diff"`).
  - Toggling `m` resets `viewHscroll = 0` and invalidates caches.
  - In-file search (`/`) correctly matches and cycles in rendered mode.
  - Header meta displays `m render` in code view and `m code` in rendered view.

### 6.3 Width-Safety Tests (`test/render.test.ts`)
- Test rendered markdown file containing:
  - Long heading lines
  - Bulleted lists and nested sublists
  - Markdown tables
  - Fenced code blocks with language tags
  - Inline formatting (bold, italic, links)
- Validate `expectWidthSafe` passes at:
  - 120×36
  - 100×28 (and verify footer focus indicators remain intact)
  - 80×24
  - 60 columns (narrow screen)
- Verify no bright ellipsis `\x1b[0m` leak in rendered rows.

---

## §7 — Implementation Sequence & Gate Checklist

1. **Step 1**: Modify `types.ts` (`rawText?: string`).
2. **Step 2**: Update `viewer.ts` (`isMarkdownPath`, capture unexpanded `rawText` in `loadFile`).
3. **Step 3**: Add viewer unit tests in `test/viewer.test.ts` and run `npm test`.
4. **Step 4**: Update `navigator.ts` (`canRenderMarkdown`, `getRenderedMarkdownLines`, `m` key handling, `buildRightRows` branch, search integration, header/footer/help tokens).
5. **Step 5**: Update test harness mock in `test/navigator.test.ts` and add reducer test cases.
6. **Step 6**: Add rendered markdown width-safety test in `test/render.test.ts`.
7. **Step 7**: Bump version in `package.json` to `0.5.0` and run `npm run typecheck && npm test`.
