# Issue #158: `.gitignore`d Files Leak Into the Tree (Untracked Subdirectories, Filesystem Mode); No Setting Controls It

- **Status**: Resolved
- **Type**: Feature / Tree Collection
- **Severity**: Medium
- **Component(s)**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts), [`session.ts`](file:///home/jhonny/Sources/pi-navigator/session.ts), [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts), [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts), [`README.md`](file:///home/jhonny/Sources/pi-navigator/README.md)

---

## Description

The claim under review — "pi-navigator does not show files that are in `.gitignore`" —
was validated (2026-10-05) by driving the production functions (`detectRepo`,
`readGitState`, `readGitTree`, `collectDirEntries`, `collectFsEntries`) against a temp
repo whose `.gitignore` was `*.log`, `ignored-dir/`, `ignored-sub/` with both ignored
and non-ignored untracked content.

| Case | Shown? | Evidence |
| :--- | :--- | :--- |
| Git repo, ignored path at top level (`ignored.log`, `ignored-dir/`) | **No** | `readGitTree` → `.gitignore`, `tracked.txt`, `untracked-dir/` |
| Git repo, ignored path **inside an untracked directory** (`untracked-dir/debug.log`, `untracked-dir/nested/other.log`) | **Yes — leak** | `collectDirEntries("untracked-dir")` → `debug.log`, `keep.txt`; fed straight into the tree by `session.ts` (`collectTreeEntries`, the `declaredDirs` fill) |
| Tracked file matched by `.gitignore` | Yes (git-correct) | `ls-files` keeps it; `git check-ignore` exits 1 for it |
| FS mode (no git / not a repo) | **Yes** | `collectFsEntries` includes `ignored.log`, `ignored-dir/x.txt`; only `IGNORED_NAMES` filters |
| Fresh repo with nothing committed (fs fallback) | **Yes** | `session.ts` falls back to `collectFsEntries` in the `git.available && entries.length === 0` branch |

Root causes:

- `readGitState` reads `git status --porcelain -unormal -z` without `--ignored`
  (`git.ts:215`), so ignored paths never enter the listing; `readGitTree` merges
  tracked + `??` only.
- Untracked directories are subtree-filled by the bounded fs walk
  (`collectDirEntries`, `tree.ts:83`), which only knows `IGNORED_NAMES` (`tree.ts:157`),
  never `.gitignore`.
- FS mode never parsed ignore rules — documented in `tree.ts:5-6`, `README.md:149`
  ("`.gitignore` parsing is a v2 candidate"), and the implementation plan §7.

The hidden set in git mode is git's full ignore stack (`.gitignore`, nested
`.gitignore`, `.git/info/exclude`, `core.excludesFile`), not just `.gitignore` files.

**Verdict:** true for git-sourced top-level listings only; false inside untracked
directories and false for every filesystem-sourced tree — and there is no setting to
either strengthen the behavior or relax it ("show all").

## Agreed design: `tree.respectGitignore`

New boolean setting `tree.respectGitignore`, **default `true`** — the documented intent
(`README.md:149`, `tree.ts:5-6`). File/menu/`/navigator set` only, no env/flag override,
matching the `tree.showHidden` precedent (`settings.ts` registry, `NAVIGATOR_CONFIG_FIELDS`).

| Tree source | `true` (default) | `false` |
| :--- | :--- | :--- |
| Git repo | Today's git tree, plus: the untracked-directory subtree fill drops ignored paths | Today's git tree plus ignored entries (files + dirs) with the existing `!!` → dim `!` badge; ignored dirs are expandable; the git panel's change lists are untouched |
| FS (repo detected, nothing to list — empty repo) | `collectFsEntries` output filtered through the ignore predicate | Unchanged (already shows all) |
| FS (no repo / git unavailable) | Unchanged: cannot resolve ignore rules without git; documented limitation (a `.gitignore` parser is out of scope, per plan §7) | Unchanged |

Tracked files are never hidden by either polarity — gitignore only governs untracked
paths (validated: `ls-files` keeps a tracked-but-ignored file; `check-ignore` exits 1
for it).

### Implementation notes

