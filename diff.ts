/**
 * pi-navigator diff styler and view composer (v3 commit detail view).
 *
 * git.ts returns the commit diff as **plain** lines; this module applies the
 * theme in the loader (`session.ts` `loadCommit`) so git.ts stays theme-free — the same
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
 * subject bold, body plain text. `composeDiffLines` inserts the blank line
 * between message and diff (`git show`-style) only when a diff body follows;
 * this function returns the lines without it.
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
/**
 * The diff-line classes every consumer styles: file banners and git meta
 * lines, hunk headers, additions, removals and context.
 */
export type DiffLineTone = "meta" | "hunk" | "added" | "removed" | "context";

/**
 * Classify one raw diff line by its prefix — the one diff grammar, so a new
 * prefix is taught once (Issue #175). `+++`/`---` banners and git meta lines
 * are `meta`, `@@` hunks are `hunk`, `+`/`-` are additions/removals, and
 * everything else is context. The commit-message head and blank separator
 * carry no prefix and read as context: prefix-based classification is a
 * deliberate simplification that cannot show message structure.
 */
export function diffLineTone(line: string): DiffLineTone {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  return "context";
}

/** The theme styler for one tone; every consumer paints through this table
 *  (a Record keyed by the tone union, so a new tone cannot be forgotten). */
const DIFF_TONE_STYLERS: Record<DiffLineTone, (T: NavigatorTheme) => (text: string) => string> = {
  meta: (T) => T.muted,
  hunk: (T) => T.accent,
  added: (T) => T.diffAdded,
  removed: (T) => T.diffRemoved,
  context: (T) => T.diffContext,
};

export function diffLineStyler(T: NavigatorTheme, tone: DiffLineTone): (text: string) => string {
  return DIFF_TONE_STYLERS[tone](T);
}

export function styleDiffLines(lines: string[], T: NavigatorTheme): string[] {
  return lines.map((line) => diffLineStyler(T, diffLineTone(line))(line));
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
