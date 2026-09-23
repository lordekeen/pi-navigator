# Issue #117: Superseded Load's Chafa Fallback Aborts the Newest Native Image Render

- **Status**: Resolved
- **Type**: Bug / Image Tier
- **Severity**: Medium
- **Components**: [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts#L1119-L1123) (post-read/post-conversion abort check), [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L413) (fallback on any clean native failure), [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L441-L443) (shared abort slot), [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L399-L404) (ungated overlapping loads)
- **Found by**: verification of the #116 fix rounds (v0.10.8), 2026-09-23; deterministic two-load reproduction

## Description

In the #116 reporter's configuration (`images.mode: "auto"`, pi-chafa present, chafa
probe `ok`, kitty-capable terminal), an image can still silently render as chafa even
though native rendering works — the same symptom class #116 is about. This time the
cause is not the tier ladder, the probe, or the PNG conversion, but a **newly reachable
abort path** interacting with the shared abort slot that #116 deferred:

1. v0.10.8 added a second `signal.aborted` check after the read / PNG-conversion awaits
   (`images.ts:1122`, the entry check remains at `images.ts:1040`) so a superseded
   conversion can bail.
2. `viewer.ts:413` treats **every** clean native failure — including
   `{ ok: false, reason: "render aborted" }` — as a fall-through to the chafa seam.
3. The chafa seam calls `nextAbortSlot()` (`index.ts:172`), and `nextAbortSlot` aborts
   whatever controller is currently in the shared `imageAbort` slot
   (`index.ts:441-443`) before installing its own.
4. `openRelPath` has no `viewLoading` gate (`navigator.ts:399-404`): every cursor move
   starts a new load immediately, and `loadSeq` only discards stale *results* — it does
   nothing about these side effects.

Sequence with two overlapping loads (A starts, B supersedes it):

- B's native seam aborts A's controller (`index.ts:191` → `441-443`), then awaits.
- A resumes, sees the abort, returns `"render aborted"` — and falls through to the
  chafa seam, which aborts **B's** controller.
- B resumes, sees the abort, returns `"render aborted"` — and falls through to its own
  chafa render.
- A's result is discarded by `loadSeq`; **B is the load whose result is displayed, and
  it now renders as chafa** despite kitty native being available.

The invalid premise is #116's own "Ruled out" paragraph: *"`render aborted` is
unreachable for the native seam in production"* — true while the entry check was the
only one, false since v0.10.8.

## Reproduction

Deterministic, using the real `makeImageSeams` and the real `runNativeRender`
(the throwaway test that found this was run at `c518371` v0.10.8 and deleted
afterwards; restore it as a regression test when fixing):

```ts
const seamsA = makeImageSeams({ support: snapshot(), probeDecode: () => gateA, nextAbortSlot });
const seamsB = makeImageSeams({ support: snapshot(), probeDecode: () => gateB, nextAbortSlot });

const loadA = seamsA.renderNativeImage(png, req); // captures slot A, awaits gateA
const loadB = seamsB.renderNativeImage(png, req); // aborts A, captures slot B, awaits gateB

releaseA("no-reply");
await loadA;                       // { ok: false, reason: "render aborted" }   — by design
void seamsA.renderImage(png, req); // viewer.ts fallback → aborts B

releaseB("no-reply");
await loadB;                       // { ok: false, reason: "render aborted" }   ← BUG
```

