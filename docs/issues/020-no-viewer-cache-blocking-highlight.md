# Issue #020: No Per-File Viewer Cache; Synchronous Highlight Blocks the Main Thread

- **Status**: Open
- **Type**: Bug / Performance
- **Severity**: High
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) / [`loadFile`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L239) / [`highlightText`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L225)

---

## Description

Two related defects:

1. **No per-file cache.** [`loadFile`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L239) re-runs the full pipeline — stat → binary sniff → read → CR-normalize → `expandTabs` → `highlightCode` — on every open. Toggling between two files or re-opening the same file redoes all of it. Nothing is memoized by path/mtime.
2. **Blocking highlight.** [`highlightText`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L225) is synchronous despite the `await`; a file just under the caps (1 MB / 5000 lines, [`constants.ts`](file:///home/jhonny/Sources/pi-navigator/constants.ts)) can stall the TUI event loop for hundreds of milliseconds per open.

## Code References

- [`viewer.ts:239-337` (`loadFile`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L239-L337) — full pipeline, no memoization.
- [`viewer.ts:225-237` (`highlightText`)](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L225-L237) — `highlightCode` called synchronously.
- [`index.ts:170-180`](file:///home/jhonny/Sources/pi-navigator/index.ts#L170-L180) — the open-file mtime poll that can drive cache invalidation.

## Potential Solution

- Add a small `Map<relPath, { mtimeMs, sizeBytes, ViewerFile }>` cache; invalidate on mtime change (the existing poll already stats the open file). This eliminates repeat cost entirely.
- For a fresh highlight of a near-cap file, optionally yield between line chunks (e.g. process in slices with `await` points) so the event loop is not blocked for the whole duration.

## Acceptance Criteria

- [x] Re-opening a file whose mtime is unchanged does not re-run the load/highlight pipeline.
- [ ] A large (near-cap) file open does not freeze the TUI event loop for the full highlight duration. *(deferred — see note)*
- [x] mtime changes are detected and trigger a reload.
- [x] `npm run typecheck` and `npm test` are green (viewer suite included).

## Resolution (partial)

Added a per-file viewer cache in `index.ts` (`viewerCache`, bounded by
`MAX_VIEWER_CACHE_ENTRIES` = 16). `loadFileCached` stats first; on an unchanged
mtime (within ±1ms) it returns the cached `ViewerFile` — re-opening a file or
toggling between two files no longer re-runs stat → sniff → read → normalize →
expandTabs → highlight. Error cards (no `mtimeMs`) are not cached; the oldest
entry is evicted at capacity. mtime changes fall through to a fresh `loadFile`,
producing a new `ViewerFile` reference that invalidates the overlay's render
caches.

### Deferred: event-loop yielding during a fresh highlight

A *fresh* highlight of a near-cap (1 MB / 5000-line) file still runs
synchronously on the main thread, so the first open of such a file can stall
the TUI briefly. The per-file cache (above) makes this a one-time cost per
file per mtime change rather than per open, which addresses the reported
toggle/re-open pain. The remaining one-time first-open freeze is **not safely
fixable from the extension side** under the runtime pi ships in; the deferral
is grounded in a verified blocker, not just the stateful-highlighting concern.

#### The blocker (verified 2026-09-17)

Three approaches were investigated and ruled out:

1. **Per-line chunking with `await` yields (main thread).** Not safely
   implementable: `highlightCode` is a synchronous, stateful tokenizer over the
   whole string (`cli-highlight`'s `highlight()`). Per-chunk calls lose
   cross-line state (multi-line comments, template strings, heredocs) and
   regress correctness. `highlightCode` exposes no state object to thread
   across chunks.

2. **`node:worker_threads` Worker pool (off-main-thread highlight).** Measured
   to work mechanically — a 663 KB / 5000-line TypeScript file highlights in
   ~574 ms in a worker while the main thread's event loop stays responsive
   (156 timer ticks fired during the highlight), producing byte-identical
   output *when the worker imports the same module instance*. But under pi's
   **bundled Node runtime** (`dist/bundle/cli.js`, `PI_BUNDLED_NODE` — how pi
   is installed here), the extension's `import { highlightCode } from
   "@earendil-works/pi-coding-agent"` resolves via jiti `virtualModules` to an
   **in-memory bundled module**, not a disk file. A `Worker` cannot see
   virtualModules; the only `highlightCode` it can import is the **on-disk
   copy** at `node_modules/@earendil-works/pi-coding-agent/dist/.../theme.js` —
   a *different module instance* with its own separate `theme` state, and
   possibly a different pi patch (installed pi is `0.85.1` bundled; the on-disk
   `node_modules` copy floats on `^0.85.1`). Output styled by a different
   highlighter instance/version than the rest of pi is a silent correctness
   regression. A canary (compare a styled sample between main and worker)
guards theme-*name* mismatch but **not module-instance divergence** — two
different copies can style the canary identically yet differ elsewhere.

3. **Portability of the disk path.** `import.meta.resolve(
   "@earendil-works/pi-coding-agent")` **fails** inside the extension under the
   bundled runtime (`PROBE_RESOLVE_FAIL: Cannot find module …`, verified via a
   probe extension). Globbing `node_modules` relative to the extension's own
   location is not portable (breaks for global/workspace/pnpm installs and
   symlinked packages), so there is no reliable way to hand the worker a path
the *same* `highlightCode` instance.

#### What would unblock it

A pi-side API change: either (a) a `highlightCode` reachable from a worker that
is guaranteed instance-stable with the main-thread highlighter (e.g. the
runtime exposes a resolvable file URL for the bundled module, or a
`postHighlight(code, lang)` RPC over `MessagePort` that the host services), or
(b) an incremental/stateful highlighter API (`highlightLines` with a carried
state object) so main-thread chunked highlighting preserves cross-line state.
Either would let this criterion be met without the instance-divergence risk.
Until then, the freeze stays a one-time cost per file per mtime change.
