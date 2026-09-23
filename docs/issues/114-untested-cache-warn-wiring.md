# Issue #114: #109/#112/#108 Fixes Are Pinned Only at Helper Level; the Wiring Is Untested

- **Status**: Resolved
- **Type**: Technical Debt / Test Coverage
- **Severity**: Medium
- **Components**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) (`loadFileCached`, tree-collection block), `test/index.test.ts`
- **Found by**: two-axis code review of `e2d8042...HEAD` (Spec axis), 2026-09-22

## Description

Three fixes in the #102–#112 batch assert behaviour that the test suite cannot
reach, because the policy lives inline in closures that no test can drive:

1. **#109 (LRU).** `touchCacheEntry` is exported and unit-tested in isolation, but
   its only call site — `touchCacheEntry(viewerCache, relPath)` in
   `loadFileCached` — is not. Deleting that line leaves the entire suite green, so
   "the cache is LRU" is asserted only about a helper, not about the cache.
2. **#112 (kitty exclusion).** `isCacheableRender` is unit-tested, but the wiring
   is not: `const cacheable = isCacheableRender(...)`,
   `const cached = cacheable ? viewerCache.get(relPath) : undefined`, the
   mtime/variant hit test, and the store gate with its native over-cap carve-out.
   The navigator roundtrip test bypasses `viewerCache` entirely, so *neither*
   cache site is exercised by any test — the exact gap that let #112 ship green
   in the first place.
3. **#108 (walk-cap warning).** The three identical
   `if (x.truncated) notifyWarning(...)` blocks in the tree-collection path are
   untested, as is the fact that the git-mode walks draw from one shared budget.

## Root Cause

`loadFileCached` and the tree-collection block are closures created per command
invocation. They close over `viewerCache`, `imageSupport`, `cwd` and
`ctx.ui`, and nothing is injectable, so the only testable surface is the set of
free helpers exported beside them. The helpers were tested; the wiring was not.

## Potential Solution

Extract each policy into an exported unit that owns both the decision and the
effect, then have the call sites delegate:

- `createViewerCache(maxEntries)` — `lookup` (cacheable gate, ±1 ms mtime
  tolerance, variant match, LRU recency refresh on a genuine hit), `store`
  (retention rule including the native over-cap carve-out, capacity eviction),
  `drop`, `size`.
- `makeTreeTruncationWarner(notify)` — a one-shot latch that emits the
  truncation warning at most once per invocation, with the message text owned in
  one place.

## Acceptance Criteria

- [x] Removing the recency refresh, the `cacheable` gate, the over-cap carve-out, the capacity eviction, or the one-shot warning makes a test fail.
- [x] A native kitty render is provably never served from nor stored in the viewer cache.
- [x] LRU order is asserted through the cache's own surface (A, B, touch A, store C ⇒ B evicted).
- [x] The three walk sites share one warning and cannot emit it twice.
- [x] No `as any` casts into private state (Issue #098 precedent).

## Resolution

Two exported units now own the policies, and the call sites are thin delegation:

- `createViewerCache(maxEntries)` in `index.ts` owns lookup/store/drop/size;
  `loadFileCached` calls `viewerCache.lookup(relPath, { cacheable, mtimeMs, variant })`
  and `viewerCache.store(relPath, { cacheable, variant, file })`, and the
  stat-failure path calls `viewerCache.drop(relPath)`. One deliberate
  improvement, noted in the code: the capacity check is now gated on
  `!entries.has(relPath)`, so re-storing an existing key no longer evicts an
  unrelated LRU entry.
- `makeTreeTruncationWarner(notify)` owns the one-shot warning; the three
  duplicated blocks collapsed to one `noteTruncation(x.truncated)` call each,
  keeping the current timing (the warning still fires as soon as a walk reports
  truncation, not deferred to the end).

Tests drive the units through their public surface (native-kitty exclusion,
recency-refresh eviction order, mtime/variant misses and the ±1 ms tolerance,
error-card and over-cap non-retention, and the warner's latch), each verified to
fail when the corresponding fix is reverted.

**Honest limit:** the call sites themselves remain inspection-verified — a test
asserts that *a* budget flag produces exactly one warning, not that each of the
three walk sites passes its own flag. The one-line delegations are the smallest
remaining surface that could be wrong.
