# Issue #094: Git Availability Cache Test Does Not Assert Subprocess Caching

- **Status**: Resolved
- **Type**: Technical Debt / Test Quality
- **Severity**: Low
- **Component**: [`test/git.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/git.test.ts#L314-L320), [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts#L104-L118)

---

## Description

In [`test/git.test.ts` L314-320](file:///home/jhonny/Sources/pi-navigator/test/git.test.ts#L314-L320), the test `returns the cached git-on-path result` checks git binary availability caching:

```typescript
  it("returns the cached git-on-path result", async () => {
    // Two calls to isGitAvailable for the same cwd return the cached result.
    // runGit's ENOENT self-healing (Issue #021) handles the real invalidation
    // path; this test exercises the normal cache-hit branch.
    expect(await isGitAvailable(repo)).toBe(true);
    expect(await isGitAvailable(repo)).toBe(true);
  });
```

The test calls `isGitAvailable(repo)` twice and checks that both return `true`. However:
1. It does not spy on `execFile` or check that a child process was not spawned on the second call.
2. Because earlier tests in `test/git.test.ts` already invoked `readGitState`, the module-level `gitBinaryPresent` cache was already initialized to `true` prior to entering this test block.

If the caching mechanism were completely removed and `isGitAvailable` spawned `git --version` on every single invocation, this test would still pass.

## Root Cause Analysis

Missing assertion on execution counts (e.g. via `vi.spyOn` on child process execution).

## Potential Solution

Use `vi.spyOn` on `child_process.execFile` (or an injected runner seam):
1. Assert that `execFile` is called exactly 0 times on subsequent cached invocations.
2. Note that the old `resetGitAvailabilityCache()` export was intentionally deleted in Issue #027, so asserting the cold-to-warm cache transition requires either an injected runner seam (`exec` dependency) or module isolation (`vi.isolateModulesAsync`).

## Acceptance Criteria

- [x] Test fails if `isGitAvailable` executes subprocesses on subsequent calls for cached results.
- [x] Subprocess execution count is explicitly asserted.
- [x] `npm test` passes.

## Resolution

Exported `gitRunner = { execFile: childProcess.execFile }` from `git.ts` and added an automated test in `test/git.test.ts` spying on `gitRunner.execFile` to verify zero subprocess executions on cached `isGitAvailable` calls.
