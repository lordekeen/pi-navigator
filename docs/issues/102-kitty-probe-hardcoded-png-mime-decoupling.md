# Issue #102: Kitty Decode Probe Query Always Emits PNG (`f=100`) Despite MIME-Keyed Cache

- **Status**: Resolved
- **Type**: Bug / Logic
- **Severity**: Medium
- **Component**: [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts#L855-L863), [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L93-L135)

## Description

Issue #101 introduced an `a=q` query probe to verify that a terminal can decode native image payloads before rendering them, aimed particularly at terminals that declare Kitty support but whose decoders reject payloads (e.g. strict decoders receiving JPEG or WebP bytes tagged `f=100`, as relaxed in #071).

However, the probe query implementation is disconnected from the MIME argument passed to it:

1. [`buildKittyProbeQuery(id)`](file:///home/jhonny/Sources/pi-navigator/images.ts#L860) hardcodes format `f=100` (PNG) and the sample 1×1 PNG payload [`KITTY_PROBE_PNG_BASE64`](file:///home/jhonny/Sources/pi-navigator/images.ts#L856):
   ```typescript
   export function buildKittyProbeQuery(id: number): string {
     return `\x1b_Ga=q,t=d,f=100,i=${id};${KITTY_PROBE_PNG_BASE64}\x1b\\`;
   }
   ```
2. In [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L98), [`makeTuiKittyDecodeProbe`](file:///home/jhonny/Sources/pi-navigator/index.ts#L93) accepts `(mime: string)` and memoizes results per MIME in `kittyProbeCache`.
3. When [`runNativeRender`](file:///home/jhonny/Sources/pi-navigator/images.ts#L1030) renders a JPEG or WebP image, it calls `ctx.probeDecode("image/jpeg")` or `ctx.probeDecode("image/webp")`.
4. `makeTuiKittyDecodeProbe` invokes `buildKittyProbeQuery(id)`, which transmits the PNG test image (`f=100`) to the terminal.
5. If the terminal supports PNG, it replies `OK`.
6. The probe resolves `"ok"` and stores this verdict under the `"image/jpeg"` key in `kittyProbeCache`.
7. `runNativeRender` then proceeds to transmit the real JPEG bytes, which may fail silently or blank out on terminals that cannot decode JPEG tagged `f=100`.
8. In addition, when opening images of different MIME types (e.g., PNG, then JPEG, then WebP), `index.ts` triggers redundant queries transmitting the exact same PNG query each time because each MIME type has its own cache entry.

## Acceptance Criteria

- [x] Per-format testing (option b): valid 1×1 sample payloads for `image/png`, `image/jpeg`, and `image/webp`, each transmitted with `f=100` — matching pi-tui's `encodeKitty`, which tags every payload `f=100`. The PNG-stand-in path is gone.
- [x] Ensure non-PNG files do not falsely pass format-specific checks by echoing PNG test replies. (`buildKittyProbeQuery` returns `null` for a mime with no sample; the probe resolves `"no-reply"` and transmits nothing.)
- [x] Tests in `test/images.test.ts` and `test/index.test.ts` verify the updated probe semantics.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

Option (b) — per-format testing — was chosen, because pi-tui's `encodeKitty`
tags **every** payload `f=100` (`dist/terminal-image.js`), so the probe must
reproduce that exact transmission rather than invent format codes.

- `images.ts`: `KITTY_PROBE_PNG_BASE64` → `KITTY_PROBE_SAMPLES` (1×1 PNG/JPEG/
  WebP, each verified with pi-tui `getImageDimensions`); `buildKittyProbeQuery(id, mime)`
  returns `string | null` — a mime with no sample writes nothing (no PNG
  stand-in fallback).
- `index.ts`: the probe passes the mime through and memoizes per mime (now
  meaningful); a null query resolves `"no-reply"` without writing or
  subscribing (unreachable in production — the kitty mime gate admits only the
  three sampled formats).
- Tests pin the regression directly (`not.toContain(PNG sample)` for JPEG/WebP),
  assert every sample decodes 1×1 **only** for its own mime, and restore the
  timeout/unsubscribe coverage the rework initially displaced via an injectable
  probe cache (test seam only; production default unchanged).
