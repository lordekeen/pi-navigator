# Issue #109: `viewerCache` Uses Insertion-Order FIFO Eviction Instead of True LRU

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: Low
- **Component**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L373-L399)

## Description

In [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L285), the per-file highlighted viewer cache bounds its size to [`MAX_VIEWER_CACHE_ENTRIES = 16`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L33) using a JavaScript `Map`:

```typescript
const cached = viewerCache.get(relPath);
if (cached && Math.abs(cached.mtimeMs - mtimeMs) <= 1 && cached.variant === variant) {
  return cached.file;
}
...
if (file.mtimeMs !== undefined && !nativeOverCap) {
  if (viewerCache.size >= MAX_VIEWER_CACHE_ENTRIES) {
    const oldest = viewerCache.keys().next();
    if (!oldest.done) viewerCache.delete(oldest.value);
  }
  viewerCache.set(relPath, { mtimeMs: file.mtimeMs, variant, file });
}
```

In JavaScript `Map`, iteration order reflects insertion order. Because cache hits simply return `cached.file` without updating key recency (deleting and re-inserting the key), the cache evicts the oldest *inserted* item rather than the *least recently accessed* item (FIFO instead of LRU).

If a user frequently references a core file (such as `README.md`), but opens 16 other files in the session, `README.md` will be evicted despite being the most frequently and recently used file.

## Proposed Fix

Re-insert the key on cache hits to keep it at the end of the `Map`'s iteration order:
```typescript
if (cached && Math.abs(cached.mtimeMs - mtimeMs) <= 1 && cached.variant === variant) {
  viewerCache.delete(relPath);
  viewerCache.set(relPath, cached);
  return cached.file;
}
```

## Acceptance Criteria

- [x] Cache hits refresh the entry's recency in `viewerCache`.
- [x] Eviction continues to evict the least recently used file when the cache reaches capacity.
- [x] Unit tests in `test/viewer.test.ts` or `test/index.test.ts` verify LRU access ordering.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

A genuine cache hit now calls the exported `touchCacheEntry(viewerCache, relPath)`
(delete + re-set), moving the key to the Map's insertion tail, so the existing
"first key" eviction site evicts the least recently **used** entry instead of the
least recently inserted. The eviction code itself is unchanged (and now commented
with the invariant).

The helper is exported because `loadFileCached` lives inside the `runNavigator`
closure with no test seam; `test/index.test.ts` pins the ordering semantics
(touch A in a 3-entry map → iteration order B, C, A; the next capacity insert
evicts B; absent keys are a no-op).
