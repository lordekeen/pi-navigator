# Issue #116: First Image of a Session Renders as Chafa, Later Ones Render Natively

- **Status**: Resolved
- **Type**: Bug / Image Tier
- **Severity**: Medium
- **Components**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) (render seams, abort lifecycle), [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) (support reflow), [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L370-L374) (seam precedence)
- **Found by**: live use (reporter), 2026-09-22; investigated by code reading + an independent debugger pass

## Description

On a kitty-capable terminal with `images.mode: "auto"` and `preferNative: true`, the
**first** image opened in a pi session is reported to render as chafa symbol art,
while images opened later in the same session render natively.

The tier ladder is **not** the cause: for this environment `resolveNativeProtocol`
(`images.ts:803`) returns `"kitty"` deterministically (pi-tui detects
`KITTY_WINDOW_ID`; `~/.pi/agent/settings.json` also declares
`terminal.images: "kitty"`), so `mode: "auto"` + `preferNative: true` resolves
`tier = "native"` on every call to `resolveImageSupport`.

Chafa can therefore only come from the **per-file fallback** in `viewer.ts:370-374`:
the native seam runs first and a *clean* `{ok: false}` falls through to the chafa
seam, which `index.ts` always passes in auto mode (`chafaFallback` ignores the
tier). On that path the native failure reason is **discarded** — it is only shown as
the card's `imageError` when chafa is unavailable. That is what makes this hard to
observe: a native capability problem presents as a silent tier change, not an error.

## Reproduction

1. kitty terminal (or any terminal pi-tui reports as `kitty`), `images.mode: "auto"`,
   pi-chafa + `chafa` installed so the chafa seam is available.
2. Start pi, run `/navigator`, open an image as the first image of the session.
3. Reported: chafa symbol art (`chafa · i card` badge). Later images: native.

**Discriminating experiment (no rebuild needed):** run with `PI_NAV_IMAGES=native`.
That keeps chafa at `state: "deferred"`, so the chafa seam returns
`"chafa is not available"` and no fallback is possible. If the image then renders
natively, the fallback path is implicated; if a metadata card appears, its hint row
names the failing native path; if it still renders chafa, the tier snapshot itself
was non-native.

## Ruled out

- **The tier ladder** — deterministic `native` here (above).
- **The kitty decode probe** — its verdict is memoized per MIME per process
  (`index.ts:96`), so a verdict-based cause would make every later render of that
  format chafa too, not just the first. The samples were also verified genuinely
  decodable (PNG chunk CRCs + zlib valid; PIL loads all three 1×1 payloads).
