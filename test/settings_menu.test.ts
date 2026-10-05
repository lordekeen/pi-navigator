/**
 * settings_menu.ts suites (Issue #061): the pure buildSettingItems mapping
 * (values, env-override annotations) and end-to-end integration against the
 * real pi-tui SettingsList — Enter/Space stages edits into an in-memory
 * draft (zero commits), the trailing Save row commits the draft exactly
 * once, a failed save warns and keeps the draft, Esc discards with zero
 * commits, and the frame footer announces the draft while it differs from
 * the loaded file. No filesystem, no process.env.
 */

import { describe, expect, it, vi } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";

import { NAVIGATOR_CONFIG_FIELDS, type NavigatorConfigField, type NavigatorSettings } from "../settings";
import {
  buildSettingItems,
  buildSettingsMenuTheme,
  countChangedFields,
  navigatorFieldNotes,
  openSettingsMenu,
  type SettingsMenuDeps,
  type SettingsMenuOutcome,
  type SettingsMenuTheme,
  type SettingsMenuUi,
} from "../settings_menu";

interface ComponentLike {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: unknown): unknown;
  invalidate(): void;
}

function fullSettings(): NavigatorSettings {
  return {
    version: 1,
    images: { mode: "off" },
    icons: { enabled: false },
    viewer: { wrap: false, markdown: "code" },
    tree: { showHidden: false, respectGitignore: true },
    layout: { default: "files-git-viewer" },
  };
}

function markedUpSettings(): NavigatorSettings {
  return {
    version: 1,
    images: { mode: "chafa" },
    icons: { enabled: true },
    viewer: { wrap: true, markdown: "rendered" },
    tree: { showHidden: true, respectGitignore: false },
    layout: { default: "git-viewer" },
  };
}

type CommitResult = { ok: true; settings: NavigatorSettings } | { ok: false; error: string };

const KEYS = {
  enter: "\r",
  down: "\x1b[B",
  escape: "\x1b",
} as const;

/**
 * fake ctx.ui.custom: invokes the menu factory synchronously with an
 * identity theme, captures the component, and resolves when done() fires.
 */
function makeUiHarness() {
  let component: ComponentLike | undefined;
  let outcome: SettingsMenuOutcome | undefined;
  let resolveReady!: () => void;
  let resolveClosed!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const theme: SettingsMenuTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const ui: SettingsMenuUi = {
    custom: <T>(
      factory: (tui: unknown, th: SettingsMenuTheme, keybindings: unknown, done: (result: T) => void) => unknown,
    ): Promise<T> => {
      const result = factory({}, theme, {}, (value?: T) => {
        outcome = value as SettingsMenuOutcome | undefined;
        resolveClosed();
      });
      component = result as ComponentLike;
      resolveReady();
      return closed as unknown as Promise<T>;
    },
  };
  return { ui, ready, closed, getComponent: (): ComponentLike | undefined => component, getOutcome: (): SettingsMenuOutcome | undefined => outcome };
}

async function openMenu(
  deps: SettingsMenuDeps,
): Promise<{ component: ComponentLike; closed: Promise<void>; outcome: () => SettingsMenuOutcome | undefined }> {
  const harness = makeUiHarness();
  const menu = openSettingsMenu(harness.ui, deps);
  await harness.ready;
  const component = harness.getComponent();
  if (component === undefined) throw new Error("menu component was not created");
  return {
    component,
    closed: (async () => {
      await harness.closed;
      await menu;
    })(),
    outcome: harness.getOutcome,
  };
}

