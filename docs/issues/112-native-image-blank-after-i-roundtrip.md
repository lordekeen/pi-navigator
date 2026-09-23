# Issue #112: `i` Roundtrip Leaves a Native Image Blank (Reused Kitty Image Id Skips Re-transmission)

- **Status**: Resolved
- **Type**: Bug / Rendering
- **Severity**: Medium
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L928-L955), [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L207-L232)

## Description

With the native (kitty) tier active, cycling an image through render ⇄ metadata
card with `i` leaves the viewer blank on the return trip: neither the image nor
the card is drawn, and selecting another image and coming back does not restore
it. Reproduced empirically by the user on a kitty-protocol terminal.

Only the **native** tier is affected. A chafa render re-emits plain text rows,
and an iTerm2 render inlines its whole payload, so both always redraw.

## Root Cause

Three cooperating halves — one ours in the component, one ours in the cache,
one in pi-tui's alt-screen layer:

1. **`navigator.ts`** — the `i` handler toggled `imageAsCard` in place whenever
   `imageLines.length > 0`, so un-carding a native image **re-emitted the stored
   escape rows verbatim** (no re-render, no reload).
2. **`index.ts`** — `viewerCache` served the native `ViewerFile` for any
   unchanged mtime + variant, so a reopen, a `r` reload or a support reflow
   also re-emitted the same stored rows.
3. **pi-tui** (`tui-alt-screen.js`) — `prepareKittyScreen` keeps an
   `uploadedKittyImages` map keyed by image id with the
   `transmissionGeneration` assigned when `renderImage` registered that id. When
   a frame's image line has the **same id and generation** as its cache entry,
   it rewrites the row to a **placement-only** command
   (`\x1b_Ga=p,q=2,i=…`) instead of re-transmitting the payload, and the same
   frame emits `deleteAllKittyPlacements()` (`d=a`) because an image row
   changed. So the frame drops every placement and then re-places one whose
   data the terminal is assumed to still hold.

Our code made that assumption mandatory: because the image id is baked into the
rows at render time and we reused the rows, every re-display took the
placement-only path. On a terminal that has dropped the image data across the
hidden period nothing is drawn — and it stays that way, because re-emitting the
same id keeps taking the same path. (pi-tui's own WezTerm workaround in the same
function shows the assumption is terminal-dependent.)

The pre-existing test `toggles between the native render and the card with i
without reloading` **pinned the bug as intended behavior** (`expect(loads)
.toHaveLength(1)`), which is why the suite stayed green.

## Proposed Fix

Never reuse a native render's rows across a visibility cycle; give each
display a fresh kitty image id, which forces a full `a=T` transmission:

1. `navigator.ts`: un-carding a **native** image re-renders
   (`openRelPath(relPath, true)`); a chafa render keeps the cheap flag flip.
2. `index.ts`: kitty native renders are never retained in `viewerCache`
   (`isCacheableRender`), so reopen/reload/reflow re-render too. iTerm2 native
   renders stay cacheable (inline payload, no id state) and keep the D7 byte
   bound.

Deliberately **not** done: rewriting the `i=` control inside the stored line
(that would be protocol code of our own, which the native tier exists to avoid)
and emitting a `d=I` delete for the superseded id (pi-tui already bounds
offscreen images to 16 / 32 MiB and frees evicted ids with `d=I`).

## Acceptance Criteria

- [x] `i` on a native render hides it with no reload; `i` again re-renders with a fresh image id.
- [x] A chafa roundtrip stays reload-free.
- [x] Kitty native renders are not served from the viewer cache; iTerm2 ones are.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

`isCacheableRender(useNative, protocol)` (`index.ts`, exported pure seam next to
`touchCacheEntry`) is consulted at both cache sites in `loadFileCached` — a
kitty native render is neither served nor stored. The `i` handler splits the
hide (pure flag flip, any tier) from the show: chafa flips back in place,
native and metadata cards go through `openRelPath`, which re-renders with a
fresh id.

Tests: the native roundtrip test now asserts a fresh id (`i=101` → `i=102`) and
two loads; a new chafa roundtrip test pins the reload-free path; three
`isCacheableRender` cases pin the policy. Suite: 19 files / 647 cases (was 643).
Spec amended (`native-image-rendering.md` §7.4, §7.5, D7b).

Live verification is the user's: the failure needs a kitty-protocol terminal
that drops image data across the hidden period. Prediction for the diagnosis —
a *small* native image blanks on both the `i` roundtrip and a reopen, while an
image over `IMAGE_NATIVE_CACHE_MAX_CHARS` (never cached before this fix)
blanked on the roundtrip only.
