/**
 * pi-navigator theme wrapper.
 *
 * Maps the semantic tokens used by the overlay onto pi theme tokens so every
 * color follows the user's active theme (docs/themes.md). No hardcoded colors.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

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
  /** Search match highlight (current match): the match pair plus a non-colour cue. */
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
  /**
   * Re-emit a captured SGR foreground code (Issue #165). The one styling path
   * that is not a theme-token lookup: `code` came from this theme's own syntax
   * tokens via `highlightCode`, captured by `inkRuns`, so the minimap can paint
   * a row in the colour the pane already showed without inventing one.
   */
  syntax(code: string, text: string): string;
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
    // Current match: the same pair plus a non-colour cue, so it never differs
    // from every other match by colour alone (Issue #194). Underline mirrors
    // pi's own tui-renderer; hosts without it fall back to inverse, then bold,
    // and only a host with none of the three collapses to the plain pair.
    // A token-inverted pair would pass a ThemeColor name to theme.bg(), which
    // throws at runtime (theme.bg rejects unknown keys) and fails typecheck.
    searchCurrent: (t) => {
      const match = theme.bg("searchMatchBg", theme.fg("searchMatchText", t));
      if (typeof theme.underline === "function") return theme.underline(match);
      if (typeof theme.inverse === "function") return theme.inverse(match);
      if (typeof theme.bold === "function") return theme.bold(match);
      return match;
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
    // Pass-through, not a lookup: the code was captured from this theme's own
    // syntax tokens, so re-emitting it verbatim IS following the theme. The fg
    // reset keeps an enclosing background (the map's viewport band) intact.
    syntax: (code, t) => `\x1b[${code}m${t}\x1b[39m`,
  };
}

/**
 * The theme tokens the viewer's retained content depends on: `highlightCode`'s
 * syntax set (its cli-highlight theme closure plus the `mdCodeBlock` fallback
 * for a language it cannot highlight) plus the diff composer's roles —
 * `styleCommitMessage`'s subject/body and `styleDiffLines`' muted/accent and
 * dedicated diff tokens (Issue #141). Kept next to `makeStyleKey` so the
 * fingerprint and the stylers' own token sets cannot drift silently.
 */
const VIEWER_STYLE_TOKENS: readonly ThemeColor[] = [
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "muted",
  "mdCodeBlock",
  // Diff composer roles (Issues #120/#141): the commit message's text and
  // the diff classifier's accent + toolDiff* set. `muted` is shared above.
  "text",
  "accent",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
];

/**
 * Fingerprint of the theme-token ANSI sequences the retained-content stylers
 * depend on: `getFgAnsi` for every token in {@link VIEWER_STYLE_TOKENS}, plus
 * the color mode. One key covers both retained-content kinds (highlighted
 * file lines and composed diff lines) — over-approximating costs at most one
 * wasted restyle when only an unrelated role changed, while
 * under-approximating would leave stale colours on screen (the bug class of
 * Issues #136/#141). The key is defined here because the cache cost is about
 * exactly this: a theme switch changes it and pays one restyle per retained
 * view actually restyled (the open file/diff on invalidate, each cached file
 * on its next open), while resize/cell-size invalidates leave it unchanged
 * and pay nothing. The closure is lazy so it observes switches on the live
 * theme proxy, not the theme at construction time.
 */
export function makeStyleKey(theme: Theme): () => string {
  return () =>
    [...VIEWER_STYLE_TOKENS.map((token) => theme.getFgAnsi(token)), theme.getColorMode()].join(
      "|",
    );
}