describe("buildSettingItems", () => {
  it("maps every registry field to a row in registry order", () => {
    const items = buildSettingItems(fullSettings(), {});
    expect(items.map((item) => item.id)).toEqual([
      "images.mode",
      "icons.enabled",
      "viewer.wrap",
      "viewer.markdown",
      "tree.showHidden",
      "tree.respectGitignore",
      "layout.default",
    ]);
    expect(items[0]).toMatchObject({ label: "Image rendering", currentValue: "off", values: ["off", "chafa", "native", "auto"] });
    expect(items[1]).toMatchObject({ label: "Nerd Font icons", currentValue: "off", values: ["on", "off"] });
    expect(items[2]).toMatchObject({ label: "Word wrap", currentValue: "off", values: ["on", "off"] });
    expect(items[3]).toMatchObject({ label: "Markdown view", currentValue: "code", values: ["code", "rendered"] });
    expect(items[4]).toMatchObject({ label: "Hidden files", currentValue: "off", values: ["on", "off"] });
    // Issue #158: the gitignore toggle sits in the Tree section, default on.
    expect(items[5]).toMatchObject({ label: "Respect .gitignore", currentValue: "on", values: ["on", "off"] });
    // Issue #119: the Layout section row exposes the three layouts.
    expect(items[6]).toMatchObject({
      label: "Default layout",
      currentValue: "files-git-viewer",
      values: ["files-git-viewer", "files-viewer", "git-viewer"],
    });
  });

  it("reads current values from the settings object for booleans and enums", () => {
    const items = buildSettingItems(markedUpSettings(), {});
    expect(items[0]?.currentValue).toBe("chafa");
    expect(items[1]?.currentValue).toBe("on");
    expect(items[2]?.currentValue).toBe("on");
    expect(items[3]?.currentValue).toBe("rendered");
    expect(items[4]?.currentValue).toBe("on");
    expect(items[5]?.currentValue).toBe("off");
    expect(items[6]?.currentValue).toBe("git-viewer");
  });

  it("annotates env-shadowed rows with the env var name", () => {
    const items = buildSettingItems(fullSettings(), {
      "images.mode": "PI_NAV_IMAGES",
      "icons.enabled": "PI_NAV_ICONS",
      "layout.default": "PI_NAV_LAYOUT",
    });
    expect(items[0]?.description).toContain("\u2014 overridden by PI_NAV_IMAGES (env wins)");
    expect(items[1]?.description).toContain("\u2014 overridden by PI_NAV_ICONS (env wins)");
    // Issue #119: the layout row annotates the same way.
    expect(items[6]?.description).toContain("\u2014 overridden by PI_NAV_LAYOUT (env wins)");
    expect(items[0]?.description.startsWith("Render images as native terminal graphics")).toBe(true);
    expect(items[2]?.description).not.toContain("overridden");
    expect(items[4]?.description).not.toContain("overridden");
  });

  it("keeps descriptions annotation-free when nothing is shadowed", () => {
    const items = buildSettingItems(fullSettings(), {});
    for (const item of items) expect(item.description).not.toContain("overridden");
  });

  it("appends caller-provided capability notes and composes with env overrides (Issue #118)", () => {
    const notes = navigatorFieldNotes({ piChafaPresent: false });
    const items = buildSettingItems(fullSettings(), { "images.mode": "PI_NAV_IMAGES" }, notes);
    expect(items[0]?.description).toContain("the chafa mode needs chafa + pi-chafa (pi install npm:pi-chafa)");
    expect(items[0]?.description).toContain("\u2014 overridden by PI_NAV_IMAGES (env wins)");
    expect(items[1]?.description).not.toContain("chafa");
  });

  it("emits no capability notes when pi-chafa is present, leaving descriptions untouched (Issue #118)", () => {
    expect(navigatorFieldNotes({ piChafaPresent: true })).toEqual({});
    const withNotes = buildSettingItems(fullSettings(), {}, navigatorFieldNotes({ piChafaPresent: true }));
    const without = buildSettingItems(fullSettings(), {});
    expect(withNotes.map((item) => item.description)).toEqual(without.map((item) => item.description));
  });

  it("safely handles partial or empty settings without throwing TypeError", () => {
    expect(() => buildSettingItems({} as any, {})).not.toThrow();
    const items = buildSettingItems({} as any, {});
    expect(items).toHaveLength(7);
    expect(items[0]?.currentValue).toBe("off");
    expect(items[1]?.currentValue).toBe("off");
    // A missing layout section falls back to the registry default.
    expect(items[6]?.currentValue).toBe("files-git-viewer");
  });

  it("supports numeric fields with submenu and text input", () => {
    const numberField: NavigatorConfigField = {
      id: "viewer.tabWidth",
      path: ["viewer", "tabWidth"],
      kind: "number",
      section: "Viewer",
      label: "Tab width",
      description: "Spaces per tab stop",
      min: 1,
      max: 8,
      default: 4,
      live: false,
    };
    (NAVIGATOR_CONFIG_FIELDS as any).push(numberField);
    try {
      const items = buildSettingItems(fullSettings(), {});
      const numItem = items.find((i) => i.id === "viewer.tabWidth");
      expect(numItem).toBeDefined();
      expect(numItem?.submenu).toBeDefined();
      let submitted: string | undefined;
      const inputComp = numItem!.submenu!("4", (val) => {
        submitted = val;
      }) as any;
      expect(inputComp).toBeDefined();
      expect(typeof inputComp.onSubmit).toBe("function");
      inputComp.onSubmit("6");
      expect(submitted).toBe("6");
    } finally {
      (NAVIGATOR_CONFIG_FIELDS as any).pop();
    }
  });
});

