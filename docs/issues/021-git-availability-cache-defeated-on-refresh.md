# Issue #021: Git Availability Cache Defeated on Every Manual Refresh

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: Medium
- **Component**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) / [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts)

---

## Description

The overlay's `refresh` handler calls [`resetGitAvailabilityCache()`](file:///home/jhonny/Sources/pi-navigator/git.ts#L53) ([`index.ts:117`](file:///home/jhonny/Sources/pi-navigator/index.ts#L117)), so each manual refresh (`r` key / state-change key) re-spawns `git --version` ([`git.ts:56-60`](file:///home/jhonny/Sources/pi-navigator/git.ts#L56-L60)). The git binary does not disappear mid-session, so the reset buys nothing but an extra fork+exec per refresh. (This reset was added by #007 to make the cache *invalidatable*; the policy is now overly aggressive.)

## Code References

- [`index.ts:117`](file:///home/jhonny/Sources/pi-navigator/index.ts#L117) — `resetGitAvailabilityCache();`
- [`git.ts:53-60` (`resetGitAvailabilityCache` / `detectGitBinary`)](file:///home/jhonny/Sources/pi-navigator/git.ts#L53-L60)

## Potential Solution

Drop the unconditional reset on manual refresh. Only reset the availability cache after an actual `ENOENT`/spawn failure from `runGit`, so detection retries only when git genuinely fails.

## Acceptance Criteria

- [x] Manual refresh no longer re-spawns `git --version` when git is present.
- [x] Availability is re-detected after a real git spawn failure.
- [x] `npm run typecheck` and `npm test` are green (git suite included).

## Resolution

Removed the unconditional `resetGitAvailabilityCache()` call from the overlay's manual `refresh` handler in `index.ts`. `runGit` now resets the availability cache itself when a spawn fails with `code === "ENOENT"` (the git binary genuinely missing from PATH); non-zero exits and timeouts have a numeric `code` and no longer trigger a reset. Net: `r` refresh no longer re-spawns `git --version`, while a real missing-binary failure still self-heals on the next tick. The git suite's `resetGitAvailabilityCache` lifecycle hook (from #007) is unaffected — it imports the symbol directly from `git.ts`.