- **One ignored listing** (`git.ts`): `git ls-files --others --ignored --exclude-standard
  --directory --full-name -z`, prefix-translated through `repo.prefix` like
  `readTrackedFiles` (`--full-name` keeps output repo-root-relative; without it a
  subdirectory cwd yields cwd-relative paths such as `./` for the root). `--directory`
  collapses a fully ignored directory to one `dir/` record (→ `isDir`), and
  `--exclude-standard` covers `.gitignore` + `.git/info/exclude` + the global excludes
  file. Runs only on tree-changed ticks (`collectTreeEntries`); the default-on path
  must not add work to the every-tick `git status` read.
- **Walk seam** (`tree.ts`): an optional sync skip predicate on `collectDirEntries` /
  `collectFsEntries` / `walk`, consulted before an entry is pushed **and** before a
  directory descent, so an ignored directory prunes its whole subtree instead of
  burning the shared `MAX_FS_ENTRIES` budget. Exact path matches plus ignored-dir
  prefixes (collapsed records are directories, not enumerated children).
- **Dedupe before `buildTree`**: the ignored listing can repeat paths the untracked-dir
  fill already produced; `buildTree` dedupes directories but duplicates file entries,
  so the session must dedupe `TreeEntry[]` by `relPath` (first wins, as `readGitTree`
  already does).
- **Badge codes**: ignored entries carry `"!!"`; `codeText` already maps it to the dim
  `!` (`git_view.ts`), and filled children carry no per-file codes (same convention as
  the `??` fill). `parsePorcelain` and the staged/unstaged lists stay untouched.
- **Probe** (`session.ts` `collectTreeProbe`): each polarity must react to the changes
  it displays — `off` needs the ignored listing folded into the probe string for
  top-level adds/removes, and `expandedUntrackedDirs` (`tree.ts`) must include expanded
  `!!` dirs so inner changes are caught by `collectFsProbe`'s mtime check (today it
  collects `??` dirs only). `on` needs no new probe signal: a change inside an expanded
  `??` dir already triggers a rebuild and the filter drops ignored paths.

## Acceptance Criteria

- [x] `tree.respectGitignore` is a boolean registry field, default `true`, file-only
      (no env/flag); normalization, serialization, `/navigator settings`, and
      `/navigator set tree.respectGitignore on|off` all work; the
      `test/settings.test.ts` sync guards (entry count, shape fixtures, file-only list)
      are updated.
- [x] `on` (default): ignored files inside an untracked directory are no longer
      collected; git-mode top-level behavior unchanged; the empty-repo fs fallback is
      filtered; a truly git-less fs tree is a documented no-op.
- [x] `off`: git-mode trees include ignored files/dirs with the `!` badge, ignored dirs
      are expandable, and the git panel's staged/unstaged lists and probe semantics are
      not polluted.
- [x] Tracked files matched by ignore patterns remain visible in both polarities.
- [x] Probe covers each polarity's visible changes (see Implementation notes).
- [x] Tests: git ignored listing (`test/git.test.ts`), walk skip predicate
      (`test/tree.test.ts`), session polarity matrix incl. the untracked-dir leak and
      no-git degrade (`test/session.test.ts`), settings sync (`test/settings.test.ts`);
      red-green where practical.
- [x] README canonical JSON, settings table row, and the tree-source paragraph
      (`README.md:149`) updated; `package.json` version bumped (minor feature) with the
      README status badge (guarded by `test/docs.test.ts`).
- [x] `npm run typecheck` and `npm test` green; issue moved to Resolved in
      `issues_index.md` with the overview arithmetic and category marker updated.

## References

- `README.md:149` — "inside a repository it lists tracked plus untracked non-ignored
  files … `.gitignore` parsing is a v2 candidate".
- `tree.ts:5-6` — "static ignore list (no `.gitignore` parsing in v1; documented
  follow-up)".