`support` is an auto-mode kitty snapshot (tier `native`, `chafa.state === "ok"`), `png`
a real 1×1 PNG on disk, and `nextAbortSlot` mirrors `index.ts:441-443`. The two probe
gates make the interleaving deterministic; production shares one memoized probe promise,
which changes the timing but not the mechanism (the older load's continuation resumes
first and its fallback aborts the newer slot before the newer load's check runs).

**Counterfactual:** removing only the `images.ts:1122` hunk makes `loadA` resolve
`{ ok: true, …native rows }` — the fallback never runs and `loadB` renders natively.
So the added check is the active ingredient; the shared slot and the unconditional
fallback are what turn it into a user-visible downgrade.

## Impact

- Requires `mode: "auto"` with a usable chafa (otherwise the fallback seam is absent)
  and two overlapping image loads — e.g. holding `j`/arrows across an image directory,
  which `openRelPath` does not serialize.
- The displayed image renders as chafa art with no error card and no hint; the user sees
  a silent tier change, exactly the class #116 set out to eliminate.
- Superseded renders may also be aborted pointlessly (wasted work, not user-visible).

## Relationship to #116

- Implements nothing new; it is the deferred acceptance item *"Abort ownership is per
  load: one load cannot abort another's render"* becoming a live defect.
- The #116 doc's "Ruled out / A shared-abort cascade" reasoning must not be reused as
  evidence: its premise (entry-only abort check) died in v0.10.8.

## Candidate Fixes

1. **Smallest (recommended first):** in `viewer.ts`, treat a native `"render aborted"`
   as a supersession, not a render failure — do not fall through to the chafa seam.
   The result is discarded by `loadSeq` anyway when stale, and a current load can only
   be aborted by a superseded load's fallback (the bug), so there is nothing to salvage.
2. **Structural:** implement per-load abort ownership (the #116 deferred item): each
   load's seams own their controller, and a superseded load's fallback must not abort a
   render it does not own. Removes the whole class, not just this path.
3. **Revert:** drop the v0.10.8 post-read/post-conversion abort check (`images.ts:1122`)
   and restore the rev. 2 premise that the native abort path is unreachable; loses prompt
   cancellation of superseded conversions, which the `loadSeq` guard makes cosmetic.

## Acceptance Criteria

- [x] A superseded load's fallback can never abort the load that superseded it — pinned
      by a deterministic two-load test (real `makeImageSeams` + real `runNativeRender`).
- [x] With `mode: "auto"` on a kitty-capable terminal, overlapping image loads leave the
      displayed image native (no chafa fallback caused by an abort from another load).
- [x] Abort still lands promptly on overlay close and on genuine supersession (no
      regression to cancellation semantics) — neither seam's abort handling changed; the
      existing abort tests stay green.
- [x] #116's "abort ownership is per load" item is either implemented or its consequence
      is closed here — consequence closed; the item itself stays deferred in #116.

## Evidence (2026-09-23, `c518371` v0.10.8)

- `npm run typecheck` clean; `npm test` 20 suites / 670 cases green.
- Throwaway two-load test: **passed** against the current code (i.e. the bug
  reproduces deterministically); with the `images.ts:1122` hunk removed, `loadA`
  resolves `{ ok: true }` and the cascade does not occur.
- Working tree was restored byte-identical after the probe (`git status` clean).

## Resolution (v0.10.9) — an aborted native render is a supersession signal

`viewer.ts` no longer falls through to the chafa seam when the native render
returned `render aborted`. `images.ts` exports `IMAGE_ABORT_REASON` as the single
source for that string (both seams already produced it), and `loadFile` compares
the native failure reason against it before invoking the chafa seam. A superseded
load therefore never calls `nextAbortSlot()` again, so it cannot abort the render
of the load that superseded it; its stale metadata card is discarded by
navigator's `loadSeq` guard. The post-read/post-conversion abort check (now
`images.ts:1118`) is kept: it only skips work for a superseded load.

Candidate fix 1 (this) was taken. Candidate 2 (per-load abort ownership) and
candidate 3 (dropping the abort check) were not: the ownership model is unchanged,
and #116's "abort ownership is per load" acceptance item stays deferred there —
only its user-visible consequence is closed.

Tests (+2, each verified to fail with the fix disabled):

- `test/viewer.test.ts` — a native `render aborted` failure never invokes the chafa
  seam; the result is the metadata card carrying the abort reason.
- `test/index.test.ts` — the deterministic two-load cascade with real
  `makeImageSeams` + real `runNativeRender`: load B supersedes A, A's abort resolves
  to a card, and B still renders `native`.

Cleanup in the same change: the dead `KITTY_PROBE_SAMPLES` table (Issue #102
leftover, kept alive only by its own tests) is removed; `nativelyRenderable` drops
its unused protocol parameter; the stale mime-gate comment is corrected.

Gates: `npm run typecheck` clean; 20 suites / 670 cases green. version 0.10.9.
