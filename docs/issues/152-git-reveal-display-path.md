# Issue #152: The Git-Pane Reveal Uses the Display Path — Untracked Directory Rows Never Align the Files Cursor

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Low
- **Component(s)**: `navigator.ts`, `docs/issues/150-tree-surface-leaks.md`, tests

---

## Description

Directory records in the git panel render with a trailing slash: `buildGitRows`
maps every changed file through `changedPath` (`git_view.ts:25-26`,
`file.isDir === true ? file.relPath + "/" : file.relPath`), and those rows are
`kind: "file"`. The git-pane Enter reveal then passes that display path
verbatim:

```ts
if (this.root) this.expandTo(this.root, row.relPath);
...
this.alignFilesCursor(row.relPath);
```

Tree nodes are slash-free — Issue #146 normalizes the porcelain `?? dir/`
record into `GitChangedFile.isDir` and stores `relPath: "src/newdir"` — so two
things happen for an untracked-directory row (`row.relPath === "src/newdir/"`):

1. **`alignFilesCursor` is a silent no-op** (the bug): no files row has
   `node.relPath === "src/newdir/"`, so `findIndex` returns -1 and the cursor
   never moves. Tracked-file rows reveal correctly; directory rows do not.
2. **`expandAncestors` expands the longest existing prefix** (`"src"`): it
   filters the empty trailing segment, so the desired expansion happens — but
   this was an unintended consequence of Issue #150's `findNode` removal (the
   old `findNode(root, "src/newdir/")` compared slash-free node paths, returned
   `null`, and expanded nothing). Tree-absent rows (staged deletions) behave the
   same way: their parent prefix now expands where it previously did nothing.
   Confirmed by an open-code-review finding and by code reading; it exceeds
   #150's documented "no behavior change" claim.

The prefix expansion is *desirable* reveal behavior; the cursor no-op is not.
This issue makes the reveal intentional and complete.

## Fix

Normalize the reveal path once in the git-pane Enter branch:

```ts
const treePath = row.relPath.replace(/\/+$/, "");
if (this.root) this.expandTo(this.root, treePath);
...
this.alignFilesCursor(treePath);
```

`openRelPath(row.relPath)` keeps the display path — what gets opened is
unchanged, and opening a directory row as a file is out of scope.

Tests (model: "git-pane Enter expands the file's collapsed ancestor via
`expandTo`, visible after switching back"):

- an untracked-directory row (`withGit(harness, { unstaged: [{ relPath:
  "src/newdir", code: "??", isDir: true }] })`, tree built from
  `entriesFromPaths(["src/newdir/", "src/other.ts"])`) must expand `src` **and**
  land the files cursor on the `src/newdir` row after switching back — the
  cursor assertion fails at HEAD and passes with the fix;
- a staged-deletion row must expand the longest existing ancestor prefix.

Also correct #150's Resolution wording: the reveal's prefix expansion is a
deliberate outcome, not part of a "no behavior change" claim.

## Acceptance Criteria

- [x] The untracked-directory reveal moves the files cursor onto the
  `src/newdir` row — red at the previous revision (the cursor assertion fails
  while `newdir` still appears via prefix expansion), green with the fix.
- [x] `src` expands on the same reveal (pinned; already true before the fix,
  now intentional).
- [x] A staged-deletion row expands the longest existing ancestor prefix, with
  a guard-pin test.
- [x] #150's Resolution records the reveal expansion as intended behavior.
- [x] `npm run typecheck` and `npm test` green: 22 suites / 930 cases.

## Resolution

Fixed (2026-10-04), version 0.14.16:

- **`navigator.ts`** — the git-pane Enter branch normalizes the reveal path once
  (`row.relPath.replace(/\/+$/, "")`), passes the tree path to `expandTo` and
  `alignFilesCursor`, and keeps `openRelPath(row.relPath)` on the display path.
  `expandAncestors` and `alignFilesCursor` are unchanged.
- **Tests** — the untracked-directory case fails red on the cursor assertion
  without the fix (`expected '│    ▸ newdir …' to contain '▶ '`) and passes
  with it; the staged-deletion case pins the intended longest-prefix expansion.
  The files-pane signal excludes lines containing the display path because the
  git row itself carries both `newdir` and a selection arrow — a naive
  `includes` assertion would false-pass.
- **`docs/issues/150-tree-surface-leaks.md`** — Resolution notes the reveal's
  prefix expansion as deliberate and points at #152 for the path normalization.

## References

- #064 — the git-pane Enter reveal (`expandTo` + `alignFilesCursor`).
- #146 — the `?? dir/` slash normalization into `GitChangedFile.isDir`.
- #150 — the `findNode` removal this finding is a consequence of.
- Found by an open-code-review sweep over `3f1752a..ea25a83`
  (2026-10-04), finding 2 of 4, and confirmed by the earlier two-commit run.
