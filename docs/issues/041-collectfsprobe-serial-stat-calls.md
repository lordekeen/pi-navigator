# Issue #041: `collectFsProbe` Serializes Stat Calls

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: Low
- **Component**: [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts) · [`collectFsProbe`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L124-L135)

---

## Description

`collectFsProbe` `stat`s each expanded directory sequentially:

```typescript
for (const relDir of ["", ...dirs]) {
  try {
    const info = await stat(join(cwd, relDir));  // serialized
    parts.push(`${relDir}:${Math.floor(info.mtimeMs)}`);
  } catch {
    parts.push(`${relDir}:missing`);
  }
}
```

With many expanded directories, this serializes N filesystem round-trips per poll tick. Since the stats are independent, they can run concurrently.

This is a mild version of #023 (serial DFS filesystem walk), which was already resolved with `Promise.all` fan-out.

## Code References

- [`tree.ts:124-135`](file:///home/jhonny/Sources/pi-navigator/tree.ts#L124-L135) — sequential stat loop

## Potential Solution

```typescript
export async function collectFsProbe(cwd: string, dirs: Set<string>): Promise<string> {
  const entries = ["", ...dirs];
  const results = await Promise.all(
    entries.map(async (relDir) => {
      try {
        const info = await stat(join(cwd, relDir));
        return `${relDir}:${Math.floor(info.mtimeMs)}`;
      } catch {
        return `${relDir}:missing`;
      }
    }),
  );
  return results.join("|");
}
```

## Acceptance Criteria

- [x] All directory stats in `collectFsProbe` are issued concurrently.
- [x] The probe string format and ordering are unchanged.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Converted the sequential `for...of` loop in `collectFsProbe` to `Promise.all(entries.map(...))` preserving order and format while issuing stats concurrently.
