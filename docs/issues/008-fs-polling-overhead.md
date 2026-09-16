# Issue #008: Periodic 3-Second Polling May Cause Overhead in Large Repositories

- **Status**: Resolved (Phase 1 Implemented)
- **Type**: Enhancement / Performance
- **Severity**: Low
- **Component**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) / [`runNavigator`](file:///home/jhonny/Sources/pi-navigator/index.ts#L44-L206)

---

## Description

While the navigator overlay is open, [`index.ts:188-190`](file:///home/jhonny/Sources/pi-navigator/index.ts#L188-L190) runs a polling loop every 3 seconds:

```typescript
interval = setInterval(() => {
  void refreshData().then(scheduleRender);
}, REFRESH_INTERVAL_MS);
```

On every tick, `refreshData`:
1. Executes `detectRepo(cwd)` (`git rev-parse --show-toplevel` and `--show-prefix`).
2. Executes `readGitState(cwd)` (`git branch`, `git status --porcelain=v1 -z`, `git log`).
3. Computes the change probe (`gitTreeProbe` or directory modification stats).
4. Checks the open file's `mtimeMs` via `stat`.

While cheap probes prevent rebuilding the full tree when nothing changes, spawning multiple Git subprocesses every 3 seconds can introduce noticeable CPU overhead and battery drain in large mono-repositories or on resource-constrained devices.

---

## Code References

- [`constants.ts:16`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L16):
  ```typescript
  export const REFRESH_INTERVAL_MS = 3000;
  ```
- [`index.ts:101-185`](file:///home/jhonny/Sources/pi-navigator/index.ts#L101-L185) (`refreshData`)
- [`index.ts:188-190`](file:///home/jhonny/Sources/pi-navigator/index.ts#L188-L190)

---

## Potential Solution

### Phase 1: Dynamic Interval or Exponential Backoff
- Increase the idle polling interval (e.g. from 3s to 5s or 10s) when no user interactions or changes have occurred for an extended window.
- Immediately poll upon user input or window focus.

### Phase 2: File System Watcher Integration
- Use `node:fs`'s `watch` API (with recursive option where supported) to listen for filesystem change events.
- Debounce events to trigger `refreshData()` reactively rather than running constant periodic checks.
- Maintain manual refresh (`r`) as an on-demand fallback.

---

## Acceptance Criteria

- [x] Subprocess execution count while idle is reduced without compromising change detection latency.
- [x] Manual refresh (`r`) continues to provide instant state synchronization.
- [x] No file handle leaks on overlay disposal.
