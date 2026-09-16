# Issue #009: CRLF Line Endings Break the Viewer Layout (Carriage Return Resets Cursor)

- **Status**: Resolved
- **Type**: Bug
- **Severity**: High
- **Component**: [`loadFile`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L176-L243) / [`highlightText`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L168-L174)

---

## Description

When the user opens a file that uses CRLF (`\r\n`) line endings, the viewer pane layout breaks: the gutter, left border, and the start of each line's content are overwritten, leaving the pane visually garbled. The bug is reproducible on every `.ts` file in this repository, because the repo's own sources are checked out with CRLF terminators. The viewer never normalizes carriage returns, so a literal `\r` reaches the terminal on every line.

## Reproduction Steps

1. Launch pi-navigator in a repository whose sources use CRLF endings (this repo qualifies).
2. Select and open any `.ts` file (e.g. `viewer.ts`, `navigator.ts`).
3. Observe the viewer pane: the line-number gutter and the `│` separator on the left are blanked/overwritten, and the first columns of each line's text are missing.

## Root Cause Analysis

1. In [`loadFile`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L201-L211), the file is read with `readFile(absPath, "utf8")` (or `readCappedHead` for oversized files), which preserves the on-disk line terminators verbatim — CRLF for this repo's files.
2. The text flows into [`expandTabs`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L30-L49) and `expanded.split("\n")`. Splitting on `\n` leaves a trailing `\r` on every line of a CRLF file.
3. [`highlightText`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L168-L174) passes the text to `highlightCode`, which also keeps the `\r` on each line. The returned `file.lines` therefore carry a trailing `\r`.
4. In [`buildRightRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1027-L1033) each row is built as `" " + gutter + "│" + " " + row.text` and then padded to the pane width with [`padTo`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L879). Because `row.text` ends in `\r`, the rendered row string is `<content>\r<padding spaces>`.
5. When the terminal prints that row, the `\r` moves the cursor back to column 0, and the trailing padding spaces then overwrite the gutter, the border, and the first columns of the content — breaking the layout.
6. `visibleWidth`/`stripAnsi` count `\r` as a one-cell character (they strip ANSI escapes only), so the existing render width-safety tests never flagged the overflow — the rows are "width safe" on paper while still garbling the screen. The unit tests also write their fixture files with `writeFile(path, "...\n")`, which uses LF, so the bug was never exercised.

## Potential Solution

Normalize line endings in `loadFile` immediately after the read, before `expandTabs`:

```typescript
// \r\n is folded to \n first so no line gains a spurious blank.
raw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
```

This keeps every `\r` (whether from CRLF or a lone CR) out of the highlighting, line-counting, and rendering paths. A lone trailing `\r` produced by a capped read of an oversized file becomes a trailing `\n`, adding at most one blank line to an already-truncated head — acceptable, and the truncation notice still renders.

## Acceptance Criteria

- [x] Opening a CRLF file renders the gutter, border, and full line content correctly.
- [x] No `file.lines` entry contains a `\r` after `loadFile` returns.
- [x] Regression test covers a CRLF `.ts` fixture.
- [x] Existing 104 tests still pass; typecheck clean.
