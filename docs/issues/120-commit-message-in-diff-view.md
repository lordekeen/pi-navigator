# Issue #120: The Commit-Diff Viewer Shows Only the Diff; the Commit Message Is Nowhere to Read

- **Status**: Resolved
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

## Resolution (v0.12.1)

Implemented as proposed — commit `feat(git) d1cc489`:

- `readCommitDiff` (`git.ts`) fetches the message with `git show -s --pretty=format:%B
  --no-color` in the same parallel batch as body + numstat (format-only, no patch — merge-safe).
  `CommitDiff` gains `message: CommitMessage` (`{ subject, body }`, CR-normalized, trailing
  blanks trimmed); the degraded bogus-hash path returns an empty message.
- Bounded exactly like the diff: capped on **bytes** (UTF-8-safe, Issue #060 rule) and on
  **lines** (`MAX_HIGHLIGHT_LINES` covers the message too); either cap appends the existing
  `· diff truncated (showing the head)` notice. A failed message read degrades to
  `{ subject: "", body: [] }` without touching the diff.
- New pure `styleCommitMessage` (`diff.ts`): subject bold, body `text` — no new theme tokens,
  no hardcoded colors. The loader (`index.ts`) prepends the styled block above the styled diff
  with one blank separator line when a diff body follows (`git show`-style); a message-only
  commit (empty diff) still shows its message.
- `git.ts` stays theme-free; the message styling lives beside `styleDiffLines` under the same
  "highlight in the loader" split.

Verified: `npm run typecheck` + `npm test` green (712 tests, 20 suites).

## Evidence

- `test/git.test.ts` (+3): subject/body split of a multi-paragraph message (repeated `-m`
  paragraphs), single-line message → empty body, failed `%B` read → empty message with the
  diff intact, bogus-hash → empty message.
- `test/diff.test.ts` (+3): `styleCommitMessage` — subject bold + body text, empty-message/
  empty-subject edges, byte-for-byte content preservation (including diff-looking body lines).
- `test/render.test.ts`: the commit-diff width-safety case now carries a bold subject + body
  above the diff and asserts the block renders width-safe at all suite sizes.
