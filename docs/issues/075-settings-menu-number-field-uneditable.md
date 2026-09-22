# Issue #075: Number Settings Are Uneditable in TUI Settings Menu

- **Status**: Open
- **Type**: Bug / UX
- **Severity**: High
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L61-L65)

---

## Description

In [`settings_menu.ts` L61-65](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L61-L65), [`buildSettingItems`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L43) prepares items for pi-tui's `SettingsList`:

```typescript
      case "number":
        currentValue = String(value);
        values = [String(value)];
        break;
```

`SettingsList` operates as a cycle list: pressing Enter or clicking an item advances to the next value in the `values` array. For `"number"` fields, `values` contains only the single current value `[String(value)]`. As a result, selecting the row cycles to itself, leaving numeric fields completely uneditable in the TUI menu.

While none of the current five default fields in [`NAVIGATOR_CONFIG_FIELDS`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L67) use `kind: "number"`, the configuration registry, parser ([`parseNumberField`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L431)), and schema explicitly define and support numeric fields. Any future numeric setting (or extension of the schema) will be non-functional in the UI.

## Root Cause Analysis

The settings menu assumes all configuration fields can be edited via discrete value cycling, without providing a text input or stepper mechanism for numeric types.

## Potential Solution

1. Provide a text-input prompt / submenu dialog when activating a number field, delegating to pi-tui's text input components.
2. Alternatively, generate a range of values if `min`/`max`/`step` are specified on `NavigatorConfigField`, or disable/annotate numeric fields until an interactive input component is wired up.

## Acceptance Criteria

- [ ] Number settings in `SettingsList` can be edited or adjusted by the user in the TUI.
- [ ] Edited values are parsed and validated via [`parseNumberField`](file:///home/jhonny/Sources/pi-navigator/settings.ts#L431).
- [ ] Unit tests cover numeric field interaction in [`test/settings_menu.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings_menu.test.ts).
