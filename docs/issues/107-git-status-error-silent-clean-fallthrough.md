# Issue #107: Non-Zero Exit from `git status` Silently Defaults to "Clean"

- **Status**: Resolved
- **Type**: Bug / Reliability
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts#L200-L230)

## Description

In [`readGitState`](file:///home/jhonny/Sources/pi-navigator/git.ts#L175), `git status --porcelain -unormal -z` is executed to gather the staged and unstaged file lists:

```typescript
const statusText = statusRes.status === "ok" ? statusRes.stdout : "";
const { unstaged, staged } = parsePorcelain(statusText, detected.prefix);
```

While `statusRes.status === "overflow"` is explicitly checked and surfaced ([lines 209-214](file:///home/jhonny/Sources/pi-navigator/git.ts#L209-L214)), any non-zero exit code or timeout results in `statusRes.status === "error"`.

When this happens:
1. `statusText` falls back to `""`.
2. `parsePorcelain` returns empty lists: `unstaged: []`, `staged: []`.
3. The panel displays `Clean — nothing staged or unstaged`.

If `git status` fails due to lock file contention (e.g. `index.lock` present during a rebase or commit), permission issues, or index corruption, the UI shows the working tree as clean, giving the user a false impression that there are no uncommitted changes.

## Proposed Fix

Check `statusRes.status === "error"` and return an unavailable state with an explanatory error, or set an error message in `GitState` so the Git pane alerts the user that `git status` failed.

## Acceptance Criteria

- [x] A failure in `git status` does not report a working tree as "Clean".
- [x] An explanatory error is surfaced in the Git panel (e.g., `git status failed`).
- [x] Unit tests in `test/git.test.ts` verify non-zero status exit handling.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

Chosen design: keep the state **available** — branch, ahead/behind and history
are still valid — and set `error` when the status read fails (`"error"` or
`"missing"`; overflow keeps its existing unavailable-state behavior):

`"git status failed — changes not listed (press r to retry)"`

- `git_view.ts`: the empty-list branch renders the error as a **warning** group
  row instead of the dim `Clean` row, and the header shows the error instead of
  a bogus `0 unstaged · 0 staged` counter. The `!available` branch is unchanged.
- `types.ts`: the `GitState.error` doc now covers "available but the change list
  could not be read".

Tests mock a failing `status` invocation and assert availability + error + intact
branch/history, plus both view-model renderings. `padTo` hard-truncates, so the
longer label stays width-safe at every pane width.
