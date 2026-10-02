# Issue #128: Directory "Contains Changes" Is Signalled by Colour Alone

- **Status**: Resolved
- **Type**: Bug / Accessibility
- **Severity**: Medium
- **Components**: [`files_view.ts`](../../files_view.ts) (`buildFileRow`, directory branch)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M5](../exploration/ui-skill-compliance-audit.md#medium)

## Description

A directory row whose subtree contains modifications is distinguished by **warning colour only**:

```ts
// files_view.ts:76
const nameStyle = hasChanges(row.node) ? T.warning : row.node.hidden ? T.dim : T.muted;
```

There is no glyph, no badge and no text twin. Compare the **file** row branch, which carries the git
code in a dedicated badge column (`files_view.ts:78`, `badge = " " + codeText(row.node.gitCode, T)`).

Consequence: in a monochrome terminal, a `NO_COLOR` pipeline, or for a colour-blind user, a directory
with changes and a directory without are visually identical — the rollup that tells you *where* to
look before expanding is unreadable.

## Reproduction Steps

1. Open the overlay in a repo where one source directory has modified files and a sibling does not.
2. (In a theme with colour) the changed directory's name is tinted.
3. Strip colour (or view in monochrome) — the distinction disappears entirely.

## Root Cause

The design's colour-role table (`DESIGN.md`) assigns `warning` to "has changes" rows and the file
branch pairs that role with a badge; the directory branch reuses the colour without the twin, so the
signal has no non-colour encoding.

## Proposed Resolution

Give the directory row a text/glyph twin, reusing data that already exists:

- a rollup marker in the badge column the file rows already reserve (so columns do not shift), e.g.
  the count of changed descendants or a single `•` marker; or
- a distinct disclosure/rollup glyph beside the directory marker (`▾`/`▸`) when `hasChanges` is true.

Derive it from the existing aggregate (`hasChanges`, plus `additions`/`deletions` where present) — no
new plumbing, no new theme token.

## Acceptance Criteria

- [x] A directory containing changes is identifiable **without** colour
- [x] Columns do not shift between rows (the badge/marker cell is reserved on every row)
- [x] Width-safety holds at 120×36, 100×28, 80×24 and the narrow tier
- [x] Icons-on and icons-off both render the twin correctly
- [x] Render test asserts the non-colour signal
- [x] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M5](../exploration/ui-skill-compliance-audit.md) — rule: `SKILL.md` invariant 4
  *"Never encode state in colour alone. Every colour signal has a text or glyph twin."*
  (`theming.md` §Semantic, not decorative)
- Related: [#026](026-git-group-dim-tone-collapses-to-muted.md) (colour-role collapse, resolved),
  [#111](111-icon-glyphs-brand-logos-and-v3-tofu.md) (glyph column)

## Resolution

A directory that contains changes now carries a `•` in the right-aligned badge cell that file rows already reserve for git codes, in the same warning tone — the colour is reinforcement, no longer the sole carrier, so the state survives a monochrome terminal and reaches colour-blind readers.

Chosen over a name suffix or a disclosure-arrow change because it occupies a cell the layout already reserves (columns never shift), is punctuation rather than a letter (it cannot be misread as an `M`/`A`/`D`/`?` status code), and is appended *after* the body budget is computed, so the name loses cells first and the glyph survives whole at every real pane width (≥ `LEFT_COLUMN_MIN` 24). It needs no Nerd Font, so it renders with icons on or off, and it stays distinct from the `▸`/`▾` disclosure arrow, which remains glued to the indent.

Reuses `tree.ts`'s existing `hasChanges()` — no new tree logic. Tests pin the twin's presence for a changed directory and its absence for an unchanged one, its survival with colour stripped (the identity theme shows the literal glyph, the tone theme the warning channel), exact-width rows at narrow pane widths, and the unchanged file-row git-code badge.

Verified: `npm run typecheck` and `npm test` green (20 suites).

