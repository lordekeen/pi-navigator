# Issue #133: Settings Commits Report Nothing and Cancellations Say Nothing

- **Status**: Resolved
- **Type**: Enhancement / UX
- **Severity**: Medium
- **Components**: [`settings_menu.ts`](../../settings_menu.ts) (`onChange`, `done`), [`index.ts`](../../index.ts) (`runSettings` notify wiring)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M9](../exploration/ui-skill-compliance-audit.md#medium)

## Description

The settings surface is silent in both directions.

**No success feedback.** Every `notify` call in the extension uses `"warning"` — there is no
`"info"`-severity notification anywhere in the repo (`index.ts:260,279,392,807,846,888,891,897`). A
successful commit returns `{ ok: true, settings }` (`settings_menu.ts:283-287`) and only refreshes the
rows; nothing is ever reported to the user, no count and no scope.

**No cancellation feedback.** Dismissal is a bare `done()` (`settings_menu.ts:301`), and the string
`unchanged (cancelled)` does not appear anywhere in the repository.

The standard is explicit on both:

> *"Report the outcome **after** the action, with the exact count and the scope."* — `commands-and-arguments.md`
> *"The modal asks; the toast reports. A message rendered inside a modal vanishes with it."* — `dialogs-and-modals.md`
> *"After any cancellation | Say so: `forget: unchanged (cancelled)`. Silence after a cancel is
> indistinguishable from a failure."* — `dialogs-and-modals.md`

**Root cause is shared with [#121](121-settings-esc-cancel-live-apply.md):** because the menu
live-applies each edit, there is no commit *moment* to report, and no cancel that means anything — so
neither message was ever written. This issue becomes straightforward once #121 stages edits and commits
once.

## Reproduction Steps

1. Run `/navigator settings`, change a value, and confirm/close by any route.
2. No message appears (only the row's own value changes).
3. Reopen, press `Esc` immediately — again nothing, so a dismissal is indistinguishable from a crash
   or a no-op.

## Root Cause

Live-apply removed the commit event from the interaction model, and the notification vocabulary was
never extended past warnings. There is no `"info"` producer at all, which is itself the semantic gap:
successes and benign no-ops have no channel in this extension.

## Proposed Resolution

With [#121](121-settings-esc-cancel-live-apply.md)'s confirm step in place:

- **success** → `notify(info)`: `pi-navigator: settings saved (N fields) → ~/.pi/agent/pi-navigator.json`
  — the count **and** the scope, so the user never has to infer which file changed;
- **cancel/dismiss** → `notify(info)`: `pi-navigator: settings unchanged (cancelled)`;
- **failures** keep `"warning"` and continue to name the field and the reason (existing behaviour);
- introduce `"info"` for the first time, and keep it for successes and benign no-ops only
  ("nothing to change" is not an error).

## Acceptance Criteria

- [ ] A successful save reports the outcome, the count and the file it landed in (`info`)
- [ ] Dismissing/cancelling reports `settings unchanged (cancelled)` (`info`)
- [ ] Validation and write failures stay `warning` and still name the offending field
- [ ] `"info"` severity is used for successes; no success is reported as an error
- [ ] Messages are emitted **after** the menu closes, never inside it
- [ ] Tests assert the message on the save path and on the cancel path
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M9](../exploration/ui-skill-compliance-audit.md) — rules: `commands-and-arguments.md`
  §Outcome messages; `dialogs-and-modals.md` §Cancel semantics, §Feedback belongs outside the modal
- Related: [#121](121-settings-esc-cancel-live-apply.md) (creates the commit moment),
  [#068](068-settings-menu-standards-parity.md) (settings standards parity, resolved)

## Resolution

Settings outcomes now report: a successful save emits one `info` carrying the changed-field count and the file it landed in, and a cancellation emits `settings unchanged (cancelled)`; validation and write failures stay `warning` and still name the offending field. Messages are emitted after the menu closes, never inside it.

Verified: `npm run typecheck` and `npm test` green (20 suites).

