# Issue #096: Test Coverage Gap: Git Edge States Untested in `git.test.ts`

- **Status**: Open
- **Type**: Technical Debt / Test Coverage
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts), [`test/git.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/git.test.ts)

---

## Description

[`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) handles complex repository states directly in [`readGitState`](file:///home/jhonny/Sources/pi-navigator/git.ts#L173-L245) ([L202-212](file:///home/jhonny/Sources/pi-navigator/git.ts#L202-L212), [L236-238](file:///home/jhonny/Sources/pi-navigator/git.ts#L236-L238)):
1. **Detached HEAD**: branches where `branchName === ""` producing `state.detached: true` and `state.branch: null`.
2. **Ahead / behind counters**: upstream tracking divergence such as `[ahead 2, behind 1]`.
3. **Empty / unborn repositories**: repositories initialized with `git init` but having no commits yet (`fatal: your current branch 'main' does not have any commits yet`).
4. **Buffer overflow protection**: `maxBuffer` exceedance in [`runGit`](file:///home/jhonny/Sources/pi-navigator/git.ts#L71) triggering the graceful unavailable-with-error state.

However, [`test/git.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/git.test.ts) only creates basic initialized repositories with standard branches and linear commits. None of these four edge states are tested.

A regression in branch string parsing or empty-repo detection would pass existing automated tests undetected.

## Root Cause Analysis

Git unit test fixtures focus on common porcelain states (staged/unstaged files, commit diffs) and omit branch divergence and repo lifecycle edge cases.

## Potential Solution

Add test cases in [`test/git.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/git.test.ts):
1. Create a repo with a detached HEAD checkout and assert `state.branch` formatting.
2. Configure a local tracking branch diverging from an upstream remote and assert `state.ahead` and `state.behind`.
3. Create a fresh repository without commits and assert that `readGitState` returns clean/empty state without throwing.
4. Mock a large output triggering `maxBuffer` and assert graceful degradation to `{ available: false, error: ... }`.

## Acceptance Criteria

- [ ] Detached HEAD parsing is covered by an automated test.
- [ ] Ahead and behind branch counters are tested.
- [ ] Empty repository handling is verified.
- [ ] Buffer overflow error path is verified.
- [ ] `npm test` passes.
