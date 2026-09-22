# Issue #071: Kitty Native Image Mime Gate Restricts to PNG Only, Bypassing Native JPEG/WebP Support

- **Status**: Resolved
- **Type**: Enhancement
- **Severity**: Medium
- **Component**: [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts#L861-L863), [`constants.ts`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L125-L131)

---

## Description

In [`images.ts` L861-863](file:///home/jhonny/Sources/pi-navigator/images.ts#L861-L863), native image rendering under the Kitty graphics protocol is artificially gated to PNG files only:

```typescript
if (ctx.protocol === "kitty" && mime !== "image/png") {
  return { ok: false, reason: bounded("kitty requires PNG") };
}
```

When viewing a `.jpg` or `.jpeg` file in `auto` mode on a Kitty-capable terminal:
1. [`resolveImageSupport`](file:///home/jhonny/Sources/pi-navigator/images.ts#L1012) chooses `tier = "native"`.
2. [`runNativeRender`](file:///home/jhonny/Sources/pi-navigator/images.ts#L840) hits the MIME gate and returns `{ ok: false, reason: "kitty requires PNG" }`.
3. In `auto` mode, this causes JPEG files to degrade to symbol-based Chafa rendering instead of native image display. In `native` mode, it degrades to a metadata card.

Meanwhile, the host pi application renders JPEGs natively using Kitty because modern Kitty terminals auto-detect image formats (JPEG, WebP, GIF) from data headers even when transmitted with the Kitty graphics protocol, and pi-tui's `getImageDimensions` natively supports JPEG parsing ([`terminal-image.js` L364-399](file:///home/jhonny/Sources/pi-navigator/node_modules/@earendil-works/pi-tui/dist/terminal-image.js#L364-L399)).

Furthermore, [`constants.ts` L125-131](file:///home/jhonny/Sources/pi-navigator/constants.ts#L125-L131) already declares JPEG, GIF, and WebP in [`NATIVE_IMAGE_MIME`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L125-L131), but the runtime gate in `images.ts` prevents them from ever reaching the encoder.

## Root Cause Analysis

The implementation followed the formal Kitty graphics protocol specification conservatively (which originally specified PNG payload transmission), whereas the Kitty terminal implementation itself and pi-tui support raw JPEG/WebP streams.

## Potential Solution

1. Evaluate whether to relax the Kitty MIME check to allow formats supported by pi-tui (`image/jpeg`, `image/png`, `image/webp`).
2. Alternatively, make the strict PNG check configurable or test for terminal support before rejecting.
3. Update unit tests in [`test/images.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/images.test.ts) to verify native rendering of JPEG fixtures under Kitty protocol.

## Acceptance Criteria

- [x] Decision made and documented on whether to align with pi-tui's broader format support or remain strictly PNG-spec-compliant.
- [x] If relaxed, JPEG and WebP files render natively without falling back to Chafa in Kitty terminals.
- [x] Width-safety and dimension extraction verified for non-PNG formats.
- [x] Tests in [`test/images.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/images.test.ts) pass.

## Resolution

Expanded the Kitty MIME gate in `constants.ts` and `images.ts` to accept `image/png`, `image/jpeg`, and `image/webp`. Updated `runNativeRender` and `imageCardHints` to recognize supported Kitty image formats and provide accurate format hints on fallback cards. Verified with automated test cases in `test/images.test.ts`.
