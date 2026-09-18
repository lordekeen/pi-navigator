# Issue #031 — Nerd Font Icons Float at a Fixed Left Column on Nested Entries

| Field | Value |
| :--- | :--- |
| ID | #031 |
| Title | Nerd Font icons align to the left edge instead of moving with the tree depth |
| Type | Bug |
| Severity | Low |
| Component | `navigator.ts` |
| Status | Resolved |

## Summary

With `PI_NAV_ICONS=1`, the file-tree icon column was rendered **before** the
depth indent:

```
arrow + icon + indent + marker + name
```

So the glyph sat at a fixed column right after the cursor arrow regardless of
depth, while the indented name/marker floated rightward. On nested entries the
icon and the label it belonged to were visually disconnected — the icon looked
like it belonged to the parent column rather than to its own row.

## Root cause

`buildFileRow` (navigator.ts) composed the dir/file row body as
`icon(nameStyle) + T.dim(indent + marker) + nameStyle(label)`. The icon was the
first styled segment, so it always landed at the same absolute column; only the
indent+marker/name shifted right with `depth`.

The match (filter) branch was unaffected: its `prefix` already encodes the
path context, so the icon-before-prefix layout reads fine there and was left
as-is.

## Fix

Reorder the dir and file branches so the icon sits **after** the indent and
immediately before the marker/name:

```
arrow + indent + icon + marker + name   (dir)
arrow + indent + icon + name            (file)
```

The glyph now moves with the depth and stays glued to the label it belongs to.
Width accounting (`iconW`, `room`, `gap`) is unchanged — `iconW` still
reserves exactly one cell whether the icon sits before or after the indent, so
truncation and the badge column stay width-safe.

## Tests

`test/render.test.ts` — "glues the Nerd Font icon to the label at every depth
(Issue #031)" asserts, after stripping ANSI:

- `src` (depth 0): glyph precedes the expanded marker `▾`.
- `components` (depth 1, collapsed): glyph column ≥ 5 (after border + cursor
  gap + 2-space indent), and precedes the collapsed marker `▸` — the exact
  condition the old fixed-column layout violated (glyph was at column 3).
- `Button.tsx` (depth 2, after expanding `components`): file glyph precedes
  the name and sits after the 4-space indent.

Verified to fail against the pre-fix `navigator.ts` (glyph at column 3) and
pass after the reorder.
