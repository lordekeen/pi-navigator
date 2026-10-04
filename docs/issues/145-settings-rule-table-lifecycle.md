# Issue #145: Settings — One Field Rule Table and One Load/Edit/Write Lifecycle

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Medium
- **Component(s)**: `settings.ts`, `settings_menu.ts`, `index.ts`, `icons.ts`, tests

## Description

The architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #5) found three settings
faces sharing rules by convention rather than by structure. Re-validated against
`main@3bd30bb`:

1. **Kind rules live twice.** `settings.ts` `validateFieldValue` (typed JSON: boolean/enum,
  number clamped) and `applyFieldEdit`'s switch + `parseNumberField` (strings: `on`/`off`,
  `options.includes`, number clamp) are independent implementations that must agree. The
  override parsers (`parseImageMode`, `parseIconMode`, `parseLayoutMode`) are a third value
  vocabulary with their own legacy tokens.
2. **Precedence is derived twice.** `loadNavigatorSettings` applies env and flags through six
  hand-written field blocks (spreads + `sources.push`); `index.ts` `collectOverrides`
  independently rescans `process.env` and `pi.getFlag` (three blocks) to label shadowed rows.
  And `collectOverrides` reports mere *presence*: a flag whose value the loader rejected as
  invalid is still labelled "overridden", while the file/default value actually won.
3. **Read→edit→write is written twice.** `runSet` (load → `applyFieldEdit` → write → shadow
  label) and the settings menu's commit (write → reload → warnings) duplicate the persist
  sequence; `countChangedFields` and the notification policy sit in `index.ts` between them.
4. **Adding an env/flag-backed field touches ~9 places**: section interface, registry row,
  options const, override parser, loader env block, loader flag block, env/flag constant,
  `registerFlag`, the `runNavigator` env/flags objects, and `collectOverrides`.
5. **Tests** (`test/settings.test.ts`, 82 cases) index the registry positionally
  (`NAVIGATOR_CONFIG_FIELDS[0]/[3]/[5]`) and byte-pin warning phrasing. `sources` has no
  production consumer — 12 test assertions only.

## Frozen Design (2026-10-04, grilling rounds 1–2)

**One per-kind rule table consulted by both faces; each field declares its override sources;
the loader reports which layer actually won; one commit operation serves both writers.**

1. **The rule table (`settings.ts`).** A module-level per-kind rules object,
   `FIELD_KIND_RULES: Record<"enum" | "boolean" | "number", FieldKindRule>`, with two entry
   points per kind: `accept(field, raw: unknown)` (the JSON face: type check, enum membership,
   finite number + clamp into `[min, max]`, producing the existing warning strings) and
   `parse(field, raw: string)` (the string face: boolean `on`/`off`, enum membership, number
   via `parseNumberField`). `validateFieldValue` becomes a thin call into `accept`;
   `applyFieldEdit` becomes a thin call into `parse` — one rule set, no second switch.

2. **Override sources are registry data.** Each field that a startup layer can set carries
   `override?: { env: string; flag: { name: string; description: string; type: "string" |
   "boolean" }; parse: (raw: string, source: string) => { value?: …; warning?: string } }`.
   The three existing parsers (`parseImageMode`, `parseLayoutMode`, and the icons truth-table
   client `parseIconMode`) keep their exported identity and exact behavior and become the
   rows' `parse` entries; env names come from the constants (`PI_NAV_IMAGES`, `PI_NAV_LAYOUT`,
   `ICONS_ENV`), flag names/descriptions from the current `registerFlag` calls. A boolean flag
   applies its raw value directly (no parse step), exactly as today.

3. **The loader iterates the registry.** `loadNavigatorSettings({ userPath, env?, flags? })`
   takes generic maps — `env: Record<string, string | undefined>` (pass `process.env`) and
   `flags: Record<string, string | boolean | undefined>` keyed by flag name — and walks the
   registry in order: per row, the env layer applies when present and valid, then the flag
   layer beats it. Warning strings, names and ordering stay byte-identical (env warnings from
   the row's parser with the env name as source; string-flag warnings with `--<flag>`; the
   icons boolean flag applies without warning). `sources: string[]` is deleted.

