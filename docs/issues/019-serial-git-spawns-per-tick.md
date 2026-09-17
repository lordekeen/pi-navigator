# Issue #019: Serial Git Subprocess Spawns on Every Poll Tick

- **Status**: Resolved
- **Type**: Enhancement / Performance
- **Severity**: High
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) / [`readGitState`](file:///home/jhonny/Sources/pi-navigator/git.ts#L123) / [`detectRepo`](file:///home/jhonny/Sources/pi-navigator/git.ts#L64)

---

## Description

[`readGitState`](file:///home/jhonny/Sources/pi-navigator/git.ts#L123) awaits four **independent** git commands strictly sequentially: `branch --show-current`, `rev-list --left-right --count`, `status --porcelain -z`, and `log -n20`. Each is a fork+exec (up to a 3s timeout). This runs on every ~3s poll tick while the overlay is open ([`index.ts:224`](file:///home/jhonny/Sources/pi-navigator/index.ts#L224)), so worst-case serial latency is ~4× the parallelized latency.

Separately, [`detectRepo`](file:///home/jhonny/Sources/pi-navigator/git.ts#L64) awaits `rev-parse --show-toplevel` then `rev-parse --show-prefix` sequentially, and `detectRepo` is called **every tick** ([`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts#L126)), not just on open.

## Code References

- [`git.ts:151-170`](file:///home/jhonny/Sources/pi-navigator/git.ts#L151-L170) — four sequential `await runGit(...)`.
- [`git.ts:68-69` (`detectRepo`)](file:///home/jhonny/Sources/pi-navigator/git.ts#L68-L69) — two sequential `rev-parse` calls.

## Potential Solution

- `Promise.all([branch, revList, status, log])` in `readGitState`: 4 rounds → 1 round.
- Merge the two `rev-parse` calls into one: `git rev-parse --show-toplevel --show-prefix` (parse both lines).
- Net: ~6 spawns/tick across 2 rounds instead of 6 sequential rounds.

## Acceptance Criteria

- [x] Independent git commands in `readGitState` run concurrently.
- [x] `detectRepo` uses a single `rev-parse` invocation.
- [x] Git state (branch, ahead/behind, staged/unstaged, history) is parsed correctly.
- [x] `npm run typecheck` and `npm test` are green (git suite included).

## Resolution

`readGitState` now `Promise.all`s the four independent spawns (branch / rev-list / status / log) so a poll tick waits one round instead of four. `detectRepo` merges `--show-toplevel` and `--show-prefix` into a single `git rev-parse` invocation (parsing the second output line as the prefix). Net: ~6 spawns/tick across 2 rounds instead of 6 sequential rounds. All 107 tests green.