- **A shared-abort cascade** (the first hypothesis, disproven): reading
  `viewer.ts:370-374` together with the shared `imageAbort` slot
  (`index.ts:447`, `index.ts:473`) suggested an overlapping second load could
  cascade both loads into chafa. It cannot. `runNativeRender` checks
  `signal.aborted` **exactly once, at entry, synchronously** (`images.ts:1005`), and
  the seam assigns the slot and enters the renderer with **no intervening await**
  (`index.ts:472-478`). A later load's abort therefore always lands *after* the
  older render passed its only check: the older render returns `{ok: true}` and is
  discarded by the `loadSeq` guard. `"render aborted"` is unreachable for the native
  seam in production (only a pre-aborted direct call, pinned by
  `test/images.test.ts`); only chafa is abortable mid-flight (`images.ts:697-699`).

  > **Superseded in v0.10.8:** the PNG-conversion round added a second
  > `signal.aborted` check after the read/conversion await (`images.ts:1122`), so the
  > native abort path *is* reachable and a superseded load's chafa fallback can abort
  > the current load's render. Filed as
  > [#117](117-native-abort-cascade-chafa-fallback.md).
- **`renderImage` returning null** — only when `caps.images` is falsy, and pi-tui's
  detection is synchronous and env-based.
- **Image-id collisions** — real transmissions use `a=T,f=100,q=2` and elicit no replies.

## Confirmed defects found while investigating

1. **Stuck metadata card (first-image-specific).** If `resolveSupport` lands while
   the first image load is in flight, `setImageSupport` (`navigator.ts:328-341`)
   finds `viewFile === null` and arms no reflow; the load then completes as a card
   and nothing re-checks it (the 3 s poll never re-resolves support). The user must
   press `i` or `r`. This yields a *card*, not chafa.
2. **Reflow re-entrancy.** `scheduleReflow`'s callback (`navigator.ts:1130-1141`)
   does not check `viewLoading`, so a reflow can fire mid-load and overlap two
   loads. `IMAGE_RESIZE_DEBOUNCE_MS` (250 ms) equals the probe timeout (250 ms).
3. **Shared abort slot.** Both seams abort whatever came before (`index.ts:447`,
   `473`), and `imageAbort` is per invocation. Unreachable for native (above); for
   chafa it kills a child process a newer load may still need.
4. **The native failure reason is dropped on the chafa fallback**, so the fallback
   is undiagnosable from the UI.

## Causes

### Cause 1 — the over-cap sample: the 4 MiB native render cap

The reported image is **over the native render cap**: `IMAGE_NATIVE_MAX_BYTES` is
4 MiB (`constants.ts:120`), and `runNativeRender` refuses anything larger with a
*clean* failure — `"image exceeds the 4 MiB native rendering cap"`
(`images.ts:1065-1066`).

- **`mode: "native"`** — chafa stays `deferred`, so there is no fallback and the
  metadata card renders the reason through `imageCardHints` as
  `"kitty failed: image exceeds the 4 MiB native rendering cap"` — exactly what the
  reporter saw in the native-only run.
- **`mode: "auto"`** — that same clean failure falls through to the chafa seam, so
  the image renders as chafa art and the reason is discarded.

This cause is **deterministic per file size** and is the documented D7 bound — but it
explains only the over-cap sample; see cause 2 for the rest.

### Root cause of the under-cap chafa: the kitty decode probe (confirmed live)

The reporter ran the auto-mode/no-chafa-seam diagnostic above and the card read
**`"terminal cannot decode this image format"`** — the probe path at
`images.ts:1053-1055`, reached only when `consumeKittyProbeReply` returns `"error"`
(i.e. the terminal answered the query with something other than the literal `OK`).

That verdict is memoized **per MIME, per process** (`index.ts:96`), so a single error
reply degrades *every* image of that format for the rest of the pi process — while a
fresh process, whose reply may not arrive within the 250 ms window, keeps native
rendering. That accounts for all three of the reporter's observations: the same
image flipping between sessions, different images behaving differently (different
MIMEs), and the first image of a session appearing to be the affected one.

**Open question: why does a real kitty reply with an error to the probe query?**
The probe sends `a=q,t=d,f=100,i=<id>;<1x1 payload>` (`buildKittyProbeQuery`,
`images.ts:877`), i.e. it mirrors pi-tui's `f=100` tagging for every payload
(`terminal-image.js:157`) rather than kitty's documented raw-pixel detection idiom.
The samples themselves are valid — verified independently: PNG chunk CRCs and zlib
decompress cleanly, and PIL loads all three 1×1 payloads — so the error is about the
*query*, not the data. If kitty rejects `a=q` + `f=100` (or answers with a non-`OK`
query response), then the probe's premise — "an error reply means the terminal
cannot decode images" — is false for the terminal it was written to protect, and a
fully capable kitty is degraded by it.

Candidate fixes, pending the reply text: probe with kitty's documented detection
payload (`f=24,s=1,v=1` + one pixel) instead of a PNG; or make an error verdict
non-permanent (re-probe per render or per overlay invocation) instead of a
process-wide per-MIME latch; or drop the error-degrade entirely and rely on the
#100 env denylist plus a real transmission attempt.

**Reproduce the terminal's raw reply** (in a *separate* kitty tab, never inside the
pi session, so the reply cannot be read as input by the TUI):

```bash
python3 - <<'PY'
import os, tty, termios, select, time, base64
fd = os.open("/dev/tty", os.O_RDWR)
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
    q = f"\x1b_Ga=q,t=d,f=100,i=4242;{base64.b64encode(png).decode()}\x1b\\"
    os.write(fd, q.encode())
    buf, deadline = b"", time.time() + 1.0
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            buf += os.read(fd, 4096)
            if b"\x1b\\" in buf or b"\x07" in buf:
                break
    print("REPLY:", repr(buf))
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
    os.close(fd)
PY
```

`b'\x1b_Gi=4242;OK\x1b\\'` would mean the probe is sound and the error came from
something else; any non-`OK` body confirms the probe misreads a capable terminal.

### How the two causes were separated

The reporter confirmed that **some images below the cap also fell back** to chafa in
auto mode while rendering cleanly under `mode: "native"` — so the cap alone could not
explain the report. The decisive constraint was that **the native render path is
identical in both modes** (same seam, protocol, probe and bounded read), so a clean
native render in one process rules out a native failure in that process; that left
either process-dependent probe state or a chafa-only load (tier `"chafa"`, native
seam never passed — which requires `nativeProtocol === null` or
`preferNative === false` in the snapshot used for that load).

The diagnostic above (`PI_NAV_IMAGES=auto CHAFA_BIN=/nonexistent/chafa`, which leaves
`chafa.state !== "ok"` so `chafaFallback` is false and nothing can mask the failure)
separated them: the card reported the probe path, confirming cause 2.

The earlier "mostly the first image of a session" answer was elicited with an option
set carrying the now-disproven abort-cascade framing, so it must **not** be read as
evidence of a first-load mechanism.

## Acceptance Criteria

