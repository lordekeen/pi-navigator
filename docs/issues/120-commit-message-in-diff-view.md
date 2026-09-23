# Issue #120: The Commit-Diff Viewer Shows Only the Diff; the Commit Message Is Nowhere to Read

- **Status**: Pending
- **Type**: Enhancement / UX
- **Severity**: Low
- **Components**: [`git.ts`](../../git.ts) (`readCommitDiff`), [`index.ts`](../../index.ts) (`loadCommit` seam)
- **Found by**: user question "is there a way to view the git commit message?", 2026-09-23

## Description

The git pane shows each commit's **subject** only (`git log --pretty=format:%h%x1f%p%x1f%ad%x1f%s`,
`git.ts` L201), truncated to the pane width. Enter opens the commit in the viewer
(`openCommit` → `loadCommit` → `readCommitDiff`), but that view deliberately strips the
message: the diff body is fetched with `--pretty=format:` **empty** (`git.ts` L371), so the
viewer renders the changed-file diff plus a stat notice — and the message body, the part
that explains *why* the change was made, is invisible anywhere in the extension. The only
escape hatch is leaving pi for `git show`.

## Proposed resolution (v0.12.1)

Prepend the full commit message as **meta lines above the diff** in `readCommitDiff`:

- Fetch the message with `git show -s --pretty=format:%B <hash>` (subject bold via the
  theme's existing diff-meta styling, body plain); blank separator line between message and
  diff, `git show`-style.
- Styling goes through `styleDiffLines`' existing meta treatment — no new theme tokens, no
  hardcoded colors.
- Message is bounded by the same caps as the diff body (`MAX_HIGHLIGHT_BYTES` /
  `MAX_HIGHLIGHT_LINES` apply to the combined line array), so an enormous message degrades
  exactly like an enormous diff does today (truncation notice).
- Multi-line: every line after the first is body; a message-only commit (no textual diff,
  e.g. merge or empty change) still shows its message instead of an empty pane.

## Acceptance criteria

- [ ] Enter on a commit shows the full message (subject + body) above the diff.
- [ ] A merge commit shows its message followed by the first-parent diff (unchanged behavior).
- [ ] A commit whose message exceeds the caps degrades with the existing truncation notice, never an unbounded read.
- [ ] No new theme tokens, no hardcoded colors — meta styling is the existing `diff-meta`/dim treatment.
- [ ] Width-safety: message lines are styled text sliced by the viewer's existing wrap/truncate path; render suite stays green at all sizes.
- [ ] `test/git.test.ts` covers message parsing/format; the viewer suites cover rendering.
