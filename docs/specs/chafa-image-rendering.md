# pi-navigator — Specification: Optional Chafa Image Rendering (pi-chafa delegation)

**Status:** Proposed (rev. 2 — validated against pi-navigator v0.5.1, pi-chafa 0.1.0, chafa 1.18.2)

> **Rev. 2 validation amendments** (four defects found while validating rev. 1 against the
> real chafa 1.18.2 output and the pi 0.85.1 APIs):
> 1. **§8.1 cursor escapes.** Chafa wraps every payload in `\x1b[?25l` … `\x1b[?25h`
>    (verified locally), so rev. 1's unconditional non-SGR rejection would reject every
>    real render. The sanitizer now recognizes and *drops exactly those two sequences*
>    (pi-chafa parity) and still rejects every other non-SGR escape.
> 2. **§7.2 rows clamp.** `clamp(min(maxRows, paneRows), IMAGE_ROWS_MIN, maxRows)` has an
>    inverted range when `maxRows < IMAGE_ROWS_MIN`; the upper bound is
>    `max(IMAGE_ROWS_MIN, maxRows)`.
> 3. **§5.4/§7.5 pane width.** The chafa branch has no gutter and pads rows to the full
>    `rightW`, so `paneCols = rightW` (not `rightW - 2`); the pane remains the hard cap.
> 4. **§5.3/§6.4 warning channel.** `loadPiChafaConfig` keeps its declared signature and
>    exposes the parsed `version`; the `version > 1` guard and its warning live in
>    `resolveImageSupport` (`deps.onWarning`), which is the module's warning channel.
**Author:** AI Pair Programmer & User
**Target Version:** v0.6.0 (minor — new optional capability, no schema break)
**Related Components:** `viewer.ts`, `navigator.ts`, `index.ts`, `types.ts`, `constants.ts`, **`settings.ts` (new)**, **`images.ts` (new)**
**Related Docs:** `docs/plans/pi-navigator-implementation-plan.md` §8/§14 (image spike), `docs/issues/issues_index.md` (#057 to be created), pi-chafa `docs/spec/2026-09-03-pi-chafa-extension-design.md`, pi-overseer `src/config.ts` / `src/config-fields.ts` (settings patterns)

---

## 1. Overview & Motivation

Today the navigator viewer shows **only a metadata card** for image files
(`viewer.ts` image branch → `kind: "image"`, `imageTier: "metadata"`; card in
`navigator.ts:buildCard`). The original implementation plan (§8) deferred
actual image rendering to a verification spike, and the README still says
"Images (spike pending)".

The ecosystem already has the renderer: **pi-chafa** (`~/Sources/pi-chafa`)
renders images as chafa ANSI/Unicode symbol art (or native kitty/iTerm2 blocks
in the transcript). pi-navigator should **not** bundle, vendor, or depend on
either — it should **delegate**: when the user has both `chafa` and the
pi-chafa extension, and explicitly opts in, the viewer pane renders images as
chafa symbol art using **pi-chafa's own configuration** (`~/.pi/agent/pi-chafa.json`)
so both surfaces agree on colors, symbols, dithering, and size caps.

This keeps three repo invariants intact:

1. **Zero runtime dependencies** — no npm package, no bundled binary. There is
   no `import` of pi-chafa; only its config JSON is read.
2. **Read-only** — no workspace writes; the sole new read is a config file.
3. **Graceful degradation** — everything degrades to the existing metadata
   card, never to an error, and never to a hang.

The feature is **opt-in by the user** (default off). A versioned pi-navigator
settings file (`~/.pi/agent/pi-navigator.json`) is introduced now as the
*terrain* for a future settings dialog; until that dialog exists, the file plus
the `PI_NAV_IMAGES` environment variable are the whole opt-in surface.

---

## 2. Goals / Non-Goals

### Goals

- Render PNG/JPEG/GIF/WebP/… files in the viewer pane as chafa symbol art when
  (a) pi-chafa is installed, (b) a supported `chafa` binary is available, and
  (c) the user opted in — otherwise keep today's metadata card.
- Reuse pi-chafa's configuration and `CHAFA_*`/`CHAFA_CONFIG_DIR` environment
  semantics verbatim for the knobs both surfaces share. Do not invent
  duplicate image knobs.
- Instruct the user (card copy, README, help) on how to install `chafa` and
  pi-chafa and how to opt in — the feature must be discoverable without docs.
- Preserve strict width/escape safety (Issues #009/#010/#038 class), bounded
  memory, bounded subprocess lifetime, and the pure-component data contract.
- Keep the whole path testable headlessly with injected seams: tests must never
  require chafa, pi-chafa, or the real home directory.

### Non-Goals

- **Native kitty/iTerm2 rendering inside the overlay.** pi-chafa's native path
  delivers image blocks through pi's tool-result pipeline, not arbitrary
  strings; whether a pi-tui `Image` renders correctly inside an overlay region
  remains the plan §8 spike (open verification item). `imageTier: "native"`
  stays reserved and unused.
- **Animated playback.** `--animate off` (as pi-chafa does); GIFs render as a
  single frame.
- **Bundling, vendoring, or npm-depending on chafa or pi-chafa.** No `import`
  from pi-chafa; no PATH bootstrap; no auto-install.
- **Auto-detection of “I want images”.** Off by default; a human enables it.
- **A pi-navigator settings UI.** The schema, normalizer, field registry, and
  atomic writer land now; the `/navigator configure` modal is future work.
- **Rendering for non-image files, diffs, or markdown.** The existing markdown
  `m` mode and the metadata card are untouched for their kinds.
- **Changing the LLM-visible surface.** Images are user-only, like pi-chafa.

---

## 3. Technical Grounding (verified facts)

### 3.1 pi-chafa (v0.1.0, `~/Sources/pi-chafa`)

- **Config file** `~/.pi/agent/pi-chafa.json` (`src/config.ts`):
  `getConfigDir()` = `CHAFA_CONFIG_DIR` (trimmed, non-empty) else
  `join(homedir(), ".pi", "agent")`. `loadConfig()` re-reads per call, tolerant
  of missing/corrupt files (defaults), and `validateConfig()` **silently skips
  unknown keys and invalid values**. `version` is an integer (default 1).
- **Defaults** (`DEFAULT_CONFIG`): `version: 1`, `preferNative: true`,
  `cellWidth: 60`, `maxRows: 50`, `colors: "240"`, `symbolsSet: "block+border"`,
  `dither: "none"`, `formatOrder: ["symbols"]`, `binaryPath: null`,
  `timeoutMs: 8000`.
- **Env keys** (`CHAFA_ENV_KEYS`): `CHAFA_BIN`, `CHAFA_CELL_WIDTH`,
  `CHAFA_MAX_ROWS`, `CHAFA_COLORS`, `CHAFA_SYMBOLS`, `CHAFA_DITHER`,
  `CHAFA_PREFER_NATIVE`, `CHAFA_TIMEOUT_MS`, `CHAFA_CONFIG_DIR`.
  Precedence (`resolveConfig`/`applyEnv`): **defaults ← file ← `CHAFA_*` env ←
  per-call tool params**. `CHAFA_CONFIG_DIR` scopes only pi-chafa.json;
  pi's own settings stay under `~/.pi/agent`.
- **Host settings read** (`readHostImageSettings`): reads only the user-level
  `settings.json`; honors `terminal.showImages` (default true) and
  `terminal.imageWidthCells` (default 60); normalizes `terminal.images` to
  `"kitty" | "iterm2" | null`.
- **Probe** (`src/chafa.ts:probeChafa`): binary = `binaryPath` (config/env)
  else `"chafa"`; runs `chafa --version` with a 3 s timeout, parses
  `/Chafa version (\d+)\.(\d+)/`, and enforces **minimum 1.10**; `ENOENT`
  yields a platform install hint (`brew install chafa` / `apt install chafa …`
  / hpjansson.org download). `runChafa` uses `execFile` (no shell), a 32 MB
  `maxBuffer`, `timeoutMs`, and an optional `AbortSignal`.
- **Args vector** (`buildSymbolsArgs`, verbatim):
  `--format symbols --relative off --size {cellWidth}x{maxRows} --colors {c}
  --symbols {s} --dither {d} --animate off <path>`.
- **Payload cleaning** (`cleanSymbolsPayload`): strips the leading
  `\x1b[?25l` cursor-hide and trailing `\x1b[?25h`, drops `\r`, trims the tail,
  and guarantees a final `\x1b[0m`. Chafa emits SGR color escapes plus those two
  cursor escapes; `--clear` and `--relative` are deliberately off.
- **Delivery** (`src/detect.ts:decideDelivery`): native vs symbols; symbols is
  used when the terminal is not native-capable, when `terminal.showImages` is
  false, or when `preferNative` is false.

### 3.2 pi host APIs (pi 0.85.1 docs + installed types)

- **Agent dir**: `getAgentDir()` is exported from
  `@earendil-works/pi-coding-agent` and returns `~/.pi/agent` (respecting
  `CONFIG_DIR_NAME`). `CONFIG_DIR_NAME` is exported too (project dir: `.pi`).
- **Settings locations** (`docs/settings.md`): `~/.pi/agent/settings.json`
  (global) and `.pi/settings.json` (project, trust-gated). Relevant keys:
  `terminal.showImages` (boolean, default true),
  `terminal.imageWidthCells` (number, default 60),
  `terminal.images` (`"kitty" | "iterm2" | false | "auto"`), and
  `packages` (array of package sources: `npm:<name>`, relative paths, …).
- **Provenance APIs**: `pi.getCommands(): SlashCommandInfo[]` (shape
  `{ name, description?, source: "extension"|"prompt"|"skill", sourceInfo }`)
  and `pi.getAllTools(): ToolInfo[]` (per docs: `name`, `description`,
  `sourceInfo`, …). `SourceInfo` = `{ path, source, scope: "user"|"project"|
  "temporary", origin: "package"|"top-level", baseDir? }`. The docs state
  explicitly: *"Use `sourceInfo` as the canonical provenance field."* For an
  extension loaded from a settings package, `sourceInfo.source` may be a
  generic tag (`"local"`) and `baseDir` is derived from the resolved entry
  path (`<pkg>/src` or `<pkg>/dist`), so identity must be confirmed by
  reading the nearby `package.json`, not by name matching alone.
- pi's own `prettier`/read image overrides do not affect extension-registered
  tools; only `showImages` gates transcript images.

### 3.3 pi-navigator current code (v0.5.1)

- **Loader** (`viewer.ts:loadFile`): stat → image branch (`IMAGE_EXTENSIONS`,
  64-byte dimension probe via `imageDimensions` — PNG/GIF only) → binary sniff
  → caps → tab expansion → highlight. Image branch returns
  `{ kind: "image", imageTier: "metadata", lines: [], message: "size · dims",
  sizeBytes, mtimeMs }`.
- **Data contract** (`types.ts:ViewerFile`): `lines` is documented as
  "Highlighted ANSI lines for text kinds"; `imageTier?: "metadata" | "native" |
  "chafa"` is already reserved for this feature; `notice`/`message` carry
  supplementary copy.
- **Overlay options** (`navigator.ts:NavigatorOptions`): `loadFile:
  (relPath) => Promise<ViewerFile>` is the only way file data enters the
  component; `setTree`/`setGitState` are the only data setters. `enableIcons`
  and `home` are read-once options sourced in `index.ts`.
- **Env precedent** (`icons.ts` + `index.ts:183`): `PI_NAV_ICONS` is read once
  per overlay creation with `parseEnableIcons`, never inside the component.
- **Render path** (`navigator.ts:buildRightRows`): `binary | image | error`
  route to `buildCard` (centered box, no gutter); text-like kinds (including
  v3 `diff`) get the gutter/wrap/scroll/search path. Rendered markdown is a
  third branch with its own caches, and `w`/`h`/`l` are deliberately inert
  there (Issue #053 forbids state mutation during render).
- **Code viewer cache** (`index.ts:loadFileCached`): `Map<relPath,
  { mtimeMs, file }>`, bounded by `MAX_VIEWER_CACHE_ENTRIES` (16), hand-invalidated
  on mtime change. A geometry/config-dependent chafa render needs a variant key
  (see §7.3).
- **Poll** (`index.ts:refreshData`): stats the open file for `diskChanged`;
  commit diffs (`commit:` paths) are skipped. Images already carry `mtimeMs`.
- **Width discipline**: every row is measured with `visibleWidth`/`padTo`,
  styled strings are truncated with an empty ellipsis (Issue #010), carriage
  returns are normalized before layout (Issue #009), and `buildCard` clamps the
  box at narrow panes (Issue #038).
- **Footer/help budgets**: `FOCUS_HINTS.viewer` fits an exact 71-column budget
  at a 100-column terminal and is enforced by `test/render.test.ts`;
  `HELP_ROWS` is the key documentation list.

### 3.4 pi-overseer settings patterns (adopted here)

- **Typed defaults + pure normalizer** (`src/config.ts`): `DEFAULT_CONFIG`,
  `normalizeConfig(raw) → { config, warnings }` — clamps numbers into bounds,
  falls back on invalid enums with a warning, never throws, never mutates input.
- **Loader with provenance** (`src/config-loader.ts`): `loadConfig({ userPath,
  projectPath, projectTrusted }) → { config, warnings, sources }`; missing file
  is not a warning; corrupt/unreadable is a bounded warning; project override is
  trust-gated.
- **Atomic write** (`writeUserConfig`): serialize → `mkdir -p` → write
  `<path>.tmp` → `rename`.
- **Field registry for the future UI** (`src/config-fields.ts`): ordered
  `CONFIG_FIELDS` descriptors `{ id, path, kind: "enum"|"number"|"boolean"|
  "tools"|"model", section, label, description, options?, min?, max?, live }`,
  kept in sync with the schema by `test/config-fields.test.ts`.
- **Surface warnings once**: `for (const warning of loaded.warnings)
  ctx.ui.notify(...)`.

pi-navigator adopts the same shape with **JSON instead of YAML** (JSON.parse is
built-in; the repo has zero runtime dependencies and will not add `yaml`).

---

## 4. Design Decisions (resolved)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Symbols only.** `imageTier: "native"` stays reserved; viewer never emits protocol blocks. | Native delivery needs the plan §8 pi-tui overlay spike; unverified → not shipped. |
| D2 | **Delegate, don't depend.** Read pi-chafa's config JSON; never `import` pi-chafa, never call its tool. | No coupling to a versioned internal API; config is the documented contract. |
| D3 | **Presence requires evidence.** pi-chafa counts as present only via runtime `sourceInfo` + `package.json name === "pi-chafa"`, or a `settings.json` `packages` entry; a leftover `pi-chafa.json` alone does **not** count. | "Tied to existence of the extension" — a stale config must not enable a feature the user removed. |
| D4 | **Opt-in, default off.** `images.mode: "off"` unless the settings file or `PI_NAV_IMAGES` says otherwise. | Never surprise a user with subprocesses or colored art. |
| D5 | **Knobs come from pi-chafa; the pane owns the geometry.** `colors/symbolsSet/dither/timeoutMs/binaryPath` are read from pi-chafa; `cellWidth` is a *preference* capped by the live pane width; `maxRows` is capped by the pane area. | One tuning surface for both renderers; layout authority stays with the overlay. |
| D6 | **`preferNative`, `formatOrder`, and `terminal.images` are ignored.** Only `terminal.showImages: false` is honored (it disables rendering). | The overlay cannot do native; a user who disabled images must not get them as art either. |
| D7 | **Strict escape whitelist.** Only SGR (`\x1b[…m`) survives; any other ESC form rejects the payload → metadata card. | The overlay shares the terminal with pi's UI; one cursor op corrupts the frame (Issue #009 class). Stricter than pi-chafa's transcript cleaner, intentionally. |
| D8 | **`i` toggles image ⇄ card** (per open file, session-only), and retries the render when the card is showing. | Escape hatch, discoverable via the header badge, mirrors markdown's `m`. |
| D9 | **Async detection never blocks the overlay.** `/navigator` opens immediately; support resolves after and upgrades a displayed image card. | A 3 s chafa probe must not delay the overlay. |
| D10 | **Resize re-renders, debounced; stale rows are clipped meanwhile.** | Rendering at the wrong width would waste columns; clipping keeps the frame valid during the debounce. |
| D11 | **Chafa renders are cached per (path, mtime, geometry, knob fingerprint).** | Matches the existing viewer cache (#020) without returning wrong-width art. |
| D12 | **pi-navigator settings are user-level only** (`~/.pi/agent/pi-navigator.json`); no project override in v1. | Trust-gated project config is a larger question; not needed for a per-user renderer preference. |

---

## 5. Data Model, Settings Terrain & Module Layout

### 5.1 pi-navigator settings — `~/.pi/agent/pi-navigator.json`

Canonical shape (`serializeNavigatorSettings`):

```json
{
  "version": 1,
  "images": {
    "mode": "off"
  }
}
```

| Key | Type | Default | Bounds / values | Live? |
|---|---|---|---|---|
| `version` | integer | `1` | accepted, not migrated; `> 1` → defaults + warning | — |
| `images.mode` | enum | `"off"` | `"off" \| "chafa"` (`"native"` reserved → warning + off) | no (applies on next image open / `r`) |

**Environment override** `PI_NAV_IMAGES` (integer precedence: defaults ← file ←
env ← future settings dialog):

- enable: `1`, `true`, `yes`, `on`, `chafa`
- disable: `0`, `false`, `no`, `off`
- anything else: ignore with one warning notice, fall back to the file/default.

`parseImageMode(value) → { mode, warning? }` lives in `settings.ts`; `index.ts`
reads `process.env[NAVIGATOR_IMAGES_ENV]` once per `/navigator` invocation
(never in the component), exactly like `PI_NAV_ICONS`.

### 5.2 `settings.ts` (new) — API surface

```ts
export interface NavigatorImageSettings { mode: "off" | "chafa" }
export interface NavigatorSettings {
  readonly version: number;
  readonly images: NavigatorImageSettings;
}

export const DEFAULT_NAVIGATOR_SETTINGS: NavigatorSettings;

/** Never throws; unknown keys warn; invalid values fall back (pi-overseer pattern). */
export function normalizeNavigatorSettings(raw: unknown): {
  settings: NavigatorSettings;
  warnings: string[];
};

/** defaults ← user file ← env. Missing file is not a warning. */
export function loadNavigatorSettings(paths: {
  userPath: string;
  env?: { images?: string | undefined };
}): { settings: NavigatorSettings; warnings: string[]; sources: string[] };

/** Canonical nested object for persistence / the future settings modal. */
export function serializeNavigatorSettings(settings: NavigatorSettings): Record<string, unknown>;

/** Atomic tmp+rename write (used only by the future configure UI and tests). */
export function writeNavigatorSettings(path: string, settings: NavigatorSettings): void;

export interface NavigatorConfigField {
  readonly id: string;            // "images.mode"
  readonly path: readonly string[];
  readonly kind: "enum" | "boolean" | "number";
  readonly section: string;       // "Images"
  readonly label: string;         // "Image rendering"
  readonly description: string;   // one-line help
  readonly options?: readonly string[];
  readonly live: boolean;         // false: next open / r
}
/** Ordered registry for the future `/navigator configure` modal. */
export const NAVIGATOR_CONFIG_FIELDS: readonly NavigatorConfigField[];
```

`index.ts` calls `loadNavigatorSettings({ userPath: join(getAgentDir(),
NAVIGATOR_SETTINGS_FILE), env: { images: process.env[NAVIGATOR_IMAGES_ENV] } })`
and forwards warnings through the existing notify path. The resolved
`NavigatorSettings` is passed into `resolveImageSupport()` (§6) — the overlay
never reads files or env.

### 5.3 `images.ts` (new) — detection, config, probe, render

```ts
// ── pi-chafa presence ──
export interface PiChafaStatus {
  present: boolean;
  via: "runtime" | "settings" | "none";
  /** Package root when discovered; for diagnostics/help copy only. */
  packageRoot?: string;
}
export function detectPiChafa(api: {
  getAllTools(): Array<{ name: string; sourceInfo?: SourceInfoLike }>;
  getCommands(): Array<{ name: string; sourceInfo?: SourceInfoLike }>;
}, paths: { userSettings: string; projectSettings: string },
   deps?: { readText?: (path: string) => string | undefined }): PiChafaStatus;

// ── pi-chafa config (read-only mirror of the documented subset) ──
// `version` is the parsed file version; the `version > 1` guard (defaults +
// warning) is applied in resolveImageSupport, which owns the warning channel.
export interface PiChafaSubset {
  version: number;
  binaryPath: string | null;
  cellWidth: number;
  maxRows: number;
  colors: "none" | "2" | "8" | "16" | "240" | "256" | "full";
  symbolsSet: string;
  dither: "none" | "ordered" | "diffusion" | "noise";
  timeoutMs: number;
}
export function loadPiChafaConfig(deps?: {
  agentDir?: string;
  env?: Record<string, string | undefined>;
  readText?: (path: string) => string | undefined;
}): PiChafaSubset;

// ── chafa binary ──
export type ChafaStatus =
  | { state: "ok"; binary: string; version: { major: number; minor: number } }
  | { state: "missing" | "too-old" | "error"; detail: string };
export function probeChafa(binaryPath: string | null, exec?: ExecFn): Promise<ChafaStatus>;

// ── render ──
export function buildSymbolsArgs(imagePath: string, s: PiChafaSubset, geometry: { cols: number; rows: number }): string[];
export function sanitizeChafaPayload(raw: string, geometry: { cols: number; rows: number }):
  | { ok: true; lines: string[] }
  | { ok: false; reason: string };
export async function runChafaRender(absPath: string, geometry: { cols: number; rows: number }, ctx: {
  binary: string; config: PiChafaSubset; signal?: AbortSignal; exec?: ExecFn;
}): Promise<{ ok: true; lines: string[] } | { ok: false; reason: string }>;

// ── host + geometry ──
export function readHostImageSettings(paths: { userSettings: string },
  deps?: { readText?: (path: string) => string | undefined }): { showImages: boolean; imageWidthCells: number };
export function resolveChafaGeometry(input: {
  paneCols: number;       // full viewer row width (rightW; no gutter in the chafa branch)
  paneRows: number;       // viewer content area
  preferredCols: number;  // clamp(config.cellWidth, IMAGE_CELLS_MIN, IMAGE_CELLS_MAX)
  maxRows: number;        // config.maxRows
}): { ok: true; cols: number; rows: number } | { ok: false; reason: "narrow" | "short" };

// ── aggregate fed into the overlay ──
export interface ImageSupport {
  mode: "off" | "chafa";
  piChafa: PiChafaStatus;
  chafa: ChafaStatus | { state: "deferred" };
  config: PiChafaSubset;
  hostShowImages: boolean;
  /** true ⇔ mode === "chafa" && piChafa.present && chafa.state === "ok" && hostShowImages */
  active: boolean;
}
export async function resolveImageSupport(api, paths, settings, deps?): Promise<ImageSupport>;
```

**Pure/impure split:** everything except `probeChafa`/`runChafaRender`/
`resolveImageSupport`'s probe call is pure or injectable (`readText`), so the
whole module is testable with fixtures; no test touches the real `$HOME` or a
real chafa.

### 5.4 Contract changes (`types.ts`, `navigator.ts`, `viewer.ts`)

`ViewerFile` additions (all optional, no breaking change):

```ts
/** chafa-rendered ANSI rows; only with kind "image", imageTier "chafa". */
imageLines?: string[];
/** Geometry the rows were rendered at (header badge + resize detection). */
imageCols?: number;
imageRows?: number;
/** Bounded chafa failure reason for the fallback card's hint row. */
imageError?: string;
```

Invariants: `lines` stays `[]` for `kind: "image"` (chafa rows never enter the
text/gutter/search path); `message` keeps its current meaning (`"size · dims"`)
so the `i`-toggled card is unchanged; `imageLines` is set **only** when
`sanitizeChafaPayload` succeeded.

`NavigatorOptions` additions:

```ts
/** Initial support snapshot (tests inject; index.ts passes a deferred one). */
imageSupport?: ImageSupport;
/** Optional geometry hint for image loads. */
loadFile: (relPath: string, opts?: LoadFileOptions) => Promise<ViewerFile>;
export interface LoadFileOptions { image?: { cols: number; rows: number } }
```

Overlay setter (matches the `setTree`/`setGitState` contract):

```ts
setImageSupport(support: ImageSupport): void
```

`viewer.ts` loader signature:

```ts
export type ImageRenderer = (
  absPath: string,
  req: { cols: number; rows: number },
) => Promise<{ ok: true; lines: string[]; cols: number; rows: number } | { ok: false; reason: string }>;

export async function loadFile(
  absPath: string, relPath: string,
  opts?: { image?: { cols: number; rows: number }; renderImage?: ImageRenderer },
): Promise<ViewerFile>;
```

`validateChafaConfig`-style version guard: pi-chafa `version > 1` → use defaults
and surface a warning (`pi-chafa config version N is newer than this navigator
supports; using defaults`). No migration is attempted.

### 5.5 New constants (`constants.ts`)

```ts
// ── Settings ──
export const NAVIGATOR_SETTINGS_FILE = "pi-navigator.json";
export const NAVIGATOR_IMAGES_ENV = "PI_NAV_IMAGES";

// ── Chafa / image rendering ──
export const PI_CHAFA_CONFIG_FILE = "pi-chafa.json";
export const CHAFA_MIN_VERSION = { major: 1, minor: 10 } as const; // matches pi-chafa
export const IMAGE_CELLS_MIN = 16;      // below this the card wins
export const IMAGE_CELLS_MAX = 100;
export const IMAGE_ROWS_MIN = 4;        // below this the card wins
export const IMAGE_PROBE_TIMEOUT_MS = 3000;
export const IMAGE_RENDER_TIMEOUT_MIN_MS = 500;
export const IMAGE_RENDER_TIMEOUT_MAX_MS = 60_000;
export const IMAGE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export const IMAGE_RESIZE_DEBOUNCE_MS = 250;
export const IMAGE_ERROR_MAX_CHARS = 200;
```

---

## 6. Detection & Support Resolution

### 6.1 pi-chafa presence (`detectPiChafa`)

Ordered evidence; first hit wins, result cached for the overlay's lifetime:

1. **Runtime (authoritative).** In `pi.getAllTools()` find `name === "show_image"`
   (fallback: `pi.getCommands()` entry `name === "images"`, `source ===
   "extension"`) → take `sourceInfo`. Confirm identity by reading
   `package.json` from `sourceInfo.baseDir` and up to **3 ancestor directories**
   of `sourceInfo.path`; present ⇔ `name === "pi-chafa"`. Never match on the
   tool/command name alone (docs: `sourceInfo` is canonical provenance).
2. **Settings listing.** Read `packages` from `<agentDir>/settings.json` and
   `<cwd>/.pi/settings.json`; present ⇔ any entry's last path segment is
   `pi-chafa` (`npm:pi-chafa`, `../../Sources/pi-chafa`, `/abs/.../pi-chafa`),
   after stripping an `npm:` prefix and trailing slashes.
3. Otherwise absent. A readable `<agentDir>/pi-chafa.json` is **not** evidence
   (D3); it is only consulted for knobs once 1 or 2 matched.

`sourceInfo.source` is deliberately unused (it is often just `"local"`); the
`package.json` name is the stable identity.

### 6.2 chafa binary (`probeChafa`)

- Binary: `binaryPath` config value ← `CHAFA_BIN` env (env wins, pi-chafa
  parity) ← `"chafa"` on PATH.
- `execFile(binary, ["--version"], { timeout: IMAGE_PROBE_TIMEOUT_MS,
  encoding: "utf8", maxBuffer: 1 MiB })`; parse `/Chafa version (\d+)\.(\d+)/`;
  require `>= CHAFA_MIN_VERSION`. `ENOENT` → `missing` with the platform
  install hint (copy pi-chafa's `installHint` strings verbatim — user-facing
  consistency across both extensions beats avoiding a 6-line duplication);
  unparsable/exit-error → `error` with a bounded message.
- Probed once per overlay session **asynchronously** after the overlay opens
  (D9). On manual `r`: re-probe only when the last state was not `ok`
  (self-heal after a mid-session install), else keep the cached probe.

### 6.3 Host image settings

Read `<agentDir>/settings.json` `terminal.showImages` only. `false` forces
`active: false` for the whole session (D6). `terminal.imageWidthCells` is read
for parity diagnostics but does not override `pi-chafa.json`'s `cellWidth`.

### 6.4 Aggregate + lifecycle

`resolveImageSupport(api, paths, settings)`:

```text
active = settings.images.mode === "chafa"
       && piChafa.present
       && chafa.state === "ok"
       && hostShowImages
```

- Called once per `/navigator` command invocation; runs concurrently with
  overlay construction. `index.ts` pushes the result via
  `overlay.setImageSupport(support)`; the overlay initially holds
  `{ mode, chafa: { state: "deferred" }, active: false, … }` so the first image
  open shows the metadata card and is upgraded when support lands (D9).
- Warnings (bad env value, newer pi-chafa config, corrupt settings) notify once
  via `ctx.ui.notify`, overseer-style.
- Detection cost: in-memory API lookup + ≤ 3 small JSON reads + one 3 s-bounded
  probe. No network, no writes.

---

## 7. Render Pipeline & Data Flow

### 7.1 Sequence

```text
/navigator
  └─ index.ts: loadNavigatorSettings() ─ resolveImageSupport() [async]
        └─ overlay.setImageSupport(support)            [when resolved]
Open image (files/git Enter or any relPath)
  └─ overlay.openRelPath(relPath)
        geometry = resolveChafaGeometry(pane snapshot, support)
        await loadFile(relPath, { image: geometry })   [only for image exts]
              └─ index.loadFileCached: support.active && geometry.ok
                    → loadFile(absPath, relPath, { image, renderImage })
                          └─ renderImage: sanitize(runChafa(buildSymbolsArgs(...)))
                    → ViewerFile { kind:"image", imageTier:"chafa", imageLines, … }
                 else → loadFile(absPath, relPath)      [today's metadata card]
  └─ buildRightRows: chafa branch (no gutter) or buildCard
```

`renderImage` is created in `index.ts` (which owns async work) and closes over
the resolved `ImageSupport`; the component only ever calls the injected
`loadFile`.

### 7.2 Geometry (`resolveChafaGeometry`)

```text
preferredCols = clamp(support.config.cellWidth, IMAGE_CELLS_MIN, IMAGE_CELLS_MAX)
cols          = clamp(min(paneCols, preferredCols), IMAGE_CELLS_MIN, IMAGE_CELLS_MAX)
rows          = clamp(min(support.config.maxRows, paneRows), IMAGE_ROWS_MIN, support.config.maxRows)
```

- The pane is the hard cap (**never** exceed it — width safety first); the
  pi-chafa `cellWidth` preference is honored whenever the pane is wider, so a
  user who set 40 gets 40 even in a 100-column pane.
- `paneCols < IMAGE_CELLS_MIN` or `paneRows < IMAGE_ROWS_MIN` → `{ ok: false }`
  → metadata card (with the “pane too small for a rendered image” hint).
- Both numbers are passed to chafa as `--size {cols}x{rows}`; chafa preserves
  aspect ratio inside the box.

### 7.3 `index.ts` loader + cache

```ts
const imageVariant = (g: {cols: number; rows: number}, s: ImageSupport) =>
  `${g.cols}x${g.rows}:${s.config.binaryPath ?? ""}:${s.config.colors}:${s.config.symbolsSet}:${s.config.dither}:${s.config.timeoutMs}`;

const loadFileCached = async (relPath: string, opts?: LoadFileOptions): Promise<ViewerFile> => {
  // ...existing stat / mtime cache lookup, extended with the variant...
  const isImage = IMAGE_EXTENSIONS.has(extOf(relPath));
  const useChafa = isImage && opts?.image !== undefined && imageSupport.active;
  const variant = useChafa ? imageVariant(opts.image!, imageSupport) : "";
  // cache hit requires cached.variant === variant
  const file = useChafa
    ? await loadFile(absPath, relPath, { image: opts!.image, renderImage })
    : await loadFile(absPath, relPath);
  // ...store { mtimeMs, variant, file } ...
};
```

- The variant string guarantees that a width change, or a pi-chafa config edit
  picked up on `r`, is a cache miss (D11). Non-image entries keep `variant: ""`
  and behave exactly as today.
- On `r`, pi-chafa's config is re-read (file + `CHAFA_*` env), so `/images`
  tuning in pi-chafa is picked up by the next `r`/open. If the binary probe was
  cached `ok`, a config change does not re-probe (cheap either way; the render
  uses the configured `binaryPath`, so a config path change is honored by the
  next render even without a re-probe).
- A new `AbortController` per image load; aborted on overlay close/dispose and
  on a newer load for the same overlay (`loadSeq` already discards stale
  results; the signal prevents the child process from outliving the overlay).
- The 3 s open-file mtime poll is unchanged; `diskChanged` handling for images
  stays as today (the card/branch does not render the warning row; no change).
- `commit:` paths and markdown loading are untouched.

### 7.4 `viewer.ts` image branch

When `IMAGE_EXTENSIONS.has(ext)`:

1. Keep the existing 64-byte dimension probe for `message` (`size · dims`).
2. If `opts?.renderImage` is present:
   - `const out = await opts.renderImage(absPath, opts.image)` inside
     `try/catch` (an unexpected throw is a failure, never a crash).
   - `ok` → `{ kind: "image", imageTier: "chafa", imageLines: out.lines,
     imageCols: out.cols, imageRows: out.rows, lines: [], message, sizeBytes,
     mtimeMs }`.
   - `!ok` → metadata card + `imageError: bounded(reason, IMAGE_ERROR_MAX_CHARS)`.
3. Else → today's metadata card unchanged.
4. `rawText` and all text paths are untouched (markdown tests stay green).

### 7.5 `navigator.ts` rendering, keys, chrome

**Branch** in `buildRightRows` (before the card branch):

```ts
if (file.kind === "image" && file.imageTier === "chafa" && file.imageLines?.length && !this.imageAsCard) {
  // image branch: no gutter, no wrap, no hscroll, no search
}
if (file.kind === "binary" || file.kind === "error" ||
    (file.kind === "image" && (file.imageTier === "metadata" || this.imageAsCard))) {
  rows.push(...this.buildCard(file, rightW, area));
  return rows;
}
```

**Image branch rules:**

- `viewScroll` clamps to `max(0, imageLines.length - contentArea)`; `j`/`k`,
  `Ctrl+d`/`Ctrl+u`, `g`/`G` scroll exactly as for text.
- Each row: `this.padTo(truncateToWidth(line, rightW, ""), rightW)` — the
  empty ellipsis hard-cuts if the pane shrank before the debounced re-render
  (D10); every line already carries its own trailing reset (§8).
- No search marking, no `marked`/`rowsCache` reuse: the branch reads
  `imageLines` directly (they are pre-styled and content-stable).

**Keys** (`handleViewerInput`) on a chafa image:

| Key | Behavior |
|---|---|
| `j` `k` `Ctrl+d` `Ctrl+u` `g` `G` | scroll rows (unchanged math) |
| `i` | toggle `imageAsCard` (session-only, reset on file change). When the open image is a *card* and support is active: re-request the render instead of toggling. |
| `w`, `h`/`l` | inert, silent (rendered-markdown precedent, Issue #053) |
| `/`, `n`, `N` | `/` shows `"search is not available for rendered images"`; `n`/`N` no-op |
| `m` | unchanged: markdown-only notice |
| `r` | reload; with a new `r`-time config, the variant key forces a fresh chafa run |
| `y` | unchanged (copies `relPath`) |

**Header** (`buildViewerHeader`): when `imageSupport.active` and the file is an
image, append a dim token after the existing meta:

- chafa branch → `chafa · i card`
- card branch (chafa-capable) → `i render`

Non-image files keep today's header exactly.

**Help/footer:** add `["i", "toggle image rendering / metadata card (chafa)"]`
to `HELP_ROWS`. `FOCUS_HINTS.viewer` is **unchanged** — the 71-column footer
budget test stays as-is; the header badge is the affordance.

**Resize (D10):** the top-level `render(width)` records an idempotent
`lastLayout = { cols, rows }` (pure function of width; no user-visible state is
mutated — Issue #053 stays honored) and, when the open file is a chafa image
whose `imageCols/imageRows` differ, schedules `openRelPath(relPath, true)` after
`IMAGE_RESIZE_DEBOUNCE_MS`. The timer is cleared by `dispose()` and on file
change; a scheduled reflow is a no-op if the file changed or support is off.
`setImageSupport()` uses the same scheduler for the deferred upgrade (D9).

**Card guidance** (`buildCard` image branch) replaces the current “metadata card
in v1; native protocol and chafa…” rows with the §9 copy, selected from
`imageSupport` + `file.imageError`.

---

## 8. Output Safety (`sanitizeChafaPayload`)

Chafa output is **untrusted ANSI** (it varies by version and terminal). The
overlay shares the terminal with pi's UI, so the acceptance bar is stricter
than the transcript cleaner in pi-chafa (`cleanSymbolsPayload`).

1. **Whitelist scan.** Iterate ESC sequences. Allow only SGR
   (`\x1b\[[0-9;]*m`) plus the two absolute-mode cursor escapes chafa always
   emits — `\x1b[?25l` and `\x1b[?25h` — which are **recognized and dropped**
   (pi-chafa parity; without this exception every real payload would be
   rejected). Any other ESC form — CSI cursor movement, other `?` modes, OSC,
   DCS — **rejects the entire payload** (`{ ok: false, reason:
   "unexpected escape sequence" }`) → metadata card. Do not attempt partial
   cleaning beyond those two known cursor escapes.
2. **Strip carriage returns** (`\r`, including `\r\n`) — Issue #009 class; a CR
   resets the cursor and the row padding would overwrite the frame.
3. **Split, trim, cap.** Split on `\n`, drop trailing empty lines, cap to
   `rows` lines; a line whose visible width exceeds `cols` is truncated with an
   **empty** ellipsis (`truncateToWidth(line, cols, "")`, Issue #010).
4. **Guarantee per-row reset.** Append `\x1b[0m` when a line does not already
   end with it, so `padTo` padding and the next row's gutter can never inherit
   a chafa color.
5. **Reject empty output** → metadata card (`"chafa produced no output"`).

Bounded by construction: `maxBuffer` 8 MiB, `rows ≤ IMAGE_CELLS_MAX`-scale
line count, `cols ≤ IMAGE_CELLS_MAX`, reason strings bounded to
`IMAGE_ERROR_MAX_CHARS`.

---

## 9. User-Facing Guidance (the “instructions” requirement)

The feature must teach itself. Guidance is shown in the metadata card
(`buildCard` body rows) and in the README; the first card in an overlay session
that shows guidance also emits the existing one-time overlay notice mechanism.
Copy (kept short for narrow panes; `buildCard` hard-cuts safely):

| Condition | Card row |
|---|---|
| `active`, chafa branch reachable | *(no hint; header shows `chafa · i card`)* |
| mode off, pi-chafa present, chafa ok | `optional: enable images.mode=chafa to render images here` |
| pi-chafa absent (any mode) | `optional: install chafa + pi-chafa (pi install npm:pi-chafa) to render images` |
| mode on, chafa `missing` | `chafa not found - install it, or set CHAFA_BIN / binaryPath` |
| mode on, chafa `too-old` | `chafa <maj>.<min> is older than 1.10 - upgrade to render images` |
| mode on, chafa `error` | `chafa probe failed: <bounded detail>` |
| render failed (`imageError`) | `chafa failed: <bounded reason>` |
| pane too narrow/short | `pane too small for a rendered image` |
| support still resolving | `checking image support…` |

Documentation deliverables:

- **README** — replace “## Images (spike pending)” with an “Images (optional)”
  section: requirements (`chafa` ≥ 1.10 + pi-chafa), install commands
  (`brew/apt`, `pi install npm:pi-chafa` or local path), opt-in
  (`images.mode: "chafa"` or `PI_NAV_IMAGES=1`), the fact that all visual knobs
  live in `~/.pi/agent/pi-chafa.json` (with a pointer to pi-chafa's README),
  and the `i` toggle. Add a Config-table row for `PI_NAV_IMAGES` beside
  `PI_NAV_ICONS`.
- **README Keys** — Viewer row: `i` — toggle image rendering / metadata card.
- **Help modal** — the `HELP_ROWS` entry from §7.5.
- **AGENTS.md** — amend the “No external runtime deps / no shelling out to
  external binaries” bullet with the carve-out: *chafa is an optional,
  user-installed renderer, used only when the user opts in and pi-chafa is
  installed; it is never required, never bundled, and never invoked for any
  other purpose.* Add `images.ts`/`settings.ts` to the code-layout table and to
  `package.json` `files` + `tsconfig.json` `include` (the #037 lesson).
- **DESIGN.md** — document the image tier: chafa-authored ANSI colors are the
  one sanctioned exception to “no hardcoded colors” because the colors are
  produced by the user's tool, contained per row by an enforced trailing
  reset; pi-navigator itself hardcodes none.
- **Issue docs** — new `docs/issues/057-chafa-image-rendering.md`, added to
  `issues_index.md` with updated counts, and amend the open items in the
  original plan (§8/§14) to point at this spec.

---

## 10. Degradation Matrix

| Condition | Behavior |
|---|---|
| default (never configured) | metadata card, plus a short install/opt-in hint row |
| pi-chafa installed, chafa ok, mode off | metadata card + `enable images.mode=chafa` hint |
| mode on, pi-chafa absent | metadata card + install hint; no probe result needed |
| mode on, chafa missing | metadata card + `CHAFA_BIN` / PATH hint (probe message) |
| chafa older than 1.10 | metadata card + upgrade hint |
| chafa probe error (permissions, weird binary) | metadata card + bounded error |
| render timeout / non-zero exit | metadata card + `chafa failed: …` |
| payload has unexpected escapes / no output | metadata card + reason |
| pane < 16 cols or < 4 rows | metadata card + “pane too small” |
| overlay closed / file switched mid-render | child aborted via signal; `loadSeq` discards the result |
| `terminal.showImages: false` | rendering never activates; card only |
| not an image extension, or binary content | existing binary/error card path unchanged |
| markdown/`diff`/text files | completely unchanged paths |

---

## 11. Security, Resource Bounds, Read-Only Guarantee

- **No shell.** `execFile` with an argument array only (git.ts pattern); the
  image path is argv, never interpolated into a command string.
- **Binary provenance is user-controlled only**: `binaryPath`/`CHAFA_BIN` or
  PATH. Nothing is downloaded; no auto-install; no PATH mutation.
- **Timeouts and buffers**: probe ≤ 3 s; render ≤ `timeoutMs` clamped to
  `[500, 60000]` ms; stdout ≤ 8 MiB; each render tied to an `AbortSignal` from
  the overlay lifecycle.
- **No unbounded cache growth**: chafa entries live in the existing bounded
  viewer cache (`MAX_VIEWER_CACHE_ENTRIES`); geometry changes create distinct
  entries but eviction is unchanged (oldest first).
- **Strict ANSI containment** (§8) — a hostile or buggy chafa cannot move the
  cursor, clear the screen, or leak style into the frame.
- **Read-only**: the only new filesystem reads are `pi-chafa.json`,
  `settings.json` (user + project), and a nearby `package.json`. No writes
  except `writeNavigatorSettings`, which is not called by this feature (future
  configure UI only) and uses tmp+rename when it is.
- **No dependency edge**: grep-checkable invariant — no `from "pi-chafa"`, no
  `chafa` in `dependencies`, `package.json` `files` gains only local modules.

---

## 12. Test Matrix

### 12.1 `test/settings.test.ts` (new)

- Defaults when the file is missing; `env` override wins over the file;
  `PI_NAV_IMAGES` truth table (`1/true/yes/on/chafa` enable, `0/false/no/off`
  disable, garbage → warning + fallback).
- Corrupt JSON → defaults + warning; `version: 2` → defaults + warning;
  unknown keys warn; `images.mode: "native"` → warning + `"off"`.
- `serializeNavigatorSettings` round-trips through
  `normalizeNavigatorSettings`; atomic write leaves no `.tmp` and preserves the
  canonical shape.
- `NAVIGATOR_CONFIG_FIELDS` sync guard (overseer pattern): every field's `path`
  resolves in `DEFAULT_NAVIGATOR_SETTINGS`; enum options match the normalizer's
  accepted values; `images.mode` is `live: false`.

### 12.2 `test/images.test.ts` (new)

- `loadPiChafaConfig`: reads a fixture file; `CHAFA_*` env precedence
  table (`CHAFA_BIN`, `CHAFA_COLORS`, `CHAFA_SYMBOLS`, `CHAFA_DITHER`,
  `CHAFA_MAX_ROWS`, `CHAFA_TIMEOUT_MS`, `CHAFA_CELL_WIDTH`), `CHAFA_CONFIG_DIR`
  respected; invalid values skipped silently (pi-chafa parity); corrupt JSON →
  defaults.
- `detectPiChafa`: runtime hit via a fixture package (`package.json` name
  `pi-chafa`, entry under `src/` — the ancestor walk must find it); a tool named
  `show_image` from a package named something else → absent; command fallback;
  settings `packages` scan for `npm:pi-chafa`, a relative path, and non-matches;
  config-file-only → absent (D3).
- `probeChafa`: version parse, min-version rejection, `ENOENT` → `missing`
  with hint, unparsable output → `error` (all via injected exec).
- `buildSymbolsArgs`: exact argv equality with pi-chafa's vector for a fixed
  config and geometry.
- `sanitizeChafaPayload`: SGR-only payload passes; `\r` stripped; the two
  chafa cursor escapes (`\x1b[?25l`/`\x1b[?25h`) are dropped; any *other*
  non-SGR ESC → rejected; missing trailing reset → appended
  per row; over-wide line truncated with empty ellipsis; > `rows` lines capped;
  empty → rejected.
- `resolveChafaGeometry`: pane narrower than preference (pane wins), pane wider
  (preference wins), clamps at MIN/MAX, narrow/short rejection.
- `readHostImageSettings`: `showImages: false`; missing/corrupt file → defaults.
- `resolveImageSupport` truth table over (mode × present × chafa state ×
  showImages).

### 12.3 `test/viewer.test.ts`

- `loadFile` with an injected renderer returning `ok` → `imageTier: "chafa"`,
  `imageLines` set, `lines` empty, `message` unchanged, `mtimeMs` preserved.
- Renderer returning `!ok` → `imageTier: "metadata"`, `imageError` bounded.
- Renderer throwing → same as `!ok` (no rejection escapes `loadFile`).
- No renderer → today's metadata card byte-for-byte (regression guard).
- `rawText`/markdown behaviour untouched.

### 12.4 `test/navigator.test.ts`

- `setImageSupport` + fake loader: opening `sample.png` passes
  `opts.image = { cols, rows }` and renders `imageLines` rows width-safe with no
  gutter.
- Scroll: `j`/`G`/`Ctrl+d` clamp to the image height; blank fill below.
- `i`: toggles to the card and back; reset on file change; when the file is a
  card with `active` support, `i` re-requests the load.
- Inert keys: `w`, `h`/`l` no-op; `/` shows the search notice; `n`/`N` no-op.
- Deferred upgrade: open an image before `setImageSupport` → card; after
  `setImageSupport({active:true})` → loader called again with geometry.
- Resize: change the render width → debounced re-request with the new `cols`;
  disposal cancels the timer (fake timers).
- Header badge (`chafa · i card` / `i render`) only for supported images.
- Card guidance per support state (`active`, off, absent, missing, too-old,
  error, narrow).
- Existing suites: card path for unsupported images unchanged; help/footer
  budget tests green.

### 12.5 `test/render.test.ts`

Width safety at 120×36, 100×28, 80×24, 60 and 50 columns with a synthetic
chafa payload containing: an exact-fit line, an over-wide line, a line without
a trailing reset, nested SGR colors, and a wide (CJK) glyph. Assert for every
frame row: `visibleWidth === pane width`, no `\r`, no non-SGR escape, no bright
ellipsis leak (`\x1b[0m` artifact), and a card-only frame when the pane is
narrow. Existing markdown/diff/text frames must be byte-identical.

**Harness rules:** all tests inject `readText`/exec/`loadFile`; no test invokes
real chafa, reads `$HOME`, or depends on pi-chafa being installed. Env-mutating
tests save/restore keys in `afterEach` (icons-test pattern). `chafa` is not a
test dependency; the render suite uses fixtures.

---

## 13. Files Touched

| File | Change |
|---|---|
| `settings.ts` (new) | Schema, defaults, normalizer, loader, serializer, atomic writer, `NAVIGATOR_CONFIG_FIELDS` |
| `images.ts` (new) | pi-chafa detection, config mirror, probe, args, runner, sanitizer, geometry, `resolveImageSupport` |
| `index.ts` | Settings + support resolution per invocation; `loadFileCached` variant key + `renderImage`; `AbortController` lifecycle; pass `imageSupport`; warnings |
| `viewer.ts` | `LoadFileOptions`/`ImageRenderer`; image branch renders via injected callback, falls back with `imageError`; header comment updated |
| `navigator.ts` | `imageSupport`/`setImageSupport`, `imageAsCard`, geometry snapshot + debounced reflow, chafa render branch, `i` key, header badge, card guidance, help row |
| `types.ts` | `imageLines`/`imageCols`/`imageRows`/`imageError` |
| `constants.ts` | §5.5 constants |
| `package.json` | version `0.5.1 → 0.6.0`; `files` += `images.ts`, `settings.ts` |
| `tsconfig.json` | `include` += `images.ts`, `settings.ts` |
| `test/settings.test.ts`, `test/images.test.ts` | New suites |
| `test/viewer.test.ts`, `test/navigator.test.ts`, `test/render.test.ts` | Cases per §12 |
| `README.md` | Images section, Config row, Keys row |
| `AGENTS.md` | External-binary carve-out; module table; files/include note |
| `DESIGN.md` | Image tier / color-exception note |
| `docs/issues/057-chafa-image-rendering.md` + `issues_index.md` | New issue + counts |
| `docs/plans/pi-navigator-implementation-plan.md` | §8/§14 pointer to this spec |

---

## 14. Implementation Sequence & Gates

1. **Settings terrain** — `settings.ts` + `test/settings.test.ts`. Gate:
   typecheck + tests green (feature still inert).
2. **Detection + renderer module** — `images.ts` + `test/images.test.ts`
   (injected exits; no real chafa). Gate: green.
3. **Loader seam** — `types.ts` additions, `viewer.ts` `LoadFileOptions` +
   `ImageRenderer`, `test/viewer.test.ts` cases. Gate: green; old card path
   byte-identical.
4. **Wiring** — `constants.ts`, `index.ts` (settings load, support resolution,
   variant cache, abort lifecycle), `navigator.ts` (`setImageSupport`,
   `imageSupport` option, pass geometry through `loadFile`). Gate: green.
5. **Rendering & interaction** — navigator chafa branch, `i`, header badge,
   card guidance, resize reflow, help row; `test/navigator.test.ts` +
   `test/render.test.ts`. Gate: green at all widths.
6. **Docs & registration** — README, AGENTS.md, DESIGN.md, issue #057 + index,
   version bump to `0.6.0`, `package.json`/`tsconfig.json` includes, then
   `pi install .`. Gate: `npm run typecheck` + `npm test` green; re-check the
   #037 class (new modules shipped + included).
7. **Manual QA (evidence to `docs/plans/qa-evidence.md`)** — with pi-chafa +
   chafa 1.18.2 installed but mode off (card + hint), mode on via env (render,
   scroll, `i`, resize by resizing the terminal), `CHAFA_BIN` bogus (missing
   hint), `terminal.showImages:false` (card), and a mode-on run with
   pi-chafa absent (install hint).

Each step is one commit; `npm run typecheck` and `npm test` must be green before
the next, per AGENTS.md.

---

## 15. Acceptance Criteria

#### Functional

- Default install (no settings file, no env): image files show today's metadata
  card plus a short install/opt-in hint; no subprocess is spawned.
- With pi-chafa + chafa ≥ 1.10 present and `images.mode: "chafa"` (or
  `PI_NAV_IMAGES=1`): opening a PNG renders symbol art in the viewer pane;
  colors/symbols/dither/timeout follow `~/.pi/agent/pi-chafa.json` and
  `CHAFA_*`; `--size` is bounded by the pane.
- `i` toggles to the metadata card and back; the header badge reflects the
  state; `j/k/g/G/Ctrl+d/Ctrl+u` scroll; `w`, `h`, `l` are inert; `/` explains
  it is unavailable.
- Resizing the terminal re-renders the image at the new geometry (debounced);
  no row ever exceeds the pane width before or during the re-render.
- Removing chafa (or uninstalling pi-chafa, or setting `showImages: false`)
  degrades to the card with the matching hint; nothing throws.
- No filesystem writes; no network; no npm dependency; no pi-chafa import.

#### Automated

- `npm run typecheck` clean; `npm test` green including the two new suites and
  the extended viewer/navigator/render suites.
- Render suite: width-safe at 120×36, 100×28, 80×24, 60, 50; no CR, no
  non-SGR escape, no bright-ellipsis artifact.
- No test requires chafa, pi-chafa, a Nerd Font, or a writable `$HOME`.

#### Docs

- README “Images (spike pending)” is gone, replaced by install/opt-in
  instructions; `PI_NAV_IMAGES` is documented beside `PI_NAV_ICONS`;
  `i` is in the Keys table and the help modal; AGENTS.md carries the
  external-binary carve-out; issue #057 is registered in the index.

---

## 16. Open Questions & Future Work

1. **Native tier** — **resolved** by
   [`native-image-rendering.md`](./native-image-rendering.md) (issue #069): the
   plan §8 spike is answered, `imageTier: "native"` activates, and the tier
   ladder is native → chafa → metadata (`preferNative` becomes meaningful for
   the `auto` mode).
2. **Animated GIF playback** — needs `--animate on` plus frame timing in the
   overlay; explicitly out of scope.
3. **Per-image overrides** — pi-chafa's tool exposes per-call
   `cellWidth/colors/symbolsSet/dither`; navigator has only session settings.
   A future `/navigator configure` could add transient overrides.
4. **Project-level pi-navigator settings** — deliberately excluded (D12);
   revisit with the trust model.
5. **pi-chafa config schema drift** — the mirrored subset is pinned to
   `version: 1`; a future pi-chafa schema bump surfaces a warning rather than a
   migration. Consider reading pi-chafa's own published schema if one appears.
6. **Cell aspect ratio** — chafa assumes ~2:1 cells; a future `aspectRatio`
   knob in pi-chafa would be passed through automatically once documented.
