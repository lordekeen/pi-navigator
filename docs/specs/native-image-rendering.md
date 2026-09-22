# pi-navigator — Specification: Native Terminal Image Rendering (kitty / iTerm2 via pi-tui)

**Status:** Proposed (rev. 1 — validated against pi-navigator v0.7.4, pi-tui 0.85.1, pi 0.86.1, pi-chafa v0.1.0, chafa 1.18.2, tmux 3.7c)

> **Rev. 1 findings baked in** (headless verification, 2026-09 field work):
> 1. **pi-tui already ships the native layer.** `Image`, `renderImage`,
>    `encodeKitty`, `encodeITerm2`, `getCapabilities`, `setCapabilityOverrides`,
>    kitty metadata/placement/crop helpers, and both renderers' kitty lifecycle
>    (reserved rows, changed-range expansion, per-ID deletion) are public API.
>    pi-navigator must **reuse** them, not reimplement protocols (D3).
> 2. **Overlay pass-through verified headlessly.** A pi-tui kitty line
>    (`\x1b_Ga=T,f=100,q=2,C=1,c=…,r=…,i=…`) survives the navigator's
>    `hardTruncate` + `padTo` + pi-tui `compositeTuiLine` byte-identically
>    (§3.5). Remaining uncertainty is live-terminal redraw/cleanup behavior,
>    which is a gated manual QA step (§14), not a design blocker.
> 3. **Sixel is upstream work.** pi-tui has zero sixel support
>    (`ImageProtocol = "kitty" | "iterm2" | null`); pi-chafa carries an upstream
>    proposal (`~/Sources/pi-chafa/docs/spec/2026-09-03-pi-tui-sixel-support-proposal.md`).
>    Out of scope here (§2, §16).
> 4. **pi-chafa's native path is not reusable code.** It emits
>    `{type:"image",data,mimeType}` blocks rendered by pi's
>    `ToolExecutionComponent`; it never writes protocol bytes and never invokes
>    `chafa -f kitty|sixel|iterm`. Its ladder (`decideDelivery`, `preferNative`)
>    informs our decision table; its code does not (§3.2).

**Author:** AI Pair Programmer & User
**Target Version:** v0.8.0 (minor — new opt-in tier, no schema break)
**Related Components:** `images.ts`, `viewer.ts`, `viewer_view.ts`, `index.ts`, `settings.ts`, `constants.ts`, `types.ts`
**Related Docs:** [`docs/specs/chafa-image-rendering.md`](./chafa-image-rendering.md) (§16 item 1, the open spike this resolves), [`docs/plans/pi-navigator-implementation-plan.md`](../plans/pi-navigator-implementation-plan.md) §8 item 1, issue [`#057`](../issues/057-chafa-image-rendering.md), proposed issue [`#069`](../issues/069-native-image-rendering.md), pi-chafa `docs/spec/2026-09-04-show-image-native-vs-read-render-investigation.md` (dual-instance hazard), pi-chafa `docs/spec/2026-09-03-pi-tui-sixel-support-proposal.md` (upstream sixel)

---

## 1. Overview & Motivation

