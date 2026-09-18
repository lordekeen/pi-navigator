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
 * Style one diff line by its leading characters:
 *
 * - `+++` / `---` file headers → muted
 * - `+`   added line → success
 * - `-`   removed line → error
 * - `@@`  hunk header → accent
 * - `diff` / `index` / `new file` / `deleted file` / `Binary files` meta → muted
 * - anything else (context) → text
 */
export function styleDiffLines(lines: string[], T: NavigatorTheme): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) out.push(T.muted(line));
    else if (line.startsWith("+")) out.push(T.success(line));
    else if (line.startsWith("-")) out.push(T.error(line));
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
      out.push(T.text(line));
    }
  }
  return out;
}
