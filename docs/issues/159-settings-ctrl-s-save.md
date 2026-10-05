# Issue #159: Settings Confirmation Is a Synthetic Save Row Instead of Ctrl+S

- **Status**: Resolved
- **Type**: Enhancement / UX Consistency
- **Severity**: Low
- **Components**: [`settings_menu.ts`](../../settings_menu.ts) (`SettingsMenuFrame`, `openSettingsMenu`), [`README.md`](../../README.md), [`AGENTS.md`](../../AGENTS.md)
- **Found by**: Ecosystem convention check against the installed pi host (1.0.3) and the installed extension set, 2026-10-05

---

## Description

The settings menu stages edits in an in-memory draft and confirms them through a
synthetic trailing list row: `{ id: "save", label: "Save", currentValue:
"save and go back", values: ["save and go back"] }` appended after the registry
rows. Issue #121 introduced the row because pi-tui's `SettingsList` exposes only
per-change `onChange` and `onCancel` — no form-level confirm — and the row was
the clearest available commit moment at the time. That constraint still holds,
but the row is not a setting:

- It appears in search results (`enableSearch: true`) and matches the query
  "save" as if it were a value.
- It participates in the list's scroll math and row counting; tests count it as
  an item.
- It is the only item in the list not built from `NAVIGATOR_CONFIG_FIELDS`, so
  the item model is not "one row per setting".

The ecosystem's staged-save convention is Ctrl+S with a footer hint, not a
value-list row. The survey below was taken on 2026-10-05 against pi 1.0.3 and
the extensions installed in this environment.

## Evidence

| Surface | Staged draft? | Save affordance |
| :--- | :--- | :--- |
| pi base model picker | yes | **Ctrl+S** (`app.models.save`, "Save model selection") → save & close; footer advertises |
| pi base thinking selector | yes | **Ctrl+S** (`app.thinking.save`) → save & close; footer advertises |
| pi base `/settings` main list | no — live-apply per change | none |
| pi base automatic-theme submenu | yes | "Apply" row, description "save and go back" — the one save row in base |
| `@aliou/pi-utils-settings` (library; used by **pi-processes**) | yes | **Ctrl+S saves drafts from any depth; footer `Ctrl+S save · Esc close`; no row**; dirty tabs marked; "saved" notify |
| **pi-blackhole** | yes ("buffered") | **Ctrl+S** (footer `ctrl+s save`) **plus** a Save/Discard/Reset action row |
| pi-vision-handoff | yes | **Ctrl+S = done** (save & close), footer advertises |
| pi-overseer, pi-chafa, pi-usage, pi-statusbar-control, pi-token-speed | no | live-apply per change, no save affordance |

Key mechanics verified for the fix:

