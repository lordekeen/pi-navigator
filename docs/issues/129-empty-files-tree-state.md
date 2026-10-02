# Issue #129: Empty Files Tree Renders `1/0` and Has No Empty State

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Medium
- **Components**: [`files_view.ts`](../../files_view.ts) (`buildFilesHeader`, row model)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M6](../exploration/ui-skill-compliance-audit.md#medium)

## Description

Two defects in the same state — a files pane with zero rows:

**1. The counter is nonsense.** `Math.max(1, …)` floors the numerator at one:

```ts
// files_view.ts:41
T.dim(`${Math.max(1, Math.min(ctx.filesCursor + 1, total))}/${total}`)
```

With `total === 0` this renders **`1/0`** — a numerator greater than its denominator.

**2. There is no empty state.** `files_view.ts` has no placeholder row for zero entries, so the pane
is simply blank below the header. The git pane, by contrast, does have one
(`git_view.ts:53`, `"Clean — nothing staged or unstaged"`), so the two panes disagree about how to
render emptiness.

The standard requires three list states: *nothing exists yet* (one explanatory line **plus how to
create one**), *nothing matches the filter*, and *read/render failed*. The first is missing for the
files pane. This state is not hypothetical — the project's own standards report calls the
empty-repository / no-git case "the current machine's reality and **must be first-class**"
([`ui-standards-report.md`](../plans/ui-standards-report.md) §4.3).

## Reproduction Steps

1. Run `/navigator` in an empty directory (or in a repository whose tracked listing yields nothing).
2. The FILES header reads `1/0`.
3. The pane body is blank, with no explanation and no hint about what to do.

## Root Cause

The counter was written for the normal case and the `Math.max(1, …)` guard was added to keep a
1-of-N display from ever reading `0/N`; it was not revisited for `N = 0`. The empty state was never
specified per-pane, and only the git pane received one.

## Proposed Resolution

- **Counter:** render `0/0` or omit the counter entirely when `total === 0`; never show a numerator
  above the denominator.
- **Empty state:** add one dim explanatory row, in the style of the git pane's `Clean` row, saying
  *why* it is empty — e.g. `no files` plus the source (`git ls-files returned nothing` vs
  `directory is empty`) — and keep the header and footer hints intact so the frame does not collapse
  (the standard: keep the frame in all three states).

## Acceptance Criteria

- [ ] The counter never shows a numerator above the denominator (`0/0` or hidden)
- [ ] An empty tree renders one explanatory line naming the reason
- [ ] The header and footer hints are still present in the empty state
- [ ] The git pane's `Clean` row is unchanged
- [ ] Render tests cover the empty files pane at the suite's terminal sizes
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M6](../exploration/ui-skill-compliance-audit.md) — rule: `overlays-and-components.md`
  §Empty and error states *"Nothing exists yet | one explanatory line + how to create one"* and
  *"Keep the frame in all three."*
- Related: [#107](107-git-status-error-silent-clean-fallthrough.md) (git pane empty/error states, resolved)

## Resolution

`buildFilesHeader` no longer floors the numerator: with a filter active it still shows `N matches`; with entries it shows `cursor/total` and the numerator can no longer exceed the denominator; with a zero-entry tree it shows no counter at all — there is no position a cursor could occupy in an empty tree, so `0/0` would assert one.

The empty pane is filled by `filesEmptyRow` (pure, in `files_view.ts`), which names the reason: `no matches for "<query>"` when a filter is active, `no files` otherwise. It is deliberately presentation rather than a row-model entry, so the header's counts and the pane's cursor math are untouched (as a model row it would have made an empty tree read `1/1`, which is exactly the defect this issue is about).

Render coverage asserts the row at 120/100/80; below `LEFT_COLUMN_HIDE_BELOW` the files pane does not exist at all, so only width safety applies there.

Verified: `npm run typecheck` and `npm test` green (760+ tests, 20 suites).