- [x] The tier a load renders at is decided from one immutable snapshot, so a mid-load support change cannot make the seams disagree with the loader.
- [x] A clean native failure that falls through to chafa **keeps its reason**, surfaced in the header or card hint. *(v0.10.7 deliberately reversed this: the header suffix was removed as header-error pollution, so the reason now surfaces on the metadata card only — see the Resolution §2.)*
- [x] `setImageSupport` arms the upgrade reflow when an image load is *in flight* (`viewTargetRelPath` is an image), not only when `viewFile` is set.
- [x] A reflow never fires while a load is in flight (`viewLoading`).
- [ ] Abort ownership is per load: one load cannot abort another's render. — **deferred, see below**; became a live defect in v0.10.8 → [#117](117-native-abort-cascade-chafa-fallback.md)
- [x] An error verdict from the kitty decode probe does not permanently degrade every image of that MIME for the whole process.
- [x] The first image of a session renders at the same tier as later ones, verified live.

## Implemented (v0.10.5) — the collateral defects

The four confirmed defects below are fixed and pinned by mutation-proven tests
(20 suites / 674 cases; each fix reverted individually and the matching test
observed failing):

1. **Tier from one immutable snapshot.** New exported
   `makeImageSeams({ support, probeDecode, nextAbortSlot })` (`index.ts`) is built by
   `loadFileCached` from the `const s = imageSupport` captured at load start, so a
   mid-load `setImageSupport` can no longer make a seam disagree with the tier the
   loader chose. Tests pin both snapshot gates and per-render slot ownership.
   *Limit:* the factory's contract is tested; the loader's choice of `s` is a
   one-liner verified by reading, because the `loadFileCached` closure is not
   injectable (the #114 limit).
2. **The native failure reason survives the chafa fallback.** `viewer.ts` keeps it
   on the chafa result, and `buildViewerHeader` shows it as a budgeted, hard-clamped
   dim suffix. Render tests assert width safety with a long reason at
   120×36 / 100×28 / 80×24 / 60 / 50.
3. **The upgrade reflow arms for an in-flight load.** `setImageSupport` now uses
   `viewTargetRelPath ?? viewFile?.relPath`, so support landing while the first image
   load is pending upgrades instead of sticking as a card.
4. **A reflow re-arms rather than firing during a load.** `scheduleReflow`'s callback
   re-arms while `viewLoading`, so a pending load's work is not discarded by a
   `loadSeq` bump.

Deliberately **not** done: per-load abort ownership. The debugger established that
`runNativeRender` observes an abort only once, at entry, synchronously, so the native
abort path is unreachable in production; only chafa children are abortable
mid-flight, and those belong to superseded loads. It has no observable effect today,
so it is left until the probe question is settled.

## Resolution (v0.10.8) — Kitty Non-PNG Conversion via convertToPng & Clean Chafa Fallback

1. **Kitty graphics protocol requires PNG (`f=100`), non-PNG converted via `convertToPng`**:
   The Kitty terminal emulator decodes PNG under `f=100`; transmitting raw JPEG/WebP bytes tagged `f=100` makes Kitty's PNG decoder fail silently (under quiet mode `q=2`), leaving the viewer blank. Instead of gating Kitty to PNG-only files, `runNativeRender` (`images.ts`) converts non-PNG formats (JPEG, WebP, GIF) to PNG before transmission using `convertToPng` from `@earendil-works/pi-coding-agent` (mirroring the host `pi` Image component and `tool-execution.ts` implementation).
   - In `native` and `auto` modes, JPEG, WebP, GIF, and PNG under 4 MiB render natively in Kitty with high resolution.
   - If conversion fails (e.g. unsupported format or corrupt image), `runNativeRender` returns a clean failure (`"could not convert image to PNG for Kitty rendering"`), falling back to Chafa in `auto` mode or displaying the error card in `native` mode.
2. **Clean Chafa rendering on fallback (no header error pollution)**:
   When an image falls back to Chafa (e.g. over-cap 4 MiB images, SVG, or unconvertible files), Chafa renders cleanly with standard `chafa · i card` badges without attaching error suffixes (`imageError`) to the header. Diagnostic failure messages are reserved exclusively for metadata cards when an image cannot be rendered at all.
3. **Protocol-level Kitty probe**:
   The Kitty protocol probe (`buildKittyProbeQuery`) transmits a valid 1×1 PNG sample under `f=100` and is cached per overlay invocation in `index.ts`, verifying that the terminal supports Kitty graphics without failing due to format mismatch.

## Follow-up (2026-09-23)

- [#117](117-native-abort-cascade-chafa-fallback.md) — verification of v0.10.8 found that the
  deferred abort-ownership item above is no longer dormant: the new post-read/post-conversion
  `signal.aborted` check (`images.ts:1122`) makes a superseded load's chafa fallback able to
  abort the newest load's native render. Reproduced deterministically; filed as a pending bug.
