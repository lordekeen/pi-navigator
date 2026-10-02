# Issue #124: File-Tree and Git Selection Anchored by Index, Not Identity

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Medium
- **Components**: [`navigator.ts`](../../navigator.ts) (`setTree`, `setGitState`, `alignFilesCursor`, `handleFilterInput`)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M1](../exploration/ui-skill-compliance-audit.md#medium)

## Description

Both data setters keep the cursor by **position**, not by the item under it:

```ts
// navigator.ts:324 (setTree)
this.filesCursor = moveCursor(this.filesRows().length, this.filesCursor, 0);
// navigator.ts:341 (setGitState)
this.gitCursor  = moveCursor(this.gitNavRows().length, this.gitCursor, 0);
```

`moveCursor` only clamps the number against the new row count. When the refresh poll
(`refreshData`, 3–10 s) rebuilds the tree with a file added or removed **above** the cursor, the
selection silently lands on a different file, with no visual cue and no way to notice before acting
on it.

The identity machinery already exists — `alignFilesCursor(relPath)` (`navigator.ts:1062`) matches by
`relPath` — but it is wired to exactly one caller: the git→files jump (`navigator.ts:828`).

The filter path has the same defect in a more visible form: every keystroke resets
`filesCursor = 0` (`handleFilterInput`), so refining a query drops the user at the top of the list
instead of keeping the item they had selected (when it still matches).

## Reproduction Steps

1. Open the overlay and select a file in the middle of the tree.
2. In another terminal, create or delete a file **above** it in the same directory.
3. Wait for the poll refresh: the cursor now highlights a different file.

## Root Cause

Selection state is an integer index, and the setters treat "still in range" as "still correct". The
standard requires anchoring by identity and clamping only when the item is gone.

## Proposed Resolution

- Re-anchor by `relPath` in `setTree` and `setGitState`, reusing `alignFilesCursor`; fall back to
  clamping when the path is gone (deleted, filtered out, or a collapsed directory).
- In `handleFilterInput`, preserve the currently selected path when it still matches the new query;
  otherwise clamp to the nearest surviving row rather than jumping to index 0.
- Consider the open file (`openRelPath`) as the preferred anchor when the cursor item disappears.

## Acceptance Criteria

- [ ] A tree refresh preserves the selected path whenever it survives
- [ ] A git refresh preserves the selected row whenever it survives
- [ ] Refining a filter keeps the selected item when it still matches
- [ ] When the item is gone, the cursor clamps (no jump to an unrelated item)
- [ ] Tests cover survive / removed / collapsed-directory cases for both panes
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M1](../exploration/ui-skill-compliance-audit.md) — rule:
  `overlays-and-components.md` §Selection *"Anchor selection by identity, not index… Index-based
  selection silently retargets onto a different item"* (also `anti-patterns.md`, "defects that
  survive code review").
- Related: [#105](105-search-filter-multi-char-paste-surrogate-pairs.md) (filter input path)

## Resolution

Selection is re-anchored by identity: `setTree` captures the anchor `relPath` *before* swapping the root, `setGitState` re-anchors through `gitRowIdentity` (`file:<relPath>` / `commit:<shortHash>`, returning `null` for group rows so they clamp instead of false-matching), and `keepFilterSelection` keeps a still-matching selection while a filter is refined instead of resetting the cursor to 0.

Verified: `npm run typecheck` and `npm test` green (20 suites).

