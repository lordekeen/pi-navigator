# Issue #106: Binary File Changes Ignored in `readCommitDiff` Files-Changed Count

- **Status**: Resolved
- **Type**: Bug / UX
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts#L373-L381)

## Description

When viewing a commit's diff in the viewer pane, [`readCommitDiff`](file:///home/jhonny/Sources/pi-navigator/git.ts#L341) parses Git's `--numstat` output to construct the stat summary notice (e.g. `commit abc1234 · 1 file · +2 −0`):

```typescript
  if (statRes.status === "ok") {
    for (const raw of statRes.stdout.split("\n")) {
      const m = raw.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue; // skip binary entries and the summary line
      filesChanged += 1;
      insertions += Number.parseInt(m[1] ?? "0", 10) || 0;
      deletions += Number.parseInt(m[2] ?? "0", 10) || 0;
    }
  }
```

In `git show --numstat`, binary files are emitted with `-` instead of numeric line insertion/deletion counts:
```
-       -       assets/logo.png
```

Because the regex `/^(\d+)\s+(\d+)\s+(.+)$/` requires digits, binary rows do not match `m`. If a commit touches only binary files, `filesChanged` remains `0`, and the diff viewer header reads:
```
commit abc1234 · no files · +0 −0
```
This is misleading to the user because files were indeed modified or added in the commit.

## Proposed Fix

Extend the regex to match `-` in place of insertion/deletion counts:
```typescript
for (const raw of statRes.stdout.split("\n")) {
  const m = raw.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
  if (!m) continue;
  filesChanged += 1;
  if (m[1] !== "-") insertions += Number.parseInt(m[1] ?? "0", 10) || 0;
  if (m[2] !== "-") deletions += Number.parseInt(m[2] ?? "0", 10) || 0;
}
```

## Acceptance Criteria

- [x] A commit that changes only binary files reports the correct number of files changed (e.g., `1 file` instead of `no files`).
- [x] Insertions and deletions counts remain 0 for binary entries.
- [x] Text files continue to parse insertions and deletions accurately.
- [x] Unit tests in `test/git.test.ts` verify binary entry handling in `--numstat` output.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

The numstat matcher now accepts `-` in either count column
(`/^(\d+|-)\s+(\d+|-)\s+(.+)$/`): a binary row counts as one changed file and
contributes 0 insertions / 0 deletions; numeric rows parse exactly as before and
the summary line is still skipped.

Tests cover a binary-only commit (`1 file`, `+0 −0`) and a mixed binary+text
commit (files and counts summed correctly).
