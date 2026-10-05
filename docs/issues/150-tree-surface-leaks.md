# Issue #150: Tree Surface Leaks — Test Support Out, One Mutation Door, No Back-Pointer

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Low
- **Component(s)**: `tree.ts`, `types.ts`, `navigator.ts`, tests

## Description

The architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #9) claimed `tree.ts`'s
21-export surface exposes a 14-field mutable `FileNode` whose derived flags callers read.
Re-validated against `main@31f3838` (v0.14.12, after Issues #140–#148):

1. **The audit's premise is stale.** `parent`, `lowerName`, `lowerRelPath` and
   `subtreeChanged` have **zero readers outside `tree.ts`** — in production or tests. The
   derived data is already internal in practice; only the type still declares it.
2. **What actually leaks:**
   - `FileNode.parent` is a pure back-pointer: written at four `makeNode` call sites and
     read by exactly one function, `expandAncestors`, which walks it upward.
   - `navigator.ts:701` (`node.expanded = …` in `toggleDir`) is the only graph mutation
     performed outside `tree.ts`.
   - `entriesFromPaths` has had **zero production callers since #146** (its ~18 lines
     build `TreeEntry[]` from slash-suffixed fixture paths) yet sits in the module's
     export surface; three test files import it.
   - `findNode` has exactly one production caller — `navigator`'s git-pane Enter reveal
     (line 954) — and is imported by two test files.
   - `walkTree` is the internal traversal engine for five helpers (`applyGitCodes`,
     `expandedUntrackedDirs`, `collectExpanded`, `reapplyExpansion`, `findNode`); its
     *export* is consumed only by tests.
3. **The row projection is rejected, not deferred.** Making rows stop carrying `node`
   would churn ~14 hand-built `FileNode` fixtures in `files_view.test.ts` and a further
   ~10 `.expanded` setup mutations, while the derived flags it would encapsulate are
   already unread by callers and the renderer legitimately reads presentation values.
   The churn is larger than the win (recorded under Non-goals).

## Frozen Design (2026-10-04, validated then frozen by the user)

1. **Test support leaves the module.** `entriesFromPaths` and `findNode` move verbatim to
   a new `test/tree_fixtures.ts` (which imports `walkTree` and the `FileNode` type from
   `../tree`). `tree.ts`'s export list drops both; `test/render.test.ts`,
   `test/tree.test.ts` and `test/navigator.test.ts` re-point their imports. The #058
   `entriesFromPaths` suite and every `findNode` call site stay as they are — only the
   module path changes. `test/tree_fixtures.ts` is invisible to the suite counter
   (`vitest.config.ts` collects `test/**/*.test.ts`; `docs.test.ts` filters on the same
   suffix).

2. **The back-pointer dies; `expandAncestors` becomes root-anchored.**
   `FileNode` drops `parent?: FileNode` (14 → 13 fields); `makeNode` loses its parameter
   and its four call sites drop `current`/`null`. `expandAncestors(root, relPath)` walks
   the path's segments from the root and marks every non-root ancestor expanded, never
   the node itself — the current semantics. The root's own `expanded` flag is no longer
   set; it is inert (`buildTree` sets it `true`, and nothing reads it: `flattenVisible`
   starts at the root's children and the probe helpers guard with `node.relPath`), so the
   skip is not observable. `navigator`'s `expandTo` takes `(root, relPath)` and the
   git-pane Enter path calls it directly — `findNode` leaves `navigator`'s imports.

3. **One mutation door for expansion.** `tree.ts` gains
   `setExpanded(node, expanded?)` (negate when `expanded` is omitted); `navigator.toggleDir`
   delegates to it and keeps its `treeVersion++` / `touch()` cache bookkeeping. After
   this, every write to the node graph originates in `tree.ts`.

4. **Non-goals (explicit, so they are not re-opened by drift):** the row projection
   (rejected above); `walkTree` stays exported — its prune/stop contract is the traversal
   engine's own semantics and is not observable through any consumer, so the direct pins
   are its only coverage; `FileNode` stays exported (the session holds the root).

## Acceptance Criteria

- [x] `FileNode` has 13 fields and no `parent` anywhere in the source; `makeNode` takes no
  parent parameter.
- [x] `expandAncestors(root, relPath)` walks segments (no back-pointer), sets every
  non-root ancestor's `expanded`, and its test drives the new signature.
- [x] No direct `node.expanded =` write exists outside `tree.ts`; `setExpanded` is the
  only expansion mutation and `navigator.toggleDir` delegates to it.
- [x] `tree.ts` no longer exports `entriesFromPaths` or `findNode`; both live in
  `test/tree_fixtures.ts`; every former call site is unchanged except its import path.
- [x] No behavior change: full suite green at 22 suites / 927 cases, including the #058
  fixture suite and the #064 expansion/reveal pins.
- [x] `npm run typecheck` green, no new non-null assertions, suite count unchanged.

## Resolution

Implemented as designed (2026-10-04), version 0.14.14:

- **`test/tree_fixtures.ts` (new)** — `entriesFromPaths` and `findNode` moved verbatim
  (imports `walkTree` + `TreeEntry` from `../tree`); `tree.ts` no longer exports either, so
  `tree.ts`'s surface is now the graph type plus the operations the app performs. The three
  test files re-point only their import lines; the #058 suite and every `findNode` call
  site are otherwise untouched.
- **`FileNode` 14 → 13 fields** — `parent?: FileNode` deleted (types.ts) and `makeNode`
  loses its parameter (four call sites updated). The back-pointer had exactly one reader.
- **`expandAncestors(root, relPath)`** — root-anchored segment walk (`slice(0, -1)` +
  `find` by name, no indexed access under `noUncheckedIndexedAccess`): every non-root
  ancestor of the path is expanded, the node itself never. The root's own flag is no
  longer touched and is inert (`buildTree` sets it true; nothing reads it). The test now
  calls the new signature directly instead of looking the node up first.
- **`setExpanded(node, expanded?)`** — the one expansion mutation door; `navigator.toggleDir`
  delegates to it and keeps its `treeVersion++` / `touch()` cache bookkeeping. Every
  production write to `FileNode.expanded` now originates in `tree.ts`
  (`buildTree`, `reapplyExpansion`, `setExpanded`, `expandAncestors`).
- **Non-goals unchanged** — no row projection, `walkTree` stays exported with the recorded
  rationale, `FileNode` stays exported (the session holds the root).

The git-pane reveal's prefix expansion for git rows absent from the tree is a deliberate
outcome, and the trailing-slash reveal path is normalized in #152.

Verification: `npm run typecheck` clean; `npm test` **22 suites / 927 cases** (count
unchanged — the change is pure surface surgery).

## References

- [Architecture review 2026-10-03](../audits/architecture-review-2026-10-03.html) — candidate #9
  ("FileNode is the real interface; make it opaque"), rescoped here after re-validation.
- #046 / #090 — the traversal order, prune and stop semantics `walkTree` still pins.
- #058 — the `entriesFromPaths` untracked-directory suite.
- #064 — the files-tree mutation-version agreement `toggleDir` guards.
- #103 — cited by #149; unrelated to this change but shipped in the same audit sweep.
- #146 — `readGitTree` removed `entriesFromPaths`' last production caller, which is why
  the fixture builder is now test-only.
