# Issue #074: Fixed `.tmp` Filename in `writeNavigatorSettings` Creates Concurrency Race and File Leak

- **Status**: Open
- **Type**: Bug / Reliability
- **Severity**: High
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L417-L423)

---

## Description

In [`settings.ts` L417-423](file:///home/jhonny/Sources/pi-navigator/settings.ts#L417-L423), [`writeNavigatorSettings`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L417) writes settings using a static temporary file path:

```typescript
export function writeNavigatorSettings(path: string, settings: NavigatorSettings): void {
  const dir = dirname(path);
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(serializeNavigatorSettings(settings), null, 2), "utf8");
  renameSync(tmp, path);
}
```

This presents two reliability issues:
1. **Concurrency collision**: If two pi agent sessions or processes attempt to update settings concurrently, both write to `${path}.tmp` simultaneously. Their writes can interleave, corrupting the temporary file before one overwrites the other via `renameSync`.
2. **Orphaned temporary files**: If `renameSync` fails (e.g. permission error, cross-device link, or lock), the `${path}.tmp` file is never cleaned up and remains orphaned on disk.

## Root Cause Analysis

Static `.tmp` filename instead of a unique process/timestamp/random suffix, and lack of try/finally cleanup on write or rename failures.

## Potential Solution

Generate a unique temporary filename and clean it up in a `finally` block if the rename did not succeed:

```typescript
export function writeNavigatorSettings(path: string, settings: NavigatorSettings): void {
  const dir = dirname(path);
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  let renamed = false;
  try {
    writeFileSync(tmp, JSON.stringify(serializeNavigatorSettings(settings), null, 2), "utf8");
    renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore cleanup error
      }
    }
  }
}
```

## Acceptance Criteria

- [ ] Temporary file path uses a unique per-write suffix to avoid collisions across processes.
- [ ] Temporary file is deleted if write or rename fails.
- [ ] Atomic replacement of the target file via `renameSync` remains intact.
- [ ] Tests in [`test/settings.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings.test.ts) pass.
