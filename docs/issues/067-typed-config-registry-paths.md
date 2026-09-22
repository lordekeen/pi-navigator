# Issue #067: Typed Config Registry Paths

- **Status**: **Deferred** — filed for tracking, not scheduled
- **Type**: Technical Debt / Type Safety
- **Severity**: Low
- **Component**: [`settings.ts`](file:///home/jhonny/Sources/pi-navigator/settings.ts) (`NAVIGATOR_CONFIG_FIELDS` and the registry walk)
- **Deferred from**: the post-#064 review ([#066](066-post-064-review-gaps.md)), where it was assessed and deliberately declined for a five-field schema

---

## Why deferred

`settings.ts` currently pays for schema changes in **runtime tests** instead of **types**, and that trade
is a good one at five fields: a typo'd path cannot survive the suite, because
`serializeNavigatorSettings`'s test pins the emitted object *and* the exact byte-order JSON. The design
below moves that safety to the compiler, but it is not free (see *Catch*), so it is filed rather than
scheduled.

**Revisit when any of these becomes true:**

- the schema grows past roughly 15 fields or gains a third section level — each new entry then costs one
  registry row instead of one row plus one runtime pin;
- `live: true` is implemented and fields are applied without a reload, so the walk runs on a hot path
  where a wrong path fails quietly instead of at load;
- the byte-pinned `serializeNavigatorSettings` test is relaxed or split — that test is the runtime net this
  deferral leans on, and losing it changes the trade;
- a real defect escapes that a compile-time path check would have caught.

## Description

`NavigatorConfigField.path` is `readonly string[]`, so every consumer indexes the compile-time
`NavigatorSettings` interface with runtime strings. `settings.ts` carries 8 `as unknown as` casts: **6 are
path-walk casts** (`buildDefaultSettings` return, `setField` ×3, `serializeNavigatorSettings` and its
clone) and **2 are structural** (`deepFreezeDefaults`' `Object.values` walk) — the structural pair would
survive this rework, so "make the casts disappear" is not an accurate description of it.

Two failure modes are compile-clean today:

1. **A typo'd path** — `path: ["viewer", "wrapp"]` type-checks; only the serialize pin objects at runtime.
2. **A wrong-typed default or option set** — `default: string | number | boolean` and
   `options?: readonly string[]` are unrelated to the section's value type, so the row for
   `["viewer", "wrap"]` could declare `default: "code"` or `options: ["code"]`. Nothing in `settings.ts`
   objects; only a runtime test must.

## Proposed design

Derive the valid path set from the interface. The **product expansion is the load-bearing detail** — the
obvious `readonly [S, KeysOf<S>]` form is wrong:

```ts
type Sections = Omit<NavigatorSettings, "version">;
type SectionName = keyof Sections & string;

// Product over section x key. The tempting `{ [S in SectionName]: readonly [S, keyof Sections[S] & string] }`
// would admit `["viewer", "wrap" | "markdown"]` as one member, so markdown's values would satisfy
// `["viewer", "wrap"]`'s default — silently, which is the whole hazard this issue is about.
type ConfigPath = {
  [S in SectionName]: { [K in keyof Sections[S] & string]: readonly [S, K] }[keyof Sections[S] & string];
}[SectionName];

type ValueAt<P extends ConfigPath> = P extends readonly [infer S, infer K]
  ? S extends SectionName
    ? K extends keyof Sections[S]
      ? Sections[S][K]
      : never
    : never
  : never;

export interface NavigatorConfigField<P extends ConfigPath> {
  readonly path: P;
  readonly default: ValueAt<P>;             // "viewer.wrap" must default to a boolean
  readonly options?: readonly ValueAt<P>[]; // enum members checked against the section
  readonly kind: "enum" | "boolean" | "number";
  // …id / section / label / description / min / max / live unchanged
}

// Distributive union, so each registry literal keeps its own P; plain
// `NavigatorConfigField[]` would collapse P to the union and accept anything.
export type AnyConfigField = { [P in ConfigPath]: NavigatorConfigField<P> }[ConfigPath];
export const NAVIGATOR_CONFIG_FIELDS: readonly AnyConfigField[] = [ /* …five rows, unchanged values */ ];
```

**Walk sites.** A runtime tuple cannot index the interface even when typed as a union — TypeScript cannot
correlate `path[0]` and `path[1]` when both are unions. Two ways out:

1. **Exhaustive `switch (path[0])`.** Inside `case "viewer"` the tuple narrows to that section's members,
   so `path[1]` is exactly `"wrap" | "markdown"` and `{ ...viewer, [path[1]]: value }` type-checks with
   `value: ValueAt<…>` — no cast. Four branches (one per section) per structural operation, covered by
   `noFallthroughCasesInSwitch` plus an exhaustiveness check. This is *not* the field-id switch #063
   deleted, but it is hand-written per-section code inside the module whose whole point is that the
   registry drives everything.
2. **One boundary accessor.** `getAt`/`setAt` carrying a single documented `SAFETY` cast, replacing six.
   This centralizes the laundering rather than removing it, and does not give the typed `default`/`options`
   guarantees (those come from the type mapping above regardless of which walk style is chosen).

## Catch: mapped types fail open

If `ConfigPath` or `ValueAt` is subtly wrong, both collapse to `never` and **everything still compiles** —
the machinery would type nothing while the runtime pins it replaced are gone. The rework must therefore
ship with negative type tests (`// @ts-expect-error` fixtures or `expectTypeOf`) proving that a bad path
and a wrong-typed default fail to compile. That requirement — not the type plumbing — is the real cost
driver, and the reason this is deferred rather than queued.

## Cost estimate

~100–150 lines touched in `settings.ts` (including the registry literal's shape), 4–6 type-assertion
cases, and no change to the runtime contract: warning strings, serialization order, and the
`/navigator settings` rows stay byte-identical, with the current 19 suites / 498 cases green throughout.

## Acceptance Criteria (not started)

- [ ] `ConfigPath` is the product expansion over section × key, so no pair admits another key's values.
- [ ] `path`, `default` and `options` are checked against `NavigatorSettings`; the 6 path-walk casts are gone (the 2 `deepFreezeDefaults` structural casts may remain, with their rationale recorded).
- [ ] Negative type tests prove a bad path and a wrong-typed default fail to compile.
- [ ] `serializeNavigatorSettings`'s byte-order pin, the warning strings, and the `NAVIGATOR_CONFIG_FIELDS` sync guards are unchanged and green.
- [ ] `npm run typecheck` and `npm test` green.

## References

- [#066](066-post-064-review-gaps.md) — where this was assessed and declined for a five-field schema
- `docs/specs/navigator-settings-menu.md` — the settings terrain this registry drives
- [#063](063-review-followups.md) — made `NAVIGATOR_CONFIG_FIELDS` the single source (and removed the field-id switch)
