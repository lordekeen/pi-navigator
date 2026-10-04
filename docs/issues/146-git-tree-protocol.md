# Issue #146: The Git Path Protocol — One Tree Entry, One Slash Normalization

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Medium
- **Component(s)**: `git.ts`, `session.ts`, `tree.ts`, `types.ts`, `git_view.ts`, tests

## Description

The architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #6) found `git.ts`'s
cwd-relative path protocol stitched together by its caller and the `?? dir/` trailing-slash
marker interpreted in two modules. Re-validated against `main@b2a0f40` — the friction is
intact, but it moved address after #140 and two audit details are stale:

1. **Four-call stitching, now in `session.ts`** (the audit cited `index.ts`, which #140's
  session extraction superseded): `detectRepo(cwd)` → `readGitState(cwd, repo)` every tick
  (session.ts:636-639), then on changed ticks
  `toCwdRelative(await readTrackedFiles(cwd), repo.prefix)` (session.ts:665). The caller must
  know tracked paths are *repository-root-relative*, status paths are *cwd-relative*, and
  `repo.prefix` is the bridge; `repo` exists only to route that prefix and skip re-detection.
2. **The slash is stripped twice.** `entriesFromPaths` (tree.ts:76-84) reads `?? dir/`'s
  trailing slash as the directory marker and strips it for the node path; `gitCodeMap`
  (git.ts:305-306) strips it again so the badge key matches the node.
3. **Codes re-derived at every use.** `gitCodeMap(git)` is called at three session sites
  (session.ts:712, 724, 781) — all pure and state-only, but scattered.

Stale audit details, corrected here: (a) the orchestrator is `session.ts`, not `index.ts`;
(b) `RepoInfo` and `CommitDiff` are no longer documentation-only exports — `session.ts`
named-imports `RepoInfo`, `test/session.test.ts` imports both, and `CommitDiff` is
`readCommitDiff`'s return type; that lever is mostly spent. New constraints the sketch did
not account for: (c) the probe runs on `GitState` *before* the tree decision, so
`ls-files` must stay changed-tick-only — no all-in-one per-tick entry can exist, and the
state path stays separate; (d) the git panel renders `file.relPath` verbatim
(git_view.ts:225), so `?? dir/` displays **with** its slash today — normalization must
preserve those bytes; (e) `gitCodeMap` is also needed on unchanged-shape ticks (the
restamp path, session.ts:781), so a pure state→codes builder survives regardless.

## Frozen Design (2026-10-04, grilling round 1)

**One git tree entry owns the path protocol; the `?? dir/` marker is normalized once, at the
porcelain boundary; the state path and its exports stay as they are.**

