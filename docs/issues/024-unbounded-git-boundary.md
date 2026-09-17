# Issue #024: Unbounded Inputs at the Git Boundary

- **Status**: Resolved
- **Type**: Enhancement / Robustness
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) / [`runGit`](file:///home/jhonny/Sources/pi-navigator/git.ts#L37)

---

## Description

[`runGit`](file:///home/jhonny/Sources/pi-navigator/git.ts#L37) uses `maxBuffer: 4 MB`. A monorepo with enormous `status -uall` or `ls-files` output exceeds the buffer and fails silently (`runGit` returns `null`, treated as empty). Additionally `status -uall` lists every untracked file with no count cap.

## Code References

- [`git.ts:44`](file:///home/jhonny/Sources/pi-navigator/git.ts#L44) — `maxBuffer: 4 * 1024 * 1024,`
- [`git.ts:151-170`](file:///home/jhonny/Sources/pi-navigator/git.ts#L151-L170) — `status --porcelain -uall -z` usage.

## Potential Solution

- Consider `status -unormal` (or `-uno`) to avoid listing every untracked file recursively.
- Document and enforce an entry cap on parsed porcelain output.
- Surface a truncated-state indicator instead of silently treating an overflow as empty.

## Acceptance Criteria

- [x] A decision is made and documented on untracked-file listing mode.
- [x] Overflow is surfaced rather than silently empty.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Two changes:

1. **Surfacing overflow.** `runGit` now returns a discriminated `GitResult` (`"ok" | "overflow" | "error"`) instead of `string | null`. Node signals a maxBuffer overflow as `code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"`; `runGit` maps that to `"overflow"` distinct from ordinary failures. `readGitState` returns an unavailable state with an explanatory `error` ("git output exceeded the 4 MB buffer …") when the status or log command overflows, so the git panel renders the message as its explanation row instead of silently showing empty lists. All `runGit` call sites (`detectRepo`, `isGitAvailable`, `readGitState`, `readTrackedFiles`) were updated for the new return type.

2. **Bounding untracked listing.** Switched `git status --porcelain -uall -z` to `-unormal -z`. `-uall` recurses into every file under untracked directories, which is what can blow past the 4 MB buffer on a monorepo with large untracked trees; `-unormal` lists untracked files and directories without that recursion, keeping output bounded. The existing untracked-file integration test (`untracked.txt` → `??`) still passes because a single top-level untracked file is listed identically under both modes. The porcelain parsing unit tests parse raw output directly and are unaffected.

All 107 tests green.
