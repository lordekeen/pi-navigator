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
    searchCurrent: (t) => theme.underline(theme.bg("searchMatchBg", theme.fg("searchMatchText", t))),
    frame: (t) => theme.fg("dim", t),
  };
}
