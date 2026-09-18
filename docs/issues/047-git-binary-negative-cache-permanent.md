# Issue #047: `gitBinaryPresent` Negative Cache Is Permanent for Non-ENOENT Failures

- **Status**: Resolved
- **Type**: Enhancement / Robustness
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) · [`isGitAvailable`](file:///home/jhonny/Sources/pi-navigator/git.ts#L78-L83)

---

## Description

`isGitAvailable` caches the result of `git --version`. If the initial check fails for any reason other than `ENOENT` (e.g., timeout, permissions error), `gitBinaryPresent` caches `false` permanently:

```typescript
if (gitBinaryPresent !== null) return gitBinaryPresent;  // line 79
const result = await runGit(cwd, ["--version"]);
gitBinaryPresent = result.status === "ok";               // caches false on timeout
```

The `ENOENT` recovery path in `runGit` (line 63: `gitBinaryPresent = null`) only fires on a spawn-level `ENOENT`. But `isGitAvailable` returns early from the cached `false` before `runGit` ever executes again, so the recovery is unreachable.

This continues the pattern noted in #007 (resolved by export, then #021 removed the export, then #027 removed the dead export). The underlying cache-invalidation gap remains.

## Code References

- [`git.ts:78-83`](file:///home/jhonny/Sources/pi-navigator/git.ts#L78-L83) — `isGitAvailable` caching
- [`git.ts:62-64`](file:///home/jhonny/Sources/pi-navigator/git.ts#L62-L64) — ENOENT recovery (unreachable when cached false)

## Potential Solution

Only cache positive results, or add a TTL:

```typescript
export async function isGitAvailable(cwd: string): Promise<boolean> {
  if (gitBinaryPresent === true) return true;  // only cache success
  const result = await runGit(cwd, ["--version"]);
  gitBinaryPresent = result.status === "ok" ? true : null;
  return gitBinaryPresent === true;
}
```

## Acceptance Criteria

- [x] A transient `git --version` failure (timeout, permission) does not permanently disable git.
- [x] A genuine missing binary still caches correctly (no unnecessary retries every tick).
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Introduced `{ status: "missing" }` in `runGit` when spawn catches `ENOENT`. In `isGitAvailable`, genuine missing binary (`status: "missing"`) caches `gitBinaryPresent = false` to avoid retrying every tick, while transient errors leave `gitBinaryPresent = null` so subsequent ticks can recover.
