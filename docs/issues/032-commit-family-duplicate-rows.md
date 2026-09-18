# Issue #032 — Expanded Commit Family Duplicates Ancestor Rows and Mis-Nests

| Field | Value |
| :--- | :--- |
| ID | #032 |
| Title | Expanded commit family emits ancestor rows under the wrong anchor and duplicates them |
| Type | Bug |
| Severity | Medium |
| Component | `navigator.ts` |
| Status | Resolved |

## Summary

Expanding a commit's ancestor family (`Enter` on a `commit` row, Issue #030)
produced **duplicated and mis-nested rows**. For history `bbb → aaa → 999`
(expand `bbb`), the render was:

```
▶ bbb2222  child
  aaa1111  mid          ← intended child of bbb (depth 1)
    aaa1111  mid        ← DUPLICATE: aaa re-emitted after aaa's own top-level row
  9998888  base
    9998888  base       ← DUPLICATE: 999 re-emitted after 999's own top-level row
```

The ancestor chain did not nest under the expanded commit; instead each family
child was re-inserted after the top-level history row that shared its hash.

## Root cause

`gitRows()` built a single flat `familyRows` list via DFS, then in the history
loop did:

```js
for (const commit of git.history) {
  rows.push({ kind: "commit", commit });
  rows.push(...familyRows.filter((r) => r.commit.shortHash === commit.shortHash));
}
rows.push(...familyRows.filter((r) => !git.history.some((c) => c.shortHash === r.commit.shortHash)));
```

The filter keyed on the **child's own hash**, so when the loop reached a commit
that was both a top-level history entry and a family child (e.g. `aaa`), it
appended that child row again — once as a nested child of `bbb`, once as a
sibling of `aaa`'s top-level row. The nesting landed under whichever top-level
row shared the child's hash, not under the expanded anchor.

## Fix

Build the family as a **per-anchor block**: a `Map<shortHash, GitRow[]>`
keyed on the expanded commit, each value a DFS-ordered chain rooted at that
commit. Emit the whole block once, directly after its expanded anchor's
top-level row:

```js
const familyByAnchor = new Map<string, GitRow[]>();
// … DFS, pushing into `out` per expanded commit, capped by depth/rows …
for (const commit of git.history) {
  rows.push({ kind: "commit", commit });
  const family = familyByAnchor.get(commit.shortHash);
  if (family) rows.push(...family);
}
```

Now expanding `bbb` renders the full chain nested beneath `bbb` in depth order,
and `aaa`/`999` still appear once each as their own top-level history rows —
duplicate-free. Global dedup (`added` set) and the `FAMILY_MAX_ROWS` cap are
preserved across all expanded commits.

## Tests

`test/navigator.test.ts` — "nests the ancestor family under the expanded
commit without duplicating rows (Issue #030)" asserts the rendered git-pane
hash order is exactly
`["bbb2222", "aaa1111", "9998888", "aaa1111", "9998888"]` — nested chain under
`bbb` first, then the flat top-level rows — and that each ancestor appears
exactly twice (nested + flat), never three times.

Verified to fail against the pre-fix code (order was
`["bbb","aaa","aaa","999","999"]` — duplicated, no nesting under `bbb`) and
pass after the fix.