4. **The precedence report.** `loadNavigatorSettings` returns
   `origins: Record<string, { layer: "env" | "flag"; source: string }>` — sparse, one entry
   per field a startup layer actually won (a present-but-invalid flag therefore does NOT
   report an origin; today's `collectOverrides` would have labelled it, and that
   untruthfulness is the one accepted behavior delta). The same registry-driven logic is
   exported as a pure `resolveOverrideOrigins(env, flags)` for callers that need the report
   without the file (justified by the rule table being the single source). `index.ts`'s
   `collectOverrides` is deleted; `runSet`'s shadow warning and the menu's annotations both
   read origins (projected to the existing `fieldId → source label` shape, so
   `buildSettingItems`' signature and the exact description wording are unchanged).

5. **One commit operation.** `settings.ts` gains
   `commitNavigatorSettings(path, settings) → { ok: true; settings; warnings } | { ok: false;
   error }`: atomic write, reload (file-only) and bounded error wrapping. `runSet` and the
   menu's commit callback both call it for persistence; `applyFieldEdit` remains the edit
   step, and each caller keeps its current notification bytes (the menu notifies the reload
   warnings; `runSet` notifies its pre-edit load warnings and does not double-report).

6. **Flag registration and the run-load call iterate the registry.** `index.ts` registers
   flags in a loop over the rows that carry `override.flag` (type + description from the
   row), and builds the `env`/`flags` maps for `runNavigator`'s load by the same walk — adding
   a field is one registry row (plus its settings interface section).

7. **Scope fences.** #067 (typed registry paths) stays deferred and untouched; capability
   notes (`navigatorFieldNotes`), #133 save-feedback copy, `live`/`section` reserved fields,
   and number fields (still none) are out of scope. Behavior is preserved except the truthful
   origins delta in item 4.

## Acceptance Criteria

- [x] `validateFieldValue` and `applyFieldEdit` both delegate to `FIELD_KIND_RULES`; no
  second kind switch exists, and a parity test sweeps every registry field through both faces.
- [x] Every override-backed field declares env + flag in its registry row; the loader,
  `registerFlag` and the origins report are registry-driven loops.
- [x] `collectOverrides` is gone; `runSet`'s warning and the menu annotations come from
  loader/resolver origins; an invalid flag value yields no origin.
- [x] `sources` is gone; no production consumer changed behavior.
- [x] `commitNavigatorSettings` is the only persist operation; both `runSet` and the menu
  commit through it; notification bytes unchanged.
- [x] The env/flag warning strings, precedence outcomes and accepted vocabularies are
  byte-identical to today (tests preserve them).
- [x] Test registry access is by-id, not positional.
- [x] `npm run typecheck` and `npm test` green.

## Resolution

Implemented as designed (2026-10-04), version 0.14.9:

- `settings.ts` — `FIELD_KIND_RULES` is the one per-kind table (`accept` for the JSON face,
  `parse` for the string face; number clamps and every warning/error byte preserved);
  `validateFieldValue` and `applyFieldEdit` are thin calls into it. Each override-backed
  registry row (`images.mode`, `icons.enabled`, `layout.default`) declares
  `override: {env, flag{name,description,type}, parse}`, with the unchanged
  `parseImageMode` / `parseIconMode` / `parseLayoutMode` as the parsers and the former
  `registerFlag` descriptions as the flag descriptors. `resolveOverrideLayers` is the single
  two-pass registry walk (all env layers in registry order, then all flag layers, flags beat
  env per field, boolean flags applied directly); `loadNavigatorSettings` consumes it and
  now takes generic `process.env`-shaped maps, returns `{settings, warnings, origins}` and
  no longer returns `sources`. `resolveOverrideOrigins(env, flags)` exposes the same walk
  without the file. `commitNavigatorSettings(path, settings)` is the one persist operation
  (atomic write → file-only reload → persisted settings + warnings, 160-bounded errors).
- `index.ts` — `collectOverrides`, `flagString` and `flagBoolean` deleted; `flagValues(pi)`
  builds the flag map by iterating registry rows; `registerFlag` is a loop over the rows'
  descriptors (identical names/types/descriptions); `runNavigator`'s load passes
  `env: process.env` + `flagValues(pi)`; `runSet` and the menu commit both go through
  `commitNavigatorSettings`, and their shadow/annotation labels come from
  `resolveOverrideOrigins`.

Accepted behavior delta (the only one): the override report is now truthful — a
present-but-invalid env/flag value no longer labels a field as overridden (the loader never
applied it), where `collectOverrides` reported mere presence. Tests pin both the
invalid-flag-with-no-env and invalid-flag-with-valid-env cases.

Deliberately left alone: `settings_menu.ts` (API and the `— overridden by X (env wins)`
wording), `icons.ts`, `constants.ts`, the `live`/`section` reserved fields,
`navigatorFieldNotes`, the #133 save-feedback copy, and #067's deferral.

Verification: `npm run typecheck` clean; `npm test` **21 suites / 888 cases** (876 baseline,
+12 — the parity sweep, registry-driven loader walk, origins semantics, layer
warning-order pin, override-backed-row descriptor guard, and the
`commitNavigatorSettings` contract). No behavior assertion was weakened; the 12 `sources`
assertions were converted to `origins` coverage and the positional registry reads to by-id
lookups.

## References

- Architecture review of 2026-10-03, candidate #5:
  [`docs/audits/architecture-review-2026-10-03.html`](../audits/architecture-review-2026-10-03.html)
- [`docs/GLOSSARY.md`](../GLOSSARY.md) — "settings field rule", "override origin"
- [#131](131-settings-flags-and-headless-path.md) — the flags and `/navigator set` this unifies
- [#133](133-settings-commit-and-cancel-feedback.md) — the save feedback this preserves
- [#118](118-settings-menu-chafa-capability-note.md) — the notes channel this leaves alone
