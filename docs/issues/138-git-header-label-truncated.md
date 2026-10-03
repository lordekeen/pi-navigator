# Issue #138: Git Header Truncates the `GIT` Label to `GI` at 120 Columns

- **Status**: Pending
- **Type**: Bug / UI Consistency
- **Severity**: Low
- **Components**: [`git_view.ts`](../../git_view.ts) (`buildGitHeader`), [`frame.ts`](../../frame.ts) (`joinLeftRight`)
- **Found by**: live QA drive of [#137](137-e-style-chrome-migration.md) during the E-style chrome migration (tmux 3.7c at 120×36, pi 1.0.1), 2026-10-03

## Description

At exactly 120 columns the git pane header renders **`GI 0 unstaged · 0 staged 1/20`** — the label
loses its `T`. At 140 columns the same header renders `GIT` intact. The cut is a hard truncation
with no ellipsis, so it reads as a different word rather than a clipped one.

Live capture (120×36, overlay inner width 106, left column 31):

```text
│ GI 0 unstaged · 0 staged 1/20 │
```

## Root Cause

`buildGitHeader` appends the position counter only when it believes the row fits:

```ts
// git_view.ts:182
if (visibleWidth(label) + visibleWidth(info) + visibleWidth(counter) <= leftW) info += counter;
```

At `leftW = 31` the three segments measure exactly `4 + 22 + 5 = 31`, so the guard passes. But the
row is then composed by `joinLeftRight`, which reserves one gap cell between the segments:

```ts
// frame.ts:213-215
const rightW = visibleWidth(right);
const maxLeft = Math.max(0, width - rightW - 1);
const leftPart = visibleWidth(left) > maxLeft ? hardTruncate(left, maxLeft) : left;
```

`maxLeft` is therefore 3 while `" GIT"` is 4, so `hardTruncate` shaves the label to `GI`. The guard
is missing the gap cell the composer reserves — the same class of off-by-one as
[#113](113-git-group-row-ignores-leftw.md), one level up.

## Reproduction Steps

1. Terminal exactly 120 columns wide; open `/navigator` in a repository with a clean worktree
   (0 unstaged, 0 staged) and at least one commit.
2. The GIT header reads `GI 0 unstaged · 0 staged 1/20`.
3. Widen to 140 columns — it reads `GIT`.

## Proposed Resolution

Include the gap cell in the counter guard (`… + 1 <= leftW`), so the counter is appended only when
the label survives the join; alternatively shrink the counter's own budget first. One line in
`git_view.ts`; mirror the arithmetic in a test that renders at the exact threshold width.

## Acceptance Criteria

- [ ] At 120 columns with a clean worktree the header reads `GIT` (the counter never truncates the label)
- [ ] When the row cannot hold all three, the counter is dropped rather than the label clipped
- [ ] A render test pins the threshold width
- [ ] `npm run typecheck` and `npm test` green

## References

- Live QA evidence: [`qa-evidence.md`](../plans/qa-evidence.md) § "E-style chrome (#137)"
- Composer: [`joinLeftRight`](../../frame.ts) (#010 truncation convention)
- Same defect class one level up: [#113](113-git-group-row-ignores-leftw.md)
