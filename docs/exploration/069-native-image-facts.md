# 069 — Native image rendering: verified API facts (pi-tui 0.85.1, pi 0.85.1, pi-chafa)

Verified by direct read of the installed packages in `/home/jhonny/Sources/pi-navigator/node_modules/`.
No source modified.

## 0. Versions & linkage

- `@earendil-works/pi-tui` **0.85.1** (`node_modules/@earendil-works/pi-tui/package.json`).
- `@earendil-works/pi-coding-agent` **0.85.1** (spec §3 header says "pi 0.86.1" — the *installed host here* is 0.85.1; the spec's citation of `settings-manager.js:833` corresponds to line ~796–805 in 0.85.1).
- `node_modules/@earendil-works/` contains **one directory per package, no symlinks** (`ls -la` shows plain dirs) — a regular npm copy, not a pnpm-style alias. pi's loader aliasing to the host singleton is a runtime behavior, not a node_modules property.

## 1. pi-tui 0.85.1 public exports (`dist/index.d.ts`)

All of the following ARE exported from the package root (index.d.ts lines 6, 30):

```ts
export { Image, type ImageOptions, type ImageTheme } from "./components/image.ts";
export { allocateImageId, type CellDimensions, calculateImageRows, deleteAllKittyImages,
  deleteKittyImage, detectCapabilities, encodeITerm2, encodeKitty, getCapabilities,
  getCellDimensions, getGifDimensions, getImageDimensions, getJpegDimensions,
  getPngDimensions, getWebpDimensions, hyperlink, type ImageDimensions, type ImageProtocol,
  type ImageRenderOptions, imageFallback, renderImage, resetCapabilitiesCache, setCapabilities,
  setCapabilityOverrides, setCellDimensions, type TerminalCapabilities } from "./terminal-image.ts";
```

Also exported from root: `getOsc8LinkAtColumn, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi` (utils.ts). `registerKittyImageMetadata`, `getKittyImageMetadata`, `getKittyImagePlacement`, `cropKittyImageLine`, `isImageLine`, `calculateImageCellSize` are NOT in the index.d.ts export line but ARE `export function` in `terminal-image.d.ts` (module-level, importable via `@earendil-works/pi-tui/dist/terminal-image.js` or via the package export map). Check the package.json `exports` map before importing the subpath — the main entry does not re-export them.

### 1.1 `Image` component (`components/image.js`)

Constructor: `new Image(base64Data, mimeType, theme: ImageTheme, options?: ImageOptions, dimensions?: ImageDimensions)`; options `{maxWidthCells?, maxHeightCells?, filename?, imageId?}`. Methods `getImageId()`, `invalidate()`.

`render(width)` (image.js:34–88), verbatim logic:

- `maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60))` — note the `width - 2` clamp.
- default maxHeight = `Math.ceil((maxWidth * cellW) / cellH)` unless `options.maxHeightCells`.
- kitty path: allocates `imageId` if undefined; calls `renderImage(..., {maxWidthCells, maxHeightCells, imageId, moveCursor: false})`; then:
  ```js
  lines = [result.sequence];
  for (let i = 0; i < result.rows - 1; i++) lines.push("");
  ```
  i.e. **kitty: sequence on the FIRST row, rows−1 filler rows of exactly `""`, `moveCursor:false` → `C=1` in the sequence.**
- iterm2 path: `(rows-1)` empty rows first, last row is `moveUp + result.sequence` where `moveUp = rowOffset>0 ? "\x1b[${rowOffset}A" : ""` — sequence row is LAST, cursor restored below.
- fallback (caps.images null or renderImage null): single line `imageFallback(...)` truncated to `width`.
- Results cached per `(lines, width)`; `invalidate()` clears.

### 1.2 `renderImage` (terminal-image.js:498–530)

```ts
function renderImage(base64Data: string, imageDimensions: ImageDimensions,
  options?: ImageRenderOptions): { sequence: string; columns: number; rows: number; imageId?: number } | null
```

- `caps = getCapabilities()`; **returns null when `!caps.images`** and also falls through to `return null` for any protocol other than kitty/iterm2.
- `maxWidth = options.maxWidthCells ?? 80`; size from `calculateImageCellSize(imageDimensions, maxWidth, options.maxHeightCells, getCellDimensions())`.
- kitty: if `options.imageId !== undefined`, calls `registerKittyImageMetadata({imageId, columns, rows, widthPx, heightPx})` (which bumps a global `transmissionGeneration`); then `encodeKitty(base64, {columns, rows, imageId, moveCursor})`. Returns `{sequence, columns, rows, imageId}` (imageId may be `undefined` if not passed).
- iterm2: `encodeITerm2(base64, {width: size.columns, height: "auto", preserveAspectRatio: options.preserveAspectRatio ?? true})`; returns `{sequence, columns, rows}` (no imageId).

### 1.3 Capabilities (terminal-image.js)

```ts
export type ImageProtocol = "kitty" | "iterm2" | null;
export interface TerminalCapabilities { images: ImageProtocol; trueColor: boolean; hyperlinks: boolean; }
export function detectCapabilities(tmuxForwardsHyperlink?: () => boolean): TerminalCapabilities;
export function getCapabilities(): TerminalCapabilities;
export function resetCapabilitiesCache(): void;
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): void;
export function setCapabilities(caps: TerminalCapabilities): void; // overrides cache wholesale (test hook)
```

Detection highlights (verbatim branches): `TMUX || term.startsWith("tmux")` → `{images:null, hyperlinks: tmuxForwardsHyperlink()}`; `term.startsWith("screen")` → `{images:null, hyperlinks:false}`; `KITTY_WINDOW_ID || TERM_PROGRAM==="kitty"` / ghostty / `WEZTERM_PANE` / Warp → `"kitty"`; `ITERM_SESSION_ID || TERM_PROGRAM==="iterm.app"` → `"iterm2"`; WT_SESSION/alacritty/vscode/zed/jetbrains/windows-console/unknown → `null`. `detectCapabilities` folds env: `PI_IMAGE_PROTOCOL` accepts `"kitty"|"iterm2"` (set), `"none"|"0"` (null), anything else = no override; `PI_TRUE_COLOR` / `PI_HYPERLINKS` accept only `"1"`/`"0"`.

**Override merge:** `getCapabilities()` computes `{...detectCapabilities(...), ...capabilityOverrides}` once and caches; `setCapabilityOverrides` replaces the overrides object and invalidates the cache (no-op if all three fields are unchanged). So overrides fully replace a detected field (a `"kitty"` override re-enables images even under tmux).

### 1.4 Kitty id/metadata/placement API (all `export function` in terminal-image.js)

```ts
export function allocateImageId(): number;              // random in [1, 0xfffffffe]
export function deleteKittyImage(imageId: number): string;   // "\x1b_Ga=d,d=I,i=<id>,q=2\x1b\\"
export function deleteAllKittyImages(): string;              // "\x1b_Ga=d,d=A,q=2\x1b\\"
export function deleteAllKittyPlacements(): string;          // "\x1b_Ga=d,d=a,q=2\x1b\\" (keeps uploaded data)
export function registerKittyImageMetadata(metadata: KittyImageMetadata): void;
export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined;
export function getKittyImagePlacement(line: string): KittyImagePlacement | undefined;
export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string;
```

`KittyImageMetadata extends ImageCellSize {imageId; widthPx; heightPx}`; `ImageCellSize {columns; rows}`. `KittyImagePlacement {imageId; transmissionGeneration; transmissionBytes; estimatedDecodedBytes; sequence; replacementLine}` — `sequence` is a **placement-only** command `\x1b_Ga=p,q=2,<filtered controls>\x1b\\` and `replacementLine` is the original line with the transmission chunks swapped for the placement command. Metadata map is LRU-capped at 1000 entries; `registerKittyImageMetadata` bumps `kittyTransmissionGeneration` each call. `cropKittyImageLine` strips `y/h/r` controls and adds `y=<sourceY>,h=<sourceHeight>,r=<croppedRows>`; returns the line unchanged when no metadata, `hiddenRows<0`, `hiddenRows>=metadata.rows`, or `visibleRows<=0`.

### 1.5 Dimensions & sizing

```ts
export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null;
export function calculateImageCellSize(imageDimensions: ImageDimensions, maxWidthCells: number,
  maxHeightCells?: number, cellDimensions?: CellDimensions): ImageCellSize;
export function getCellDimensions(): CellDimensions;  // {widthPx, heightPx}, default {9, 18}
```

- `getImageDimensions` accepts **exactly** the mime strings `"image/png" | "image/jpeg" | "image/gif" | "image/webp"` — **`"image/jpg"` is NOT recognized** (returns null). Per-format parsers sniff magic bytes, so data validity matters too.
- `calculateImageCellSize`: maxWidth/maxHeight are floored and clamped to ≥1; scale = `min(widthScale, heightScale)` (heightScale = widthScale when maxHeightCells undefined); returns `{columns: max(1, min(maxWidth, ceil(scaledW/cellW))), rows: max(1, maxHeight===undefined ? rows : min(maxHeight, ceil(scaledH/cellH)))}` — both dims are clamped to their max, never 0.

### 1.6 `isImageLine` / `getKittyImageReservedRows`

`isImageLine` (terminal-image.js): recognizes the prefixes `"\x1b_G"` (KITTY_PREFIX) and `"\x1b]1337;File="` (ITERM2_PREFIX); fast path `startsWith`, slow path `includes` anywhere in the line.

`getKittyImageReservedRows` lives in the **renderers**, not terminal-image (tui-main-screen.js:172–181):

```js
getKittyImageReservedRows(lines, index, maxIndex = lines.length - 1) {
    const rows = extractKittyImageRows(lines[index] ?? "");   // from r= in the first \x1b_G header
    if (rows <= 1) return 1;
    const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
    let reservedRows = 1;
    while (reservedRows < maxRows) {
        const line = lines[index + reservedRows] ?? "";
        if (isImageLine(line) || visibleWidth(line) > 0) break;
        reservedRows++;
    }
    return reservedRows;
}
```

**Confirmed: a following row counts as reserved only if it is `isImageLine(line)===false` AND `visibleWidth(line)===0` — i.e. exactly `""` (or pure invisible escape sequences). A space-padded row has visibleWidth>0 and stops the count at 1.**

### 1.7 `encodeKitty` / `encodeITerm2`

```ts
encodeKitty(base64Data: string, options?: {columns?; rows?; imageId?; moveCursor?}): string
```
Params always start `["a=T","f=100","q=2"]`; `moveCursor===false` → `C=1`; then `c=<columns>`, `r=<rows>`, `i=<imageId>`. Body chunked at 4096 chars with `m=1`/`m=0` continuation. Terminator `\x1b\\`.

```ts
encodeITerm2(base64Data: string, options?: {width?; height?; name?; preserveAspectRatio?; inline?}): string
```
Always emits `inline=1` (unless `inline===false`) and `size=<byteLength>`; optional `width=`, `height=`, `name=<b64>`, `preserveAspectRatio=0` when `false`. Wraps as `\x1b]1337;File=...:<b64>\x07`.

## 2. Host renderer kitty lifecycle

### TuiMainScreen (`tui-main-screen.js`)

- `parseKittyImageHeader` (lines ~60–90) scans the FIRST `\x1b_G…;` header of a line and collects `i=` values (integers 1..0xffffffff) and `r=` (default 1). `extractKittyImageIds(line)` = its `ids`.
- `collectKittyImageIds(lines)` / `deleteKittyImages(ids)` / `deleteChangedKittyImages(first,last)` emit per-ID `deleteKittyImage` sequences for lines in the changed range of the **previous** frame.
- `expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines)` walks previous+new lines; any line with kitty ids expands the range to `[i, i + reservedRows(i) - 1]` when it overlaps the change window.
- `doRender` full render (`fullRender(clear)`): with `clear`, emits `deleteKittyImages(previousKittyImageIds)` + `\x1b[2J\x1b[H\x1b[3J`. Full renders are triggered by: first render (no clear), width change, height change (except Termux), `clearOnShrink` + shrink, firstChanged above viewport, deleted-lines viewport shift, and "kitty image pre-clear would scroll".
- Differential path: for an image line with reservedRows>1 it pre-clears each reserved row with `\x1b[2K`, emits `\r\n\x1b[2K` per filler row, moves back up, writes the line, moves down — and **skips** the filler rows (`i += imageReservedRows - 1`). If `imageStartScreenRow < 0` or `start + reserved > height` → `fullRender(true)`.

**Space-padded filler rows (the key question):** `visibleWidth(line) > 0` breaks the reserved-row count → reserved rows = 1. Consequences: (a) the changed-range expansion only covers the sequence line itself; (b) the differential renderer treats the line as a plain line — writes `\x1b[2K` + the line, no row skipping, no pre-clear of rows below; (c) the sequence carries `C=1` (no cursor movement) and `c/r` cell size, so kitty still paints `rows` cells downward from the anchor, **overwriting whatever the renderer then writes on those rows** (or being overwritten, depending on order — the padded text written after the sequence lands on painted cells). Ids are still collected from `previousLines`/`newLines` and deleted on change/full-redraw, so there are no ghost images, but the row accounting differs from the empty-filler contract. This matches spec §3.5's "known contract wrinkle".

### TuiAltScreen (`tui-alt-screen.js`)

- `beforeTerminalStart` snapshots capabilities, sets `imageProtocol`, clears `uploadedKittyImages`; **if iterm2, it calls `setCapabilities({...caps, images:null})` for the alt-screen session** and restores on exit.
- `prepareKittyScreen(screen)`: for each line, `getKittyImagePlacement` → if cached with same `transmissionGeneration`, swap in `placement.replacementLine` (placement-only command, no retransmission); LRU-reinsert visible ids; evict offscreen cached images (oldest-first) while over budget: `MAX_CACHED_OFFSCREEN_KITTY_IMAGES=16`, transmission `32 MiB`, decoded `64 MiB` (lines 26–28), emitting `deleteKittyImage` per eviction.
- Render: `fullRedraw = previousScreen empty / width / height changed`; `imagesNeedRedraw = any row differs and either line isImageLine`. If redrawing images with kitty: full redraw → `deleteAllKittyPlacements()` (had uploaded images) else `deleteAllKittyImages()`; partial image redraw → `deleteAllKittyPlacements()`. Every changed row is rewritten with `\x1b[<row>;1H\x1b[2K<line>` — full-screen addressing, no reserved-row concept, no `getKittyImageReservedRows` anywhere in alt-screen.

## 3. pi host (pi-coding-agent 0.85.1)

- Settings → overrides: `dist/core/settings-manager.js:796–805` `getTerminalCapabilityOverrides()` maps `terminal.images`: `"kitty"|"iterm2"` → `{images}`, `false` → `{images: null}`, anything else (including `"auto"`, absent) → no override; `terminal.trueColor`/`terminal.hyperlinks` booleans pass through. Applied via `setCapabilityOverrides(...)` in `dist/modes/interactive/interactive-mode.js:309` and `:1479`.
- `getShowImages()` = `settings.terminal?.showImages ?? true` (settings-manager.js:807). `getImageWidthCells()` = `settings.terminal?.imageWidthCells`, defaulting to **60** when not a finite number (settings-manager.js:817–823); setter floors to ≥1.
- Render context: `interactive-mode.js` passes `showImages: settingsManager.getShowImages()` and `imageWidthCells: settingsManager.getImageWidthCells()` into tool render contexts (lines 2631–2, 2697–8, 3020–1, 3776).
- `ToolExecutionComponent` (`dist/modes/interactive/components/tool-execution.js`):
  - `maybeConvertImagesForKitty()` (:135–156): only when `getCapabilities().images === "kitty"`; converts every non-PNG image block via `convertToPng` (photon WASM, `dist/utils/image-convert.js:26` — "Kitty graphics protocol requires PNG format (f=100)"), caches by block index, re-renders.
  - `updateDisplay()` (:286–304): builds `new Image(imageData, imageMimeType, {fallbackColor}, {maxWidthCells: this.imageWidthCells})` per image block when `caps.images && this.showImages`; **skips the block entirely when `caps.images === "kitty" && imageMimeType !== "image/png"`** (conversion pending → skipped until converted). Preceded by a `Spacer(1)`.
  - `setImageWidthCells(width)` clamps `max(1, floor(width))`.

## 4. pi-chafa (`~/Sources/pi-chafa`)

- `resolveCapsImages(caps, hostImages, envProtocol)` (src/detect.ts:36–53): ladder is (1) `caps` when non-null; (2) settings `terminal.images` via `asNativeProtocol` — **only `"kitty"`/`"iterm2"` count; `false`, `"auto"`, `"none"`, absent, unrecognized → no override (null), it does NOT treat `false` as "force off"**; (3) `PI_IMAGE_PROTOCOL` (trimmed, same acceptance); (4) `null`.
- `decideDelivery` (src/detect.ts:183–204): `format==="native"` → throws if not native-capable, else `showImages ? "native" : "symbols"`; `format==="symbols"` → symbols; `auto` → symbols when `!nativeCapable` or `!showImages`, else **`preferNative ? "native" : "symbols"`**.
- `preferNative` (src/config.ts): default `true` (DEFAULT_CONFIG:25); validation accepts only `typeof === "boolean"` (config.ts:96–98); env `CHAFA_PREFER_NATIVE` parsed by `envBoolean` (config.ts:186–200):
  ```ts
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;   // case-insensitive, trimmed; anything else ignored
  ```
  So yes: 0/false/no/off all count as false; typos fall through to file/default.
- Native mimes: `NATIVE_SAFE_MIMES = ["image/png","image/jpeg","image/gif","image/webp"]` (detect.ts:56–61) — provider-history constraint, per-file `decideFileDelivery` degrades recognized-but-unsafe mimes (svg/avif/bmp/x-icon) to symbols with a note.
- `decideFileDelivery` also enforces: forced native + unsafe mime → per-file error message; symbols mode + missing chafa loader → error.

## 5. Surprises vs. spec §3

1. **`isImageLine`, `getKittyImageReservedRows`, `calculateImageCellSize`, `registerKittyImageMetadata`, `getKittyImageMetadata`, `getKittyImagePlacement`, `cropKittyImageLine` are NOT re-exported from the package root** — they are only module-level exports of `terminal-image`. The spec's "public API" claim is true at module level; the extension must import from `@earendil-works/pi-tui/dist/terminal-image.js` (verify the package `exports` map allows it) or stick to root-exported calls.
2. **`Image.render` clamps `maxWidth = min(width - 2, maxWidthCells ?? 60)`** — spec doesn't mention the −2 gutter; a navigator pane must account for it when choosing `maxWidthCells`.
3. **`renderImage` kitty path registers metadata only when `imageId !== undefined`** — correct in spec; but note `registerKittyImageMetadata` bumps the global transmission generation on every call, which is what invalidates alt-screen placement caches.
4. **`getImageDimensions` rejects `"image/jpg"`** — the mime gate must normalize to `"image/jpeg"` before calling.
5. **Space-padded filler rows** confirmed (§2 above): reserved rows collapse to 1, changed-range expansion covers only the sequence line, no per-row pre-clear below it. Id deletion still works. Spec §3.5's wording is accurate.
6. **Alt-screen disables iTerm2 images entirely** (`setCapabilities({...caps, images:null})` while in alt screen) and uses placement reuse + LRU eviction (16 imgs / 32 MiB transmission / 64 MiB decoded). Spec mentions "eviction by generation/byte budget" — exact constants now known.
7. **`detectCapabilities` accepts only `"1"`/`"0"` for `PI_TRUE_COLOR`/``PI_HYPERLINKS`**, and `PI_IMAGE_PROTOCOL` accepts `kitty|iterm2|none|0` — spec's list is right, but note `PI_IMAGE_PROTOCOL` cannot force *off* with e.g. `"false"`.
8. **pi's `terminal.images: "auto"` maps to NO override** (settings-manager passes nothing) — "auto" is not a value pi-tui knows; the spec's type union `"auto"` is a pi-side no-op, equivalent to absent.
9. **pi-chafa's ladder treats `terminal.images: false` as "no override", not "force off"** — `resolveCapsImages` returns the pi-tui-detected value when non-null regardless. The spec's D4 "never re-enables a host-detected 'no'" is satisfied only because pi-tui detection itself nulls tmux/screen; a user setting `terminal.images:false` while TERM reports kitty would NOT disable images in pi-chafa's ladder (only `decideDelivery`'s `showImages` gate can suppress). pi's own override path DOES force null — the difference is which source wins in pi-chafa's step 1 vs pi's `setCapabilityOverrides`.
10. **Host default `imageWidthCells` is 60**, and `maybeConvertImagesForKitty` requires `caps.images === "kitty"` exactly (not iterm2) — iTerm2 gets original mimes (encodeITerm2 sends raw bytes, fine). Extension images targeting kitty must be PNG or they are skipped by pi's own component (relevant precedent for navigator's D5 PNG-only rule).
11. **Installed pi-coding-agent is 0.85.1**, not 0.86.1 as the spec header states; settings-manager line numbers differ (overrides at :796–805, not :833).
