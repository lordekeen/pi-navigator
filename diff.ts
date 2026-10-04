/**
 * pi-navigator diff styler and view composer (v3 commit detail view).
 *
 * git.ts returns the commit diff as **plain** lines; this module applies the
 * theme in the loader (index.ts) so git.ts stays theme-free — the same
 * "highlight in the loader" split viewer.ts uses for files. The styling is
 * prefix-keyed, matching the approach lazygit/gitui take: no diff parser, just
 * a per-line look at the leading characters. This module also owns the
 * message+body assembly (`composeDiffLines`) and its synchronous restyle
 * (`restyleDiffViewerFile`, Issue #141), so a themed diff is recomposed from
 * its retained source without re-running `git show`.
 *
 * No hardcoded colors — every style goes through NavigatorTheme (theme.ts),
 * which delegates to the user's active pi theme.
 */

import type { NavigatorTheme } from "./theme";
import type { ViewerFile } from "./types";

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

/**
 * The plain material a diff view is composed from: the commit message plus
 * the raw diff body lines. Structurally the commit-detail loader's CommitDiff
 * minus its metadata, so `loadCommit` can pass that result directly.
 */
export interface DiffSource {
  message: CommitMessage;
  lines: string[];
}

/**
 * Compose a diff view's lines from its plain source (Issue #141): the styled
 * commit message above the styled diff body, `git show`-style, with one blank
 * separator line only when both parts are non-empty. Pure — this is exactly
 * the assembly session.ts's loadCommit used to inline, extracted so the
 * retained-source restyle can re-run it.
 */
export function composeDiffLines(source: DiffSource, T: NavigatorTheme): string[] {
  const messageLines = styleCommitMessage(source.message, T);
  const diffLines = styleDiffLines(source.lines, T);
  return messageLines.length > 0 && diffLines.length > 0
    ? [...messageLines, "", ...diffLines]
    : [...messageLines, ...diffLines];
}

/**
 * Recompose a diff viewer file from its retained plain source under a new
 * theme (Issue #141). Synchronous and I/O-free: the composer is a pure
 * function of the retained message + lines, so a theme switch pays one
 * recompose — never another `git show`. Returns the same reference when there
 * is nothing to do (not a diff, no retained source, or the key already
 * matches), so callers can detect the no-op cheaply.
 */
export function restyleDiffViewerFile(
  file: ViewerFile,
  T: NavigatorTheme,
  styleKey: string,
): ViewerFile {
  if (file.kind !== "diff" || file.styleDiff === undefined || file.styleKey === styleKey) {
    return file;
  }
  return { ...file, lines: composeDiffLines(file.styleDiff, T), styleKey };
}
