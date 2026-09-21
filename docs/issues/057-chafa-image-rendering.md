# Issue #057: Optional Chafa Image Rendering (pi-chafa delegation)

- **Status**: Resolved (shipped as v0.6.0 in this change)
- **Type**: Feature
- **Severity**: Medium
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) / [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) / [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts) / [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts)

---

## Description

Up to v0.5.1 the viewer shows only a metadata card for image files (`kind: "image"`, `imageTier: "metadata"`); the implementation plan §8 deferred actual image rendering to a verification spike. This feature delivers the **chafa tier**: when (a) the user opts in, (b) the pi-chafa extension is installed, and (c) a `chafa >= 1.10` binary is available, the viewer pane renders PNG/JPEG/GIF/WebP/… files as chafa ANSI symbol art — delegating to pi-chafa's **own** configuration (`~/.pi/agent/pi-chafa.json` + `CHAFA_*` env) so both surfaces agree on colors, symbols, dithering, and size caps.

The feature keeps the repo's three invariants intact: **zero runtime dependencies** (no npm package, no bundled binary, no pi-chafa import — only its config JSON is read), **read-only** (no workspace writes), and **graceful degradation** (every failure path lands on the existing metadata card, never an error and never a hang). Opt-in is explicit and off by default. Full spec: [`docs/specs/chafa-image-rendering.md`](../specs/chafa-image-rendering.md).

## Resolution

### Settings terrain (`settings.ts`, new)

- Versioned user-level settings file `~/.pi/agent/pi-navigator.json` — canonical shape `{ "version": 1, "images": { "mode": "off" } }`; the terrain for a future `/navigator configure` modal.
- **Opt-in**: `images.mode: "chafa"` in the file, or the `PI_NAV_IMAGES` env var (`1`/`true`/`yes`/`on`/`chafa` enable; `0`/`false`/`no`/`off` disable; anything else → one warning + fallback). Precedence: defaults ← file ← env.
- pi-overseer-style normalizer/loader/serializer/atomic writer plus the ordered `NAVIGATOR_CONFIG_FIELDS` registry; `index.ts` reads the env once per invocation and forwards warnings through the notify path; the overlay never touches env or files.

### Detection, probe, render (`images.ts`, new)

- **pi-chafa presence requires evidence**: a runtime tool/command whose `sourceInfo` leads to a nearby `package.json` named `pi-chafa` (package root + up to 3 ancestor dirs), or a `settings.json` `packages` entry whose last path segment is `pi-chafa` (`npm:pi-chafa`, relative, or absolute). A leftover `pi-chafa.json` alone is **not** evidence (D3).
- **Read-only config mirror**: `loadPiChafaConfig` reads `~/.pi/agent/pi-chafa.json` + `CHAFA_*` env (binaryPath, cellWidth, maxRows, colors, symbolsSet, dither, timeoutMs), silently skipping invalid values (pi-chafa parity); `version > 1` → defaults + warning.
- **Probe**: `chafa --version` via `execFile` (no shell), 3 s timeout, requires `>= 1.10`; `ENOENT` → platform install hint (`brew install chafa` / `apt install chafa`).
- **Strict sanitizer**: SGR-only whitelist; drops exactly chafa's two cursor escapes (`\x1b[?25l` / `\x1b[?25h`); any other non-SGR escape rejects the payload → metadata card; `\r` stripped (Issue #009 class); per-row enforced trailing `\x1b[0m`; rows/width capped (`IMAGE_CELLS_MAX`); empty output rejected.
- **Pane-bounded geometry**: `cellWidth`/`maxRows` preferences clamped by the live pane (the pane is the hard cap); narrow/short panes fall back to the card with the "pane too small" hint.

### Wiring & interaction

- **`i` toggle** toggles rendered image ⇄ metadata card (per open file, session-only) and re-requests the render when the card is showing; header badge (`chafa · i card` / `i render`); help row added.
- **Resize reflow**: debounced re-render at the new geometry; stale rows clipped meanwhile; `AbortSignal` per render kills the child on dispose/file switch; chafa entries live in the existing bounded viewer cache keyed on a geometry/knob variant.
- **Deferred async support**: `/navigator` opens immediately; `resolveImageSupport` resolves after (non-blocking, ≤ 3 s probe) and upgrades a displayed image card.
- `terminal.showImages: false` disables rendering for the session; markdown/diff/text paths untouched.
- **Full degradation**: no opt-in, no pi-chafa, chafa < 1.10, missing chafa, probe/render failure, unexpected escapes, or a too-small pane → metadata card with the matching hint row. No writes, no network, no npm dependency, no pi-chafa import.

## Verification

- `npm run typecheck` clean.
- `npm test` green: new `test/settings.test.ts` and `test/images.test.ts` suites (env truth table, corrupt/newer-config warnings, presence detection via fixtures, probe parses, exact chafa argv, sanitizer cases, geometry clamps, support truth table) plus extended `test/viewer.test.ts`, `test/navigator.test.ts`, and `test/render.test.ts` (chafa branch, `i`, resize reflow, deferred upgrade, width-safety at 120×36 / 100×28 / 80×24 / 60 / 50).
- All image suites run on injected seams (`readText`/exec/`loadFile`) — no test requires chafa, pi-chafa, or the real `$HOME`.

## Acceptance Criteria

- [x] Default install (no settings file, no env): image files show the metadata card plus a short install/opt-in hint; no subprocess spawned.
- [x] With pi-chafa + chafa ≥ 1.10 and opt-in: opening a PNG renders symbol art in the viewer pane; colors/symbols/dither/timeout follow pi-chafa config and `CHAFA_*`; `--size` is bounded by the pane.
- [x] `i` toggles card ⇄ render; header badge reflects the state; `j`/`k`/`g`/`G`/`Ctrl+d`/`Ctrl+u` scroll; `w`/`h`/`l` inert; `/` explains it is unavailable for rendered images.
- [x] Resizing the terminal re-renders the image at the new geometry (debounced); no row ever exceeds the pane width before or during the re-render.
- [x] Removing chafa, uninstalling pi-chafa, or `showImages: false` degrades to the card with the matching hint; nothing throws.
- [x] No filesystem writes; no network; no npm dependency; no pi-chafa import.
- [x] README "Images (spike pending)" replaced with install/opt-in guidance; `PI_NAV_IMAGES` documented beside `PI_NAV_ICONS`; `i` in the Keys table and help; AGENTS.md external-binary carve-out; DESIGN.md image-tier note; version 0.6.0.