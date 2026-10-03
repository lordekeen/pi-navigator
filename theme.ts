/**
 * pi-navigator theme wrapper.
 *
 * Maps the semantic tokens used by the overlay onto pi theme tokens so every
 * color follows the user's active theme (docs/themes.md). No hardcoded colors.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export interface NavigatorTheme {
  accent(t: string): string;
  muted(t: string): string;
  dim(t: string): string;
  success(t: string): string;
  warning(t: string): string;
  error(t: string): string;
  text(t: string): string;
  bold(t: string): string;
  /** Selected row background. */
  selectedBg(t: string): string;
  /** Search match highlight (all matches). */
  searchMatch(t: string): string;
  /** Search match highlight (current match, inverted pair). */
  searchCurrent(t: string): string;
  /** Frame borders. */
  frame(t: string): string;
  /** Viewer scrollbar: the unfilled track (Issue #137). */
  scrollbarTrack(t: string): string;
  /** Viewer scrollbar: the proportional thumb (Issue #137). */
  scrollbarThumb(t: string): string;
  /** Added diff line. */
  diffAdded(t: string): string;
  /** Removed diff line. */
  diffRemoved(t: string): string;
  /** Diff context line. */
  diffContext(t: string): string;
}

export function makeNavigatorTheme(theme: Theme): NavigatorTheme {
  return {
    accent: (t) => theme.fg("accent", t),
    muted: (t) => theme.fg("muted", t),
    dim: (t) => theme.fg("dim", t),
    success: (t) => theme.fg("success", t),
    warning: (t) => theme.fg("warning", t),
    error: (t) => theme.fg("error", t),
    text: (t) => theme.fg("text", t),
    bold: (t) => (typeof theme.bold === "function" ? theme.bold(t) : t),
    selectedBg: (t) => theme.bg("selectedBg", t),
    searchMatch: (t) => theme.bg("searchMatchBg", theme.fg("searchMatchText", t)),
    // Current match: same pair plus underline, mirroring pi's own tui-renderer.
    // A token-inverted pair would pass a ThemeColor name to theme.bg(), which
    // throws at runtime (theme.bg rejects unknown keys) and fails typecheck.
    searchCurrent: (t) => {
      const match = theme.bg("searchMatchBg", theme.fg("searchMatchText", t));
      return typeof theme.underline === "function" ? theme.underline(match) : match;
    },
    frame: (t) => theme.fg("borderMuted", t),
    // Dedicated scrollbar roles (Issue #137 §4). Both are optional host tokens:
    // the Theme constructor backfills them (track ← muted, thumb ← text) for
    // themes that do not declare them, so fg() never throws here.
    scrollbarTrack: (t) => theme.fg("scrollbarTrack", t),
    scrollbarThumb: (t) => theme.fg("scrollbarThumb", t),
    // Dedicated host diff roles. The generic success/error/text tokens mean
    // other things elsewhere in the overlay, and a theme that styles diffs
    // specifically (toolDiff*) would otherwise never reach this view (#135 L7).
    diffAdded: (t) => theme.fg("toolDiffAdded", t),
    diffRemoved: (t) => theme.fg("toolDiffRemoved", t),
    diffContext: (t) => theme.fg("toolDiffContext", t),
  };
}
