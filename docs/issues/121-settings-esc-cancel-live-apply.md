# Issue #121: Settings Menu's "Esc to cancel" Does Not Cancel — Edits Are Written Immediately

- **Status**: Resolved
- **Type**: Bug / UX Consistency
- **Severity**: High
- **Components**: [`settings_menu.ts`](../../settings_menu.ts) (`onChange`), [`index.ts`](../../index.ts) (`runSettings` → `commit`), [`settings.ts`](../../settings.ts) (`writeNavigatorSettings`)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 H1](../exploration/ui-skill-compliance-audit.md#high)

## Description

The settings surface is **live-apply**: every row change commits and writes to disk immediately,
while the chrome rendered by the host's `SettingsList` promises the opposite.

- The host renders `"Enter/Space to change · Esc to cancel"` —
  `@earendil-works/pi-tui/dist/components/settings-list.js:248`.
- `settings_menu.ts:280-283` calls `deps.commit(edited.settings)` on **every** `onChange`.
- That callback writes synchronously to the user's config file —
  `index.ts:873-875` → `writeNavigatorSettings(userPath, next)`.

So a user who changes a value, reconsiders, and presses `Esc` has **already persisted it**. `Esc`
closes the menu and cannot undo the write. The cancel affordance is stated by the UI and honoured
by nothing.

The wording is host-owned (`SettingsList` is a host primitive), so it cannot be reworded from this
side — the mismatch has to be fixed on the integration side: `Esc` must actually revert.

## Reproduction Steps

1. Run `/navigator settings`.
2. Change any value (e.g. `viewer.wrap`, `images.mode`).
3. Press `Esc` — the menu closes, implying no change.
4. Inspect `~/.pi/agent/pi-navigator.json`: the new value **is** written.

## Root Cause

Live-apply integration. The menu treats each row edit as a completed change (`commit` per edit), but
the host primitive it is built on advertises a cancel that reverts. `openSettingsMenu` has no draft
state and no confirm step, so there is no moment at which a change could be discarded.

## Proposed Resolution

Stage edits and commit once, on an explicit confirm — which also creates the missing outcome moment
for [#133](133-settings-commit-and-cancel-feedback.md):

- **Draft in memory**: apply edits to an in-memory `current`, write on confirm; `Esc` discards.
- **Temp-file-then-rename on confirm**: reuse the existing atomic writer
  (`settings.ts:466-480`) but call it once, on confirm.

Either shape keeps the existing atomic writer and the reload/validate path; only the *timing* of
`commit` changes. A per-row "applied" indicator (or keeping the changed row highlighted while the
draft is dirty) keeps the frame honest about unsaved state.

## Acceptance Criteria

- [ ] `Esc` after edits leaves `~/.pi/agent/pi-navigator.json` byte-identical to its pre-open state
- [ ] Confirm writes exactly once, through the existing atomic tmp+rename writer
- [ ] The frame distinguishes draft from persisted state (no silent dirty state)
- [ ] Env-override annotations and normalization/reload behaviour are unchanged
- [ ] Regression tests: `Esc` after edits → file unchanged; confirm → written once
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 H1](../exploration/ui-skill-compliance-audit.md) — rule: `dialogs-and-modals.md`
  *"The default action is cancel… `Esc` always cancels"* and *"After any cancellation, say so"*.
- Host wording: `pi-tui/dist/components/settings-list.js:248`
- Related: [#133](133-settings-commit-and-cancel-feedback.md) (outcome/cancel messages),
  [#062](062-settings-menu-overlay-placement.md) (where the menu docks)

## Resolution

Esc now discards: `settings_menu.ts` stages each edit in an in-memory draft (`onChange` commits nothing) and a trailing **Save** row calls `commit` exactly once — the pattern pi's own settings selector uses, since the host `SettingsList` has no form-level submit. Esc routes through `onCancel` to `{kind: "cancelled"}` so the file is never written, and the frame switches between clean and dirty wording so draft state is never silent. Verified by a test that stages a real edit (`images.mode` chafa→native) before pressing Esc, then asserts the file is byte-identical to its pre-open state with no `.tmp` leftovers.

Verified: `npm run typecheck` and `npm test` green (20 suites).