- `docs/plans/pi-navigator-implementation-plan.md` §7 — the same deferral.
- [#058](058-untracked-dirs-unreachable.md) — introduced the untracked-dir subtree fill
  this issue filters.
- [#146](146-git-tree-protocol.md) — the git path protocol / one tree entry.
- [#145](145-settings-rule-table-lifecycle.md), [#131](131-settings-flags-and-headless-path.md)
  — the settings registry and headless edit path this field joins.

---

## Resolution

Resolved in v0.15.0.

### What changed

- **`settings.ts`** — `NavigatorTreeSettings` gained `respectGitignore: boolean` and the
  registry gained the `tree.respectGitignore` row (kind `boolean`, section `Tree`,
  default `true`, `live: false`, no `override` — file/menu/`/navigator set` only,
  matching `tree.showHidden`). Defaults, normalization, serialization, the settings menu
  and `applyFieldEdit` are registry-driven, so the field works on every face without
  further code.
- **`git.ts`** — one new exported listing, `readIgnoredEntries(cwd, repo)`:
  `ls-files --others --ignored --exclude-standard --directory --full-name -z`, NUL-split,
  prefix-translated through `repo.prefix` like `readTrackedFiles`, the collapsed `dir/`
  trailing slash normalized to a slash-free relPath plus `isDir`, deduped first-wins;
  `error`/`overflow`/`missing` degrade to `[]`. `parsePorcelain`, `readGitState` and
  `GitState` are untouched, so ignored records never enter the git panel nor the
  every-tick `git status` read.
- **`tree.ts`** — `collectDirEntries` (new optional fourth parameter) and
  `collectFsEntries` (extended `opts.skip`) thread an optional synchronous
  `TreeSkipPredicate` into `walk`, consulted before the push and before the descent, so a
  skipped directory prunes its subtree instead of spending the shared `MAX_FS_ENTRIES`
  budget. `expandedUntrackedDirs` now also collects expanded `!!` dirs, so inner changes
  of an expanded ignored dir are caught by `collectFsProbe` when the setting is off.
- **`session.ts`** — `respectGitignore` is read once at `createSession`. **Off, git
  mode**: one ignored listing per tick, read before the probe, feeds (a) the probe
  signature (top-level ignored adds/removes rebuild), (b) the per-tick code map
  (`gitCodeMap` plus `!!` per ignored entry), and (c) the merge — `!!` dirs join the `??`
  declared dirs for the subtree fill and the assembled `TreeEntry[]` is deduped
  first-wins, because the ignored listing repeats paths the fill produces and `buildTree`
  would otherwise emit duplicate file rows. **On, git mode**: the fill installs the
  ignore predicate as the walk's skip, and the listing is read only when a fill actually
  runs (one per changed tick, zero on idle ticks); the empty-repo fs fallback is filtered
  through the same predicate. A truly git-less fs tree is unchanged in both polarities
  (documented no-op). Filled children keep carrying no per-file codes; only the ignored
  listing's own entries get `!!` (rendered as the existing dim `!`).
- **`README.md`** — canonical JSON block, the `tree.respectGitignore` settings-table row
  and the tree-source behavior note updated.

### Tests

- `test/settings.test.ts` — sync guards (seven entries incl. the new row, canonical
  serialize bytes with `"tree":{"showHidden":false,"respectGitignore":true}`, shape
  fixtures, the file-only override list, the boolean-only case) plus an explicit
  `applyFieldEdit` on/off case. **+1 case (95).**
- `test/git.test.ts` — `readIgnoredEntries` parsing (flags/argv, NUL split,
  collapsed-dir slash → `isDir`, prefix translation, outsider drop, dedupe,
  failure/overflow → `[]`) plus a real scratch-repo pass over the full ignore stack
  (tracked-but-ignored file excluded, `.git/info/exclude` included) and a
  subdirectory-cwd translation pass. **+5 cases (46).**
- `test/tree.test.ts` — the skip predicate prunes `collectFsEntries` without spending
  the budget (ignored dir's children never surface, no truncation), the same for
  `collectDirEntries` before push and descent, and `expandedUntrackedDirs` collects
  expanded `??` and `!!` dirs only. **+3 cases (46).**
- `test/session.test.ts` — the polarity matrix: the on-polarity untracked-dir leak
  (red-green verified — the case fails with the skip wiring disabled), the off-polarity
  merge with `!!` codes / filled ignored dirs / dedupe, the off probe fold, the on
  fs-fallback filter, and the no-git no-op in both polarities. **+5 cases (34).**

22 suites / 945 cases; `npm run typecheck` clean. Version 0.15.0.
