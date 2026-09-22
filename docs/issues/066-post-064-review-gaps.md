# Issue #066: Post-#064 Review Gaps (last inline `padTo`, env literal, docs drift)

- **Status**: Resolved
- **Type**: Technical Debt / Code Hygiene
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) (`getRenderedMarkdownLines`), [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts) (`parseImageMode`), [`docs/`](file:///home/jhonny/Sources/pi-navigator/docs)
- **Found by**: two-axis (Standards / Spec) review of `c372631` — the #063/#064 refactor commit

---

## Description

The `c372631` refactor passed both review axes with no hard violations, but the Standards axis left four
ungathered items: one extraction the commit itself created but did not finish applying, one duplicated
literal, and two documentation defects. This issue closes them and records four further review findings
that were assessed and deliberately **not** changed, so the next reviewer does not re-file them.

## Findings fixed

1. **The last inline copy of the pad-to-width idiom** — `navigator.ts` `getRenderedMarkdownLines` still
   inlined `vw < width ? line + " ".repeat(width - vw) : hardTruncate(line, width)` while `c372631`
   extracted that exact body into `frame.ts` `padTo`. Now `rawLines.map((line) => padTo(line, width))`;
   the imports it made dead (`visibleWidth` from pi-tui, `hardTruncate` from `viewer.ts`) are removed.
   `tsconfig.json` has no `noUnusedLocals`, so the dead imports were found by search, not the compiler.
2. **Duplicated normalization + a hardcoded env name** — `settings.ts` `parseImageMode` computed
   `trimmed`/`normalized` for the `chafa` early-return and then handed the **raw** value to
   `parseTruthyEnv`, which trims/lowercases again; it also passed the literal `"PI_NAV_IMAGES"` while
   `NAVIGATOR_IMAGES_ENV` already existed in `constants.ts`. It now passes `normalized` and the constant.
   The emitted warning embeds `parseTruthyEnv`'s own internally-trimmed value, so every warning string is
   byte-identical — pinned by the existing `test/settings.test.ts` warning assertions.
3. **#064's line count was stale** — the issue doc and the index row said `2,052 → 1,469 (−583, −28%)`.
   `git show HEAD~1:navigator.ts | wc -l` is **2,060**, so the real delta is **−591 (−28.7%)**. The doc's
   own Finding-1 heading already said 2,060; only the summary line carried the stale base (measured before
   #061/#062 added lines). The refactor commit's message text cannot be corrected retroactively.
4. **`docs/code-review.md` read as live conventions** — it is a point-in-time report from the 5-suite /
   99-case era, and during the `c372631` review a sub-agent cited it as a standards source. It now opens
   with a *Historical document* banner pointing at `docs/issues/issues_index.md` as the live tracker.

## Assessed, deliberately not changed

- **`git_view.ts` `codeText` cascade + `nameStyle` ternary.** Labelled "possible Repeated Switches", but
  each cascade occurs exactly once and both are already linear data→style maps; a lookup table would be
  marginally shorter without removing a real duplication.
- **Residual raw empty-ellipsis cuts (`images.ts`, `settings_menu.ts`).** #063 finding 3 scoped
  `hardTruncate` to the `navigator.ts` sites, and the two residuals are structurally different:
  `settings_menu.ts` **cannot** statically import `viewer.ts` — it lazy-loads pi-tui (`SettingsList`,
  `truncateToWidth`) so the menu degrades when the TUI module is missing; and `images.ts`'s cut is a
  per-row clamp followed by a guaranteed `\x1b[0m` reset for pre-styled chafa output.
- **`settings.ts` `as unknown as` casts (6 sites).** Kept as the documented trade-off #063 shipped: the
  registry walks a `readonly string[]` path, so a typo (`["viewer", "wrapp"]`) compiles — but it cannot
  survive the suite, because `serializeNavigatorSettings`'s test pins the emitted object *and* the exact
  byte-order JSON. Moving that safety from tests to the compiler (key-typed paths) is a real improvement
  but a ~100-line rework of a module whose on-disk format is byte-pinned; not worth it in a cleanup pass.
- **Unified completion wording.** `index.ts` `navigatorCompletions` now derives `description` from
  `NAVIGATOR_SUBCOMMANDS`, which changed two user-visible popup strings (`"Configure…"` →
  `"configure…"`, `"Lists every /navigator subcommand"` → `"show this command list"`). Kept: the durable
  `/navigator help` entry already used those exact phrases, so the popup aligned *to* the help surface
  instead of forking a second copy — the point of #063 finding 5. Now pinned in `test/help.test.ts`.

## Process note for future refactors

`c372631` claims byte-identical equivalence "over 28 fixture states x 120/100/80/60 columns" with the
harness "deleted after use". Nothing in the repo can reproduce that claim post-hoc. A behaviour-identical
refactor should leave its equivalence harness behind as an opt-in/skipped snapshot suite (or attach the
digest of its output to the issue), so the guarantee is auditable after the fact.

## Acceptance Criteria

- [x] All `padTo`-idiom sites route through `frame.ts` `padTo`; dead imports removed.
- [x] `parseImageMode` normalizes once and uses `NAVIGATOR_IMAGES_ENV`; warning strings unchanged.
- [x] #064's line count and delta corrected in the issue doc and the index.
- [x] `docs/code-review.md` marked historical with a pointer to the live tracker.
- [x] Assessed-and-not-changed findings recorded with their rationale.
- [x] `npm run typecheck` and `npm test` green (19 suites / 498 cases).

## References

- Review of `c372631` (Standards axis findings 1, 3, 5; Spec axis findings 3, 4)
- [#063](063-review-followups.md) (the dedup this completes), [#064](064-navigator-decomposition.md) (the refactor under review)
- [#065](065-viewer-header-hscroll-badge-stale-clamp.md) (the one behaviour change filed out of the same review)
