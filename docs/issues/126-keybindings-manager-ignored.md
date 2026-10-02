# Issue #126: The Injected `KeybindingsManager` Is Ignored, So User Key Remapping Never Applies

- **Status**: Resolved
- **Type**: Technical Debt / Platform Contract
- **Severity**: Medium
- **Components**: [`index.ts`](../../index.ts) (overlay mount), [`settings_menu.ts`](../../settings_menu.ts) (menu mount)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M3](../exploration/ui-skill-compliance-audit.md#medium)

## Description

Both `ctx.ui.custom` factories receive the injected `KeybindingsManager` and drop it on the floor:

```ts
// index.ts:399 — the third factory argument is accepted for signature compatibility only
(tui: TuiLike, piTheme: Theme, _keybindings: unknown, done: (value: null) => void) => { … }
```

The code comment at `index.ts:399-403` documents this as deliberate, citing
[`docs/plans/ui-standards-report.md`](../plans/ui-standards-report.md) §2.5 (*"overlay-local keys
(j/k, /, ?) are hardcoded in extensions by convention, as skill-gate does"*).

Two consequences, one of which is a user-visible defect today:

1. The host's app-level cancel binding cannot fire. `pi-tui/dist/keybindings.js:87` defines
   `tui.select.cancel` as `["escape", "ctrl+c"]` — the overlay implements the Esc half by hand and
   loses the Ctrl+C half entirely ([#125](125-ctrl-c-does-nothing.md)).
2. A user who remaps a key in `keybindings.json` sees no effect inside the overlay: the physical key
   keeps whatever this extension hardcoded.

**Where the repo's own reasoning is weakest.** The "local keys are hardcoded by convention" reading is
fair for overlay-local **letters** — `j`/`k`/`g`/`G`/`l`/`h`/`w`/`m`/`n`/`y`/`t`/`r`/`.`, plus `/`
and `?`, have no host binding ids and are genuinely ours. It is much weaker for keys the host has
already claimed as app-level actions (cancel, confirm, selection movement/paging), where
`KeybindingsManager.matches(data, id)` is the documented path.

## Reproduction Steps

1. Remap a host-owned key (e.g. cancel) in the user keybindings file.
2. Open `/navigator` and press it — the remap has no effect.
3. Press `Ctrl+C` (the host's other cancel alias) — nothing happens at all.

## Root Cause

A single deliberate decision — "accept the manager for signature compatibility, consult nothing" —
applied uniformly to two different classes of key: overlay-local letters (fine) and host-owned
actions (not fine). Narrowing the policy fixes both symptoms.

## Proposed Resolution

Consult the manager for host-owned keys only; keep local letters literal and documented.

- cancel → `keybindings.matches(data, "tui.select.cancel")` (covers `Esc`, `Ctrl+C`, and remaps)
- confirm/selection movement → the `tui.select.*` ids where they apply
- keep `j/k/g/G/l/h/./w/m/i/n/N/y/t/r/?` as literals, with a comment saying why

Then update the "deliberately not consulted" comment, `docs/plans/ui-standards-report.md` §2.5 and the
`AGENTS.md` keyboard note to state the narrowed policy.

## Acceptance Criteria

- [ ] Host-owned keys (cancel, confirm, movement/paging where applicable) go through the injected manager
- [ ] Overlay-local letters stay literal, with the policy documented in one place
- [ ] A remapped cancel key works inside the overlay
- [ ] `docs/plans/ui-standards-report.md` §2.5 and `AGENTS.md` reflect the narrowed policy
- [ ] Tests inject a fake manager and assert it is consulted for cancel
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M3](../exploration/ui-skill-compliance-audit.md) — rule: `navigation-and-focus.md`
  *"Do not fight the keybindings manager: if it already owns a key, use the manager rather than
  intercepting"* and *"a keybindings manager (passed to your component factory) for app-level
  bindings and remapping"*.
- Related: [#125](125-ctrl-c-does-nothing.md) (the user-visible half of this root cause)

## Resolution

The `KeybindingsManager` injected into the `ctx.ui.custom` factory is threaded into the overlay and consulted for `tui.select.cancel`, so a remapped cancel key works inside the overlay; overlay-local letters stay literal because the manager is never asked about them. The narrowed policy is recorded in three places: `navigator.ts` (`matchesCancel`), `AGENTS.md` (Conventions) and `docs/plans/ui-standards-report.md` §2.5.

The no-manager fallback matches Esc alone and exists for harnesses only — it is never a shipping substitute. The test guarding this drives the real wiring, which is the failure class [#114](114-untested-cache-warn-wiring.md) recorded.

Verified: `npm run typecheck` and `npm test` green (20 suites).

