# Issue #083: `sliceStyled` Only Handles CSI Sequences, Ignoring OSC Hyperlink Sequences

- **Status**: Open
- **Type**: Technical Debt / Robustness
- **Severity**: Low
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L79-L105)

---

## Description

In [`viewer.ts` L79-105](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L79-L105), [`sliceStyled`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L81) uses a sticky regex to identify and bypass ANSI escape sequences:

```typescript
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;

export function sliceStyled(styled: string, start: number, end: number): string {
  let out = "";
  let column = 0;
  let styledOut = false;
  let i = 0;
  while (i < styled.length) {
    CSI_RE.lastIndex = i;
    const esc = CSI_RE.exec(styled);
    if (esc) {
      out += esc[0];
      styledOut = true;
      i += esc[0].length;
      continue;
    }
    // ...
```

`CSI_RE` only matches Control Sequence Introducer (CSI) escapes beginning with `\x1b[`. Operating System Command (OSC) sequences (such as OSC 8 terminal hyperlinks, `\x1b]8;;url\x1b\` or `\x1b]8;;url\x07`) are not matched.

If an OSC sequence appears in viewed text (e.g. from future pi-tui hyperlink emission, markdown link rendering, or git commit messages containing terminal escape sequences), `sliceStyled` treats the escape characters as printable text. This causes:
1. Slicing through the middle of an escape sequence, emitting raw terminal control fragments.
2. Inaccurate column width calculations (`visibleWidth` evaluating escape characters).

## Root Cause Analysis

Regex matcher in `sliceStyled` only accounts for CSI sequences and omits OSC escape syntax.

## Potential Solution

Broaden the sequence matcher to detect both CSI and OSC escape sequences:

```typescript
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x1b\x07]*(?:\x1b\\|\x07))/y;
```

Update `sliceStyled` to use `ANSI_ESCAPE_RE`.

## Acceptance Criteria

- [ ] `sliceStyled` recognizes OSC sequences (including OSC 8 hyperlinks) and preserves them without splitting mid-sequence.
- [ ] CSI sequence handling and performance remain unchanged.
- [ ] Unit tests in [`test/viewer.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/viewer.test.ts) cover string slicing with OSC 8 sequences.
