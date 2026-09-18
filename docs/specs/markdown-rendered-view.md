# pi-navigator — Specification: Rendered Markdown View

**Status:** Proposed (rev. 2 — validated against codebase v0.4.2)  
**Author:** AI Pair Programmer & User  
**Target Version:** v0.5.0  
**Related Components:** `viewer.ts`, `navigator.ts`, `types.ts`, `theme.ts`  
**Reference Implementations:** `pi-skill-gate` (`overlay.ts`), `@earendil-works/pi-tui` (`Markdown`), `@earendil-works/pi-coding-agent` (`getMarkdownTheme`)

---

## 1. Overview & Motivation

`pi-navigator` provides a read-only file tree, git panel, and file viewer overlay for `pi`. Currently, all text files—including Markdown (`.md`, `.markdown`)—are displayed strictly in **code form**: syntax-highlighted source code with line-numbered gutters, word-wrap or horizontal scrolling, and raw markdown syntax tokens (`#`, `**`, backtick code fences, pipe tables).

While viewing code form is essential for editing and exact line referencing, documentation files (such as `README.md`, design specifications, task lists, and skill docs) are significantly easier to read when rendered as rich terminal prose with styled headings, clean lists, formatted tables, and indented code blocks.

### Goals
- Allow users to toggle between **Code View** (raw syntax-highlighted source with line gutter) and **Rendered View** (rich terminal markdown) for Markdown files via a dedicated keybinding (`m`).
- Utilize native `pi-tui` rendering components ([`Markdown`](file:///home/jhonny/Sources/pi-navigator/node_modules/@earendil-works/pi-tui/dist/components/markdown.d.ts#L53)) and `pi-coding-agent` theme infrastructure ([`getMarkdownTheme`](file:///home/jhonny/Sources/pi-navigator/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.d.ts#L127)), maintaining zero external runtime dependencies.
- Preserve full viewer interactivity in rendered mode: smooth vertical scrolling, in-file search (`/`, `n`, `N`) with match highlighting, and viewport resizing.
- Ensure strict width-safety across all supported terminal sizes (120×36, 100×28, 80×24, and narrow viewports).

### Non-Goals
- Editing or WYSIWYG modification of markdown (the viewer remains read-only).
- Adding npm markdown libraries or shelling out to external renderers like `glow` or `pandoc`.
- Rendering non-markdown documents (HTML, Org-mode, AsciiDoc, etc.).
- Rendering commit diffs as markdown (see §4.1 / G1).

---

## 2. Technical Grounding & Architecture References

### 2.1 The `pi-skill-gate` Reference Pattern
The reference extension `pi-skill-gate` implements a bordered overlay that displays rendered markdown for skill documentation (`overlay.ts:162, 690-758`):
1. **Component**: Instantiates `new Markdown("", 0, 0, getMarkdownTheme())`.
2. **Layout & Reflow**:
   - Takes raw markdown text via `md.setText(content)`.
   - Renders wrapped lines for a specific column width via `md.render(contentW)`.
   - Slices visible lines for scrolling: `mdLines.slice(scrollOffset, endLine)`.
3. **Search Highlighting**: Applies match styling over styled lines using visible-width measurements without disturbing ANSI escapes.

### 2.2 Verified `Markdown` Component Behavior (`@earendil-works/pi-tui/dist/components/markdown.js`)
Facts confirmed against the installed component — the spec builds on these:
- `render(width)` **already pads every line to `width`** (left/right margins via `paddingX`, then `" ".repeat(paddingNeeded)` when no background). It also **replaces tabs with 3 spaces before lexing** (`text.replace(/\t/g, "   ")`), independent of this repo's `TAB_WIDTH = 4`.
- `setText()` clears the component's internal `(text, width) → lines` cache; `render()` memoizes on `cachedText === this.text && cachedWidth === width`.
- `getMarkdownTheme()` returns a complete `MarkdownTheme` including `highlightCode: (code, lang) => string[]` — fenced code blocks inside rendered Markdown are automatically syntax-highlighted using the active theme.

### 2.3 `pi-navigator` Constraints & Contracts
- **Pure Component Boundary**: `navigator.ts` is purely synchronous and receives file data through `loadFile(absPath, relPath)`. It must not access the filesystem.
- **Strict Width Safety**: Every row rendered by `NavigatorOverlay` must measure exactly to the allocated pane width; `padTo` and `truncateToWidth` prevent escape leaks or frame breakage.
- **Cache Invalidation**: The top-level `render()` method is called on every keystroke. Expensive operations (Markdown AST parsing, code syntax highlighting, wrap recomputation) must be cached against their stable inputs. The existing per-view caches (`markedCache`, `maxLineWidthCache`, `rowsCache`, and the `searchVersion` bump — `navigator.ts:115-160`) are the pattern to follow and must not be bypassed.
- **Memory Caps**: File size caps (`MAX_HIGHLIGHT_BYTES = 1 MB`, `MAX_HIGHLIGHT_LINES = 5000`) must be respected so large markdown files do not degrade performance.

---

## 3. Data Model Changes

### 3.1 Extended `ViewerFile` (`types.ts`)
Add an optional `rawText` field to `ViewerFile` to retain the text needed by the `Markdown` component:

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
   * Source text for alternative renderers (e.g. rendered Markdown).
   * Strictly the CR-normalized, tab-unexpanded raw string (the loader's
   * `raw` right after CR folding, before expandTabs) — NOT the expanded
   * or highlighted variants. Retained only for markdown files; `""`
   * / undefined for every other kind (diff, binary, image, error).
   * When present it is the single source of truth for rendering; `lines`
   * stays the code-view (highlighted) representation.
   */
  rawText?: string;
}
```

**Typing constraint:** declare `rawText?: string` (optional, never `rawText: string = ""`). The type must stay open so `kind === "diff"` (a `.md` file opened as a commit diff) is distinguishable from a rendered-capable text file by `rawText === undefined` (see G1).

### 3.2 File Loading Pipeline (`viewer.ts`)
Modify `loadFile(absPath, relPath)`:

```typescript
export function isMarkdownPath(relPath: string): boolean {
  const ext = extOf(relPath);
  return ext === "md" || ext === "markdown";
}
```

1. `raw` is already the CR-normalized string (`\r\n`/`\r` → `\n`) at `viewer.ts:265-268`. **Capture it before `expandTabs`.** `expanded` is derived from `raw` and cannot be un-expanded, so the renderer's source must be `raw`.
2. When `isMarkdownPath(relPath)` is true:
   - **Regular files** (`kind: "text"`): attach `rawText: raw`.
   - **Oversized files** (`kind: "truncated"`): attach `rawText: raw.split("\n").slice(0, MAX_HIGHLIGHT_LINES).join("\n")`. This is the same head boundary `allLines.slice(0, MAX_HIGHLIGHT_LINES)` already enforces, but taken from the unexpanded `raw` so the rendered view respects the truncation boundary without pulling unbounded content into memory *and* without pre-expanded tabs.
3. **Non-markdown files: omit `rawText`.** This is also what keeps a `.md` file opened as a **commit diff** (`kind: "diff"`) out of rendered mode — the diff loader (`index.ts:159-170`) constructs its `ViewerFile` without `rawText`, and that is the discriminator, not the path (see §4.1).

Note: `loadFileCached` in `index.ts` caches the whole `ViewerFile` by mtime — `rawText` rides along for free; no cache changes needed.

---

## 4. UI & Interaction Design

### 4.1 Keybinding: `m` (Toggle Markdown Mode)
- **Scope**: Active when focus is on `"viewer"` (`this.focus === "viewer"`) — `m` is unclaimed by the global keys in `handleNormalInput` (`navigator.ts:616-673`), so it falls through to `handleViewerInput` cleanly.
- **Rendered eligibility — one predicate, used everywhere:**
  ```typescript
  private canRenderMarkdown(file: ViewerFile | null): boolean {
    return (
      file !== null &&
      file.kind !== "diff" &&            // G1: commit diffs never render, even for .md paths
      file.rawText !== undefined &&      // only the file loader sets this
      isMarkdownPath(file.relPath)
    );
  }
  ```
- **Behavior when eligible** (a markdown text/truncated file is open):
  - Toggles `this.viewRenderMarkdown = !this.viewRenderMarkdown;`.
  - Resets horizontal scroll (`this.viewHscroll = 0`) — rendered markdown always wraps to width.
  - **Invalidates every viewer cache that depends on the active line set**, not just "the search cache" (M1):
    - `searchDirty = true` **and** clear `searchMatches` / `searchMatchLines` (the lazy `recomputeSearchIfNeeded` then re-indexes against the rendered rows on the next render pass); bump `searchVersion`.
    - Clear `rowsCache` and `markedCache` — they hold code-view artifacts keyed on `marked`/`hscroll` and would otherwise serve stale rows.
    - Clear the `mdCache` (see §5.3) — its `width` key alone is not enough; the rendered content source changed.
    - Clamp `this.viewScroll` to the new content bounds on the next render pass (the existing clamp at `navigator.ts:1404-1406` handles this; `cacheVal`, then re-run).
  - Calls `this.touch()` to trigger a render.
- **Behavior when NOT eligible**:
  - Calls `this.showNotice("rendered view only available for markdown files")`.
  - The mode flag stays unchanged, so opening a markdown file after a `.ts` file does not carry stale state.
- **`w` in rendered mode is a no-op**: rendered rows are pre-wrapped to `contentW`; `viewWrap` is ignored there (see §5.2). The `w` hint may remain in the footer; it just has no effect while rendered.

### 4.2 Header Indicators (`navigator.ts:buildViewerHeader`)
Display the current viewing mode in the viewer header next to the file path and metadata, gated on the **same** `canRenderMarkdown` predicate:
- Rendered-capable, code view: `README.md · 4.2 KB · 120L [m render]`
- Rendered-capable, rendered view: `README.md · 4.2 KB · 120L [m code]`
- Non-markdown (`.ts`, `.json`, …): `src/main.ts · 2.0 KB · 200L` — **no mode token at all** (avoids advertising an unavailable action).

The meta array in `buildViewerHeader` (`navigator.ts:1382-1403`) is where the token is pushed: `meta.push(T.dim("m render"))` / `T.dim("m code")`.

### 4.3 Footer Hints (`getFooterHint`)
`FOCUS_HINTS` is a **static record** returned directly by the `switch` in `getFooterHint` (`navigator.ts:1078-1085`) — it cannot be spliced per-file at render time. Two acceptable options (pick one):
1. **Static base hint** (simplest, matches current width budget — see the comment at `navigator.ts:78-79`):
   `"j k scroll  Ctrl+d/u  w wrap  m mode  / search  n N  Tab  ? help  q close"`
   (`m mode` shown always, regardless of the open file — it is a no-op + notice on non-markdown).
2. **Dynamic**: extend `getFooterHint` to return `FOCUS_HINTS.viewer` plus `\u200b m render|m code` only when `canRenderMarkdown(this.viewFile)` and focus is viewer. Requires re-checking the 100-column width budget test if the string grows.

Recommend **option 1** — it keeps the footer width-stable and the `m` action discoverable everywhere.

### 4.4 Help Modal (`HELP_ROWS`)
Add an entry to `HELP_ROWS`:
```typescript
["m", "toggle markdown rendered / code view"],
```

---

## 5. Viewer Pane Rendering (`navigator.ts:buildRightRows`)

### 5.1 Gutter & Layout Decision: Clean Reader Layout
- **Code View**: Displays line numbers with gutter:
  ```
  │   1 │ # Title
  │   2 │
  │   3 │ Paragraph text...
  ```
- **Rendered View**: Uses a clean **Reader Layout** (no line numbers, 1-character left padding):
  ```
  │  Title
  │
  │  Paragraph text with bold styling and formatted lists...
  ```
  *Rationale*: In rendered markdown, paragraphs reflow, headings shift, lists reformat, and tables span multiple rows. Source line numbers lose their 1:1 meaning and consume horizontal width that is critical for tables and indented code blocks.

### 5.2 Geometry & Width Calculation
In `buildRightRows`, derive one predicate and branch once:

```typescript
const canRender = this.canRenderMarkdown(file);   // §4.1
const useRendered = canRender && this.viewRenderMarkdown;

let contentW: number;
if (useRendered) {
  // 1-cell left margin, 1-cell right margin inside rightW
  contentW = Math.max(10, rightW - 2);
  this.viewHscroll = 0;        // rendered mode is wrap-always; no horizontal scroll
} else {
  // Gutter width follows lineCount or lines.length (unchanged, current code)
  const digits = Math.max(2, String(file.lineCount ?? file.lines.length).length);
  const gutterW = digits + 1;
  contentW = Math.max(10, rightW - 2 - (gutterW + 2));
}
```

**Rendered mode short-circuits the code-view row pipeline.** `computeRows`/`sliceStyled`/`cachedComputeRows` (which wrap and horizontally slice styled lines) must **not** run on rendered rows — `Markdown.render()` has already wrapped them to `contentW`. The rendered path is: `getRenderedMarkdownLines(file, contentW)` → mark matches → clamp → slice to viewport (§5.4). `viewWrap` is ignored while `useRendered`.

### 5.3 Render Caching
`Markdown.render(width)` is internally cached on `(text, width)`, but re-parsing on every mode toggle is avoidable and the cache must live across `touch()` (which only clears the top-level frame cache). Keep a component-level memo:

```typescript
private mdRenderer: Markdown | null = null;
// Unmarked rendered rows, keyed on (file ref, contentWidth). Marking is
// applied per render pass on top of these (row counts are viewport-bounded
// and cheap), so searchVersion does NOT need to be part of this key.
private mdCache: { file: ViewerFile; width: number; lines: string[] } | null = null;

private getRenderedMarkdownLines(file: ViewerFile, width: number): string[] {
  if (width <= 0) return [];                       // edge case 7.4
  if (this.mdCache && this.mdCache.file === file && this.mdCache.width === width) {
    return this.mdCache.lines;
  }
  if (!this.mdRenderer) {
    this.mdRenderer = new Markdown("", 0, 0, getMarkdownTheme());
  }
  // rawText is the single source of truth: CR-normalized, tab-unexpanded.
  // Never fall back to file.lines (they are highlighted code-view rows with
  // ANSI + tab-expanded text — not parseable markdown).
  this.mdRenderer.setText(file.rawText ?? "");
  const rawLines = this.mdRenderer.render(width);

  // Belt-and-suspenders width safety: Markdown already pads to `width`, but
  // the no-background path is the one it pads; keep the clamp for narrow
  // margins / exotic glyphs. Empty ellipsis per the repo convention
  // (truncateToWidth's default "..." wraps in \x1b[0m resets).
  const lines = rawLines.map((line) => {
    const vw = visibleWidth(line);
    return vw < width ? line + " ".repeat(width - vw) : truncateToWidth(line, width, "");
  });

  this.mdCache = { file, width, lines };
  return lines;
}
```

Invalidation: `mdCache` is cleared (set to `null`) alongside the other caches on: mode toggle (§4.1), file change (new `file` ref), and — because `Markdown.render` is internally cached on text — nothing else. `setText` + `render` already re-key correctly when width changes.

### 5.4 Search Integration in Rendered View
Rendered rows are **reflowed** — source `lineCount` and the `lines[i]` numbering have no meaning in `mdLines`. The code-view search path (`searchLines` over `file.lines` → `markSearch` line-index membership → `computeRows`) therefore does **not** apply. The rendered path is self-contained:

1. **Targets**: `searchLines(cachedMdLines, query)` — the md row index *is* the match's `line`.
2. **No `markSearch` file-clone**: with rendered rows, matches are indexed into `mdLines` directly. Per render pass, walk the (viewport-corresponding) cached md lines and apply `markMatches(line, query, T.searchMatch, T.searchCurrent, occurrenceOnLine)` — the same occurrence computation `markSearch` uses (`navigator.ts:1507-1513`), indexed against the **md** match list. This is O(viewport rows) per pass and needs no cache. The full-set scan (for the `n/3/12` counter and `n`/`N` cycling) uses the already-cached full `mdLines`.
3. **Jump**: `searchLines`/`cycleSearch` set `searchJump`; in rendered mode, `this.viewScroll = max(0, currentMatch.line - floor(contentArea/2))` — `currentMatch.line` **is** the md row index, no `display.findIndex(row => row.line === …)` translation needed.
4. **Invalidation** is unified: any `searchQuery` / mode change bumps `searchVersion` (`recomputeSearch`/`cycleSearch` already do) and clears `mdCache`/`searchMatches` (§4.1).
5. **Constraint**: never feed rendered rows through `computeRows`, `sliceStyled`, or `viewHscroll` — the styled-byte match offsets are valid only for direct marking of the row in which they were located (they do not survive wrap slicing).

---

## 6. Implementation Plan & File Modifications

| File | Changes |
|---|---|
| `types.ts` | Add `rawText?: string` to `ViewerFile` (CR-normalized, tab-unexpanded source; §3.1). |
| `viewer.ts` | Export `isMarkdownPath()`; capture CR-normalized `raw` before `expandTabs`; attach `rawText` for `.md`/`.markdown` text and truncated kinds (head-sliced); omit otherwise (§3.2). |
| `navigator.ts` | Add `viewRenderMarkdown` state + `canRenderMarkdown()`; instantiate/cache `Markdown` renderer (`mdRenderer`/`mdCache`); bind `m` in `handleViewerInput` with full cache invalidation; update `buildViewerHeader` meta token, `getFooterHint` (or static `FOCUS_HINTS`), `buildRightRows` branch, rendered search path (§4, §5). |
| `test/viewer.test.ts` | `rawText` retention on `.md`/`.markdown` (text + truncated head); omission on `.ts`/`.txt`; `rawText` is unexpanded (tab-free) and CR-normalized. |
| `test/navigator.test.ts` | `m` toggles mode for `.md` files; notice for non-markdown; notice + no state change for a `.md` open as **diff** (G1); resets `hscroll`; invalidates search/caches. |
| `test/render.test.ts` | Rendered markdown layout width-safety at 120×36, 100×28, 80×24, and 50 columns; rendered rows bypass the gutter and never overflow; `m` + search highlight renders inside pane bounds. |

**Test-harness requirement (initTheme split):** `test/navigator.test.ts` and `test/render.test.ts` mock `@earendil-works/pi-coding-agent` (`navigator.test.ts:15`) — keep `getMarkdownTheme` behind that mock (or stub it) rather than calling the real one, which throws `Theme not initialized` outside a pi session (`theme.js:544`). `test/viewer.test.ts` uses the **real** pi-coding-agent highlighter and is unaffected. With `Markdown` also imported from `pi-tui` (real), the render/navigator suites exercise the real component against a stubbed theme.

---

## 7. Edge Cases & Safety Constraints

1. **Headless Vitest Execution (`initTheme()`)** — see the test-harness note in §6. Real `getMarkdownTheme()` requires `initTheme()` first; prefer stubbing in suites that already mock pi-coding-agent.
2. **Oversized Markdown Documents**: `rawText` for the truncated kind is the capped head (`MAX_HIGHLIGHT_LINES` lines from `raw`), so the `Markdown` parser never sees unbounded input. Memory stays bounded by `MAX_HIGHLIGHT_BYTES`/`MAX_HIGHLIGHT_LINES` — never by the file.
3. **CRLF Line Endings**: `rawText` comes from the already CR-normalized `raw`; the `Markdown` path is carriage-return-free by construction (§3.2).
4. **Zero or Negative Width**: `getRenderedMarkdownLines` returns `[]` for `width <= 0`; `contentW` is floored at 10 by §5.2; `buildRightRows`'s existing `contentArea = max(1, …)` and `padTo` keep the narrow-terminal compact notice reachable.
5. **`.md` opened as a commit diff (G1)**: `canRenderMarkdown` excludes `kind === "diff"` — even though `isMarkdownPath("commit:<hash>")` would be false anyway (the stored path is `commit:abc1234`, extensionless), the guard is explicit so the mode state can never render or advertise itself against a diff. Pressing `m` on a diff shows the notice.
6. **Rendered rows are pre-wrapped (G3)**: they must bypass `computeRows`/`sliceStyled`/`viewHscroll`; match offsets are styled-byte offsets valid only for direct marking. Wrap is mandatory in rendered mode (`w` is a no-op).
7. **Tab expansion**: `rawText` is tab-unexpanded; `Markdown` internally replaces `\t` with 3 spaces (its own constant, not `TAB_WIDTH = 4`). If 4-space consistency for fenced code is wanted, pass a `transform` option (`MarkdownOptions.transform`) — a tuning note, not a blocker.
8. **Fenced code highlight**: `getMarkdownTheme()` implements `highlightCode` via pi's syntax highlighter (`cli-highlight` based on `highlight.js`), so fenced code blocks automatically receive language-appropriate syntax coloring.

---

## 8. Verification & Acceptance Criteria

- **Functional Verification**:
  - Open a `.md` file in `/navigator`.
  - Pressing `m` switches to formatted headings, lists, tables, and fenced code blocks; header shows `[m code]`.
  - Pressing `m` again returns to the line-numbered code view; header shows `[m render]`.
  - Pressing `m` on a `.ts` file (or on a `.md` open as a **commit diff**) shows the notice: `"rendered view only available for markdown files"` and changes nothing else (compact notice, no mode-token in the header).
  - In-file search (`/`) locates and highlights terms in rendered text; `n`/`N` cycle; the footer counter is accurate.
  - Scrolling (`j`/`k`/`g`/`G`/`Ctrl+d`/`Ctrl+u`) is smooth — the `mdCache` absorbs reflow; `w` is inert in rendered mode.
  - Truncated markdown renders its capped head (notice row visible), no stutter on scroll.
- **Automated Verification**:
  - `npm run typecheck` passes with zero type errors.
  - `npm test` passes all suites, including new viewer (`rawText`), navigator (`m` toggle/notice/diff-gate/cache invalidation), and render (width-safety at 120×36, 100×28, 80×24, 50) tests.
  - No ANSI escape leaks or line overflow beyond pane boundaries in any mode.
  - Fenced code blocks render with syntax-highlighted code styling via `highlightCode` (§7.8).