- `SettingsList.handleInput` claims only `tui.select.up` / `down` / `confirm` /
  `cancel`; with `enableSearch: true` every other key — **including Ctrl+S** —
  falls through to its search `Input`. The chord must be intercepted in
  `SettingsMenuFrame.handleInput` **before** delegating to the list, which is
  also what `@aliou/pi-utils-settings` deliberately does ("intercept here so
  submenus never see the key").
- pi has **no host action id** with "save this menu" semantics. The three
  ctrl+s ids are context-local to other selectors (`app.models.save`,
  `app.thinking.save`, `app.session.toggleSort` — session sort), so rerouting
  through one of them would apply the wrong user remaps. Every surveyed
  extension matches `ctrl+s` literally (`matchesKey(data, Key.ctrl("s"))`).

## Proposed Resolution

Keep the staged draft and the single atomic commit; move confirmation to
**Ctrl+S, save-and-close**:

- Remove the `SAVE_ROW_*` constants, the `items.push(...)` row, and the
  `id === SAVE_ROW_ID` branch in `onChange`.
- In `SettingsMenuFrame.handleInput`, match `ctrl+s` first
  (`matchesKey(data, Key.ctrl("s"))`) and invoke an injected `onSave` callback;
  only otherwise delegate to `settingsList.handleInput`. Works from any row and
  with a submenu open.
- Ctrl+S calls the same commit path the row used: `deps.commit(current)` once;
  success → `done({ kind: "saved", settings })`; failure/throw → existing
  behavior (warn, keep the draft, stay open for retry). A clean draft still
  saves-and-closes (one commit; the #133 toast reports 0 changed fields).
- Esc continues through `tui.select.cancel`/`onCancel` → `{ kind: "cancelled" }`,
  leaving the file byte-identical (#121 acceptance stays).
- `DIRTY_FOOTER` becomes `unsaved changes — Ctrl+S saves and closes · Esc
  discards`; `CLEAN_FOOTER` unchanged.
- Update the module/`openSettingsMenu` doc comments, the README settings
  paragraph (which still promises "the trailing Save row"), and the AGENTS.md
  `settings_menu.ts` row.

## Acceptance Criteria

- [x] Save row gone: no `SAVE_ROW_*` symbol and no synthetic item in the list
      (item count equals the registry row count).
- [x] Ctrl+S after an edit commits exactly once and closes with
      `{ kind: "saved" }`; from any cursor position and with a submenu open.
- [x] Esc after an edit still leaves the settings file byte-identical and
      returns `{ kind: "cancelled" }` (the #121 test stays, adapted if needed).
- [x] Commit failure and commit throw on Ctrl+S: warn, stay open, draft
      retained; retry succeeds (existing #082/#133 semantics).
- [x] Dirty footer advertises Ctrl+S (text pinned by a render test); clean
      footer unchanged.
- [x] README / AGENTS.md no longer describe a Save row; package.json bumped
      `0.15.0` → `0.16.0` (minor — user-visible interaction change) with the
      README badge synced (the #155 docs guard is green).
- [x] `npm run typecheck` and `npm test` green; issue moved to Resolved with the
      index overview re-derived.

## References

- Related: [#121](121-settings-esc-cancel-live-apply.md) (introduced the row),
  [#133](133-settings-commit-and-cancel-feedback.md) (outcome reporting),
  [#118](118-settings-menu-chafa-capability-note.md) (row annotations).
- pi base: `dist/modes/interactive/components/settings-selector.js` (~L200
  auto-theme Apply row; L627 main list live-apply);
  `dist/core/keybindings.js` (`app.models.save` / `app.thinking.save` /
  `app.session.toggleSort` default `ctrl+s`, all context-local).
- pi-tui: `dist/components/settings-list.js` (~L183–190 input routing; L248
  hint), `dist/keys.d.ts` (`Key`, `matchesKey`).
- `@aliou/pi-utils-settings/src/settings-command.ts` (header semantics, Ctrl+S
  interception, footer); pi-blackhole `src/pi-base/settings/{body,render}.ts`
  and `config-flow.ts` (Ctrl+S + action row).

## Resolution

Resolved in v0.16.0. The synthetic Save row is gone: `SAVE_ROW_ID`/`SAVE_ROW_LABEL`/`SAVE_ROW_VALUE`, the `items.push(...)` row and the `id === SAVE_ROW_ID` branch in `onChange` were deleted, so the list is now exactly one row per `NAVIGATOR_CONFIG_FIELDS` entry. `SettingsMenuFrame.handleInput` gained an injected `onSave` and intercepts `matchesKey(data, Key.ctrl("s"))` **before** delegating to `settingsList.handleInput` — the frame level is required because `SettingsList` claims only up/down/confirm/cancel and hands everything else (including the chord) to its search input, and an open submenu would swallow it entirely; the literal match stands because no host action id has "save this menu" semantics (the host ctrl+s ids are context-local to the model picker / thinking selector / session sort). `openSettingsMenu` wires `onSave` to the existing `saveAndClose`: `deps.commit(current)` exactly once, success → `done({ kind: "saved", settings })`, failure/throw → warning + draft retained + stay open for retry (#082/#133 semantics unchanged); a clean draft still saves-and-closes with one commit. `DIRTY_FOOTER` now reads `unsaved changes \u2014 Ctrl+S saves and closes \u00b7 Esc discards` (test-pinned); `CLEAN_FOOTER` and Esc (`tui.select.cancel` → `{ kind: "cancelled" }`, file byte-identical) are unchanged. README, AGENTS.md, `index.ts`'s `runSettings` comment and the settings-menu spec were updated off the Save-row wording; version `0.15.0` → `0.16.0` with the badge synced. Verification: `npm run typecheck` clean; `npm test` 22 suites / 946 cases green (the #121 Esc test and the #133 outcome reporting survive, adapted; new coverage pins the footer text, the registry-only row count, commit-exactly-once on Ctrl+S, and Ctrl+S with a submenu open; `test/index.test.ts`'s end-to-end save now presses Ctrl+S).