The chafa tier (#057) renders images as ANSI symbol art: terminal-agnostic,
but low-fidelity (rounded blocks), dependent on an external binary, and a
subprocess per render. The chafa spec deliberately left `imageTier: "native"`
reserved because the plan §8 spike — *does a pi-tui image render correctly
inside an overlay region?* — was unverified (D1, D6 there).

That spike is now substantially answered:

- pi-tui exposes a complete, supported native image API (kitty + iTerm2).
- pi's extension loader aliases `@earendil-works/pi-tui` to the host singleton,
  so an extension shares capability state and the renderers' kitty lifecycle.
- A headless probe shows the generated kitty sequence survives the navigator's
  truncation/padding and the overlay compositor byte-for-byte (§3.5).

This spec defines the **native tier**: when the terminal reports kitty or
iTerm2 support, the viewer pane displays the real image via pi-tui's encoders —
no subprocess, no new dependency, no protocol code of our own. chafa remains
the universal fallback and the metadata card remains the terminal degradation.

The tier ladder becomes **native → chafa → metadata**, selected by a new
`images.mode` value set (`off | chafa | native | auto`), opt-in by default.

---

## 2. Goals / Non-Goals

### Goals

- Render PNG (and, on iTerm2, PNG/JPEG/GIF/WebP) images as native terminal
  graphics in the viewer pane when the terminal supports kitty or iTerm2 and
  the user opts in.
- Reuse pi-tui's public API end to end: capability detection and overrides,
  image dimension sniffing, cell sizing, protocol encoding, kitty metadata and
  placement semantics. **pi-navigator generates no protocol bytes itself.**
- Resolve native capability with a pi-chafa-style, instance-independent ladder
  (`getCapabilities` → `terminal.images` settings → `PI_IMAGE_PROTOCOL`), so a
  non-shared pi-tui instance cannot silently disable the tier.
- Keep `images.mode: "chafa"` byte-identical to today; add
  `native` (strict) and `auto` (best available) modes.
- Preserve every existing invariant: zero runtime dependencies, read-only,
  bounded memory/time, strict width/escape safety, pure-component data contract,
  images user-only (never sent to the model).
- Keep the whole path testable headlessly: no test touches a real terminal; the
  pure seams and pi-tui's `setCapabilities` fixtures cover both protocols.

### Non-Goals

- **Sixel.** pi-tui has no sixel line model; raw DCS streams break
  `visibleWidth` accounting and have no placement/deletion primitives. This is
  upstream work (pi-chafa's proposal), not an extension feature.
- **chafa native formats** (`-f kitty|sixels|iterm`). chafa's native output is
  an unmanaged stream: no pi-tui metadata registration, no placement reuse, no
  crop, no renderer deletion. It would look correct for one frame and ghost
  afterwards. Rejected (D3).
- **Our own protocol encoders / placement state machine.** Reuse pi-tui.
- **tmux passthrough wrapping.** pi-tui emits no DCS envelope; its own detector
  reports `images: null` under tmux/screen. We inherit both facts (D8).
- **Animated GIF playback.** Single frame, matching the chafa tier.
- **Auto-enabling.** Default stays `off`; the opt-in philosophy is unchanged.
- **Converting non-PNG formats for kitty.** pi-tui's kitty encoder sends
  `f=100` (PNG) only; pi core converts with an internal `photon-node`
  dependency we must not take. Non-PNG on kitty degrades (D5).
- **Resizing/compressing oversized images.** Over the native byte cap → card
  with a hint; no image-processing dependency.
- **Changing the LLM-visible surface.** No image content blocks are ever
  produced; the native tier is terminal display only.

---

## 3. Technical Grounding (verified facts)

### 3.1 pi-tui native API (0.85.1 devDependency; bundled in pi 0.86.1)

Exports from `node_modules/@earendil-works/pi-tui/dist/index.d.ts`:

- `Image` component (`components/image.js`) — `render(width)` returns, for
  **kitty**: `[sequence, ...(rows-1) empty strings]` (sequence carries
  `a=T,f=100,q=2,C=1,c=<cols>,r=<rows>,i=<id>`); for **iTerm2**:
  `[...(rows-1) empty strings, \x1b[<rows-1>A + sequence]` (draw up, restore
  cursor). Falls back to a truncated text line when `caps.images` is null.
- `renderImage(base64, dims, {maxWidthCells, maxHeightCells, imageId, moveCursor, preserveAspectRatio})`
  — dispatches on `getCapabilities().images`; for kitty it registers placement
  metadata when `imageId` is provided (this registration is what the alt-screen
  placement reuse and `cropKittyImageLine` rely on).
- `allocateImageId()`, `deleteKittyImage(id)`, `deleteAllKittyImages()`,
  `deleteAllKittyPlacements()`, `registerKittyImageMetadata`, `getKittyImageMetadata`,
  `getKittyImagePlacement`, `cropKittyImageLine`.
- `getImageDimensions/getPngDimensions/getJpegDimensions/getGifDimensions/getWebpDimensions`,
  `calculateImageCellSize`, `getCellDimensions`, `imageFallback`, `hyperlink`.
- `getCapabilities` / `setCapabilities` / `setCapabilityOverrides` /
  `detectCapabilities` / `resetCapabilitiesCache`.

Detection (`terminal-image.js`): env-based. tmux/screen → `images: null` hard;
`KITTY_WINDOW_ID`/kitty, ghostty, `WEZTERM_PANE`, Warp → `"kitty"`;
`ITERM_SESSION_ID`/`TERM_PROGRAM=iTerm.app` → `"iterm2"`; unknown → null.
`detectCapabilities` also folds `PI_IMAGE_PROTOCOL` (`kitty|iterm2|none|0`).
`getCapabilities()` merges module-level `capabilityOverrides` (set by pi from
the `terminal.images` setting) **over** detection.

Renderer lifecycle (verified in `tui-main-screen.js`, pi-navigator's default
`regular` mode): `extractKittyImageIds` parses `i=` from rendered lines;
changed ranges containing images are expanded; changed images are deleted with
`deleteKittyImage(id)` before redraw; full redraws delete all previously
rendered ids; multi-row images get reserved rows derived from the sequence's
`r=` plus following empty lines. `tui-alt-screen.js` additionally reuses
placement-only commands across frames and evicts offscreen images by
generation/byte budget. **All of this is automatic for any component that
emits pi-tui-shaped image lines.**

### 3.2 pi-chafa native mode (verified, `~/Sources/pi-chafa`)

- Native delivery is `{type:"image", data:<base64>, mimeType}` content blocks
  (`src/show-image.ts:472`, `:551`) rendered by pi's `ToolExecutionComponent`
  via the pi-tui `Image` component. No protocol bytes, no `chafa -f …` calls;
  no sixel anywhere in `src/`.
- Delivery decision (`src/detect.ts:183 decideDelivery`): `auto` → symbols when
  not native-capable, when `terminal.showImages` is false, or `preferNative` is
  false; otherwise native. Forced `format=native` on a non-capable session
  throws; on a capable-but-images-off host it degrades to symbols.
- Capability ladder (`src/detect.ts:36 resolveCapsImages`):
  `getCapabilities().images` → settings `terminal.images` (`"kitty"|"iterm2"`
  only) → `PI_IMAGE_PROTOCOL` (`kitty|iterm2`) → null.
- Native-safe mime gate: only png/jpeg/gif/webp (a *provider* constraint for
  content blocks; not binding for us, but the same set is what pi-tui can size).
- Documented hazard: a precompiled-ESM extension can bind its own pi-tui module
  instance whose `getCapabilities()` never sees the host's overrides
  (`docs/spec/2026-09-04-show-image-native-vs-read-render-investigation.md`).
  pi-navigator ships TS source and pi's loader aliases the package to the host
  singleton (`dist/core/extensions/loader.js:64`, `virtual-modules.js:21`), so
  the hazard is unlikely — but the ladder mirrors pi-chafa's anyway (D4).
- `preferNative` (default true) and `CHAFA_PREFER_NATIVE` are the real knobs for
  automatic delivery; `formatOrder` is a dead placeholder.

### 3.3 pi host facts (pi 0.86.1)

- `settings.json` `terminal.images: "kitty" | "iterm2" | "auto" | false` is
  mapped to `setCapabilityOverrides` at startup and on settings change
  (`settings-manager.js:833`), so `getCapabilities()` in an aliased extension
  reflects it. `PI_IMAGE_PROTOCOL` is read inside pi-tui.
- `ToolExecutionComponent` converts non-PNG to PNG for kitty via pi's internal
  `photon-node` (`maybeConvertImagesForKitty`) — extensions cannot access it.
- Default `tuiMode` is `"regular"` (`TuiMainScreen`); `"fullscreen"`
  (`TuiAltScreen`) is opt-in.

### 3.4 pi-navigator current code (v0.7.4)

- `images.ts` — chafa presence/probe/config mirror/render/sanitizer/geometry,
  `ImageSupport { mode, piChafa, chafa, config, hostShowImages, active }`,
  `makeDeferredImageSupport`.
- `viewer.ts` — `ImageRenderer` injection seam; image branch calls it and
  stores `lines` + `imageTier: "chafa" | "metadata"` + `imageCols/imageRows`;
  any failure/throw → metadata card with a bounded reason.
- `viewer_view.ts` — chafa rows branch (`padTo(hardTruncate(line, width), width)`
  per row), header badge (`chafa`, `i card`/`i render`), `imageCardHints`.
- `index.ts` — `renderImage` seam wrapping `runChafaRender`; abort controller
  per render; variant key (`chafa` geometry+knobs) in the bounded viewer cache
  (`MAX_VIEWER_CACHE_ENTRIES = 16`); deferred support resolution upgraded via
  `setImageSupport`; `cleanup` aborts in-flight renders.
- `settings.ts` — `images.mode: "off" | "chafa"`, `PI_NAV_IMAGES` truth table
  (`1|true|yes|on|chafa` → chafa), field registry, settings-menu rows.
- `types.ts` — `ViewerFile.imageTier: "metadata" | "chafa" | "native"` already
  reserves `"native"`; `ViewerKind "image"`.

### 3.5 Overlay spike (headless, verified)

With pi-tui capabilities forced to kitty, a 1×1 PNG produced
`\x1b_Ga=T,f=100,q=2,C=1,c=20,r=5,i=<id>;…` + 4 filler rows. The sequence
survived `hardTruncate(line, 40)` → `padTo(…, 40)` → `compositeTuiLine(base, padded, 10, 60, 120)`
**byte-identically**, `registerKittyImageMetadata` intact.

Remaining unknowns are live-terminal only: actual placement relative to the
overlay border, redraw stability under the 1 s poll, deletion when the overlay
closes or the file switches, viewer scroll, resize, and
`PI_HARDWARE_CURSOR` on/off. §14 gates the feature on those checks.

**Known contract wrinkle:** the navigator (and the overlay compositor) pads
every pane row with spaces, so pi-tui's `getKittyImageReservedRows` — which
requires the rows after the sequence line to be *empty* — sees a single-row
image. The image still anchors at the sequence line and draws downward; the
accounting difference is exactly what the live QA gate must judge (§8, §16).

---

## 4. Design Decisions (resolved)

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **Mode set `off \| chafa \| native \| auto`; default `off`.** `native` = strict native (no chafa substitution); `auto` = native → chafa → metadata. | Keeps the explicit opt-in philosophy; `native` matches pi-chafa's forced-native strictness (minus the throw); `auto` is the "best available" convenience. |
| D2 | **Protocols: kitty and iTerm2 only.** Sixel deferred to upstream pi-tui. | pi-tui's closed union; sixel has no line model or placement primitives. |
| D3 | **Reuse pi-tui; never emit protocol bytes ourselves.** `renderImage` + `allocateImageId` + our row layout mirroring `Image.render` exactly. chafa's native formats rejected. | Placement registry, renderer diff deletion, scroll crops, and alt-screen placement reuse depend on pi-tui-generated sequences. |
| D4 | **Capability ladder mirrors pi-chafa:** `getCapabilities().images` → settings `terminal.images` (`"kitty"\|"iterm2"` only) → `PI_IMAGE_PROTOCOL` (`"kitty"\|"iterm2"`) → null; positive-only. | Survives a non-shared pi-tui instance; never re-enables a host-detected "no". |
| D5 | **Mime gate: kitty → PNG only; iTerm2 → png/jpeg/gif/webp; else fall to the next tier.** | pi-tui kitty sends `f=100`; no converter dependency allowed. |
| D6 | **Revise the old D6 (chafa spec): mirror `preferNative` (+ `CHAFA_PREFER_NATIVE`).** `auto` honors it; explicit `native`/`chafa` ignore it. `formatOrder` stays ignored (dead placeholder). | Both surfaces should agree on automatic delivery; explicit mode wins over borrowed preference. |
| D7 | **Byte cap `IMAGE_NATIVE_MAX_BYTES = 4 MiB` (new constant).** Over cap → card hint. Native entries larger than `IMAGE_NATIVE_CACHE_MAX_CHARS` are displayed but not retained in the viewer cache. | Bounded memory; base64 rows are large; `MAX_VIEWER_CACHE_ENTRIES` alone (16) is not a byte bound. |
| D8 | **No tmux/screen passthrough wrapper.** Follow the host capability report exactly; document the limitation. | pi-tui's own detector nulls images under tmux/screen; a forced `terminal.images` override deliberately bypasses that, and navigation-side second-guessing would contradict the host. |
| D9 | **Row contract:** native lines are returned verbatim (sequence row, `""` filler rows; iTerm2 `moveUp + sequence` on the last row); no width function may touch a native row; the pane pins `viewScroll` to 0 for native images. | Width safety comes from pi-tui's cell sizing (`c=`/`r=`/`width=`), not from truncation; scrolling an anchored placement misplaces it. |
| D10 | **`ImageSupport.active` is replaced by `tier: "native" \| "chafa" \| "none"` + `nativeProtocol`.** All call sites updated. | One explicit effective-tier field beats a boolean that meant "chafa". |
| D11 | **Cleanup is primarily the renderer's diff deletion** (ids parsed from changed/removed lines). A `dispose`-time `deleteAllKittyImages`/`deleteAllKittyPlacements` write is contingency only, added if live QA shows ghosts. | The host renderer already owns this; duplicating it risks clearing host images elsewhere on screen. |
| D12 | **`mode: "native"` on a non-capable terminal → metadata card + a "terminal does not support kitty/iTerm2" hint** (no warning banner, no silent chafa). | Explicit mode should be honest about why it did nothing; a warning for a terminal fact is noise. |
| D13 | **No new module.** Native resolution/render live in `images.ts` (it owns the image domain); wiring stays in `index.ts`. | The module graph and pure-seam rules are unchanged. |

---

## 5. Settings Terrain & API Surface

### 5.1 `~/.pi/agent/pi-navigator.json`

```json
{ "version": 1, "images": { "mode": "off" } }
```

`images.mode` gains two values (the field's registry entry enumerates them):

| Value | Meaning |
| --- | --- |
| `off` | Metadata card only (default). |
| `chafa` | Today's behavior: chafa symbols when all #057 gates pass, else card. |
| `native` | Native only: kitty/iTerm2 when capable and the mime is allowed, else card with a hint. Never substitutes chafa. |
| `auto` | Native → chafa → card, honoring `preferNative`. |

### 5.2 `PI_NAV_IMAGES` truth table (byte-compatible extension)

| Token | Resolved mode |
| --- | --- |
| `chafa`, `1`, `true`, `yes`, `on` | `chafa` (unchanged from #057) |
| `native` | `native` (new) |
| `auto` | `auto` (new) |
| `0`, `false`, `no`, `off` | `off` |
| anything else | warning (existing copy) + file value stands |

### 5.3 `images.ts` — additions

```ts
export type ImageTier = "native" | "chafa" | "none";
export type NativeProtocol = "kitty" | "iterm2";

/** Instance-independent capability ladder (D4). Pure; no terminal access. */
export function resolveNativeProtocol(deps?: {
  capabilities?: () => { images: NativeProtocol | null };
  readText?: ReadText;
  env?: Record<string, string | undefined>;
  userSettings?: string;
}): NativeProtocol | null;

/** Mirrored pi-chafa preference (D6), defaults true. */
// PiChafaSubset gains: preferNative: boolean;
// validatePiChafaConfig parses it; loadPiChafaConfig overlays CHAFA_PREFER_NATIVE.

export interface NativeRenderCtx {
  protocol: NativeProtocol;
  signal?: AbortSignal;
  /** Test seam; default node fs read. */
  readBytes?: (path: string) => Promise<Uint8Array>;
}

/** One native render: read (cap)→ base64 → pi-tui renderImage → layout rows. */
export async function runNativeRender(
  absPath: string,
  geometry: { cols: number; rows: number },
  ctx: NativeRenderCtx,
): Promise<
  | { ok: true; lines: string[]; cols: number; rows: number }
  | { ok: false; reason: string }
>;
```

`runNativeRender` steps (all failures → `{ok:false, reason}` under
`IMAGE_ERROR_MAX_CHARS`; never throws):

1. `signal?.aborted` → `"render aborted"`.
2. `mimeOfPath(absPath)` must be in `NATIVE_IMAGE_MIME` (`png/jpeg/gif/webp`);
   kitty additionally requires `image/png` (D5).
3. Bounded read; over `IMAGE_NATIVE_MAX_BYTES` → `"image exceeds the 4 MiB native rendering cap"`.
4. `base64 = Buffer.from(bytes).toString("base64")`;
   `dims = getImageDimensions(base64, mime)`; null → `"could not read image dimensions"`.
5. `result = renderImage(base64, dims, { maxWidthCells: cols, maxHeightCells: rows, imageId: protocol === "kitty" ? allocateImageId() : undefined, moveCursor: false })`
   — null (capability vanished) → `"native rendering is not available"`.
6. Layout, mirroring pi-tui `Image.render` (0.85.1) exactly:
   - kitty: `[result.sequence, ...(result.rows-1) × ""]`
   - iTerm2: `[...(result.rows-1) × "", moveUp + result.sequence]` where
     `moveUp = result.rows > 1 ? \x1b[<result.rows-1>A : ""`.
7. Return `{ok: true, lines, cols: result.columns, rows: result.rows}`.

### 5.4 `ImageSupport` contract change (D10)

```ts
export interface ImageSupport {
  mode: "off" | "chafa" | "native" | "auto";
  nativeProtocol: NativeProtocol | null;   // resolved capability
  tier: ImageTier;                          // effective renderer for this session
  piChafa: PiChafaStatus;
  chafa: ChafaStatus | { state: "deferred" };
  config: PiChafaSubset;
  hostShowImages: boolean;
}
```

`tier` derivation (host image settings always gate):

```text
if (!hostShowImages || mode === "off")  -> "none"
mode === "chafa"  -> chafa gates ? "chafa" : "none"
mode === "native" -> nativeProtocol ? "native" : "none"
mode === "auto"   -> nativeProtocol && config.preferNative ? "native"
                     : chafa gates ? "chafa" : "none"
```

Explicitly:

- `mode === "chafa"` → `tier = "chafa"` iff `piChafa.present && chafa.state === "ok"`, else `"none"` (today's `active`).
- `mode === "native"` → `tier = nativeProtocol !== null ? "native" : "none"`.
- `mode === "auto"` → `"native"` if `nativeProtocol !== null && config.preferNative`; else `"chafa"` under the chafa gates; else `"none"`.
- Mime is a per-file gate at render time, not a session tier: a non-PNG file
  under kitty returns `{ok:false, …}` and the loader falls back one tier for
  that file (§7.3). Session-level `tier` remains "native".

`makeDeferredImageSupport(mode)` returns `{mode, nativeProtocol: null, tier: "none", …}` (no probes at open, per D9 of #057).

### 5.5 New constants (`constants.ts`)

| Constant | Value | Purpose |
| --- | --- | --- |
| `IMAGE_NATIVE_MAX_BYTES` | `4 * 1024 * 1024` | Bounded read for native rendering (D7). |
| `IMAGE_NATIVE_CACHE_MAX_CHARS` | `1_000_000` | Max total char length of cached native rows (D7). |
| `NATIVE_IMAGE_MIME` | `{ png, jpg/jpeg, gif, webp }` map | Extension → mime gate (D5). |

Existing `IMAGE_CELLS_MIN`, `IMAGE_ROWS_MIN`, `IMAGE_CELLS_MAX`,
`IMAGE_ERROR_MAX_CHARS`, `MAX_VIEWER_CACHE_ENTRIES` are reused as-is.

---

## 6. Capability Resolution & Lifecycle

`resolveImageSupport` keeps its shape (deferred, fire-and-forget, upgraded via
`setImageSupport`) and adds one step:

1. Host image settings (`terminal.showImages`) — unchanged.
2. pi-chafa presence + config mirror — unchanged, plus `preferNative` (D6).
3. `nativeProtocol = resolveNativeProtocol({ capabilities: getCapabilities, readText, env, userSettings })`
   — pure ladder (D4). No probe, no I/O beyond the injectable `readText`.
4. chafa probe — unchanged; still skipped when pi-chafa is absent **and** still
   deferred when the native tier is the effective one? **No**: `auto`/`native`
   do not need chafa, but `auto` may fall back per file (mime) or per config.
   Keep the probe lazy-but-resolved (it is cheap, ≤3 s) only when
   `mode !== "native"`; `mode === "native"` never probes chafa.
5. Derive `tier` (D10) and return.

Provenance annotation for hovers/hints: `nativeProtocol` carries whether it came
from the live host (`getCapabilities`), the settings file, or the env — reuse
`PiChafaStatus`-style `{ value, via }` only if the help copy needs it; v1 may
store the bare protocol and a boolean `viaHost` for diagnostics.

---

## 7. Render Pipeline & Data Flow

### 7.1 Sequence (native)

1. Cursor lands on an image row → `index.ts` loader.
2. `tier === "native"` → `loadFile(absPath, relPath, { image, renderNativeImage })`.
3. `renderNativeImage(absPath, geometry)` → `runNativeRender(absPath, geometry, { protocol: support.nativeProtocol, signal })`.
4. Success → `ViewerFile { kind: "image", imageTier: "native", lines, imageCols, imageRows, message }`.
5. `viewer_view.ts` native branch emits `lines` verbatim (D9) and the header
   badge shows `kitty`/`iterm2` + `i card`.
6. Failure → one tier down for that file (§7.3) → card hint.

No subprocess, no timeout knob. `IMAGE_NATIVE_MAX_BYTES` is the only bound
needed beyond the read itself; the encoder is synchronous CPU work (base64 +
cell math) on ≤4 MiB.

### 7.2 Geometry

Reuse the chafa pane rule with native semantics:

- Pane is the hard cap: `maxWidthCells = paneCols`, `maxHeightCells = paneRows`.
- Same refuse thresholds as chafa (`IMAGE_CELLS_MIN = 16`, `IMAGE_ROWS_MIN = 4`)
  so "pane too small for a rendered image" stays one copy string; a narrower
  pane hides the left column and the viewer keeps degrading to the card.
- pi-tui aspect-fits, so the resulting `rows ≤ paneRows`; the pane consumes the
  returned height (sequence + filler) and pads the remainder.

### 7.3 Per-file tier fallback (mime gate, D5)

When `tier === "native"` but the file is not natively renderable or the render
fails cleanly (oversized, undecodable dimensions):

- `mode === "auto"`: fall back to the chafa render for that file (if the chafa
  gates pass), else card + hint. `auto` is "best available per file".
- `mode === "native"`: card + the specific reason (`kitty requires PNG`,
  `image exceeds the 4 MiB native rendering cap`, `could not read image dimensions`).
- Hard renderer failure (thrown) behaves like the existing seam: card + bounded
  reason.

### 7.4 Cache & abort

- Variant key becomes `native:<protocol>:<cols>x<rows>` (chafa key unchanged).
  Tier is part of the key, so mode/geometry changes are cache misses.
- Abort: the existing `AbortController` is still created per render and passed
  into `runNativeRender` (checked at entry; the read is small and fast). No
  child process means no kill path.
- Cache retention: native `ViewerFile`s are cached only when
  `lines.join("").length <= IMAGE_NATIVE_CACHE_MAX_CHARS` (D7); over-cap renders
  are displayed and dropped on the next open (re-render is cheap).

### 7.5 Interaction

- `i` unchanged: toggles rendered image ⇄ metadata card for the open file.
  For native, the image lines disappear from the component; the host renderer's
  diff deletes the kitty image by id (D11).
- Scroll keys (`j/k/g/G/Ctrl+d/Ctrl+u`) are inert for a native image (D9);
  `w/h/l` already inert; `/` already reports unavailable.
- Resize re-render: existing debounce; new geometry = new variant key.
- `setImageSupport` upgrade: a card shown while support resolved swaps to a
  native render on the next image open or `r`, exactly like chafa today.

---

## 8. Row Contract & Overlay Integration

Invariants (mirrors the #057 §5.4 contract with one addition):

1. `ViewerFile.imageTier` gains `"native"`; `lines` holds the layout rows.
2. **`viewer_view.ts` native branch: emit `lines[i]` verbatim — no
   `hardTruncate`, no `padTo`, no styled wrapping; emit `""` for filler rows.**
3. **Frame/join paths must not width-process a native row.** `joinLeftRight`
   and its callers treat a row for which `isImageLine(row)` is true as
   pass-through (pi-tui's `isImageLine` recognizes `\x1b_G` and
   `\x1b]1337;File=`), with the same guard style as `compositeTuiLine`
   (`if (isImageLine(baseLine)) return baseLine`). Where a native row sits in
   the left pane position, the frame concatenates chrome around it unchanged.
4. Width safety for native rows is pi-tui's responsibility: `c=`/`r=` (kitty)
   and `width=<cells>` (iTerm2) are clamped by `calculateImageCellSize` to the
   pane geometry. Tests assert byte-identity of the sequence at all render
   widths rather than width arithmetic.
5. The pane consumes exactly `lines.length` rows (image height), then pads.
   The filler rows are `""` at the view-model boundary; the overlay compositor
   may space-fill them, which is the known §3.5 wrinkle — live QA decides
   whether an extra reserved-row workaround is needed.

---

## 9. Degradation Matrix

| Terminal | Mode | PNG | JPEG/GIF/WebP | Other |
| --- | --- | --- | --- | --- |
| kitty | `off` | card | card | card |
| kitty | `chafa` | chafa / card | chafa / card | chafa / card |
| kitty | `native` | **native** | card + `kitty requires PNG` | card + format hint |
| kitty | `auto` | **native** | chafa / card | chafa / card |
| iTerm2 | `native` | **native** | **native** | card + format hint |
| iTerm2 | `auto` | **native** | **native** | chafa / card |
| none (unknown, tmux, screen) | `native` | card + `terminal does not support kitty/iTerm2 images` | same | same |
| none | `auto` | chafa / card | chafa / card | chafa / card |
| any | `off` | card | card | card |

`chafa / card` reads "chafa symbols when the #057 gates pass, otherwise the
metadata card". `card + reason` is the existing bounded `imageError` hint
(200 chars).

---

## 10. User-Facing Guidance

- **Header badge:** native renders show `kitty` or `iterm2` plus the `i card`
  affordance; card view shows `i render` when a native render is available.
- **Card hints (`imageCardHints`, first applicable wins):** extend the existing
  ladder with native states:
  - `imageError` → `kitty failed: <reason>` (existing shape).
  - pane too small → existing copy.
  - `mode === "native" && nativeProtocol === null` →
    `this terminal does not support kitty/iTerm2 - use auto or chafa`.
  - native protocol present, image not natively renderable (kitty + non-PNG) →
    `kitty rendering needs PNG - chafa or auto can render this format`.
  - `mode === "off"` → existing "optional: enable images.mode=…" copy, updated
    to mention `native`/`auto`.
- **README** images section: add the native tier (no chafa/pi-chafa required),
  the mode table, and the tmux caveat; note native is opt-in and never sends
  anything to the model.
- **Help modal:** no new keys (`i` already documented). The image toggle row
  stays protocol-agnostic.

---

## 11. Security, Resource Bounds, Read-Only Guarantee

- **No protocol bytes generated by us.** All sequences come from pi-tui's
  encoders; the risk surface of hand-rolled APC/OSC is avoided entirely.
- **Bounded read:** `IMAGE_NATIVE_MAX_BYTES` (4 MiB) is read at most; base64 is
  ~4/3× in memory, freed with the `ViewerFile`.
- **Cache bound:** `IMAGE_NATIVE_CACHE_MAX_CHARS` prevents the 16-entry viewer
  cache from retaining tens of MB of base64 (D7).
- **No subprocess, no network, no writes.** Native rendering is CPU-only.
- **No capability escape from env:** the ladder only reads `PI_IMAGE_PROTOCOL`
  and `terminal.images`; it never trusts arbitrary env as protocol bytes.
- **User-only:** no `{type:"image"}` content blocks, no model-visible change.
- **Terminal injection:** paths are never interpolated into sequences; only
  file bytes are base64-encoded by pi-tui.

---

## 12. Test Matrix

### 12.1 `test/images.test.ts` (extended)

- `resolveNativeProtocol` ladder: host capability wins; host null + settings
  `"kitty"|"iterm2"`; host null + settings false/"auto" + env; env-only; all
  null. Fixtures via injected `capabilities`/`readText`/`env` — no real home.
- `preferNative` mirror: file value, `CHAFA_PREFER_NATIVE`, defaults,
  invalid values skipped (pi-chafa parity).
- `makeDeferredImageSupport`: `nativeProtocol: null`, `tier: "none"`.
- `resolveImageSupport` tier truth table across modes × capabilities ×
  `preferNative` × chafa gates × `showImages`.
- `runNativeRender`: real pi-tui with `setCapabilities({images:"kitty"})` and
  `{images:"iterm2"}` (restore after): kitty sequence shape
  (`a=T,f=100,q=2,C=1,c=`, `r=`, `i=`), filler layout, iTerm2 moveUp layout;
  mime gates (kitty non-PNG fails); oversized file fails; `signal.aborted`
  fails; injected read seam. No real terminal.

### 12.2 `test/viewer.test.ts` (extended)

- `loadFile` with an injected `renderNativeImage`: success → `imageTier`
  `"native"`, lines/geometry stored; per-file fallback → chafa when injected;
  failure → card with bounded reason; throw → card.

### 12.3 `test/viewer_view.test.ts` (extended)

- Native rows emitted byte-identically (sequence row unchanged; filler rows
  `""`); badge `kitty`/`iterm2` + `i card`; card hints for each native state
  (unsupported terminal, non-PNG on kitty, size cap).

### 12.4 `test/render.test.ts` / `test/navigator.test.ts` (extended)

- Width-safety at 120×36 / 100×28 / 80×24 / 60 / 50 with a native image
  fixture: sequence bytes survive the full navigator render; no row exceeds
  pane width by `visibleWidth`; `i`/scroll modes behave as specified.
- Frame guard: `joinLeftRight`/frame never splits a native row.

### 12.5 `test/settings.test.ts` / `test/settings_menu.test.ts` (extended)

- `images.mode` round-trips all four values; env tokens `native`/`auto`;
  settings menu cycles four values; unchanged tokens byte-identical.

**No test may require a real terminal, real chafa, or the real `$HOME`.**

---

## 13. Files Touched

| File | Change |
| --- | --- |
| `images.ts` | `resolveNativeProtocol`, `runNativeRender`, `NATIVE_IMAGE_MIME` use, `preferNative` mirror, `ImageSupport` fields |
| `constants.ts` | `IMAGE_NATIVE_MAX_BYTES`, `IMAGE_NATIVE_CACHE_MAX_CHARS`, `NATIVE_IMAGE_MIME` |
| `viewer.ts` | `LoadFileOptions.renderNativeImage`; native branch in the image tier |
| `viewer_view.ts` | Native rows branch (verbatim + empty fillers), badge, hints; `active` → `tier` |
| `index.ts` | Native render seam, per-file fallback, variant key, cache retention rule, chafa probe skip in `native` mode |
| `settings.ts` | `images.mode` enum + env tokens + registry copy |
| `types.ts` | No shape change needed (`imageTier` already reserves `"native"`); `ImageSupport` import unaffected |
| `AGENTS.md` | `images.ts` row mentions the native tier; deps note stays "no external runtime deps" (pi-tui is a peer) |
| `README.md` | Images section: modes, native tier, tmux caveat |
| `package.json` | `version: 0.8.0` |
| tests | §12 |

No new source modules; `package.json` `files` already includes every touched
module.

---

## 14. Implementation Sequence & Gates

1. **Settings/env terrain** — `settings.ts` + tests. Gate: green; `off`/`chafa`
   behavior byte-identical.
2. **Capability ladder + `preferNative` mirror** — `images.ts` +
   `test/images.test.ts`. Gate: green (tier inert until wired).
3. **Native renderer** — `runNativeRender` + real-pi-tui encoding tests. Gate:
   green.
4. **Loader seam** — `viewer.ts` + `index.ts` wiring, variant key, cache
   retention rule. Gate: green; chafa path byte-identical.
5. **View-model & chrome** — `viewer_view.ts` rows/badge/hints, frame guards,
   `active` → `tier` migration. Gate: green at all widths.
6. **Docs & registration** — README, AGENTS.md, issue #069 + index, version
   `0.8.0`, `pi install .`. Gate: `npm run typecheck` + `npm test` green.
7. **Live QA gate (required before declaring native done)** — run pi in a
   kitty-capable terminal **outside tmux** (and once in `tuiMode: fullscreen`),
   with `images.mode: "native"`:
   - PNG opens as a real image inside the overlay pane; no border bleed, no
     offset by a row/column.
   - File switch, `i` toggle, overlay close (`q`), and `r` leave no ghost
     pixels (kitty ids deleted).
   - The 1 s refresh poll does not flicker or re-anchor the image; resize
     re-renders cleanly.
   - Repeat with `PI_HARDWARE_CURSOR=1`.
   - iTerm2 spot-check if available (macOS); otherwise the encoding test plus
     the host renderer contract stand in.
   - tmux run documents the expected no-op/garbage-free behavior under a forced
     `terminal.images: "kitty"` override.
   Evidence goes to `docs/plans/qa-evidence.md` (or the issue doc).

Each step is one commit; `npm run typecheck` and `npm test` must be green before
the next, per AGENTS.md.

---

## 15. Acceptance Criteria

#### Functional

- With `images.mode: "native"` and a kitty-capable terminal: a PNG renders as
  a native image in the viewer pane; badge reads `kitty`; `i` toggles to the
  card and the placement disappears; switching away and closing the overlay
  leave no ghost image.
- With `images.mode: "auto"`: native when capable, chafa when not, metadata
  card when neither — per file for the mime gate.
- With `images.mode: "native"` on an unsupported terminal: metadata card with
  the unsupported-terminal hint; nothing is emitted to the terminal.
- Non-PNG on kitty: card (strict) or chafa (auto) with the PNG hint; never a
  corrupt kitty sequence.
- `images.mode: "off"` and `"chafa"` behave exactly as v0.7.4; default remains
  `off`.
- `preferNative: false` in pi-chafa config (or `CHAFA_PREFER_NATIVE=0`) makes
  `auto` choose chafa; explicit `native` still renders native.
- No file over 4 MiB is read for native rendering; over-cap files show the card.

#### Automated

- `npm run typecheck` clean; `npm test` green including the §12 cases.
- Render suite: native sequence bytes byte-identical through the navigator at
  120×36, 100×28, 80×24, 60, 50; no width violations.
- No test touches a real terminal, chafa, pi-chafa, or the real `$HOME`.

#### Docs

- README documents the four modes, the native tier, and the tmux limitation;
  the chafa spec's §16 item 1 is marked resolved by this spec; issue #069 is
  registered; AGENTS.md's `images.ts` row mentions native.

---

## 16. Open Questions & Future Work

1. **Filler-row accounting (live QA).** The overlay compositor pads filler rows
   with spaces, so pi-tui's reserved-row heuristic sees a one-row image. If
   live QA shows clipping/scroll artifacts, options: a navigator-side
   `getKittyImageReservedRows`-compatible row contract using `isImageLine`-aware
   compositing, an upstream pi-tui overlay-composite exception for image
   filler rows, or sizing native images to a single row (rejected unless
   forced).
2. **tmux passthrough.** pi-tui emits no DCS envelope. A future upstream or
   extension-side wrapper could make kitty work under tmux 3.3+
   (`allow-passthrough on`); out of scope until pi-tui supports it. Note the
   user's current tmux 3.7c advertises `sixel_support=1`, which is why sixel
   remains attractive there.
3. **Sixel.** Track pi-chafa's upstream proposal; if pi-tui's `ImageProtocol`
   grows and `isImageLine` learns DCS, a `sixel` protocol can slot into D4's
   ladder with no navigator redesign.
4. **Image resizing/compression.** A 4 MiB cap means some photos fall back to
   chafa. Revisit if pi exposes a public resize API (pi has internal
   `photon-node`/`images.autoResize`); do not add an npm dependency for it.
5. **Kitty Unicode placeholders (`U=1`).** Would make images scroll with text
   and interact better with partial overlay clipping, but support is not
   universal and pi-tui does not use it. Revisit upstream first.
6. **`terminal.imageWidthCells`.** The chafa path honors pi-chafa's
   `cellWidth`; the native path currently takes the full pane width. If users
   want a narrower native image, add a width preference sourced from the host
   setting (parity with pi's transcript images) rather than a new navigator
   knob.
7. **pi-tui version skew.** devDependency `^0.85.1` vs pi-bundled 0.86.x: the
   row-layout mirror is pinned by tests and documented against 0.85.1; if
   upstream changes `Image.render` layout, the layout test fails loudly rather
   than silently misplacing images.
