/**
 * pi-navigator diff line styler (v3 commit detail view).
 *
 * git.ts returns the commit diff as **plain** lines; this module applies the
 * theme in the loader (index.ts) so git.ts stays theme-free — the same
 * "highlight in the loader" split viewer.ts uses for files. The styling is
 * prefix-keyed, matching the approach lazygit/gitui take: no diff parser, just
 * a per-line look at the leading characters.
 *
 * No hardcoded colors — every style goes through NavigatorTheme (theme.ts),
 * which delegates to the user's active pi theme.
 */

import type { NavigatorTheme } from "./theme";

/**
 * A commit's message, split for display (Issue #120): the subject line and
 * the body lines that follow it, plain and theme-free (git.ts owns parsing,
 * this module owns styling).
 */
export interface CommitMessage {
  /** First line of the commit message (may be empty for a blank message). */
  subject: string;
  /** Message lines after the subject, trailing blank lines trimmed. */
  body: string[];
}

/**
 * Style the commit message block shown above the diff (Issue #120):
 * subject bold, body plain text. Returns the lines without a separator —
 * the caller (index.ts) inserts the blank line between message and diff,
 * `git show`-style, only when a diff body follows.
 */
export function styleCommitMessage(message: CommitMessage, T: NavigatorTheme): string[] {
  const lines: string[] = [];
  if (message.subject !== "") lines.push(T.bold(message.subject));
  for (const line of message.body) lines.push(T.text(line));
  return lines;
}

/**
 * Style one diff line by its leading characters. Added, removed and context
 * lines use the host's dedicated diff roles (`toolDiffAdded` /
 * `toolDiffRemoved` / `toolDiffContext`) rather than the generic
 * success/error/text tokens, which mean other things elsewhere in the overlay
 * and are not what a theme styles diffs with (Issue #135 L7).
 *
 * - `+++` / `---` file headers → muted
 * - `+`   added line → diffAdded
 * - `-`   removed line → diffRemoved
 * - `@@`  hunk header → accent
 * - `diff` / `index` / `new file` / `deleted file` / `Binary files` meta → muted
 * - anything else (context) → diffContext
 */
export function styleDiffLines(lines: string[], T: NavigatorTheme): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) out.push(T.muted(line));
    else if (line.startsWith("+")) out.push(T.diffAdded(line));
    else if (line.startsWith("-")) out.push(T.diffRemoved(line));
    else if (line.startsWith("@@")) out.push(T.accent(line));
    else if (
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("Binary files")
    ) {
      out.push(T.muted(line));
    } else {
      out.push(T.diffContext(line));
    }
  }
  return out;
}
