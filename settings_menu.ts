/**
 * /navigator settings — pi-tui SettingsList in the editor dock (pi-overseer
 * pattern).
 *
 * `buildSettingItems` is pure and pi-free (unit-tested directly); the TUI
 * layer lazily imports pi-tui behind a dynamic shape check and wraps its
 * `SettingsList` in a host-framed wrapper following the settings-panel
 * convention (top/bottom full-width rule in the `border` token, like pi's
 * own `/settings` and pi-overseer). Mouse events are forwarded to the list
 * with y translated past the frame chrome. The menu renders as a plain
 * (non-overlay) `ctx.ui.custom` component, so it docks in the editor
 * area on/above the message textbox like pi's own `/settings` selector and
 * the reference extensions — the transcript stays visible. The module never
 * touches the filesystem (fs stays in settings.ts/index.ts) and hardcodes no
 * colors — the SettingsListTheme is built from the injected pi `Theme` tokens.
 */

import { applyFieldEdit, NAVIGATOR_CONFIG_FIELDS, type NavigatorSettings } from "./settings";

export interface SettingItemData {
  id: string;
  label: string;
  description: string; // field.description + env-override note when shadowed
  currentValue: string; // "on"/"off" for booleans, raw value for enums
  values: string[]; // ["on","off"] for booleans, field.options for enums
}

/** Read `field.path` out of settings; every registry path resolves. */
function fieldValue(settings: NavigatorSettings, path: readonly string[]): string | number | boolean {
  let current: unknown = settings;
  for (const segment of path) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current as string | number | boolean;
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
): readonly SettingItemData[] {
  const items: SettingItemData[] = [];
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    const value = fieldValue(settings, field.path);
    let currentValue: string;
    let values: string[];
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
        values = [String(value)];
        break;
    }
    const envVar = overrides[field.id];
    const description =
      envVar !== undefined ? `${field.description} \u2014 overridden by ${envVar} (env wins)` : field.description;
    items.push({ id: field.id, label: field.label, description, currentValue, values });
  }
  return items;
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
  commit: (next: NavigatorSettings) => { ok: true; settings: NavigatorSettings } | { ok: false; error: string };
  onWarning: (message: string) => void;
}

// ── Lazy TUI types (pi-tui imported only at call time) ──

interface ComponentLike {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: PituiMouseEvent): PituiMouseResult | undefined;
  invalidate(): void;
}

type SettingsListLike = ComponentLike & { updateValue(id: string, newValue: string): void };

type PituiSettingItem = {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
};

// pi-tui TuiMouseEvent / TuiMouseEventResult (structural mirrors, as for the
// SettingsList types above — pi-tui is imported only at call time).
type PituiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
type PituiMouseButton = "left" | "middle" | "right" | "none";
type PituiMouseEvent = {
  type: PituiMouseEventType;
  button: PituiMouseButton;
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  wheelDelta?: number;
  clickCount?: number;
};
type PituiMouseResult = {
  handled?: boolean;
  capture?: boolean;
  focus?: boolean;
  render?: boolean;
};

/**
 * Host settings-list theme roles (pi's `getSettingsListTheme`): unselected
 * labels stay plain, unselected values are muted, the selection is accent.
 */
export function buildSettingsMenuTheme(theme: SettingsMenuTheme): SettingsListThemeLike {
  return {
    label: (t, selected) => (selected ? theme.fg("accent", t) : t),
    value: (t, selected) => (selected ? theme.fg("accent", t) : theme.fg("muted", t)),
    description: (t) => theme.fg("dim", t),
    cursor: theme.fg("accent", "\u2192 "),
    hint: (t) => theme.fg("dim", t),
  };
}

export type SettingsListThemeLike = {
  label(text: string, selected: boolean): string;
  value(text: string, selected: boolean): string;
  description(text: string): string;
  cursor: string;
  hint(text: string): string;
};

type PituiModule = {
  SettingsList: new (
    items: PituiSettingItem[],
    maxVisible: number,
    theme: SettingsListThemeLike,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
    options?: { enableSearch?: boolean },
  ) => SettingsListLike;
  truncateToWidth: (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string;
};

const MAX_VISIBLE_ROWS = 10;

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
class SettingsMenuFrame implements ComponentLike {
  private readonly list: SettingsListLike;
  private readonly title: string;
  private readonly footer: string;
  private readonly truncate: (text: string, maxWidth: number) => string;
  private readonly rule: (text: string) => string;
  private listHeight = 0;

  constructor(list: SettingsListLike, theme: SettingsMenuTheme, truncate: (text: string, maxWidth: number) => string) {
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

  handleMouse(event: PituiMouseEvent): PituiMouseResult | undefined {
    // Mirror pi-tui Container's child dispatch: only rows inside the list
    // receive the event, with y translated past the frame chrome. The
    // SettingsList owns wheel scroll and click selection itself.
    const y = event.y - FRAME_HEADER_ROWS;
    if (y < 0 || y >= this.listHeight) return undefined;
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
  let pitui: PituiModule;
  try {
    // SAFETY: the shape check below guards the cast at call time; the module
    // is provided by the pi host which aliases @earendil-works/pi-tui.
    pitui = (await import("@earendil-works/pi-tui")) as unknown as PituiModule;
  } catch {
    deps.onWarning("pi-navigator settings unavailable: the TUI library could not be loaded.");
    return;
  }
  if (pitui.SettingsList === undefined || pitui.truncateToWidth === undefined) {
    deps.onWarning("pi-navigator settings unavailable: the TUI library could not be loaded.");
    return;
  }
  const { SettingsList, truncateToWidth } = pitui;
  const truncate = (text: string, width: number): string => truncateToWidth(text, width, "");

  let current = deps.settings;

  const refreshRows = (items: PituiSettingItem[], list: SettingsListLike): void => {
    const rows = buildSettingItems(current, deps.overrides);
    for (const item of items) {
      const row = rows.find((candidate) => candidate.id === item.id);
      if (row === undefined) continue;
      item.currentValue = row.currentValue;
      item.values = [...row.values];
      item.description = row.description;
      list.updateValue(item.id, item.currentValue);
    }
  };

  await ui.custom<void>(
    (_tui, theme, _keybindings, done) => {
      const settingsTheme = buildSettingsMenuTheme(theme);

      const items: PituiSettingItem[] = buildSettingItems(current, deps.overrides).map((data) => ({
        id: data.id,
        label: data.label,
        description: data.description,
        currentValue: data.currentValue,
        values: [...data.values],
      }));

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

      const settingsList = new SettingsList(items, MAX_VISIBLE_ROWS, settingsTheme, onChange, () => done(), {
        enableSearch: true,
      });
      return new SettingsMenuFrame(settingsList, theme, truncate);
    },
  );
}