1. **One tree entry (`git.ts`).**
  `readGitTree(cwd: string, git: GitState, repo: RepoInfo): Promise<TreeEntry[]>` — async,
  spawns `ls-files --full-name -z` through the now-internal `readTrackedFiles`, translates the
  repository-root-relative tracked paths to cwd-relative through the internalized
  `toCwdRelative` (outsiders outside `repo.prefix` dropped), merges the untracked `??` paths
  from `git.unstaged` (already cwd-relative), dedupes by relPath (first occurrence wins,
  tracked before untracked, matching today's `new Set`), and returns `TreeEntry` records
  (`isDir` from the record, `symlink: false`). Tree-ready by contract; the `TreeEntry` type
  is a type-only import from `./tree` (acyclic — tree.ts does not import git.ts). Never
  throws: a failed `ls-files` degrades to untracked-only, as today. `readTrackedFiles` and
  `toCwdRelative` lose their exports; their tests move to the entry.

2. **Slash normalization at the porcelain boundary (`types.ts`, `git.ts`, `git_view.ts`).**
  `GitChangedFile` gains `isDir?: boolean` (documented: true only for an untracked-directory
  record — porcelain's trailing-slash marker). `parsePorcelain` strips the trailing slash
  from that record's `relPath` and sets `isDir: true`; every other record is untouched.
  `gitCodeMap` drops its `.replace(/\/$/, "")` (keys are now the normalized relPaths).
  `buildGitRows` re-appends `"/"` for a file row whose record has `isDir === true`, so the
  panel keeps rendering `?? dir/` byte-identically (`relPath` verbatim otherwise, which also
  keeps hand-built fixtures without `isDir` rendering as written). `entriesFromPaths`
  (tree.ts) is unchanged: it remains the tree-model/fixture helper, but production no longer
  calls it, so the convention has exactly one production home.

3. **The state path is unchanged (`git.ts`).** `detectRepo` + `readGitState(cwd, repo)` stay
  per-tick exactly as they are (spawn equality); `readGitState`'s optional `repo` parameter
  stays; `RepoInfo` stays exported (it has a real importer now — the session's read type);
  `CommitDiff` is untouched. No per-tick detection caching.

4. **Codes are pure and computed once per tick (`session.ts`).** `refreshData` computes
  `const codes = gitCodeMap(git)` once after the state read and passes it to
  `stampTree(entries, codes, probe, expandedBefore)` and to the unchanged-shape restamp
  branch; `stampTree`'s two internal `gitCodeMap(git)` calls disappear. `gitCodeMap` stays
  exported and pure — it is still the restamp path's only route to codes without a spawn.

5. **The session's tree collection shrinks (`session.ts`).** `collectTreeEntries` drops the
  tracked read, prefix translation, untracked merge/dedupe and the `entriesFromPaths` call —
  `const base = await readGitTree(cwd, git, repo)`. It keeps the untracked-directory subtree
  fill (shared budget, `collectDirEntries`) with `declaredDirs = base.filter(entry =>
  entry.isDir)`, the git-unavailable fs walk, and the empty-repo fs fallback — those are
  session policy, not git protocol.

6. **Tests.**
  `test/session.test.ts`'s `../git` mock collapses to
  `detectRepo` / `readGitState` / `gitTreeProbe` / `gitCodeMap` / `readGitTree` /
  `readCommitDiff`; the `trackedReads` counter becomes the `readGitTree` call count (same
  assertions: none in fs mode, one per changed tick). `test/git.test.ts` gains a `readGitTree`
  suite — subdirectory prefix translation with outsiders dropped, `?? dir/` becoming a
  slash-free `isDir` entry, dedupe, `ls-files` failure degrading to untracked-only — and
  re-vocabularizes the `parsePorcelain` directory pin (normalized relPath + `isDir` instead
  of the kept slash) and the `gitCodeMap` strip test (keys are the already-normalized
  relPaths); the integration subdir test reads through `readGitTree`. `test/tree.test.ts`'s
  `entriesFromPaths` fixture tests, and all render/navigator suites, are untouched.

7. **Scope fences.** Out: probe logic (`gitTreeProbe` + fs probe), per-tick detection
  caching, `CommitDiff`'s payload, the untracked-subtree fill and fs fallback (still
  session/tree.ts policy), and any UI work beyond the display-preserving `buildGitRows`
  slash. No new `docs/GLOSSARY.md` term.

## Correction to the Frozen Design (2026-10-04, found during implementation)

The design's premise — "tracked paths arrive repository-root-relative and are translated" —
is inaccurate for the actual call: `git ls-files` **without `--full-name` is
cwd-relative**, so from a repository subdirectory the prefix translation dropped every
tracked path (a pre-existing bug, masked by the integration test reading `ls-files` from
the repository root while passing a subdirectory prefix). Preserving that bug would have
left `readGitTree`'s contract false at runtime, so the user approved fixing it inside #146:
`readTrackedFiles` now spawns `ls-files --full-name -z`, which makes the output
repository-root-relative exactly as the translation assumes, and the subdirectory
integration test drives `readGitTree` from the real subdirectory (it fails without the
flag).

**This is the one deliberate behavior delta of #146**: with the navigator's cwd inside a
repository subdirectory, the git-mode tree now lists the tracked files. Previously they
were dropped whenever any untracked record existed (only untracked entries rendered); with
no untracked records the empty-entries fs fallback masked the bug by listing everything,
without the git-source distinction.

## Acceptance Criteria

- [x] `readGitTree` is the only production path from git to tree entries; `session.ts` no
  longer imports `readTrackedFiles`, `toCwdRelative` or `entriesFromPaths`, and neither
  `readTrackedFiles` nor `toCwdRelative` is exported.
- [x] `parsePorcelain` is the only production site interpreting the `?? dir/` slash: it
  emits a slash-free relPath plus `isDir`, `gitCodeMap` no longer strips, and the git panel
  still renders `?? dir/` with the slash.
- [x] The state path is spawn-identical: `detectRepo` + `readGitState(cwd, repo)` per tick,
  `repo` still threaded, `RepoInfo`/`CommitDiff` exports unchanged.
- [x] `gitCodeMap(git)` is computed once per tick in `refreshData`; `stampTree` takes codes.
- [x] A failed `ls-files` degrades to untracked-only and never throws; outsiders outside the
  prefix stay dropped; dedupe keeps tracked-first precedence.
- [x] `ls-files` is invoked with `--full-name` (pinned by a spawn-args test) and a
  subdirectory integration test drives `readGitTree` from the real subdirectory, failing
  without the flag.
- [x] `test/session.test.ts` mocks the entry and preserves every existing behavioral
  assertion (no weakened case); `test/git.test.ts` covers the protocol directly; the
  render/navigator suites are untouched and `test/tree.test.ts` changed only in the
  end-to-end porcelain fixture that had to follow the normalized record.
- [x] No non-null assertions; `npm run typecheck` and `npm test` green (888-case baseline).
- [x] Behavior is preserved end to end — tree contents, badges, panel bytes, probe cadence —
  except the recorded subdirectory correction (tracked files are no longer dropped when the
  cwd is a repository subdirectory).

## Resolution

Implemented as designed (2026-10-04), version 0.14.10:

- `git.ts` — `readGitTree(cwd, git, repo)` is the one git→tree entry: it reads tracked
  files through the now-private `readTrackedFiles`, translates them through `repo.prefix`
  (outsiders dropped), merges the untracked `??` records, dedupes tracked-first and returns
  tree-ready `TreeEntry[]`; it never throws (a failed `ls-files` degrades to
  untracked-only). `toCwdRelative` is deleted. `parsePorcelain` — the one production
  interpretation of porcelain's trailing-slash directory marker — emits a slash-free
  relPath plus `isDir`; `gitCodeMap` keys the already-normalized relPaths with no strip.
- `types.ts` — `GitChangedFile.isDir?: boolean`, documented as true only for the
  untracked-directory record.
- `session.ts` — the `./git` import is just `readGitTree`; `collectTreeEntries`' git branch
  is one `await readGitTree(cwd, git, repo)` plus the unchanged subtree fill/fallback;
  `stampTree` takes the tick's code map, which `refreshData` derives once with
  `gitCodeMap(git)` and shares with the unchanged-shape re-stamp.
- `git_view.ts` — a `changedPath` helper re-appends the display slash for `isDir` rows, so
  the panel keeps rendering `?? dir/` byte-identically (verbatim for records without it).

Correction found during implementation and fixed here (user-approved): `git ls-files`
without `--full-name` is cwd-relative, so the prefix translation was dropping every tracked
path whenever the navigator's cwd was a repository subdirectory (pre-existing bug, masked by
the integration test reading from the root). `readTrackedFiles` now spawns
`ls-files --full-name -z`, making the listing repository-root-relative as the translation
assumes — the one deliberate behavior delta: a subdirectory cwd now lists its tracked files
instead of only the untracked ones.

The worker's extra deviation: `test/tree.test.ts`'s end-to-end porcelain test had to adapt
(its fixture stitched `parsePorcelain` + `entriesFromPaths` + a hand-slashed `gitCodeMap`,
which cannot survive normalization); only that test changed — the two `entriesFromPaths`
fixture tests are byte-unchanged.

Verification: `npm run typecheck` clean; `npm test` **21 suites / 893 cases** (888 baseline,
+5 net: four `readGitTree` unit cases, the spawn-args pin, one `git_view` display case,
minus the deleted `toCwdRelative` case). The subdirectory regression pin was verified red by
temporarily removing `--full-name` (`expected [] to deeply equal [{ relPath: 'a.ts' … }]`)
and green with it restored.

## References

- Architecture review of 2026-10-03, candidate #6:
  [`docs/audits/architecture-review-2026-10-03.html`](../audits/architecture-review-2026-10-03.html)
- [#140](140-session-module-extraction.md) — moved the orchestration this refactors from
  `index.ts` into `session.ts`
- [#058](058-untracked-dirs-unreachable.md) — the `?? dir/` convention and its
  untracked-subtree fill
- [#022](022-applygitcodes-walk-every-tick.md) — the probe/stamping split this preserves
- [#024](024-unbounded-git-boundary.md) — the `-z` porcelain parsing notes