describe("buildSettingsMenuTheme (host settings-list roles)", () => {
  const theme: SettingsMenuTheme = {
    fg: (color, text) => `<${color}>${text}</>`,
    bold: (text) => `*${text}*`,
  };
  const themed = buildSettingsMenuTheme(theme);

  it("keeps unselected labels plain and mutes unselected values", () => {
    expect(themed.label("Label", false)).toBe("Label");
    expect(themed.label("Label", true)).toBe("<accent>Label</>");
    expect(themed.value("Value", false)).toBe("<muted>Value</>");
    expect(themed.value("Value", true)).toBe("<accent>Value</>");
  });

  it("styles description, cursor and hint with the host tokens", () => {
    expect(themed.description("Desc")).toBe("<dim>Desc</>");
    expect(themed.cursor).toBe("<accent>\u2192 </>");
    expect(themed.hint("Hint")).toBe("<dim>Hint</>");
  });
});

describe("settings menu integration (real SettingsList)", () => {
  it("stages each edit without committing and saves the draft exactly once on the Save row (#121)", async () => {
    const commit = vi.fn((next: NavigatorSettings): CommitResult => ({ ok: true, settings: next }));
    const onWarning = vi.fn();
    const { component, closed, outcome } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });

    component.handleInput?.(KEYS.enter); // images.mode off -> chafa (staged only)
    expect(commit).not.toHaveBeenCalled();

    component.handleInput?.(KEYS.enter); // chafa -> native (the draft drives the cycle)
    expect(commit).not.toHaveBeenCalled();

    component.handleInput?.(KEYS.down); // icons.enabled
    component.handleInput?.(KEYS.enter); // false -> true (staged only)
    expect(commit).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();

    // The dirty frame announces the draft.
    const dirtyLines = component.render(80);
    expect(dirtyLines.join("\n")).toContain("unsaved changes");

    // The trailing Save row is the explicit confirm.
    expect(dirtyLines.some((line) => line.includes("save and go back"))).toBe(true);
    for (let i = 0; i < 6; i++) component.handleInput?.(KEYS.down); // to the Save row
    component.handleInput?.(KEYS.enter); // Save: one commit with the whole draft
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0]!.images.mode).toBe("native");
    expect(commit.mock.calls[0]![0]!.icons.enabled).toBe(true);

    await closed;
    expect(outcome()).toEqual({ kind: "saved", settings: commit.mock.calls[0]![0] });
  });

  it("warns on a failed save, keeps the draft, and stays open for a retry", async () => {
    const commit = vi.fn((_next: NavigatorSettings): CommitResult => ({ ok: false, error: "disk full" }));
    const onWarning = vi.fn();
    const { component, closed, outcome } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });

    component.handleInput?.(KEYS.enter); // images.mode off -> chafa: staged, no commit yet
    expect(commit).not.toHaveBeenCalled();

    for (let i = 0; i < 7; i++) component.handleInput?.(KEYS.down); // to the Save row
    component.handleInput?.(KEYS.enter); // Save fails: warn, stay open, keep the draft
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[0]).toContain("disk full");

    // The draft is retained: the row still shows the staged value.
    const lines = component.render(80);
    const row = lines.find((line) => line.includes("Image rendering"));
    expect(row ?? "").toContain("chafa");

    // Retrying Save calls commit again.
    component.handleInput?.(KEYS.enter);
    expect(commit).toHaveBeenCalledTimes(2);

    component.handleInput?.(KEYS.escape); // abort: the file never saw the draft
    await closed;
    expect(outcome()).toEqual({ kind: "cancelled" });
  });

  it("Esc discards staged edits with zero commits — the file never sees the draft (#121)", async () => {
    const commit = vi.fn((next: NavigatorSettings): CommitResult => ({ ok: true, settings: next }));
    const onWarning = vi.fn();
    const { component, closed, outcome } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });

    component.handleInput?.(KEYS.enter); // images.mode off -> chafa
    component.handleInput?.(KEYS.enter); // chafa -> native
    component.handleInput?.(KEYS.down);
    component.handleInput?.(KEYS.enter); // icons.enabled -> on
    expect(commit).not.toHaveBeenCalled();

    component.handleInput?.(KEYS.escape); // cancel: discard the draft
    await closed;
    expect(commit).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();
    expect(outcome()).toEqual({ kind: "cancelled" });
  });

  it("closes on Esc with zero commits and reports a cancelled outcome", async () => {
    const commit = vi.fn((_next: NavigatorSettings): CommitResult => ({ ok: true, settings: _next }));
    const onWarning = vi.fn();
    const { component, closed, outcome } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });

    component.handleInput?.(KEYS.escape);
    await closed;
    expect(commit).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();
    expect(outcome()).toEqual({ kind: "cancelled" });
  });

  it("announces the draft only while staged values differ from the loaded file (#121)", async () => {
    const commit = vi.fn((next: NavigatorSettings): CommitResult => ({ ok: true, settings: next }));
    const onWarning = vi.fn();
    const { component, closed } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });

    const clean = component.render(80);
    expect(clean.join("\n")).toContain("changes apply the next time /navigator opens");
    expect(clean.join("\n")).not.toContain("unsaved changes");

    component.handleInput?.(KEYS.enter); // off -> chafa: draft differs
    let lines = component.render(80);
    expect(lines.join("\n")).toContain("unsaved changes");
    expect(lines.join("\n")).not.toContain("changes apply the next time");

    // Cycling back to the original value restores the clean footer.
    component.handleInput?.(KEYS.enter); // chafa -> native
    component.handleInput?.(KEYS.enter); // native -> auto
    component.handleInput?.(KEYS.enter); // auto -> off: draft equals the loaded file
    lines = component.render(80);
    expect(lines.join("\n")).toContain("changes apply the next time /navigator opens");
    expect(lines.join("\n")).not.toContain("unsaved changes");
    expect(commit).not.toHaveBeenCalled();

    // The dirty footer stays width-safe even at the narrowest suite size.
    component.handleInput?.(KEYS.enter); // dirty again
    for (const line of component.render(44)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(44);
    }

    component.handleInput?.(KEYS.escape);
    await closed;
  });

  it("warns and reverts the row display when a staged value fails field validation", async () => {
    const numberField: NavigatorConfigField = {
      id: "viewer.tabWidth",
      path: ["viewer", "tabWidth"],
      kind: "number",
      section: "Viewer",
      label: "Tab width",
      description: "Spaces per tab stop",
      min: 1,
      max: 8,
      default: 4,
      live: false,
    };
    (NAVIGATOR_CONFIG_FIELDS as any).push(numberField);
    try {
      const commit = vi.fn((next: NavigatorSettings): CommitResult => ({ ok: true, settings: next }));
      const onWarning = vi.fn();
      const { component, closed, outcome } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });

      // Rows: 7 registry fields + the pushed number field + the Save row.
      for (let i = 0; i < 7; i++) component.handleInput?.(KEYS.down); // to the number row
      component.handleInput?.(KEYS.enter); // open the number input submenu
      for (const ch of "abc") component.handleInput?.(ch);
      component.handleInput?.(KEYS.enter); // submit the invalid value

      expect(commit).not.toHaveBeenCalled();
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onWarning.mock.calls[0]?.[0]).toContain("viewer.tabWidth");
      expect(onWarning.mock.calls[0]?.[0]).toContain("invalid number");

      // Row display reverted: the row still shows the pre-edit value.
      const lines = component.render(80);
      const row = lines.find((line) => line.includes("Tab width"));
      expect(row ?? "").toContain("4");

      component.handleInput?.(KEYS.escape); // close the submenu
      component.handleInput?.(KEYS.escape); // cancel the menu
      await closed;
      expect(outcome()).toEqual({ kind: "cancelled" });
    } finally {
      (NAVIGATOR_CONFIG_FIELDS as any).pop();
    }
  });

  it("frames with full-width rules and forwards in-list mouse rows to the SettingsList", async () => {
    const commit = vi.fn((next: NavigatorSettings): CommitResult => ({ ok: true, settings: next }));
    const onWarning = vi.fn();
    const { component, closed } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });

    const lines = component.render(80);
    expect(lines[0]).toBe("\u2500".repeat(80));
    expect(lines[lines.length - 1]).toBe("\u2500".repeat(80));
    expect(lines[1]).toContain("pi-navigator \u00b7 settings");

    // Wheel on chrome rows scrolls the list.
    const before = lines.findIndex((line) => line.startsWith("\u2192 "));
    const wheelRes = component.handleMouse?.({ type: "wheel", wheelDelta: 1, y: 1, height: lines.length }) as any;
    expect(wheelRes?.handled).toBe(true);
    const after = component.render(80).findIndex((line) => line.startsWith("\u2192 "));
    expect(after).toBe(before + 1);

    component.handleInput?.(KEYS.escape);
    await closed;
    expect(commit).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("clears mousePressedIndex when mouse is released outside list bounds", async () => {
    const commit = vi.fn((next: NavigatorSettings): CommitResult => ({ ok: true, settings: next }));
    const onWarning = vi.fn();
    const { component, closed, outcome } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });
    const lines = component.render(80);
    // Press on second item (y=6 in frame coords)
    component.handleMouse?.({ type: "press", button: "left", y: 6, height: lines.length });
    // Release outside list bounds (e.g. y=0)
    component.handleMouse?.({ type: "release", button: "left", y: 0, height: lines.length });
    // Now click on first item (y=5 in frame coords)
    component.handleMouse?.({ type: "click", button: "left", y: 5, height: lines.length });
    // The click stages the value; nothing is written until the Save row.
    expect(commit).not.toHaveBeenCalled();
    const row = component.render(80).find((line) => line.includes("Image rendering"));
    expect(row ?? "").toContain("chafa");
    component.handleInput?.(KEYS.escape);
    await closed;
    expect(outcome()).toEqual({ kind: "cancelled" });
  });

  it("catches an exception thrown by commit on Save, keeps the draft, and warns", async () => {
    const commit = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    });
    const onWarning = vi.fn();
    const { component, closed } = await openMenu({ settings: fullSettings(), overrides: {}, commit, onWarning });
    component.handleInput?.(KEYS.enter); // stage only: no commit, no throw
    expect(commit).not.toHaveBeenCalled();
    for (let i = 0; i < 7; i++) component.handleInput?.(KEYS.down); // to the Save row
    component.handleInput?.(KEYS.enter); // Save throws
    expect(commit).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("failed to save settings"));
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
    // The draft is kept: the row still shows the staged value.
    const lines = component.render(80);
    const row = lines.find((line) => line.includes("Image rendering"));
    expect(row).toContain("chafa");
    component.handleInput?.(KEYS.escape);
    await closed;
  });

  it("adapts maxVisible for small terminals", async () => {
    const commit = vi.fn((next: NavigatorSettings): CommitResult => ({ ok: true, settings: next }));
    const onWarning = vi.fn();
    const { component, closed } = await openMenu({
      settings: fullSettings(),
      overrides: {},
      commit,
      onWarning,
      termRows: 10,
    });
    const lines = component.render(80);
    expect(lines[0]).toBe("\u2500".repeat(80));
    expect(lines[lines.length - 1]).toBe("\u2500".repeat(80));
    component.handleInput?.(KEYS.escape);
    await closed;
  });

  it("calls ctx.ui.custom with no options object so the menu docks above the input", async () => {
    const calls: unknown[][] = [];
    const theme: SettingsMenuTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const ui: SettingsMenuUi = {
      custom: <T>(...args: unknown[]): Promise<T> => {
        calls.push(args);
        const factory = args[0] as (
          tui: unknown,
          th: SettingsMenuTheme,
          keybindings: unknown,
          done: (result: T) => void,
        ) => unknown;
        factory({}, theme, {}, () => undefined);
        return Promise.resolve(undefined as T);
      },
    };

    await openSettingsMenu(ui, {
      settings: fullSettings(),
      overrides: {},
      commit: (next: NavigatorSettings): CommitResult => ({ ok: true, settings: next }),
      onWarning: () => undefined,
    });

    // The pi settings-UI standard (pi's own /settings selector, pi-overseer,
    // @aliou/pi-utils-settings) is a plain editor-dock component: passing
    // { overlay: true, ... } would float a centered modal over the transcript.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0]?.[1]).toBeUndefined();
  });
});

describe("countChangedFields (Issue #121 draft accounting)", () => {
  it("counts exactly the registry fields whose values differ", () => {
    expect(countChangedFields(fullSettings(), markedUpSettings())).toBe(7);
    expect(countChangedFields(fullSettings(), fullSettings())).toBe(0);
  });

  it("ignores non-registry differences such as version", () => {
    const extra = { ...fullSettings(), version: 99 } as NavigatorSettings;
    expect(countChangedFields(fullSettings(), extra)).toBe(0);
  });
});
