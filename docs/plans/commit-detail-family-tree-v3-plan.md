# pi-navigator — Commit Detail & Family Tree v3 Plan

**Status:** Implemented (v3). Resolves the three design drifts from the UI v2 commit-family tree (#030 — dropped `▸`/`▾` marker, non-actionable `commit-child` Enter, silent `FAMILY_MAX_DEPTH` truncation) **and** delivers the deferred commit detail/diff view (#034). Two coupled changes, one version bump (0.3.2 → 0.4.0).

**Scope:** Resolve the three design drifts from the UI v2 commit-family tree (#030 — dropped `▸`/`▾` marker, non-actionable `commit-child` Enter, silent `FAMILY_MAX_DEPTH` truncation) **and** deliver the deferred commit detail/diff view. Two coupled changes, one version bump.

**Grounding (why this shape):** lazygit, gitui, and tig all keep the commit log as a **flat list** and open a **separate detail/diff view** on Enter; none expand ancestors inline. pi-navigator's inline family tree is already non-standard, so it must borrow the most recognizable affordance available — the **collapsible-tree idiom pi-navigator already uses in its file pane** (`▸`/`▾` + Enter toggle, `l`/`h` expand/collapse). The detail/diff view reuses the **existing viewer pane** (`buildRightRows`) rather than a new surface, so it inherits scroll/wrap/search/width-safety for free.

---

## §0 — Verified facts (grounding)

- **`GitCommit.parents?`** already carries parent short hashes (`git.ts:176`, parsed from `--parents` `%p`). No new git data fetch needed for the tree.
- **`gitExpanded: Set<string>`** (`navigator.ts:192`) keys family expansion on `shortHash`; `toggleCommitFamily` (`navigator.ts:429`) adds/removes + bumps `gitTreeVersion`. Caches key on `(git, gitTreeVersion)`.
- **`gitRows()` family build** (`navigator.ts:368-407`) already does a per-anchor DFS (`familyByAnchor`) emitting one block under each expanded commit — the ordering fix from #032 holds. The recursion to `FAMILY_MAX_DEPTH` is the only thing making it "full chain in one shot" rather than "one level at a time."
- **`buildGitRow`** (`navigator.ts:1142-1160`): the `commit` branch renders `arrow + hash + "  " + subject` with **no marker**; the `commit-child` branch adds `"  ".repeat(row.depth)` indent and **no marker**.
- **`handleGitInput` Enter** (`navigator.ts:643-658`): only `row.kind === "commit"` toggles; `commit-child` and `group` fall through to `else { return; }` (no-op, no `touch()`).
- **File-pane idiom** (`handleFilesInput`, `navigator.ts:599-616`): Enter on a dir toggles `expanded`; `l` expands, `h` collapses. Markers come from `buildFileRow` (`navigator.ts:1072`): `row.node.expanded ? "▾ " : "▸ "`.
- **Viewer pane** (`buildRightRows`, `navigator.ts:1166-1230`): renders `viewFile: ViewerFile`. `kind` switches between text-like (gutter + `computeRows` + search) and card (`buildCard`) for binary/image/error. `openRelPath` (`navigator.ts:263`) drives loading via the injected `loadFile` callback with a `loadSeq` race guard.
- **`ViewerFile`** (`types.ts:100-118`): `kind: ViewerKind`, `lines: string[]` (ANSI-highlighted), `relPath`, `notice?`, `message?`.
- **`loadFile` injection** (`NavigatorOptions.loadFile`, `index.ts:153`): `index.ts` owns all async/fs work and injects `loadFileCached` into the overlay. The overlay never touches fs/git directly — the **data contract**.
- **`highlightCode`/`getLanguageFromPath`** (`viewer.ts:16`): pi-native, used for file highlighting. Reusable for diff lines.
- **`runGit`** (`git.ts:46`) is private; the public git surface is `readGitState`, `readTrackedFiles`, `detectRepo`, `isGitAvailable`, `parsePorcelain`, `gitCodeMap`, `gitTreeProbe`, `toCwdRelative`. A new `readCommitDiff` export joins this list.
- **Footer/help** (`navigator.ts:82-99`): `FOCUS_HINTS` + `HELP_ROWS` are the two places new keys must be documented.

---

## §1 — Feature A: Restore the drill-down family tree (Option A)

Make the commit family tree behave like the file pane's collapsible dirs: one level per Enter, `▸`/`▾` markers, every `commit-child` actionable, truncation signalled instead of silent.

### A.1 — One-level expansion in `gitRows()`

**Current** (`navigator.ts:381-391`): `visit` recurses to `FAMILY_MAX_DEPTH` in one call, emitting the whole chain.

**Change:** `visit` emits **only direct parents** (depth 1) of the expanded commit. Each of those parents is itself a `commit-child` row; if the user later toggles *that* row, its own direct parents are emitted as depth-2 children under it. The recursion stays, but it is now driven by **which commits are in `gitExpanded`**, not by a single anchor's deep walk.

Concretely, replace the per-anchor deep DFS with a **single-level emission per expanded commit**:

```ts
const familyByAnchor = new Map<string, GitRow[]>();
if (this.gitExpanded.size > 0) {
  const byHash = new Map<string, GitCommit>();
  for (const commit of git.history) byHash.set(commit.shortHash, commit);
  const added = new Set<string>();      // global dedup across the pane
  let count = 0;                        // global row cap
  for (const commit of git.history) {
    if (count >= FAMILY_MAX_ROWS) break;
    if (!this.gitExpanded.has(commit.shortHash)) continue;
    const out: GitRow[] = [];
    for (const parentHash of commit.parents ?? []) {
      if (count >= FAMILY_MAX_ROWS) break;
      const parent = byHash.get(parentHash);
      if (!parent || added.has(parent.shortHash)) continue;
      added.add(parent.shortHash);
      count += 1;
      // depth is the parent's own depth in the visible tree: the anchor's
      // depth + 1. Stored on the row so render + future toggle know where
      // to nest. (See A.3 for the depth computation.)
      out.push({ kind: "commit-child", commit: parent, depth: childDepth(commit) });
    }
    if (out.length > 0) familyByAnchor.set(commit.shortHash, out);
  }
}
```

- `childDepth(commit)` = the depth the *parent* row would render at = `renderDepth(commit) + 1`. `renderDepth` walks `gitExpanded`/parent links to find the commit's indent level (a top-level history commit is depth 0; a child of an expanded depth-0 commit is depth 1; a child of an expanded depth-1 commit is depth 2). This is O(depth) per row and bounded by `FAMILY_MAX_ROWS` total.
- **`FAMILY_MAX_DEPTH`** becomes the **user-driven ceiling**: a `commit-child` at `depth >= FAMILY_MAX_DEPTH` still renders a `▸` marker (if it has parents in history) but its Enter does not expand — it shows a one-time dim notice `max depth reached`. No silent cut.
- **`FAMILY_MAX_ROWS`** stays the global breadth cap; when hit, the deepest would-be child renders a dim `… N more` row beneath the last expanded commit (see A.4).

### A.2 — `▸`/`▾` markers in `buildGitRow`

**Current** (`navigator.ts:1142-1160`): neither `commit` nor `commit-child` renders a marker.

**Change:** add a marker to both, driven by `gitExpanded.has(shortHash)` and whether the commit has any parents in history:

```ts
// shared helper
private commitMarker(commit: GitCommit): string {
  const hasParents = (commit.parents?.length ?? 0) > 0;
  if (!hasParents) return "  ";            // root: no marker, nothing to expand
  return this.gitExpanded.has(commit.shortHash) ? "\u25be " : "\u25b8 "; // ▾ / ▸
}
```

- `commit` branch: `arrow + marker + hash + "  " + subject` (marker between arrow and hash, mirroring `buildFileRow`'s `indent + marker + name`).
- `commit-child` branch: `arrow + "  ".repeat(depth) + marker + hash + "  " + subject`.
- **Width accounting:** the marker is 2 visible cells (`glyph + space`), same as the dir marker. `room` for the subject truncation must subtract it: `leftW - 2 - visibleWidth(hash) - 2 - markerW - 2*depth` (commit-child) and `leftW - 2 - visibleWidth(hash) - 2 - markerW` (commit). `markerW = 2`. Reuse `truncateAndWidth` for the empty-ellipsis hard-cut (#018).

### A.3 — `commit-child` is actionable on Enter

**Current** (`navigator.ts:643-658`): only `commit` toggles.

**Change:** `commit-child` toggles its own family too:

```ts
} else if (row.kind === "commit" || row.kind === "commit-child") {
  const hash = row.commit.shortHash;
  const depth = row.kind === "commit-child" ? row.depth : 0;
  if (depth >= FAMILY_MAX_DEPTH && !this.gitExpanded.has(hash)) {
    this.showNotice("max depth reached \u2014 collapse a parent to go deeper");
    return;   // no touch(); the notice already requested a render
  }
  this.toggleCommitFamily(hash);
}
```

- Toggling a `commit-child` that is already expanded collapses its subtree (the `gitRows` per-anchor emission naturally stops including its children when it leaves `gitExpanded`).
- The depth guard fires only on *expand* at the cap; collapse always works.

### A.4 — Truncation is signalled, not silent

When `count >= FAMILY_MAX_ROWS` mid-walk, emit one trailing row under the last-expanded anchor:

```ts
{ kind: "group", label: "\u2026 more ancestors (narrow the view or collapse a branch)", tone: "dim" }
```

This `group` row is filtered out of `gitNavRows()` (cursor skips it), so it is informational only — consistent with the existing `Clean`/`History` group rows. This replaces the plan's "▸ still shows" with an explicit count-free hint row, which is less ambiguous than a marker on a row the user can't actually expand.

### A.5 — `l`/`h` parity with the file pane (optional, recommended)

For muscle-memory parity with dir expand/collapse, also bind in `handleGitInput`:
- `l` / `Key.right` on a `commit` or `commit-child`: expand (same as Enter-on-collapsed).
- `h` / `Key.left` on a `commit-child`: collapse its own family **and** move the cursor to its anchor parent (so the user "steps out" like in the file pane). On a top-level `commit`, `h` collapses its family without moving.

This is additive; if it complicates the cursor-move-on-collapse story, drop it and keep Enter-only. The file pane binds both, so parity is the lower-surprise choice.

### A.6 — Footer + help

- `FOCUS_HINTS.git` (currently): add `Enter` → `open diff / toggle family`, `l h` → `expand / collapse family` (if A.5 lands).
- `HELP_ROWS`: replace the single `["Enter", "open file, or toggle a directory"]` row with two rows:
  - `["Enter", "open file / commit diff, or toggle a directory / family"]`
  - `["l h", "expand or collapse a directory / commit family"]`

---

## §2 — Feature B: Commit detail/diff view on Enter

The standard pattern (lazygit/gitui/tig): Enter on a commit opens a **detail view**, not an inline expansion. pi-navigator already has a viewer pane; the diff renders there.

### The keybinding conflict and its resolution

Feature A puts Enter on family toggle. Feature B wants Enter to open the diff. **They cannot share Enter.** Resolution, ranked by precedent:

1. **`Enter` = open diff (detail view); `l`/`Key.right` = expand family; `h`/`Key.left` = collapse family.** This matches the file pane's *file-vs-dir* split: Enter opens a file (the "leaf" action), `l`/`h` expand/collapse a dir (the "structure" action). For commits: Enter opens the diff (the leaf action), `l`/`h` expand/collapse the family (the structure action). A commit is always both expandable and diffable, so unlike dirs (which only toggle), commits get Enter=diff and `l`/`h`=family. **Recommended — strongest muscle-memory transfer from the file pane.**
2. `Enter` = toggle family (as in UI v2); `d` or `o` = open diff. Keeps the v2 Enter, but diverges from "Enter opens" convention.
3. `Enter` = diff; family expand is `Tab`-into-the-row or a dedicated key. Heavier, less discoverable.

This plan adopts **option 1**. Feature A's A.3/A.5 are amended: **Enter does not toggle family**; only `l`/`h` (and `Key.right`/`Key.left`) do. The depth-cap notice (A.3) fires on `l` instead of Enter.

### B.1 — New `ViewerFile` kind: `"diff"`

`types.ts`:

```ts
export type ViewerKind = "empty" | "text" | "truncated" | "binary" | "image" | "error" | "diff";

export interface ViewerFile {
  kind: ViewerKind;
  relPath: string;          // for diff: the commit shortHash, stored in relPath for header/identity
  sizeBytes?: number;
  lineCount?: number;
  mtimeMs?: number;
  lines: string[];          // ANSI-highlighted diff lines
  notice?: string;          // e.g. "commit abc1234 · 2 parents · 3 files changed"
  message?: string;
  imageTier?: ...;
  // NEW, diff-only:
  commitHash?: string;      // full or short hash the diff is for
  parents?: string[];       // for the notice line
}
```

- `relPath` is reused as the identity key (so `viewTargetRelPath`/header/caches work unchanged); for a diff it holds `commit:<shortHash>` to keep it distinct from file paths.
- `lines` holds the already-highlighted diff output (see B.3). The viewer's `computeRows`/wrap/scroll path treats `diff` exactly like `text` (same gutter, same search) — the only branch is in `buildRightRows` (B.4) and `buildViewerHeader` (B.5).

### B.2 — `git.ts`: new `readCommitDiff` export

```ts
export interface CommitDiff {
  shortHash: string;
  parents: string[];
  /** ANSI-highlighted diff lines (already styled). Empty if the commit is a root. */
  lines: string[];
  /** Files changed count + insertions/deletions for the notice row. */
  filesChanged: number;
  insertions: number;
  deletions: number;
  notice: string;
}

export async function readCommitDiff(cwd: string, shortHash: string): Promise<CommitDiff> {
  // 1. Resolve the short hash to a full hash (handles ambiguous shorts safely).
  //    git rev-parse --verify --quiet <shortHash>^{commit}
  // 2. Diff body: git show --no-color --no-renames --pretty=format: <hash>
  //    --no-renames keeps the diff to add/delete pairs (simpler highlight);
  //    --pretty=format: strips the commit metadata from `git show` (we render
  //    our own notice). Bounded by MAX_HIGHLIGHT_LINES/MAX_HIGHLIGHT_BYTES
  //    (reuse viewer.ts caps): truncate the captured stdout before highlight.
  // 3. Stat line: git show --numstat --format= <hash> → sum insertions/deletions
  //    and count files. One extra spawn, but cheap and bounded.
  //    (Alternative: parse from the diff, but numstat is robust to renames.)
  // 4. Highlight the diff body: reuse viewer.ts's highlightCode with a
  //    "diff" language if pi exposes one, else a small inline diff styler
  //    (see B.3). Return CommitDiff.
}
```

- **Bounded:** the diff body is capped with the existing `MAX_HIGHLIGHT_BYTES`/`MAX_HIGHLIGHT_LINES` from `constants.ts` before highlighting; a truncated diff sets `notice` to `… diff truncated (N lines omitted)`.
- **Never throws:** returns a `CommitDiff` with `lines: []` and `notice: "cannot read commit <hash>"` on any failure (missing hash, git error, overflow) — mirrors `readGitState`'s degrade-don't-throw contract.
- **No new constants** unless the diff needs its own cap; prefer reusing the viewer caps. If a separate `MAX_DIFF_BYTES` is cleaner, add it to `constants.ts`.

### B.3 — Diff highlighting

**Decision: inline prefix styler** (verified — pi has no `diff` language; see §6 #1). `styleDiffLines(lines: string[], T: NavigatorTheme): string[]` per-line, prefix-keyed:

- `+` → `T.success` (add); `+++` file header → `T.muted`
- `-` → `T.error` (delete); `---` file header → `T.muted`
- `@@` hunk header → `T.accent` (cyan)
- `diff `/`index ` → `T.muted` (meta)
- everything else (context) → `T.text`

This is the prefix-based approach lazygit/gitui take (no diff parser). **No hardcoded colors** — all styles go through `NavigatorTheme`. The styler runs in `index.ts` (which has the theme) on the plain lines returned by `readCommitDiff`, producing the final `lines: string[]` for the `ViewerFile`. Keeps `git.ts` theme-free, matching `viewer.ts`'s "highlight in the loader" split. Lives in a new `diff.ts` or alongside `viewer.ts`'s highlight use.

### B.4 — Wiring: `loadCommit` injection, parallel to `loadFile`

**`NavigatorOptions`** (`navigator.ts:64-69`): add

```ts
loadCommit?: (shortHash: string) => Promise<ViewerFile>;
```

Optional — if absent, Enter on a commit falls back to the family toggle (so the overlay still works in tests that don't stub it; see B.7).

**`index.ts`**: implement `loadCommit` alongside `loadFileCached`:

```ts
const loadCommit = async (shortHash: string): Promise<ViewerFile> => {
  const diff = await readCommitDiff(cwd, shortHash);
  return {
    kind: "diff",
    relPath: `commit:${diff.shortHash}`,
    commitHash: diff.shortHash,
    parents: diff.parents,
    lineCount: diff.lines.length,
    lines: diff.lines,            // already ANSI-highlighted by readCommitDiff
    notice: diff.notice,
  };
};
```

- No cache for diffs (commits are immutable; a 1-line `Map<hash, ViewerFile>` is optional later). Keep it simple for v1.
- `readCommitDiff` does the highlight step with the theme — so `index.ts` must pass the theme to it, or `readCommitDiff` returns plain lines and the styler runs in `index.ts`. **Cleaner:** `readCommitDiff` returns plain diff lines + stat; `index.ts` runs a `styleDiffLines(lines, theme)` helper (from `diff.ts` or `git.ts`) to produce `lines: string[]`. This keeps `git.ts` theme-free (matching `viewer.ts`'s "highlight in the loader" split).

**`navigator.ts`**: new `openCommit(shortHash)` method, parallel to `openRelPath`:

```ts
async openCommit(shortHash: string): Promise<void> {
  if (!this.loadCommit) { this.toggleCommitFamily(shortHash); return; }  // B.7 fallback
  const seq = ++this.loadSeq;
  this.viewLoading = true;
  this.viewTargetRelPath = `commit:${shortHash}`;   // reuse the race-guard field
  this.viewScroll = 0; this.viewHscroll = 0;
  this.searchQuery = ""; this.searchMatches = []; this.searchIndex = 0;
  this.touch(); this.requestRender();
  try {
    const file = await this.loadCommit(shortHash);
    if (this.disposed || this.loadSeq !== seq) return;
    this.viewFile = file;
    this.searchDirty = true; this.diskChanged = false;
  } catch {
    if (this.disposed || this.loadSeq !== seq) return;
    this.viewFile = { kind: "error", relPath: `commit:${shortHash}`, lines: [], message: "cannot read commit" };
    this.searchDirty = true;
  } finally {
    if (!this.disposed && this.loadSeq === seq) {
      this.viewLoading = false; this.viewTargetRelPath = null;
      this.touch(); this.requestRender();
    }
  }
}
```

- **Reuses** `loadSeq` race guard, `viewTargetRelPath`, `viewLoading`, `searchDirty`, all caches (they key on `viewFile` ref). No new state.
- `getOpenRelPath()` returns `commit:<hash>` for a diff — the on-disk-mtime poll in `index.ts` (`stat(join(cwd, openRel))`) will fail on a `commit:` path. Guard: in `refreshData`, skip the mtime poll when `openRel.startsWith("commit:")`. One-line check.

### B.5 — `handleGitInput` Enter: open diff

```ts
} else if (row.kind === "commit" || row.kind === "commit-child") {
  this.focus = "viewer";
  void this.openCommit(row.commit.shortHash);
}
```

- `l`/`Key.right` → expand family (`toggleCommitFamily` + depth-cap notice).
- `h`/`Key.left` → collapse family (A.5).
- Enter → diff. This is the file-pane split: Enter is the "open" verb, `l`/`h` are the "structure" verbs.

### B.6 — Viewer pane renders `kind === "diff"`

In `buildRightRows` (`navigator.ts:1186`): treat `diff` **exactly like `text`** — it falls through the text-like branch (gutter + `computeRows` + search + wrap + scroll). No new card. The only diff-specific render is the **notice row** (the `… N files · +I -D · M parents` line), which already has a slot (`file.notice` → rendered above the content for `truncated`; generalize to `diff` too):

```ts
if ((file.kind === "truncated" || file.kind === "diff") && file.notice) noticeRows += 1;
// ... later:
if ((file.kind === "truncated" || file.kind === "diff") && file.notice)
  rows.push(this.padTo(" " + T.dim(file.notice), rightW));
```

- Use `T.dim` (not `T.warning`) for the diff notice — it's a summary, not an alert.
- The `diskChanged` notice path is gated on `getOpenMtime()`; diffs have no `mtimeMs`, so it's naturally skipped.

### B.7 — `buildViewerHeader` for a diff

`buildViewerHeader` (`navigator.ts:1248`) currently shows the file path + line count. For `kind === "diff"`:

- Left: `T.accent("commit " + commitHash)` (mirrors `git show`'s header).
- Right: the line count or `N files · +I -D` (already in `notice`, so keep the right side as the existing position indicator to avoid duplication).
- Gate on `viewFile.kind === "diff"` and read `viewFile.commitHash`.

### B.8 — Tests

- `test/git.test.ts`: `readCommitDiff` on a scratch repo — root commit (empty diff or single-file), normal commit (add/delete lines), merge commit (two-parent diff). Assert `lines` is non-empty, `filesChanged`/`insertions`/`deletions` correct, no throw on a bogus hash.
- `test/navigator.test.ts`:
  - Enter on a `commit` with `loadCommit` injected → `focus` becomes `"viewer"`, `viewFile.kind === "diff"`, `viewFile.commitHash` matches.
  - Enter on a `commit-child` → same.
  - `l` on a collapsed commit → `gitExpanded` gains the hash, family rows appear (one level only). `h` → collapses.
  - Depth cap: expand to `FAMILY_MAX_DEPTH`, `l` on the deepest child → notice shown, no expand.
  - **Fallback:** construct an overlay with **no** `loadCommit` → Enter on a commit toggles the family (B.4 fallback), so the existing #030 tests stay green without rewriting their stubs.
- `test/render.test.ts`: width-safety with a diff `ViewerFile` at 120/100/80/50; assert the diff notice row renders and the `+`/`-` lines stay in-bounds; no bright-ellipsis artifact on long diff lines.

### B.9 — Docs

- `docs/issues/`: new issue doc for the detail/diff view (call it #034 — `commit-diff-view.md`), and amend `030-commit-family-tree.md` to reference the v3 plan (the drift resolution). Update `issues_index.md` counts.
- `README.md`: Keys table — `Enter` on a commit → "show commit diff"; `l`/`h` on a commit → "expand / collapse ancestor family".
- `AGENTS.md` / `DESIGN.md`: note the `loadCommit` injection + `ViewerFile.kind === "diff"` data contract; note that diffs skip the mtime poll.
- `docs/plans/ui-v2-plan.md` §2: mark the family-tree section "superseded by v3 plan" with a link.

---

## §3 — Interaction summary (the contract)

| Pane | Row kind | Enter | `l` / `→` | `h` / `←` |
|---|---|---|---|---|
| files | dir | toggle expand | expand | collapse |
| files | file | open in viewer | — | — |
| git | file | open in viewer (align tree) | — | — |
| git | commit | **open diff in viewer** | expand family | collapse family |
| git | commit-child | **open diff in viewer** | expand family (cap → notice) | collapse family |
| git | group | — | — | — |

- Enter is always the "open / leaf" verb across both panes.
- `l`/`h` are always the "structure" verb across both panes.
- This is the file-pane idiom extended consistently to commits — the lowest-surprise design given pi-navigator already teaches the user `l`/`h` for dirs.

---

## §4 — Files touched

- `types.ts` — `ViewerKind` adds `"diff"`; `ViewerFile` adds `commitHash?`, `parents?`.
- `git.ts` — new `readCommitDiff` (+ `CommitDiff` interface); no change to `readGitState`.
- `diff.ts` (new, optional) — `styleDiffLines(lines, theme): string[]` if the inline styler is chosen. Or fold into `viewer.ts` next to `highlightCode` use.
- `navigator.ts` — `gitRows` one-level emission (A.1), `commitMarker` + `buildGitRow` markers (A.2), `handleGitInput` Enter→diff + `l`/`h`→family (A.3/A.5/B.5), `openCommit` (B.4), `buildRightRows`/`buildViewerHeader` diff branch (B.6/B.7), `NavigatorOptions.loadCommit`, footer/help rows (A.6).
- `index.ts` — `loadCommit` implementation + `readCommitDiff` call + `styleDiffLines`; mtime-poll skip for `commit:` paths (B.4).
- `constants.ts` — maybe `MAX_DIFF_BYTES`/`MAX_DIFF_LINES` (or reuse viewer caps).
- `test/git.test.ts`, `test/navigator.test.ts`, `test/render.test.ts` — per A.8/B.8.
- `docs/` — issue doc #034, amend #030, index, README keys, AGENTS/DESIGN, supersede note in ui-v2-plan.

## §5 — Version & sequencing

- **Version:** `0.3.2 → 0.4.0` (minor — adds a new viewer kind + new key behavior; not a patch).
- **Sequence:** Land A (family-tree fix) first as its own commit with tests green, then B (diff view) as a second commit. A is independently shippable and fixes the shipped drift; B is the new feature. Two commits, each typecheck + full suite green before the next.
- Re-run `pi install .` at the end.

## §6 — Decisions (resolved)

1. **Diff styler source** — **Inline prefix styler.** Verified: pi has no `diff` language (`getLanguageFromPath("a.diff")` → `undefined`; pi's own read tool falls back to plain `split("\n")` for unknown langs, and `highlightCode` requires `initTheme()` which the extension cannot safely call). `styleDiffLines(lines, theme)` lives next to the loader (`index.ts`), theme-driven: `+`→`T.success`, `-`→`T.error`, `@@`→`T.accent`, `diff `/`index `/`--- `/`+++ `→`T.muted`, context→`T.text`. No hardcoded colors.
2. **`l`/`h` on commits** — **Keep.** Enter opens the diff (the "open/leaf" verb, matching the file pane); `l`/`→` expands the family, `h`/`←` collapses (the "structure" verb, matching dir handling). Preserves "Enter always opens" across both panes.
3. **Diff cap** — **Reuse `MAX_HIGHLIGHT_BYTES`/`MAX_HIGHLIGHT_LINES`.** No new constants; the truncation notice signals overflow.
4. **Diff caching** — **Defer.** No cache for v1 (commits are immutable; the fetch is one bounded `git show`; a `Map<hash, ViewerFile>` is a trivial follow-up if reopening feels slow).
5. **`FAMILY_MAX_DEPTH`** — **Keep 3**, now user-driven (each `l` reveals one more level; the cap surfaces a notice instead of silently truncating). Revisit if real repos feel tight.
6. **Enter-on-commit when `loadCommit` is absent** — **Fallback to family toggle.** `loadCommit` is optional; 27 existing test harnesses inject none, so the fallback keeps the suite green without a mass rewrite.
