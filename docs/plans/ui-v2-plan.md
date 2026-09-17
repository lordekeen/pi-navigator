# pi-navigator — UI v2 Implementation Plan

**Status:** Approved (design reviewed in session; supersedes `docs/plans/pi-navigator-implementation-plan.md` for the icon / git-pane / commit-tree work).

**Scope:** Three features, one version bump. Order of implementation (#029 → #030 → #028) is smallest/independent first, icons last (they touch the most render paths).

| # | Feature | Doc | Type | Severity |
|---|---|---|---|---|
| #028 | Nerd Font filetype icons, env-gated | `docs/issues/028-nerd-font-icons.md` | Feature | Medium |
| #029 | Git pane dynamic rows + richer badges | `docs/issues/029-git-pane-dynamic-rows.md` | Feature | Low |
| #030 | Expandable commit family tree | `docs/issues/030-commit-family-tree.md` | Feature | Low |

---

## 0. Grounding (verified facts)

- **`GitChangedFile`** (`types.ts:62`): `{ relPath, code }`, `code: GitCode = string`. Rename/copy codes arrive as `R`/`C` from porcelain — today rendered by `codeText` (`navigator.ts:1013`) through the muted default.
- **`GitCommit`** (`types.ts:66`): `{ shortHash, dateRel, subject }`. Parsed in `readGitState` (`git.ts`) from the log format `%h%x1f%ad%x1f%s`. Adding parents is a format-string change plus a split on the same `UNIT_SEPARATOR`.
- **Overlay ctor** (`NavigatorOptions`, `navigator.ts:56`): `{ cwd, theme, getTerminalRows, requestRender, onClose, loadFile, refresh }` — adding an optional `enableIcons?: boolean` field keeps all existing call sites (tests, `index.ts`) compiling unchanged.
- **Git Enter handling** (`handleGitInput`, `navigator.ts:530-546`): the `row.kind === "commit"` branch currently calls `this.showNotice("commit detail view is deferred to v2 (plan section 1)")` — this is the hook to replace with tree-toggle. The comment in the README ("commit rows are informational in v1") gets updated.
- **Cache invalidation pattern**: `treeVersion` counter (`navigator.ts:179`) bumps on in-place expansion. The same pattern applies to git expansion via a new `gitTreeVersion`.
- **Theme tokens** (`theme.ts`): `T.dim`, `T.muted`, `T.warning`, `T.success`, `T.error` all exist; `NavigatorTheme` is the only color source.
- **Width helpers** (`navigator.ts:45-51`): `truncateAndWidth` (one truncate + one measure) and `visibleWidth` from pi-tui are the mandated measurement/truncation primitives.
- **Icons gating**: pi exposes **no settings getter** on `ExtensionContext` (only `isProjectTrusted()`) and pi-tui's `detectCapabilities()` covers image/truecolor/hyperlinks only — **no nerd-font detection API**. Hence the env-var toggle (approved design §1).

---

## §1 — Feature #029: Git pane dynamic rows + richer badges

Small, fully bounded by `gitRows()` (`navigator.ts:322-350`) and `codeText` (`navigator.ts:1013-1022`).

### Changes

1. **`gitRows()` dynamic group rows**
   - Skip the `Unstaged (N)` group row when `git.unstaged.length === 0`.
   - Skip the `Staged (N)` group row when `git.staged.length === 0`.
   - Keep the existing `Clean` row (dim) when **both** are empty.
   - Header `buildGitHeader` (`navigator.ts:1012`) **unchanged** — the "0 unstaged · 0 staged" summary always renders.
2. **Richer badges** in `codeText`:
   - `R` → `T.warning` (rename, worktree/index)
   - `C` → `T.success` (copy)
   - Existing `M→warning`, `A→success`, `D→error`, `??→dim "?"`, `!!→dim "!"` unchanged.
3. **`gitNavRows()`** (`navigator.ts:352`) already filters `kind === "group"`, so skipping empty groups is transparent to navigation.

### Files touched

- `navigator.ts` (`gitRows`, `codeText`)
- `test/render.test.ts` (new: no `Unstaged (0)`/`Staged (0)` row when empty)
- `test/navigator.test.ts` (new: `codeText` R/C mapping)
- Docs: `docs/issues/029-...md` + index entry

### Testing

- render: empty both lists → only `Clean` + `History`; header still shows "0 unstaged · 0 staged".
- navigator unit: `codeText("R")`, `codeText("C")` return styled tokens; existing codes unchanged.
- `npm run typecheck` + `npm test` green.

---

## §2 — Feature #030: Expandable commit family tree

### Data (near-free)

Extend the **existing** log fetch in `readGitState` (`git.ts`) with `--parents`:

```bash
git log -n20 --date=relative --pretty=format:%h%x1f%p%x1f%ad%x1f%s
```

- `%p` = space-separated short parent hashes (empty for root commits).
- `GitCommit` (`types.ts:65`): add `parents?: string[]` (optional — existing `setGitState` stubs/fixtures keep compiling). Split on `UNIT_SEPARATOR`; `parents = part[1] ? part[1].split(" ") : []`.
- Parsing stays bounded: 20 commits, each ≤ handful of parents.

### Interaction

**`handleGitInput` Enter on a commit row** (`navigator.ts:542-544`): toggle its family expansion, replacing the deferred-notice:

```ts
else if (row.kind === "commit") {
  this.toggleCommitFamily(row.commit.shortHash);
}
```

- **Toggle semantics**: `toggleCommitFamily(hash)` → if the commit is already expanded (rows for its ancestors rendered after it), collapse; else expand.
- **Children set**: map `parent → child` built from `git.history` parents. For the expanded commit at `gitCursor`, render its direct children as rows beneath it (indented).
- **Caps** (new in `constants.ts`): `FAMILY_MAX_DEPTH = 3`, `FAMILY_MAX_ROWS = 16`. Expansion stops when either is exceeded (a `▸` still shows on the row so the user knows there's more).
- **Flatening for nav**: `gitRows()` returns the flat history + expanded family rows (interleaved); `gitNavRows()` (which filters out only `kind !== "group"`) keeps working without changes since family rows are `kind: "commit"` or a new `kind: "commit-child"`.
- **New row kind** `{ kind: "commit-child"; commit: GitCommit; depth: number }` in `GitRow` union (`types.ts:90-93`).
- **Indent**: `▸`/`▾` marker + 2-cell depth per level (mirrors `buildFileRow` dir idiom).
- **Cache invalidation**: new `gitTreeVersion` counter, bumped on every toggle; `gitRowsCache` keyed on `(git, gitTreeVersion)` (currently keyed on `git` ref only).
- **Render** (`buildGitRow`, `navigator.ts:1033-1060`): branch on the new kind; hash/subject styling same as commit rows, indented.

### Files touched

- `git.ts` (log `--parents` + parse), `types.ts` (`GitCommit.parents?`, `GitRow` new kind)
- `navigator.ts` (`toggleCommitFamily`, `gitRows`, `gitNavRows`, `buildGitRow`, `handleGitInput` Enter)
- `constants.ts` (two caps)
- `test/git.test.ts` (merge commit → 2 parents)
- `test/navigator.test.ts` (Enter toggles rows; caps respected)
- `test/render.test.ts` (width safety with expanded family at 80×24 + narrow)
- Docs: `docs/issues/030-...md` + index entry

### Testing

- git: scratch repo with a merge commit → that commit has 2 parents, root commit has 0.
- navigator: Enter on commit with children renders indented child rows; toggling again collapses; caps stop expansion.
- render: expanded family rows are width-safe at all suite sizes.

---

## §3 — Feature #028: Nerd Font icons, env-gated

### New module `icons.ts`

- Pure `mapExtensionToIcon(relPath: string, isDir: boolean): string` — extension → Nerd Font codepoint; dir → folder glyph; unknown/no-ext → generic file glyph.
- Curated map (v1): `ts→`, `tsx→`, `js→`, `jsx→`, `json→`, `md→`, `sh→`, `css→`, `html→`, `py→`, `go→`, `rs→`, `yml/yaml→`, `toml→`, `lock→`, `png/jpg/gif/webp→`, generic ``. Exports `GENERIC_ICON`.
- `parseEnableIcons(env: string | undefined): boolean` — `1`/`true`/`yes`/`on` → true; everything else (incl. unset) → false. Pure, unit-tested.

### Gating

- `index.ts` reads `process.env.PI_NAV_ICONS` **once at overlay open** → passes `enableIcons: boolean` into the `NavigatorOverlay` ctor (new optional `NavigatorOptions.enableIcons?: boolean`, default `false`).
- `navigator.ts` never reads env. Render path stays pure/deterministic.

### Rendering

- `buildFileRow` (`navigator.ts:966`): when `this.enableIcons`, insert a one-cell icon column between the cursor arrow and the name/dir label:
  - dirs keep `▾/▸` marker, icon = folder glyph
  - files get `mapExtensionToIcon`
  - icon inherits the row's name color (selected → `T.text`, hidden/untracked → `T.dim`, open → `T.accent(T.bold)`, etc.)
- **Width-safety**: `truncateAndWidth` room recomputed to account for the extra cell; icon must never push a row over width. Render suite covers icons-on at 120×36, 100×28, 80×24.
- **Notice for opt-in tofu**: when `enableIcons` and the overlay renders icons, show a **one-time, dim, auto-dismissing** notice once per session (reuse existing notice surface): `nerd icons on — glyphs may not render without a Nerd Font`. Non-blocking, no error().

### Files touched

- New `constants.ts`? No — env name + parser live in `icons.ts`; codepoints are the map constant.
- New `icons.ts`, `index.ts` (env read + ctor arg), `navigator.ts` (ctor field, `buildFileRow`, one-time notice), `theme.ts` untouched.
- `test/viewer.test.ts` or new `test/icons.test.ts` (parser + map), `test/render.test.ts` (icon column + width safety), `test/navigator.test.ts` (ctor default `false`).
- Docs: `docs/issues/028-...md` + index entry + README "Config" section + AGENTS.md dev note + DESIGN.md principles.

### Testing

- icons unit: parser truth-table; map for known/unknown/no-ext/dir.
- render: with `enableIcons: true`, icon column appears and rows stay in-bounds at 120/100/80.
- navigator: default (no env) renders exactly today's rows.

---

## §4 — Ordering & sequencing

1. **#029** (git rows/badges) — smallest, independent.
2. **#030** (commit family tree) — needs #029's `gitRows` shape only minimally (independent, but shares `gitRows`/`gitNavRows`; do after #029 to avoid churn).
3. **#028** (icons) — largest render-path blast radius, last.

Each lands as its own commit, typecheck + full suite green before the next.

## §5 — Version & docs

- **Version:** `package.json` `0.2.1 → 0.3.0` (minor, features). Re-run `pi install .` at the end.
- **Docs:** one spec doc at `docs/plans/ui-v2-design.md` (already approved content), plus issue docs `028`/`029`/`030` registered in `docs/issues/issues_index.md` (Pending → Resolved per the lifecycle), README Config section, AGENTS.md dev note, DESIGN.md principles.

## §6 — Open items / decisions surfaced

- Icon codepoint set is a v1 curated subset (not exhaustive); the map is additive and trivial to extend.
- `PI_NAV_ICONS` value set (`1/true/yes/on`) — approved in the config surface discussion; documented in the issue doc.
- Commit-family caps (`3` depth / `16` rows) are starting values; revisit if a real repo makes them feel tight.
