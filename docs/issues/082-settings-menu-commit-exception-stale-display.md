# Issue #082: Uncaught Exception in Settings Menu `commit` Leaves Stale Row Display

- **Status**: Open
- **Type**: Bug / Robustness
- **Severity**: Medium
- **Component**: [`settings_menu.ts`](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L286-L301)

---

## Description

In [`settings_menu.ts` L286-301](file:///home/jhonny/Sources/pi-navigator/settings_menu.ts#L286-L301), `onChange` handles field modifications:

```typescript
      const onChange = (id: string, rawValue: string): void => {
        const edited = applyFieldEdit(current, id, rawValue);
        if (!edited.ok) {
          deps.onWarning(`pi-navigator: ${id}: ${edited.error}`);
          refreshRows(items, settingsList); // revert display to the still-current value
          return;
        }
        const committed = deps.commit(edited.settings);
        if (!committed.ok) {
          deps.onWarning(`pi-navigator: ${id}: ${committed.error}`);
          refreshRows(items, settingsList); // revert display to the still-current value
          return;
        }
        current = committed.settings;
        refreshRows(items, settingsList); // normalization may canonicalize more rows
      };
```

When an item is activated in `SettingsList`, `SettingsList` advances `currentValue` in its internal item model *before* calling `onChange`.

If `deps.commit` throws an exception (for instance, if `writeNavigatorSettings` fails due to filesystem permissions `EACCES`, disk full `ENOSPC`, or read-only filesystem), `onChange` does not catch the error. The unhandled rejection escapes, and `refreshRows` is never executed.

As a consequence:
1. The UI continues to show the new value that failed to persist, misleading the user into believing the setting was saved.
2. The internal `current` settings object remains on the old state, causing UI display and runtime configuration to desynchronize.

## Root Cause Analysis

Missing `try/catch` around `deps.commit(edited.settings)` and `applyFieldEdit` in `onChange`.

## Potential Solution

Wrap the body of `onChange` in a `try...catch` block:

```typescript
      const onChange = (id: string, rawValue: string): void => {
        try {
          const edited = applyFieldEdit(current, id, rawValue);
          if (!edited.ok) {
            deps.onWarning(`pi-navigator: ${id}: ${edited.error}`);
            refreshRows(items, settingsList);
            return;
          }
          const committed = deps.commit(edited.settings);
          if (!committed.ok) {
            deps.onWarning(`pi-navigator: ${id}: ${committed.error}`);
            refreshRows(items, settingsList);
            return;
          }
          current = committed.settings;
          refreshRows(items, settingsList);
        } catch (err) {
          deps.onWarning(`pi-navigator: failed to save ${id}: ${err instanceof Error ? err.message : String(err)}`);
          refreshRows(items, settingsList);
        }
      };
```

## Acceptance Criteria

- [ ] Uncaught errors thrown during settings commit are caught gracefully and reported via `deps.onWarning`.
- [ ] `refreshRows` is always called to revert the row display to the persisted value on error.
- [ ] Unit test in [`test/settings_menu.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/settings_menu.test.ts) verifies display rollback when `deps.commit` throws.
