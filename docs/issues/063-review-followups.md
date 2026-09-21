# Issue #063: Code-Health Review Follow-Ups (Duplication, Seams, Test Gaps)

- **Status**: Open (Pending)
- **Type**: Technical Debt
- **Severity**: Low
- **Component**: [`icons.ts`](file:///home/jhonny/Sources/pi-navigator/icons.ts) / [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts) / [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) / [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`help.ts`](file:///home/jhonny/Sources/pi-navigator/help.ts) / tests

---

## Description

Batch of low-severity findings from the review run alongside Issue #062 (two-axis standards/spec review plus a repo-wide health sweep over `8195914..HEAD` + the working tree). Nothing here is a live defect; each item is a duplication, a missing seam, or a coverage gap that grows more expensive the longer it sits. Ordered by leverage.

## Findings

### 1. Env truth-table parsing is duplicated (`icons.ts:117` / `settings.ts:259`)

`parseIconMode` and `parseImageMode` carry identical enable/disable value sets and the same invalid-value warning shape; `icons.ts` even documents "Mirrors `parseImageMode`". Two copies of a truth table drift the moment one grows a value.

**Fix:** extract one `parseTruthyEnv(value, envName, fieldLabel)` (or a shared value table) and keep the two adapters as thin projections onto their own return types.

### 2. `notifyWarning` / `emittedWarnings` dedup block duplicated (`index.ts`)

`runNavigator` and `runSettings` each build their own `Set<string>` + notify-once closure. The rule "notify once per distinct message per invocation" is a documented convention (§5.2 pattern) with two implementations.

**Fix:** one small module-level factory (or a `makeNotifier(ui)` helper) both commands call.

### 3. Hard-cut truncation repeats the #010 convention in 7 places (`navigator.ts`)

`truncateToWidth(text, width, "")` (empty ellipsis = clean hard cut) appears 7 times across `navigator.ts`, with the `truncateAndWidth` wrapper as an eighth variant. The convention is load-bearing (Issue #010: the default `"..."` ellipsis injects `\x1b[0m` resets and leaks bright text).

**Fix:** a single `hardTruncate(text, width)` helper next to `sliceStyled` in `viewer.ts`, with the #010 rationale documented once at its definition.

### 4. Settings normalization repeats the same section shape four times (`settings.ts`)

`normalizeNavigatorSettings` has four near-identical blocks (section guard → unknown-key warnings → per-key validate), and `setField` still switches on hardcoded field-id strings (`"images.mode"`, …) while `settings_menu.ts`'s `fieldValue` walks `field.path` generically. Adding one field touches five spots (defaults, clone, normalize, serialize, `setField` switch), and `field.kind` is switched independently in `settings.ts` (`applyFieldEdit`) and `settings_menu.ts` (`buildSettingItems`).

**Fix:** drive all of it from `NAVIGATOR_CONFIG_FIELDS` (one generic per-kind validator + one generic path setter/getter), so a new field is a registry row plus its description.

### 5. Help surfaces are two hand-maintained tables

`HELP_ROWS` (`navigator.ts:123`, in-overlay `?` modal) and `NAVIGATOR_COMMANDS` (`help.ts:17`, `/navigator help` transcript entry) must be co-edited; `navigatorCompletions` (`index.ts`) re-types the same descriptions a third time. Drift means the three surfaces disagree on keybindings or wording.

**Fix:** one exported table (id, keys, description) projected into all three renderings, or at minimum a test asserting the descriptions and key lists agree.

### 6. Two modules have no direct test suite

- `diff.ts` (`styleDiffLines`) — pure single-function module, exercised only transitively through git/viewer suites.
- `theme.ts` — the optional-`underline` guard from Issue #042 is only covered indirectly.

**Fix:** ~15 lines of table tests each; the cheapest coverage gap in the repo.

## Acceptance Criteria

- [ ] Shared env truth-table parser; both adapters project from it.
- [ ] One notify-once implementation used by `runNavigator` and `runSettings`.
- [ ] `hardTruncate` helper in `viewer.ts`; the 7 raw empty-ellipsis call sites use it.
- [ ] Settings normalization driven by the field registry; `setField` no longer switches on hardcoded ids.
- [ ] Help/command/keybinding tables have a single source or a drift test.
- [ ] `diff.ts` and `theme.ts` gain direct suites.
- [ ] `npm run typecheck` and `npm test` green.

## References

- Review run: two-axis standards/spec review + repo-wide health sweep over `8195914..HEAD` (Issue #062 work)
- Convention: Issue #010 (empty-ellipsis hard cut), Issue #042 (optional theme token guard), `docs/plans/ui-standards-report.md`
