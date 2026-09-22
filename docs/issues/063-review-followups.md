# Issue #063: Code-Health Review Follow-Ups (Duplication, Seams, Test Gaps)

- **Status**: Resolved (v0.7.2)
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

- [x] Shared env truth-table parser; both adapters project from it.
- [x] One notify-once implementation used by `runNavigator` and `runSettings`.
- [x] `hardTruncate` helper in `viewer.ts`; the 7 raw empty-ellipsis call sites use it.
- [x] Settings normalization driven by the field registry; `setField` no longer switches on hardcoded ids.
- [x] Help/command/keybinding tables have a single source or a drift test.
- [x] `diff.ts` and `theme.ts` gain direct suites.
- [x] `npm run typecheck` and `npm test` green.

## Resolution

All six findings fixed; 19 suites / 496 cases green (from 10 / 347), typecheck clean. version 0.7.2.

1. **Env truth table.** New pure, dependency-free `env.ts` owns `TRUTHY_ENV_VALUES` / `FALSY_ENV_VALUES` and `parseTruthyEnv(value, envName)` → `{ value?, warning? }`. `parseIconMode` (`icons.ts`) is a three-line projection; `parseImageMode` (`settings.ts`) recognizes the literal `chafa` token itself *before* delegating, so each env var keeps its accepted set byte-for-byte (`PI_NAV_ICONS=chafa` is still invalid-with-warning; `PI_NAV_IMAGES=chafa` still means chafa). Warning template (`<value> is not a valid <ENV_NAME> value; using the file/default setting`) and the unset/empty/whitespace "no override" rule are pinned by `test/env.test.ts` (13 cases) plus the existing `toEqual` shape pins in `test/icons.test.ts` / `test/settings.test.ts`. `env.ts` was added to `package.json` `files` **and** `tsconfig.json` `include`, and the reason (Issue #037) is documented in the module header.
2. **Notify-once.** `makeWarningNotifier(ui: Pick<ExtensionUIContext, "notify">)` in `index.ts` creates the `Set` per factory call and returns the closure; both `runNavigator` and `runSettings` call it. Per-invocation scope (not module-global) is pinned by a dedicated test, including a second `/navigator` invocation warning again for the same message.
3. **`hardTruncate`.** Added to `viewer.ts` next to `sliceStyled` with the #010 rationale at the definition; `truncateAndWidth` (`frame.ts` after the #064 extraction) and the other seven sites now call it, `navigator.ts` no longer imports `truncateToWidth` (only one mention survives, in a comment). The two subtle sites kept their shape: the fit-or-cut branch in the rendered-markdown rows and the strip-then-re-style path in the help modal. Pinned by four focused tests (passthrough, no-ellipsis/no-injected-reset cut, wide-CJK cell safety, open-style termination).
4. **Registry-driven settings.** `NavigatorConfigField` gained `default`; `DEFAULT_NAVIGATOR_SETTINGS`, `cloneDefaults()`, `normalizeNavigatorSettings`, `serializeNavigatorSettings` and `setField` all walk `NAVIGATOR_CONFIG_FIELDS` — the `switch` over hardcoded `"images.mode"`-style ids is gone. Warning strings, section/leaf key order and the serialized JSON byte order are unchanged (existing assertions still pass; new tests pin the registry as the source of defaults and round-tripping). `settings_menu.ts` was deliberately left alone: its `field.kind` switch formats *display* values, a different axis from the normalizer's *validation* switch, and unifying them would have added an abstraction without removing code.
5. **One help surface.** `help.ts` owns `NAVIGATOR_SUBCOMMANDS` (`{cmd, desc, completionLabel}`) and `NAVIGATOR_KEYBINDINGS` (`{id, keys, description}`). `NAVIGATOR_COMMANDS` derives from the subcommand table, `navigatorCompletions` **and** `parseNavigatorArgs` derive from it in `index.ts`, and `navigator.ts` re-exports `HELP_ROWS` projected from the keybinding table (byte-identical `?` modal: same 19 rows, same order). Drift tests assert the completions match the help rows verbatim, every subcommand parses to its kind, `HELP_ROWS` is exactly the shared projection, and the ids are unique.
6. **Direct suites.** `test/diff.test.ts` (30) pins the `styleDiffLines` classification table (incl. mid-line prefix safety and 1:1 content preservation) and `test/theme.test.ts` (21) pins every semantic token mapping plus the #042 optional-`underline` guard and the `searchMatch`/`searchCurrent` composition order.

## References

- Review run: two-axis standards/spec review + repo-wide health sweep over `8195914..HEAD` (Issue #062 work)
- Convention: Issue #010 (empty-ellipsis hard cut), Issue #042 (optional theme token guard), `docs/plans/ui-standards-report.md`
