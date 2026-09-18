# Issue #040: Mtime Race Condition in `refreshData` Polling

- **Status**: Resolved
- **Type**: Enhancement / Robustness
- **Severity**: Low
- **Component**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) · [`refreshData`](file:///home/jhonny/Sources/pi-navigator/index.ts#L186-L296)

---

## Description

Between `stat(join(cwd, openRel))` and `overlay.setDiskChanged(changed)` (lines 263–273), the user could navigate to a different file. The `stat` result for the old file would then be applied to the new file's `diskChanged` flag, potentially showing a spurious "file changed on disk" notice.

```typescript
const openRel = overlay.getOpenRelPath();        // captures current path
// ...
const info = await stat(join(cwd, openRel));     // context switch here
const known = overlay.getOpenMtime();
const changed = known !== undefined && Math.abs(info.mtimeMs - known) > 1;
overlay.setDiskChanged(changed);                 // openRel might no longer be active
```

The window is narrow (a single `stat` call) and the effect is cosmetic (a false "changed" notice), but it is trivially fixable.

## Code References

- [`index.ts:257-274`](file:///home/jhonny/Sources/pi-navigator/index.ts#L257-L274) — mtime check block

## Potential Solution

Re-check `overlay.getOpenRelPath() === openRel` after the `await stat()` before committing:

```typescript
if (overlay.getOpenRelPath() !== openRel) continue;  // file changed during stat
```

## Acceptance Criteria

- [x] `setDiskChanged` is only called if the open file hasn't changed since the `stat` call.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Added `overlay.getOpenRelPath() === openRel` guard after the `await stat()` call in `refreshData` before invoking `setDiskChanged`.
