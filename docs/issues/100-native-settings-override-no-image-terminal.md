# Issue #100: Native Ladder Forces Settings/Env Protocol on Known No-Image Terminals (Blank Viewer in Alacritty)

- **Status**: Resolved
- **Type**: Bug
- **Severity**: High
- **Component**: [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts#L770-L806), [spec §native ladder](../specs/native-image-rendering.md)

## Description

With `images.mode: "auto"` and pi's global `terminal.images` setting declared
for a kitty-capable terminal (e.g. Konsole), the navigator's native capability
ladder forces the kitty protocol onto terminals that **positively cannot**
render it. Observed in Alacritty: opening an image shows an empty viewer —
no image, no metadata card. In tmux running inside the same Alacritty, images
render via chafa (correct, the #070 multiplexer guard returns null first).

## Reproduction

1. pi settings: `"terminal": { "images": "kitty" }` (needed for Konsole).
2. `pi-navigator.json`: `images.mode: "auto"`.
3. Launch pi in Alacritty and open an image file in the navigator.

Result: blank viewer pane. Expected: chafa rendering or the metadata card.

## Root Cause

pi-tui's `detectCapabilitiesFromEnvironment` returns `images: null` for two
different situations that the ladder could not distinguish:

- **Definitively image-incapable terminals** — Alacritty, VS Code, Zed
  (`TERM_PROGRAM`), JetBrains (`TERMINAL_EMULATOR=jetbrains-jediterm`),
  Windows Terminal (`WT_SESSION`).
- **Unrecognized terminals** — Konsole is absent from pi-tui's detection
  table, so it lands in the "unknown terminal" branch and also reports
  `images: null`, *despite supporting the kitty protocol*.

The ladder's settings step (`terminal.images`) and env step
(`PI_IMAGE_PROTOCOL`) treat every `null` as "detection was inconclusive" and
override it. For Konsole this override is the *only* source of the native
capability (load-bearing). For Alacritty the same override emits kitty APC
sequences the terminal ignores (APC-ignore is spec-safe), and because
`runNativeRender` returns `ok: true` once the bytes are encoded, the loader
never falls back — hence the blank viewer instead of chafa/card.

## Fix

New `knownNoImageSupport(env)` in `images.ts` — a mirror of pi-tui's
*negative* detection table (alacritty/vscode/zed `TERM_PROGRAM`,
`jetbrains-jediterm`, `WT_SESSION`):

- `resolveNativeProtocol` checks it **between** the positive-capability step
  and the settings/env steps: positive detection (including
  `PI_IMAGE_PROTOCOL` forcing through pi-tui) still wins; a known no-image
  terminal can no longer be overridden by the static fallbacks.
- `runNativeRender`'s direct-call guard applies the same flag, so a protocol
  forced onto a no-image terminal fails cleanly (`ok: false`) instead of
  emitting undecodable sequences.

The Konsole path is preserved: Konsole remains "unrecognized" to pi-tui, so
the settings override still applies and native rendering keeps working.

## Acceptance Criteria

- [x] `resolveNativeProtocol` returns `null` for alacritty/vscode/zed/jetbrains/`WT_SESSION` environments even when `terminal.images` or `PI_IMAGE_PROTOCOL` declare a protocol.
- [x] The settings override still applies to unrecognized terminals (Konsole keeps native rendering).
- [x] Positive capability detection remains authoritative over the no-image guard.
- [x] `runNativeRender` refuses known no-image terminals without reading the file.
- [x] `npm run typecheck` and `npm test` pass. (4 new cases in `test/images.test.ts`; 19 suites / 595 cases.)

## Resolution

Added `knownNoImageSupport`, a mirror of pi-tui's negative detection table,
and wired it into both `resolveNativeProtocol` (between the caps step and the
settings/env steps) and the `runNativeRender` direct-call guard. Spec §native
ladder updated. Mirrors pi-tui's table by design — the comment flags the
sync responsibility. The general case (terminals that *advertise* the
protocol but cannot decode a payload, real kitty + JPEG question) is tracked
as #101.

### Follow-up 1 (Linux Alacritty)

The first fix keyed on `TERM_PROGRAM === "alacritty"`, mirroring pi-tui — but
Alacritty sets `TERM_PROGRAM` only on macOS. On Linux it exports
`ALACRITTY_LOG` / `ALACRITTY_WINDOW_ID` / `ALACRITTY_SOCKET` and no
`TERM_PROGRAM`, so the guard (and pi-tui's detection) missed it and a fresh
Alacritty session still went blank via the settings override. Added the three
`ALACRITTY_*` markers to `knownNoImageSupport` (verified from the live
process environment) and pinned them in `test/images.test.ts`.

### Follow-up 2 (pi's host capability overrides — the real root cause)

Even with the markers, a fresh Alacritty session was still blank. The actual
transmission chain: **pi pushes `terminal.images` into pi-tui's capability
overrides at startup** (`pi main.js`: `setCapabilityOverrides(
settingsManager.getTerminalCapabilityOverrides())`), and pi-tui's
`getCapabilities()` merges overrides *after* its own detection. So
`caps.images` reports `"kitty"` in every terminal — Alacritty included — and
the ladder's capability step returned it before the negative guard (placed
after caps) could run. Konsole worked because the override is true there;
tmux worked only because the multiplexer guard precedes the caps step.

Fix: `resolveNativeProtocol` now checks `knownNoImageSupport` **before** the
capability step, so a positively no-image terminal can never receive a
declared protocol from any source (host overrides, settings file,
`PI_IMAGE_PROTOCOL`). Real protocol terminals (kitty, ghostty, wezterm,
iTerm2 …) are never in the negative table, so their detection and explicit
forcing are unaffected.