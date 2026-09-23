/**
 * /navigator settings — pi-tui SettingsList in the editor dock (pi-overseer
 * pattern).
 *
 * `buildSettingItems` is pure and pi-free (unit-tested directly); the TUI
 * layer wraps `SettingsList` in a host-framed wrapper following the settings-panel
 * convention (top/bottom full-width rule in the `border` token, like pi's
 * own `/settings` and pi-overseer). Mouse events are forwarded to the list
 * with y translated past the frame chrome. The menu renders as a plain
 * (non-overlay) `ctx.ui.custom` component, so it docks in the editor
 * area on/above the message textbox like pi's own `/settings` selector and
 * the reference extensions — the transcript stays visible. The module never
 * touches the filesystem (fs stays in settings.ts/index.ts) and hardcodes no
 * colors — the SettingsListTheme is built from the injected pi `Theme` tokens.
 */

import {
  type Component,
  Input,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { applyFieldEdit, NAVIGATOR_CONFIG_FIELDS, type NavigatorSettings } from "./settings";

export interface SettingItemData {
  id: string;
  label: string;
  description: string; // field.description + env-override note when shadowed
  currentValue: string; // "on"/"off" for booleans, raw value for enums
  values: string[]; // ["on","off"] for booleans, field.options for enums
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

/** Read `field.path` out of settings; every registry path resolves. */
function fieldValue(
  settings: NavigatorSettings,
  path: readonly string[],
  fallback?: string | number | boolean,
): string | number | boolean {
  let current: unknown = settings;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) {
      return fallback ?? "";
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return (current ?? fallback ?? "") as string | number | boolean;
}

/**
 * Pure, pi-free description of every configure row (the TUI wrapper maps
 * this onto pi-tui SettingItems). Env-shadowed rows are annotated with the
 * env var name; all fields are `live: false`, so the "applies next open"
 * note lives once in the overlay footer, not per row.
 */
export function buildSettingItems(
  settings: NavigatorSettings,
  overrides: Readonly<Record<string, string>>, // fieldId → env var name
  notes: Readonly<Record<string, string>> = {}, // fieldId → capability note
): readonly SettingItemData[] {
  const items: SettingItemData[] = [];
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    const value = fieldValue(settings, field.path, field.default);
    let currentValue: string;
    let values: string[];
    let submenu: ((currentValue: string, done: (selectedValue?: string) => void) => Component) | undefined;
    switch (field.kind) {
      case "boolean":
        currentValue = value === true ? "on" : "off";
        values = ["on", "off"];
        break;
      case "enum":
        currentValue = String(value);
        values = [...(field.options ?? [])];
        break;
      case "number":
        currentValue = String(value);
        if (field.options && field.options.length > 0) {
          values = [...field.options];
        } else {
          values = [String(value)];
          submenu = (curVal, done) => {
            const input = new Input({ prompt: `${field.label}: ` });
            input.setValue(curVal);
            input.onSubmit = (val) => done(val);
            input.onEscape = () => done(undefined);
            return input;
          };
        }
        break;
    }
    const envVar = overrides[field.id];
    const note = notes[field.id];
    let description = field.description;
    if (note !== undefined) description += ` \u2014 ${note}`;
    if (envVar !== undefined) description += ` \u2014 overridden by ${envVar} (env wins)`;
    items.push({ id: field.id, label: field.label, description, currentValue, values, submenu });
  }
  return items;
}

/**
 * Capability notes for settings rows (Issue #118): a value whose runtime
 * requirement is not met is annotated, not hidden — a user can legitimately
 * pre-configure `images.mode` before installing pi-chafa, and hiding the value
 * would make the menu disagree with the schema. Presence is detected by the
 * caller (`index.ts`); this mapping is pure and unit-tested.
 */
export function navigatorFieldNotes(input: { piChafaPresent: boolean }): Readonly<Record<string, string>> {
  return input.piChafaPresent
    ? {}
    : { "images.mode": "the chafa mode needs chafa + pi-chafa (pi install npm:pi-chafa)" };
}

export interface SettingsMenuTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** The slice of ctx.ui the settings menu needs (narrow, testable shape). */
export interface SettingsMenuUi {
  custom<T>(
    factory: (tui: unknown, theme: SettingsMenuTheme, keybindings: unknown, done: (result: T) => void) => unknown,
  ): Promise<T>;
}

export interface SettingsMenuDeps {
  settings: NavigatorSettings;
  overrides: Readonly<Record<string, string>>;
  /** Capability notes appended to field descriptions (Issue #118). */
  notes?: Readonly<Record<string, string>>;
  commit: (next: NavigatorSettings) => { ok: true; settings: NavigatorSettings } | { ok: false; error: string };
  onWarning: (message: string) => void;
  termRows?: number;
}

/**
 * Host settings-list theme roles (pi's `getSettingsListTheme`): unselected
 * labels stay plain, unselected values are muted, the selection is accent.
 */
export function buildSettingsMenuTheme(theme: SettingsMenuTheme): SettingsListTheme {
  return {
    label: (t, selected) => (selected ? theme.fg("accent", t) : t),
    value: (t, selected) => (selected ? theme.fg("accent", t) : theme.fg("muted", t)),
    description: (t) => theme.fg("dim", t),
    cursor: theme.fg("accent", "\u2192 "),
    hint: (t) => theme.fg("dim", t),
  };
}

export type SettingsListThemeLike = SettingsListTheme;

/** Rows the frame renders before the SettingsList (rule, title, blank). */
const FRAME_HEADER_ROWS = 3;
/** Host frame rule glyph (pi's DynamicBorder, pi-overseer's BorderLine). */
const FRAME_RULE = "\u2500";

/**
 * Host-framed wrapper: top/bottom rules in the border token, the title row,
 * the SettingsList, and a dim footer note. Mouse events are translated into
 * list coordinates and forwarded. Every line it produces itself is
 * width-safe (truncateToWidth with the repo's empty-ellipsis convention);
 * the SettingsList truncates its own lines. Rendered in the editor dock, so
 * it fills whatever width the editor area has.
 */
class SettingsMenuFrame implements Component {
  private readonly list: SettingsList;
  private readonly title: string;
  private readonly footer: string;
  private readonly truncate: (text: string, maxWidth: number) => string;
  private readonly rule: (text: string) => string;
  private listHeight = 0;

  constructor(list: SettingsList, theme: SettingsMenuTheme, truncate: (text: string, maxWidth: number) => string) {
    this.list = list;
    this.title = theme.fg("accent", theme.bold("pi-navigator \u00b7 settings"));
    this.footer = theme.fg("dim", "changes apply the next time /navigator opens");
    this.truncate = truncate;
    this.rule = (text) => theme.fg("border", text);
  }

  render(width: number): string[] {
    const rule = this.truncate(this.rule(FRAME_RULE.repeat(Math.max(1, width))), width);
    const listLines = this.list.render(width);
    this.listHeight = listLines.length;
    return [
      rule,
      this.truncate(this.title, width),
      "",
      ...listLines,
      "",
      this.truncate(this.footer, width),
      rule,
    ];
  }

  handleInput(data: string): void {
    this.list.handleInput?.(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      // SAFETY: pi-tui's SettingsList keeps `searchEnabled` (set from the
      // `enableSearch` option this wrapper always passes) as an internal field
      // the published type omits; reading it decides whether the search bar
      // occupies the first two rows. A missing field falls back to 0.
      const minY = (this.list as unknown as { searchEnabled?: boolean }).searchEnabled ? 2 : 0;
      const y = Math.max(minY, Math.min(Math.max(minY, this.listHeight - 1), event.y - FRAME_HEADER_ROWS));
      return this.list.handleMouse?.({ ...event, y, height: this.listHeight });
    }
    const y = event.y - FRAME_HEADER_ROWS;
    if (y < 0 || y >= this.listHeight) {
      if (event.type === "release" || event.type === "click") {
        // SAFETY: same internal-field access as above — `mousePressedIndex` is
        // pi-tui's list-internal mouse press state; clearing it on an
        // out-of-bounds release prevents a stale click from sticking.
        ((this.list as unknown) as { mousePressedIndex?: number }).mousePressedIndex = undefined;
      }
      return undefined;
    }
    return this.list.handleMouse?.({ ...event, y, height: this.listHeight });
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

/**
 * Open the settings menu in the editor dock. Esc → the SettingsList's
 * onCancel → done() and nothing is written. Every edit goes through
 * `applyFieldEdit` then `commit`; failures warn and revert the row display,
 * successes adopt the committed settings and refresh every row (normalization
 * may canonicalize more than the edited field).
 */
export async function openSettingsMenu(ui: SettingsMenuUi, deps: SettingsMenuDeps): Promise<void> {
  const truncate = (text: string, width: number): string => truncateToWidth(text, width, "");

  let current = deps.settings;

  const refreshRows = (items: SettingItem[], list: SettingsList): void => {
    const rows = buildSettingItems(current, deps.overrides, deps.notes);
    for (const item of items) {
      const row = rows.find((candidate) => candidate.id === item.id);
      if (row === undefined) continue;
      item.currentValue = row.currentValue;
      item.values = [...row.values];
      item.description = row.description;
      item.submenu = row.submenu;
      list.updateValue(item.id, item.currentValue);
    }
  };

  await ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const settingsTheme = buildSettingsMenuTheme(theme);

      const items: SettingItem[] = buildSettingItems(current, deps.overrides, deps.notes).map((data) => ({
        id: data.id,
        label: data.label,
        description: data.description,
        currentValue: data.currentValue,
        values: [...data.values],
        submenu: data.submenu,
      }));

      const onChange = (id: string, rawValue: string): void => {
        try {
          const edited = applyFieldEdit(current, id, rawValue);
          if (!edited.ok) {
            deps.onWarning(`pi-navigator: ${edited.error}`);
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
        } catch (err) {
          deps.onWarning(`pi-navigator: failed to save ${id}: ${err instanceof Error ? err.message : String(err)}`);
          refreshRows(items, settingsList);
        }
      };

      const termRows = deps.termRows ?? (typeof process.stdout?.rows === "number" && process.stdout.rows > 0 ? process.stdout.rows : 24);
      const maxVisible = Math.max(3, Math.min(10, termRows - 6));

      const settingsList = new SettingsList(items, maxVisible, settingsTheme, onChange, () => done(), {
        enableSearch: true,
      });
      return new SettingsMenuFrame(settingsList, theme, truncate);
    },
  );
}
