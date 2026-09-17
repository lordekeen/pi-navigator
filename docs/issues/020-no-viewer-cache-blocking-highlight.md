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
the TUI briefly. Chunking `highlightCode` with `await` yields between slices is
**not safely implementable**: syntax highlighting is stateful across lines
(multi-line comments, template strings, heredocs), so per-chunk highlighting
would lose that state and regress correctness. The cache makes this a one-time
cost per file per mtime change rather than per open, which addresses the
reported toggle/re-open pain. If a future `highlightCode` API supports
incremental/stateful highlighting, this criterion can be revisited.
