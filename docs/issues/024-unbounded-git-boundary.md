# Issue #024: Unbounded Inputs at the Git Boundary

- **Status**: Open
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

- [ ] A decision is made and documented on untracked-file listing mode.
- [ ] Overflow is surfaced rather than silently empty.
- [ ] `npm run typecheck` and `npm test` are green.
