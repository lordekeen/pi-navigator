/**
 * ANSI / styled-text grammar (Issue #172): strip, measure, slice, truncate
 * and inspect strings that carry SGR escape sequences. Pure, and knows
 * nothing about a ViewerFile, a row or a pane — the viewer pipeline and the
 * pure pane modules both consume it.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Remove every CSI/OSC escape sequence; the result is plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// C0 controls except tab and newline, DEL, C1, and the two Unicode line
// separators — the active bytes a terminal acts on rather than prints.
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Strip the terminal-active bytes from untrusted repo content (Issue #201):
 * C0 controls except `\n`, DEL, C1 and the Unicode line separators, with a tab
 * mapped to one space. Rendered rows may only carry printable text plus `\n`,
 * so a raw ESC/BEL in a filename, commit subject or diff line — all of which
 * the repo controls — would otherwise let content corrupt or escape the
 * overlay. Idempotent and pure.
 */
export function sanitizeText(text: string): string {
  return text.replace(/\t/g, " ").replace(CONTROL_PATTERN, "");
}

/** Visible cell width of a possibly styled string (ANSI is zero-width). */
export function visibleTextWidth(text: string): number {
  return visibleWidth(stripAnsi(text));
}

// Sticky ANSI escape sequence matcher (CSI + OSC) reused by sliceStyled and
// inkRuns; `lastIndex` is set per call site so it scans the full string
// without allocating a suffix copy per character (Issue #083).
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x1b\x07]*(?:\x1b\\|\x07))/y;

/**
 * Escape-sequence spans of a styled string, ascending and non-overlapping:
 * the byte ranges that are grammar, not text (Issue #181). A sequence cut off
 * at the end of the line counts too — a terminal keeps consuming it, so the
 * rest of the line is not readable text.
 */
export function escapeSpans(styled: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < styled.length) {
    const at = styled.indexOf("\x1b", i);
    if (at === -1) break;
    ANSI_ESCAPE_RE.lastIndex = at;
    const esc = ANSI_ESCAPE_RE.exec(styled);
    if (esc === null) {
      spans.push({ start: at, end: styled.length });
      break;
    }
    spans.push({ start: at, end: at + esc[0].length });
    i = at + esc[0].length;
  }
  return spans;
}

/**
 * One visible run of styled text with the SGR foreground code active over it
 * (Issue #165). `color` is the raw parameter string a re-emitter can paste
 * back into `\x1b[<color>m` ("38;5;240", "38;2;1;2;3"), or null for the
 * theme's default foreground. The viewer minimap measures ink and colour from
 * these runs, so the ANSI grammar stays in one module.
 */
export interface InkRun {
  text: string;
  color: string | null;
}

/**
 * Advance the active foreground over one SGR parameter list. Handles the two
 * colour introducers (38;5;N and 38;2;R;G;B), the two resets (0 and 39), and
 * leaves the colour untouched for every other code — including 48;* (a
 * background) and 58;* (the pretty-print underline colour), which are not the
 * text's foreground.
 */
function nextForeground(current: string | null, params: string): string | null {
  // An empty parameter list IS SGR 0 (ECMA-48), so `\x1b[m` resets exactly
  // like `\x1b[0m` — a real code, not the malformed one it resembles.
  const tokens = params === "" ? ["0"] : params.split(";");
  let value = current;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "0" || token === "39") {
      value = null;
      continue;
    }
    if (token !== "38") continue;
    const kind = tokens[i + 1];
    if (kind === "5" && tokens[i + 2] !== undefined) {
      value = `38;5;${tokens[i + 2]}`;
      i += 2;
      continue;
    }
    if (kind === "2" && tokens[i + 4] !== undefined) {
      value = `38;2;${tokens[i + 2]};${tokens[i + 3]};${tokens[i + 4]}`;
      i += 4;
    }
  }
  return value;
}

export function inkRuns(styled: string): InkRun[] {
  const runs: InkRun[] = [];
  let text = "";
  let color: string | null = null;
  const flush = (): void => {
    if (text.length > 0) runs.push({ text, color });
    text = "";
  };
  let i = 0;
  while (i < styled.length) {
    ANSI_ESCAPE_RE.lastIndex = i;
    const esc = ANSI_ESCAPE_RE.exec(styled);
    if (esc) {
      const seq = esc[0];
      i += seq.length;
      // CSI sequences end in a letter; only "m" (SGR) carries styling.
      // `\x1b[m` is the shortest of them (empty parameter list = reset),
      // so there is no length floor beyond the two introducer bytes.
      if (seq.startsWith("\x1b[") && seq.endsWith("m")) {
        const next = nextForeground(color, seq.slice(2, -1));
        if (next !== color) {
          flush();
          color = next;
        }
      }
      continue;
    }
    text += styled[i] ?? "";
    i += 1;
  }
  flush();
  return runs;
}

/**
 * Column-slice a styled line for horizontal scrolling. Escape sequences are
 * preserved as encountered; the result is reset-terminated when any styling
 * was included. Columns are terminal cells (Issue #059): a wide character
 * occupies two of them, so a glyph whose first cell falls inside the window is
 * emitted whole — callers hard-cut any transient one-cell overflow (padTo).
 */
export function sliceStyled(styled: string, start: number, end: number): string {
  let out = "";
  let column = 0;
  let styledOut = false;
  let i = 0;
  while (i < styled.length) {
    ANSI_ESCAPE_RE.lastIndex = i;
    const esc = ANSI_ESCAPE_RE.exec(styled);
    if (esc) {
      out += esc[0];
      styledOut = true;
      i += esc[0].length;
      continue;
    }
    const code = styled.codePointAt(i);
    if (code === undefined) break; // unreachable: i walks valid code points
    const ch = String.fromCodePoint(code);
    if (column >= start && column < end) out += ch;
    column += visibleWidth(ch);
    i += ch.length;
    if (column >= end) break;
  }
  if (styledOut && out.length > 0 && !out.endsWith("\x1b[0m")) out += "\x1b[0m";
  return out;
}

/**
 * Hard-truncate a (possibly styled) string to a visible width with no
 * ellipsis. `truncateToWidth`'s default `"..."` ellipsis is wrapped in
 * `\x1b[0m` resets, which close any enclosing style and render the ellipsis
 * in bright default (Issue #010); overlay callers instead pass an empty
 * ellipsis so they can re-style or pad the cut themselves. This helper is
 * that convention in one named place: it delegates to
 * `truncateToWidth(text, width, "")`, so like `sliceStyled` the result is
 * reset-terminated when a cut actually happens (a bare `\x1b[0m` closes an
 * open style at the cut, which cannot leak into later padding), and it never
 * splits a wide (CJK) character — the contiguous prefix simply under-fills
 * the last cell.
 */
export function hardTruncate(text: string, width: number): string {
  return truncateToWidth(text, width, "");
}
