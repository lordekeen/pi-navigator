# Issue #118: Settings Menu Offers `chafa` Mode With No Indication That pi-chafa Is Required

- **Status**: Resolved
- **Type**: Enhancement / UX
- **Severity**: Low
- **Components**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts) (row notes), [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) (presence detection)
- **Found by**: follow-up question on pi-chafa optionality, 2026-09-23

## Description

`images.mode` always lists `off | chafa | native | auto` (`IMAGE_MODES` in
`settings.ts`), and `/navigator settings` renders the enum straight from that
registry with no presence awareness: `buildSettingItems` is built from the schema
plus env overrides, and `runSettings` never consulted pi-chafa. With pi-chafa
absent the `chafa` value is inert — `resolveImageSupport` leaves chafa
`deferred`, the tier resolves `none`, and the viewer card explains
`optional: install chafa + pi-chafa (pi install npm:pi-chafa)`
(`viewer_view.ts:386`) — but the settings row itself gave no hint, so a user
selecting `chafa` could not tell why nothing happened.

pi-chafa itself is and remains optional: no dependency, no import, and
`detectPiChafa` resolves absence to `{ present: false, via: "none" }`, after
which the binary probe is skipped entirely.

## Resolution (v0.11.0) — annotate, do not hide

- New pure `navigatorFieldNotes({ piChafaPresent })` (`settings_menu.ts`) maps
  capability facts to `fieldId → note` text and is unit-tested directly.
- `buildSettingItems(settings, overrides, notes?)` appends the note to the field
  description; notes compose with the existing env-override annotation (note
  first, then `— overridden by <ENV> (env wins)`).
- `openSettingsMenu` accepts `notes` and threads it through both row builds
  (initial render and the post-commit refresh).
- `runSettings` (`index.ts`) detects presence with `detectPiChafa` against the
  same user/project settings paths the overlay uses and passes
  `navigatorFieldNotes({ piChafaPresent })`. The menu module stays pi-free and
  does no detection itself.
- Rendered note when absent: `the chafa mode needs chafa + pi-chafa (pi install
  npm:pi-chafa)`, matching the overlay card hint's wording and install command.

The enum values are deliberately unchanged: a user can legitimately
pre-configure `images.mode` before installing pi-chafa, and removing the value
would make the menu disagree with the schema. Overlay behavior when pi-chafa is
absent is untouched (deferred chafa, no probe, tier `none`, card + install hint).

## Acceptance Criteria

- [x] With pi-chafa absent, `/navigator settings` annotates the `images.mode` row
      with the chafa requirement; no other row changes.
- [x] With pi-chafa present, descriptions are byte-identical to before.
- [x] The note composes with an active `PI_NAV_IMAGES` env override.
- [x] pi-chafa remains optional: detection only, no dependency, no import, and the
      overlay still degrades to the card with the install hint.

## Evidence (2026-09-23)

- Tests: +2 (`test/settings_menu.test.ts`) — the pure note mapping and description
  composition with an env override, plus the present-case no-op (the second test
  was observed failing before the change).
- `npm run typecheck` clean; `npm test` 20 suites / 672 cases green.
- Presence detection reuses the pinned `detectPiChafa` path
  (`test/images.test.ts`, including "skips the probe entirely when pi-chafa is
  absent").
