# Issue #007: Module-Level `gitBinaryPresent` Cache Cannot Be Invalidated

- **Status**: Resolved
- **Type**: Edge Case / Reliability
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) / [`isGitAvailable`](file:///home/jhonny/Sources/pi-navigator/git.ts#L53-L57)

---

## Description

[`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) stores the result of checking whether `git` is installed and on `PATH` in a module-scoped variable:

```typescript
let gitBinaryPresent: boolean | null = null;

export async function isGitAvailable(cwd: string): Promise<boolean> {
  if (gitBinaryPresent !== null) return gitBinaryPresent;
  gitBinaryPresent = (await runGit(cwd, ["--version"])) !== null;
  return gitBinaryPresent;
}
```

Once probed, `gitBinaryPresent` remains cached indefinitely for the entire lifetime of the Node process. If Git is installed, uninstalled, or added to `PATH` while Pi is running, `pi-navigator` will not recognize the state change until the host process restarts.

Additionally, this shared mutable state creates potential test pollution between unit test suites unless explicitly reset.

---

## Code References

- [`git.ts:35`](file:///home/jhonny/Sources/pi-navigator/git.ts#L35)
- [`git.ts:53-57`](file:///home/jhonny/Sources/pi-navigator/git.ts#L53-L57)

---

## Potential Solution

### Option A: Export a Cache Invalidation / Reset Function
Provide a helper to reset the cached value:
```typescript
export function resetGitAvailabilityCache(): void {
  gitBinaryPresent = null;
}
```
This can be invoked whenever the user manually triggers a full refresh (`r`) or in test lifecycle hooks (`beforeEach`/`afterEach`).

### Option B: Time-to-Live (TTL) or Per-Session Caching
Scope the availability flag to the active `NavigatorOverlay` session or check on a lazy TTL (e.g. recheck if more than 60 seconds have elapsed and Git was previously marked unavailable).

---

## Acceptance Criteria

- [x] Mechanism exists to invalidate or re-evaluate `gitBinaryPresent`.
- [x] No regression in startup performance or unnecessary git subprocess spawns during regular operations.
