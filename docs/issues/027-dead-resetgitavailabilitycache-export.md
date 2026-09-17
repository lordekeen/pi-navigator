# Issue #027: Dead `resetGitAvailabilityCache` Export; Stale #007 Resolution Summary

- **Status**: Resolved
- **Type**: Technical Debt
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) / [`issues_index.md`](file:///home/jhonny/Sources/pi-navigator/docs/issues/issues_index.md)

---

## Description

[`resetGitAvailabilityCache()`](file:///home/jhonny/Sources/pi-navigator/git.ts#L78) is exported but has **no production caller**. Issue #021 removed the unconditional `r`-refresh reset from `index.ts`; self-healing is now handled inside [`runGit`](file:///home/jhonny/Sources/pi-navigator/git.ts#L48) on a spawn `ENOENT`. The only remaining consumers are the test lifecycle hooks ([`test/git.test.ts:23, 267`](file:///home/jhonny/Sources/pi-navigator/test/git.test.ts#L23)). The export is now dead API.

#007's resolution summary in [`issues_index.md`](file:///home/jhonny/Sources/pi-navigator/docs/issues/issues_index.md) previously stated the reset was *"wired to run on manual `r` refresh"* — which #021 made false. That index entry has been corrected in the doc-sync pass that opened this issue; this issue tracks finishing the code cleanup of the dead export itself.

## Code References

- [`git.ts:78` (`resetGitAvailabilityCache`)](file:///home/jhonny/Sources/pi-navigator/git.ts#L78)
- [`git.ts:56-62` (`runGit` ENOENT self-healing)](file:///home/jhonny/Sources/pi-navigator/git.ts#L56-L62)
- [`test/git.test.ts:23, 267`](file:///home/jhonny/Sources/pi-navigator/test/git.test.ts#L23)
- [`docs/issues/issues_index.md` (#007 summary)](file:///home/jhonny/Sources/pi-navigator/docs/issues/issues_index.md)

## Potential Solution

Remove the export (and the test lifecycle hooks that use it as the only reset path), since `runGit` already self-heals on `ENOENT` and the suite can isolate via a fresh module state. If a manual-invalidation API is genuinely wanted later, re-add it with a real caller. Either way, keep the corrected #007 summary (reset is export-only, automatic re-detection happens inside `runGit`).

## Acceptance Criteria

- [x] No unused production export (removed, or documented as test-only with the corrected #007 note).
- [x] Git availability still self-heals after `ENOENT`.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Removed `resetGitAvailabilityCache()` from `git.ts` — it had no production caller after #021 moved the self-healing reset into `runGit` on `ENOENT`. Updated the git integration test to exercise the cache-hit path (two consecutive `isGitAvailable` calls return the cached result) instead of calling the removed reset function. The corrected #007 summary in `issues_index.md` (reset is export-only, re-detection happens inside `runGit`) stands.
