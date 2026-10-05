/**
 * settings.ts unit suites (§12.1): the versioned settings terrain — typed
 * defaults, the never-throw pure normalizer, the loader with file/env/flag
 * provenance and override origins, the canonical serializer, the atomic
 * writer, the one commit operation, the field registry sync guard, and
 * `applyFieldEdit` (pi-overseer pattern). The env/flags layers are always
 * passed in explicitly; no test reads or mutates process.env.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_NAVIGATOR_SETTINGS,
  NAVIGATOR_CONFIG_FIELDS,
  applyFieldEdit,
  commitNavigatorSettings,
  loadNavigatorSettings,
  normalizeNavigatorSettings,
  parseImageMode,
  parseLayoutMode,
  parseNumberField,
  resolveOverrideOrigins,
  serializeNavigatorSettings,
  writeNavigatorSettings,
} from "../settings";

import type { NavigatorConfigField, NavigatorImageMode } from "../settings";
import { ICONS_ENV } from "../icons";
import {
  NAVIGATOR_IMAGES_ENV,
  NAVIGATOR_IMAGES_FLAG,
  NAVIGATOR_ICONS_FLAG,
  NAVIGATOR_LAYOUT_ENV,
  NAVIGATOR_LAYOUT_FLAG,
} from "../constants";
import { NAVIGATOR_LAYOUTS } from "../types";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** A complete settings object with the canonical shape (all five sections). */
function fullSettings(overrides: Partial<{
  images: { mode: NavigatorImageMode };
  icons: { enabled: boolean };
  viewer: { wrap: boolean; markdown: "code" | "rendered" };
  tree: { showHidden: boolean; respectGitignore: boolean };
  layout: { default: (typeof NAVIGATOR_LAYOUTS)[number] };
}> = {}): ReturnType<typeof cloneDefaultsLike> {
  return {
    version: 1,
    images: overrides.images ?? { mode: "off" },
    icons: overrides.icons ?? { enabled: false },
    viewer: overrides.viewer ?? { wrap: false, markdown: "code" },
    tree: overrides.tree ?? { showHidden: false, respectGitignore: true },
    layout: overrides.layout ?? { default: "files-git-viewer" },
  };
}

function cloneDefaultsLike(): {
  version: 1;
  images: { mode: NavigatorImageMode };
  icons: { enabled: boolean };
  viewer: { wrap: boolean; markdown: "code" | "rendered" };
  tree: { showHidden: boolean; respectGitignore: boolean };
  layout: { default: (typeof NAVIGATOR_LAYOUTS)[number] };
} {
  return {
    version: 1,
    images: { mode: "off" },
    icons: { enabled: false },
    viewer: { wrap: false, markdown: "code" },
    tree: { showHidden: false, respectGitignore: true },
    layout: { default: "files-git-viewer" },
  };
}

/** By-id registry access (Issue #145): positional indexing is a drift trap. */
function fieldById(id: string): NavigatorConfigField {
  const field = NAVIGATOR_CONFIG_FIELDS.find((candidate) => candidate.id === id);
  if (field === undefined) throw new Error(`no registry field "${id}"`);
  return field;
}

/** The value a settings object holds at a registry path. */
function valueAt(settings: unknown, path: readonly string[]): unknown {
  let current: unknown = settings;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ── PI_NAV_IMAGES truth table (§5.1) ──

describe("parseImageMode", () => {
  it.each(["1", "true", "yes", "on", "chafa"])("enables chafa rendering for %s", (value) => {
    expect(parseImageMode(value)).toEqual({ mode: "chafa" });
  });

  it.each(["0", "false", "no", "off"])("disables rendering for %s", (value) => {
    expect(parseImageMode(value)).toEqual({ mode: "off" });
  });

  it.each(["native", "auto"])("resolves the new mode token %s", (value) => {
    expect(parseImageMode(value)).toEqual({ mode: value });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseImageMode(" TRUE ")).toEqual({ mode: "chafa" });
    expect(parseImageMode("  On  ")).toEqual({ mode: "chafa" });
    expect(parseImageMode("OFF")).toEqual({ mode: "off" });
    expect(parseImageMode("\tchafa\n")).toEqual({ mode: "chafa" });
    expect(parseImageMode("NATIVE")).toEqual({ mode: "native" });
    expect(parseImageMode(" Auto ")).toEqual({ mode: "auto" });
  });

  it("treats undefined, empty, and whitespace as no override, without a warning", () => {
    expect(parseImageMode(undefined)).toEqual({ mode: undefined });
    expect(parseImageMode("")).toEqual({ mode: undefined });
    expect(parseImageMode("   ")).toEqual({ mode: undefined });
  });

  it("rejects garbage with a bounded warning and falls back to the file/default", () => {
    const result = parseImageMode("sixel");
    expect(result.mode).toBeUndefined();
    expect(result.warning).toBeDefined();
    expect(result.warning ?? "").toContain("sixel");
    expect(result.warning ?? "").toContain("PI_NAV_IMAGES");
    expect(result.warning ?? "").toContain("file/default");
  });

  it("emits the exact warning string for invalid values", () => {
    expect(parseImageMode("sixel")).toEqual({
      mode: undefined,
      warning: "sixel is not a valid PI_NAV_IMAGES value; using the file/default setting",
    });
  });

  it("preserves original casing in warning for invalid values", () => {
    expect(parseImageMode("SIXEL")).toEqual({
      mode: undefined,
      warning: "SIXEL is not a valid PI_NAV_IMAGES value; using the file/default setting",
    });
  });
});

// ── PI_NAV_LAYOUT truth table (Issue #119, D11) ──

describe("parseLayoutMode", () => {
  it("resolves exactly the three layout names, case-sensitively", () => {
    for (const layout of NAVIGATOR_LAYOUTS) {
      expect(parseLayoutMode(layout)).toEqual({ layout });
    }
    // No legacy boolean-ish tokens and no case folding: this env var is new.
    expect(parseLayoutMode("1").layout).toBeUndefined();
    expect(parseLayoutMode("FILES-VIEWER").layout).toBeUndefined();
    expect(parseLayoutMode("Files-Viewer").layout).toBeUndefined();
  });

  it("treats undefined, empty, and whitespace as no override, without a warning", () => {
    expect(parseLayoutMode(undefined)).toEqual({ layout: undefined });
    expect(parseLayoutMode("")).toEqual({ layout: undefined });
    expect(parseLayoutMode("   ")).toEqual({ layout: undefined });
    expect(parseLayoutMode("\t\n")).toEqual({ layout: undefined });
  });

  it("trims surrounding whitespace from a valid value", () => {
    expect(parseLayoutMode(" git-viewer ")).toEqual({ layout: "git-viewer" });
  });

  it("emits the exact warning string for invalid values and keeps the original casing", () => {
    expect(parseLayoutMode("sixel")).toEqual({
      layout: undefined,
      warning: "sixel is not a valid PI_NAV_LAYOUT value; using the file/default setting",
    });
    expect(parseLayoutMode("SIXEL")).toEqual({
      layout: undefined,
      warning: "SIXEL is not a valid PI_NAV_LAYOUT value; using the file/default setting",
    });
  });
});

// ── normalizeNavigatorSettings (§5.2) ──

describe("normalizeNavigatorSettings", () => {
  it("defaults on non-object input with one bounded warning, never throwing", () => {
    for (const raw of [undefined, null, "off", 42, [1, 2]]) {
      const result = normalizeNavigatorSettings(raw);
      expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0] ?? "").toMatch(/object/i);
    }
  });

  it("defaults silently on the canonical shape", () => {
    const result = normalizeNavigatorSettings(fullSettings());
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    expect(result.warnings).toEqual([]);
  });

  it("expanded defaults cover all five sections", () => {
    expect(DEFAULT_NAVIGATOR_SETTINGS).toEqual({
      version: 1,
      images: { mode: "off" },
      icons: { enabled: false },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false, respectGitignore: true },
      layout: { default: "files-git-viewer" },
    });
  });

  it("every registry field's default is what an empty file normalizes to", () => {
    const defaults = normalizeNavigatorSettings({}).settings;
    expect(defaults).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      let current: unknown = defaults;
      for (const segment of field.path) {
        current = (current as Record<string, unknown>)[segment];
      }
      expect(current, field.id).toEqual(field.default);
    }
  });

  it("the exported defaults stay deeply frozen", () => {
    expect(Object.isFrozen(DEFAULT_NAVIGATOR_SETTINGS)).toBe(true);
    for (const section of ["images", "icons", "viewer", "tree", "layout"]) {
      const value = (DEFAULT_NAVIGATOR_SETTINGS as unknown as Record<string, unknown>)[section];
      expect(value).toBeDefined();
      if (value !== null && typeof value === "object") expect(Object.isFrozen(value), section).toBe(true);
    }
  });

  it("accepts images.mode chafa", () => {
    const result = normalizeNavigatorSettings(fullSettings({ images: { mode: "chafa" } }));
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.warnings).toEqual([]);
  });

  it("accepts all four images.mode values without warnings", () => {
    for (const mode of ["off", "chafa", "native", "auto"] as const) {
      const result = normalizeNavigatorSettings(fullSettings({ images: { mode } }));
      expect(result.settings.images.mode).toBe(mode);
      expect(result.warnings).toEqual([]);
    }
  });

  it("treats a missing version as 1 without a warning", () => {
    const result = normalizeNavigatorSettings({ images: { mode: "chafa" } });
    expect(result.settings.version).toBe(1);
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.settings.icons).toEqual({ enabled: false });
    expect(result.warnings).toEqual([]);
  });

  it("falls back to defaults when the version is newer than supported", () => {
    const result = normalizeNavigatorSettings({ version: 2, images: { mode: "chafa" } });
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0] ?? "").toContain("newer than this navigator supports");
  });

  it("warns and keeps version 1 for invalid version values", () => {
    for (const raw of [{ version: 0 }, { version: -1 }, { version: 1.5 }, { version: "1" }]) {
      const result = normalizeNavigatorSettings(raw);
      expect(result.settings.version).toBe(1);
      expect(result.warnings.some((w) => w.includes("version") && w.includes("invalid"))).toBe(true);
    }
  });

  it("warns and defaults when images is present but not an object", () => {
    for (const raw of [{ version: 1, images: "chafa" }, { version: 1, images: ["off"] }, { version: 1, images: null }]) {
      const result = normalizeNavigatorSettings(raw);
      expect(result.settings.images.mode).toBe("off");
      expect(result.warnings.some((w) => w.includes("images"))).toBe(true);
    }
  });

  it("warns on invalid images.mode values and falls back to off", () => {
    for (const mode of ["kitty", "SIXEL", "sixel"]) {
      const result = normalizeNavigatorSettings({ version: 1, images: { mode } });
      expect(result.settings.images.mode).toBe("off");
      expect(result.warnings.some((w) => w.includes("images.mode"))).toBe(true);
    }
  });

  it("accepts all three layout.default values without warnings", () => {
    for (const layout of NAVIGATOR_LAYOUTS) {
      const result = normalizeNavigatorSettings({ version: 1, layout: { default: layout } });
      expect(result.settings.layout.default).toBe(layout);
      expect(result.warnings).toEqual([]);
    }
  });

  it("warns on invalid layout.default values and falls back to files-git-viewer", () => {
    const result = normalizeNavigatorSettings({ version: 1, layout: { default: "split" } });
    expect(result.settings.layout.default).toBe("files-git-viewer");
    expect(result.warnings.some((w) => w.includes("layout.default"))).toBe(true);
  });

  it("accepts object sections and rejects non-object sections with a warning", () => {
    const result = normalizeNavigatorSettings({ version: 1, icons: { enabled: true }, viewer: { wrap: true, markdown: "rendered" }, tree: { showHidden: true }, layout: { default: "git-viewer" } });
    expect(result.settings).toEqual({
      version: 1,
      images: { mode: "off" },
      icons: { enabled: true },
      viewer: { wrap: true, markdown: "rendered" },
      tree: { showHidden: true, respectGitignore: true },
      layout: { default: "git-viewer" },
    });
    expect(result.warnings).toEqual([]);
    for (const section of ["icons", "viewer", "tree"]) {
      const sectionResult = normalizeNavigatorSettings({ version: 1, [section]: "junk" });
      expect(sectionResult.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
      expect(sectionResult.warnings.some((w) => w.includes(section))).toBe(true);
    }
  });

  it("accepts only booleans for icons.enabled, viewer.wrap, tree.showHidden, and tree.respectGitignore", () => {
    const enabled = normalizeNavigatorSettings({ version: 1, icons: { enabled: true }, viewer: { wrap: true }, tree: { showHidden: true, respectGitignore: false } });
    expect(enabled.settings.icons.enabled).toBe(true);
    expect(enabled.settings.viewer.wrap).toBe(true);
    expect(enabled.settings.tree.showHidden).toBe(true);
    expect(enabled.settings.tree.respectGitignore).toBe(false);
    expect(enabled.warnings).toEqual([]);
    for (const [sectionKey, value] of [["icons", "yes"], ["viewer", 1], ["tree", "true"]] as const) {
      const bad = normalizeNavigatorSettings({ version: 1, [sectionKey]: { enabled: value, wrap: value, showHidden: value, respectGitignore: value } });
      if (sectionKey === "viewer") {
        expect(bad.settings.viewer.wrap).toBe(false);
        expect(bad.warnings.some((w) => w.includes("viewer.wrap"))).toBe(true);
      } else if (sectionKey === "icons") {
        expect(bad.settings.icons.enabled).toBe(false);
        expect(bad.warnings.some((w) => w.includes("icons.enabled"))).toBe(true);
      } else {
        expect(bad.settings.tree.showHidden).toBe(false);
        expect(bad.settings.tree.respectGitignore).toBe(true);
        expect(bad.warnings.some((w) => w.includes("tree.showHidden"))).toBe(true);
        expect(bad.warnings.some((w) => w.includes("tree.respectGitignore"))).toBe(true);
      }
    }
  });

  it("accepts only code/rendered for viewer.markdown", () => {
    expect(normalizeNavigatorSettings({ version: 1, viewer: { markdown: "rendered" } }).settings.viewer.markdown).toBe("rendered");
    const bad = normalizeNavigatorSettings({ version: 1, viewer: { markdown: "preview" } });
    expect(bad.settings.viewer.markdown).toBe("code");
    expect(bad.warnings.some((w) => w.includes("viewer.markdown"))).toBe(true);
  });

  it("keeps the exact per-kind warning phrasing for invalid values", () => {
    expect(
      normalizeNavigatorSettings({ version: 1, icons: { enabled: "x" }, viewer: { markdown: "x" } }).warnings,
    ).toEqual(['icons.enabled "x" is invalid; using false', 'viewer.markdown "x" is invalid; using "code"']);
    expect(normalizeNavigatorSettings({ version: 1, icons: "junk" }).warnings).toEqual([
      '"icons" must be an object; using defaults',
    ]);
  });

  it("every registry enum field warns on a non-option value and falls back to its default", () => {
    for (const field of NAVIGATOR_CONFIG_FIELDS.filter((candidate) => candidate.kind === "enum")) {
      const [sectionKey, key] = field.path;
      if (sectionKey === undefined || key === undefined) continue;
      const result = normalizeNavigatorSettings({ [sectionKey]: { [key]: "not-an-option" } });
      expect(result.warnings.some((warning) => warning.includes(field.id)), field.id).toBe(true);
      let current: unknown = result.settings;
      for (const segment of field.path) {
        current = (current as Record<string, unknown>)[segment];
      }
      expect(current, field.id).toEqual(field.default);
    }
  });

  it("warns once per unknown top-level key", () => {
    const result = normalizeNavigatorSettings({ version: 1, images: { mode: "off" }, bogus: 1, other: "x" });
    expect(result.warnings).toContain('unknown setting "bogus" ignored');
    expect(result.warnings).toContain('unknown setting "other" ignored');
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
  });

  it("warns on unknown keys under images", () => {
    const result = normalizeNavigatorSettings({ version: 1, images: { mode: "off", dither: "none" } });
    expect(result.warnings).toContain('unknown setting "images.dither" ignored');
    expect(result.settings.images.mode).toBe("off");
  });

  it("warns on unknown keys under icons, viewer, and tree", () => {
    const result = normalizeNavigatorSettings({
      version: 1,
      icons: { enabled: true, vendor: "nf" },
      viewer: { wrap: true, tabWidth: 4 },
      tree: { showHidden: true, depth: 9 },
    });
    expect(result.warnings).toContain('unknown setting "icons.vendor" ignored');
    expect(result.warnings).toContain('unknown setting "viewer.tabWidth" ignored');
    expect(result.warnings).toContain('unknown setting "tree.depth" ignored');
    expect(result.settings.icons.enabled).toBe(true);
    expect(result.settings.viewer.wrap).toBe(true);
  });

  it("bounds unknown-key warnings to a handful even for a hostile file", () => {
    const raw: Record<string, unknown> = { version: 1, images: { mode: "off" } };
    for (let i = 0; i < 50; i++) raw[`key${i}`] = i;
    const result = normalizeNavigatorSettings(raw);
    const perKey = result.warnings.filter((w) => w.startsWith('unknown setting "'));
    expect(perKey.length).toBeLessThanOrEqual(5);
    expect(result.warnings.some((w) => w.includes("more unknown settings"))).toBe(true);
  });

  it("enforces a global cap on unknown-key warnings across sections", () => {
    const raw = {
      version: 1,
      images: { mode: "off", bad1: 1, bad2: 2, bad3: 3 },
      icons: { enabled: true, bad4: 4, bad5: 5, bad6: 6 },
    };
    const result = normalizeNavigatorSettings(raw);
    const perKey = result.warnings.filter((w) => w.startsWith('unknown setting "'));
    expect(perKey).toHaveLength(5);
    expect(result.warnings).toContain("and 1 more unknown setting ignored");
  });

  it("uses plural 'settings' when multiple unknown settings overflow the cap", () => {
    const raw = {
      version: 1,
      images: { mode: "off", b1: 1, b2: 2, b3: 3, b4: 4, b5: 5, b6: 6, b7: 7 },
    };
    const result = normalizeNavigatorSettings(raw);
    expect(result.warnings).toContain("and 2 more unknown settings ignored");
  });

  it("never mutates its input", () => {
    const fixture = deepFreeze({ version: 1, images: { mode: "chafa" }, junk: { deep: [1, 2, 3] } });
    expect(() => normalizeNavigatorSettings(fixture)).not.toThrow();
    const result = normalizeNavigatorSettings(fixture);
    expect(result.settings.images.mode).toBe("chafa");
    // The original fixture is untouched.
    expect(fixture.images.mode).toBe("chafa");
    expect(fixture.junk.deep).toEqual([1, 2, 3]);
  });
});

// ── serializeNavigatorSettings (§5.2) ──

describe("serializeNavigatorSettings", () => {
  it("emits the canonical nested shape with all five sections", () => {
    expect(serializeNavigatorSettings(DEFAULT_NAVIGATOR_SETTINGS)).toEqual({
      version: 1,
      images: { mode: "off" },
      icons: { enabled: false },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false, respectGitignore: true },
      layout: { default: "files-git-viewer" },
    });
    // Key order is part of the persistence contract: the writer (and thus
    // versions of the file on disk) stays byte-identical across formats.
    expect(JSON.stringify(serializeNavigatorSettings(DEFAULT_NAVIGATOR_SETTINGS))).toBe(
      '{"version":1,"images":{"mode":"off"},"icons":{"enabled":false},"viewer":{"wrap":false,"markdown":"code"},"tree":{"showHidden":false,"respectGitignore":true},"layout":{"default":"files-git-viewer"}}',
    );
    expect(
      serializeNavigatorSettings(
        fullSettings({
          images: { mode: "chafa" },
          icons: { enabled: true },
          viewer: { wrap: true, markdown: "rendered" },
          tree: { showHidden: true, respectGitignore: false },
          layout: { default: "git-viewer" },
        }),
      ),
    ).toEqual({
      version: 1,
      images: { mode: "chafa" },
      icons: { enabled: true },
      viewer: { wrap: true, markdown: "rendered" },
      tree: { showHidden: true, respectGitignore: false },
      layout: { default: "git-viewer" },
    });
  });

  it("round-trips through the normalizer with no warnings", () => {
    const samples = [
      DEFAULT_NAVIGATOR_SETTINGS,
      fullSettings({ images: { mode: "chafa" } }),
      fullSettings({ images: { mode: "native" } }),
      fullSettings({ images: { mode: "auto" } }),
      fullSettings({ icons: { enabled: true }, viewer: { wrap: true, markdown: "rendered" }, tree: { showHidden: true, respectGitignore: false } }),
    ];
    for (const settings of samples) {
      const result = normalizeNavigatorSettings(serializeNavigatorSettings(settings));
      expect(result.settings).toEqual(settings);
      expect(result.warnings).toEqual([]);
    }
  });

  it("round-trips each registry field through the normalizer at a non-default value", () => {
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      const [sectionKey, key] = field.path;
      if (sectionKey === undefined || key === undefined) continue;
      const rawValue =
        field.kind === "boolean" ? true : field.kind === "enum" ? (field.options?.[field.options.length - 1] ?? "") : 3;
      const normalized = normalizeNavigatorSettings({ [sectionKey]: { [key]: rawValue } });
      expect(normalized.warnings, field.id).toEqual([]);
      const reloaded = normalizeNavigatorSettings(serializeNavigatorSettings(normalized.settings));
      expect(reloaded.settings, field.id).toEqual(normalized.settings);
      expect(reloaded.warnings, field.id).toEqual([]);
    }
  });
});

// ── loadNavigatorSettings: defaults ← file ← env ──

describe("loadNavigatorSettings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-nav-settings-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when the file is missing, without a warning", () => {
    const result = loadNavigatorSettings({ userPath: join(dir, "missing.json") });
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    expect(result.warnings).toEqual([]);
    expect(result.origins).toEqual({});
    // `sources` is gone (Issue #145): the loader reports origins, not read
    // provenance, and a file-only load has no origin at all.
    expect(Object.keys(result).sort()).toEqual(["origins", "settings", "warnings"]);
  });

  it("warns once on corrupt JSON and falls back to defaults", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ not json !!!", "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0] ?? "").toContain("unreadable");
    expect(result.origins).toEqual({});
  });

  it("loads a valid file without reporting any override origin", () => {
    const path = join(dir, "valid.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "chafa" } })), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.warnings).toEqual([]);
    expect(result.origins).toEqual({});
  });

  it("lets the env override beat the file (precedence: defaults ← file ← env)", () => {
    const offFile = join(dir, "file-off.json");
    writeFileSync(offFile, JSON.stringify(fullSettings({ images: { mode: "off" } })), "utf8");
    const enabled = loadNavigatorSettings({ userPath: offFile, env: { [NAVIGATOR_IMAGES_ENV]: "chafa" } });
    expect(enabled.settings.images.mode).toBe("chafa");
    expect(enabled.warnings).toEqual([]);
    expect(enabled.origins).toEqual({ "images.mode": { layer: "env", source: NAVIGATOR_IMAGES_ENV } });

    const onFile = join(dir, "file-on.json");
    writeFileSync(onFile, JSON.stringify(fullSettings({ images: { mode: "chafa" } })), "utf8");
    const disabled = loadNavigatorSettings({ userPath: onFile, env: { [NAVIGATOR_IMAGES_ENV]: "0" } });
    expect(disabled.settings.images.mode).toBe("off");
    expect(disabled.warnings).toEqual([]);
    expect(disabled.origins).toEqual({ "images.mode": { layer: "env", source: NAVIGATOR_IMAGES_ENV } });
  });

  it("resolves PI_NAV_ICONS precedence inside the loader (file ← env)", () => {
    const offFile = join(dir, "icons-off.json");
    writeFileSync(offFile, JSON.stringify(fullSettings({ icons: { enabled: false } })), "utf8");
    const enabled = loadNavigatorSettings({ userPath: offFile, env: { [ICONS_ENV]: "1" } });
    expect(enabled.settings.icons.enabled).toBe(true);
    expect(enabled.warnings).toEqual([]);
    expect(enabled.origins).toEqual({ "icons.enabled": { layer: "env", source: ICONS_ENV } });

    const onFile = join(dir, "icons-on.json");
    writeFileSync(onFile, JSON.stringify(fullSettings({ icons: { enabled: true } })), "utf8");
    const disabled = loadNavigatorSettings({ userPath: onFile, env: { [ICONS_ENV]: "no" } });
    expect(disabled.settings.icons.enabled).toBe(false);
    expect(disabled.warnings).toEqual([]);
  });

  it("applies the env overrides with no file present", () => {
    const result = loadNavigatorSettings({
      userPath: join(dir, "missing.json"),
      env: { [NAVIGATOR_IMAGES_ENV]: "1", [ICONS_ENV]: "on", [NAVIGATOR_LAYOUT_ENV]: "git-viewer" },
    });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.settings.icons.enabled).toBe(true);
    expect(result.settings.layout.default).toBe("git-viewer");
    expect(result.warnings).toEqual([]);
    expect(result.origins).toEqual({
      "images.mode": { layer: "env", source: NAVIGATOR_IMAGES_ENV },
      "icons.enabled": { layer: "env", source: ICONS_ENV },
      "layout.default": { layer: "env", source: NAVIGATOR_LAYOUT_ENV },
    });
  });

  it("resolves PI_NAV_LAYOUT precedence inside the loader (file ← env, Issue #119)", () => {
    const splitFile = join(dir, "layout-split.json");
    writeFileSync(splitFile, JSON.stringify(fullSettings({ layout: { default: "files-git-viewer" } })), "utf8");
    const overridden = loadNavigatorSettings({ userPath: splitFile, env: { [NAVIGATOR_LAYOUT_ENV]: "files-viewer" } });
    expect(overridden.settings.layout.default).toBe("files-viewer");
    expect(overridden.warnings).toEqual([]);
    expect(overridden.origins).toEqual({ "layout.default": { layer: "env", source: NAVIGATOR_LAYOUT_ENV } });

    const gitFile = join(dir, "layout-git.json");
    writeFileSync(gitFile, JSON.stringify(fullSettings({ layout: { default: "git-viewer" } })), "utf8");
    const reverted = loadNavigatorSettings({ userPath: gitFile, env: { [NAVIGATOR_LAYOUT_ENV]: "files-git-viewer" } });
    expect(reverted.settings.layout.default).toBe("files-git-viewer");
    expect(reverted.warnings).toEqual([]);
  });

  it("ignores an empty or whitespace layout env without a warning", () => {
    const path = join(dir, "layout-file.json");
    writeFileSync(path, JSON.stringify(fullSettings({ layout: { default: "files-viewer" } })), "utf8");
    for (const layout of ["", "   ", undefined]) {
      const result = loadNavigatorSettings({ userPath: path, env: { [NAVIGATOR_LAYOUT_ENV]: layout } });
      expect(result.settings.layout.default).toBe("files-viewer");
      expect(result.warnings).toEqual([]);
      expect(result.origins).toEqual({});
    }
  });

  it("warns on an invalid layout env and falls back to the file value", () => {
    const path = join(dir, "layout-file.json");
    writeFileSync(path, JSON.stringify(fullSettings({ layout: { default: "files-viewer" } })), "utf8");
    const result = loadNavigatorSettings({ userPath: path, env: { [NAVIGATOR_LAYOUT_ENV]: "sixel" } });
    expect(result.settings.layout.default).toBe("files-viewer");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0] ?? "").toContain("PI_NAV_LAYOUT");
    // Invalid env never wins, so it reports no origin.
    expect(result.origins).toEqual({});
  });

  it("ignores empty or whitespace env values without a warning", () => {
    const path = join(dir, "file.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "chafa" }, icons: { enabled: false } })), "utf8");
    for (const images of ["", "   ", undefined]) {
      const result = loadNavigatorSettings({ userPath: path, env: { [NAVIGATOR_IMAGES_ENV]: images, [ICONS_ENV]: "  " } });
      expect(result.settings.images.mode).toBe("chafa");
      expect(result.settings.icons.enabled).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.origins).toEqual({});
    }
  });

  it("warns on garbage env and falls back to the file/default setting", () => {
    const path = join(dir, "file.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "off" }, icons: { enabled: false } })), "utf8");
    const result = loadNavigatorSettings({ userPath: path, env: { [NAVIGATOR_IMAGES_ENV]: "sixel", [ICONS_ENV]: "sometimes" } });
    expect(result.settings.images.mode).toBe("off");
    expect(result.settings.icons.enabled).toBe(false);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0] ?? "").toContain("PI_NAV_IMAGES");
    expect(result.warnings[1] ?? "").toContain("PI_NAV_ICONS");
    expect(result.origins).toEqual({});
  });

  it("surfaces normalizer warnings through the loader (version too new)", () => {
    const path = join(dir, "v2.json");
    writeFileSync(path, JSON.stringify({ version: 2, images: { mode: "chafa" } }), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0] ?? "").toContain("newer than this navigator supports");
    expect(result.origins).toEqual({});
  });

  it("warns on unknown file keys through the loader", () => {
    const path = join(dir, "unknown.json");
    writeFileSync(path, JSON.stringify({ version: 1, images: { mode: "chafa" }, bogus: true }), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    // Issue #135 L13: the warning names the file it came from, so a user can
    // tell a config-file problem from a PI_NAV_* env-var problem.
    expect(result.warnings).toContain(`${path}: unknown setting "bogus" ignored`);
    expect(result.settings.images.mode).toBe("chafa");
  });

  it("falls back from an invalid images.mode with a warning", () => {
    const path = join(dir, "sixel.json");
    writeFileSync(path, JSON.stringify({ version: 1, images: { mode: "sixel" } }), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings.images.mode).toBe("off");
    expect(result.warnings.some((w) => w.includes("images.mode"))).toBe(true);
  });

  // ── flags (Issue #131): the most explicit layer, applied last ──

  it("lets a flag beat the env var and the file", () => {
    const path = join(dir, "flag.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "off" } })), "utf8");
    const result = loadNavigatorSettings({
      userPath: path,
      env: { [NAVIGATOR_IMAGES_ENV]: "chafa" },
      flags: { [NAVIGATOR_IMAGES_FLAG]: "native" },
    });
    expect(result.settings.images.mode).toBe("native");
    expect(result.origins).toEqual({ "images.mode": { layer: "flag", source: `--${NAVIGATOR_IMAGES_FLAG}` } });
  });

  it("applies a boolean icons flag in both directions, beating env either way", () => {
    const path = join(dir, "flag-icons.json");
    writeFileSync(path, JSON.stringify(fullSettings({ icons: { enabled: true } })), "utf8");
    const off = loadNavigatorSettings({ userPath: path, env: { [ICONS_ENV]: "1" }, flags: { [NAVIGATOR_ICONS_FLAG]: false } });
    expect(off.settings.icons.enabled).toBe(false);
    expect(off.origins).toEqual({ "icons.enabled": { layer: "flag", source: `--${NAVIGATOR_ICONS_FLAG}` } });
    const on = loadNavigatorSettings({ userPath: path, env: { [ICONS_ENV]: "0" }, flags: { [NAVIGATOR_ICONS_FLAG]: true } });
    expect(on.settings.icons.enabled).toBe(true);
    // A boolean flag applies directly; it cannot warn, and it still wins.
    expect(on.warnings).toEqual([]);
    expect(on.origins).toEqual({ "icons.enabled": { layer: "flag", source: `--${NAVIGATOR_ICONS_FLAG}` } });
  });

  it("names the flag, not the env var, when a flag value is invalid", () => {
    const result = loadNavigatorSettings({
      userPath: join(dir, "missing.json"),
      flags: { [NAVIGATOR_LAYOUT_FLAG]: "split", [NAVIGATOR_IMAGES_FLAG]: "sixel" },
    });
    expect(result.warnings.some((w) => w.includes("--navigator-layout"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("--navigator-images"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("PI_NAV_"))).toBe(false);
    // Present but invalid: neither flag won a field.
    expect(result.origins).toEqual({});
  });

  it("ignores a flag whose runtime value has the wrong shape for its row type", () => {
    // The old flagString/flagBoolean helpers filtered this before the loader
    // saw it; the registry walk owns it now, and a wrong-shape value must stay
    // "absent" rather than being coerced.
    const result = loadNavigatorSettings({
      userPath: join(dir, "missing.json"),
      env: { [NAVIGATOR_IMAGES_ENV]: "chafa" },
      flags: { [NAVIGATOR_IMAGES_FLAG]: true, [NAVIGATOR_ICONS_FLAG]: "on" },
    });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.settings.icons.enabled).toBe(DEFAULT_NAVIGATOR_SETTINGS.icons.enabled);
    expect(result.warnings).toEqual([]);
    expect(result.origins).toEqual({ "images.mode": { layer: "env", source: NAVIGATOR_IMAGES_ENV } });
  });

  it("treats an absent or empty flag as no override", () => {
    const result = loadNavigatorSettings({
      userPath: join(dir, "missing.json"),
      env: { [NAVIGATOR_IMAGES_ENV]: "chafa" },
      flags: { [NAVIGATOR_IMAGES_FLAG]: "", [NAVIGATOR_LAYOUT_FLAG]: "  " },
    });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.settings.layout.default).toBe(DEFAULT_NAVIGATOR_SETTINGS.layout.default);
    expect(result.origins).toEqual({ "images.mode": { layer: "env", source: NAVIGATOR_IMAGES_ENV } });
  });

  // ── origins (Issue #145): the layer that actually won ──

  it("reports the effective layer per field — flag beats env, files and defaults report nothing", () => {
    const path = join(dir, "origins.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "off" }, layout: { default: "git-viewer" } })), "utf8");
    const result = loadNavigatorSettings({
      userPath: path,
      env: { [NAVIGATOR_IMAGES_ENV]: "chafa", [ICONS_ENV]: "1" },
      flags: { [NAVIGATOR_IMAGES_FLAG]: "native" },
    });
    expect(result.settings.images.mode).toBe("native");
    expect(result.origins).toEqual({
      "images.mode": { layer: "flag", source: `--${NAVIGATOR_IMAGES_FLAG}` },
      "icons.enabled": { layer: "env", source: ICONS_ENV },
    });
  });

  it("reports no origin for a present-but-invalid flag (the accepted truthfulness delta)", () => {
    const path = join(dir, "invalid-flag.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "chafa" } })), "utf8");
    const result = loadNavigatorSettings({
      userPath: path,
      flags: { [NAVIGATOR_IMAGES_FLAG]: "sixel" },
    });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.warnings).toHaveLength(1);
    expect(result.origins).toEqual({});
  });

  it("keeps the env origin when an invalid flag did not win the field", () => {
    const result = loadNavigatorSettings({
      userPath: join(dir, "missing.json"),
      env: { [NAVIGATOR_IMAGES_ENV]: "chafa" },
      flags: { [NAVIGATOR_IMAGES_FLAG]: "sixel" },
    });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.origins).toEqual({ "images.mode": { layer: "env", source: NAVIGATOR_IMAGES_ENV } });
  });

  it("keeps the layer warning order: all env warnings before all flag warnings", () => {
    const result = loadNavigatorSettings({
      userPath: join(dir, "missing.json"),
      env: { [NAVIGATOR_IMAGES_ENV]: "sixel", [ICONS_ENV]: "sometimes", [NAVIGATOR_LAYOUT_ENV]: "split" },
      flags: { [NAVIGATOR_IMAGES_FLAG]: "nope", [NAVIGATOR_LAYOUT_FLAG]: "nope" },
    });
    expect(result.warnings).toEqual([
      "sixel is not a valid PI_NAV_IMAGES value; using the file/default setting",
      "sometimes is not a valid PI_NAV_ICONS value; using the file/default setting",
      "split is not a valid PI_NAV_LAYOUT value; using the file/default setting",
      "nope is not a valid --navigator-images value; using the file/default setting",
      "nope is not a valid --navigator-layout value; using the file/default setting",
    ]);
    expect(result.origins).toEqual({});
  });

  it("applies overrides by iterating registry rows, not a hardcoded field list (Issue #145)", () => {
    const synthetic: NavigatorConfigField = {
      id: "viewer.tabWidth",
      path: ["viewer", "tabWidth"],
      kind: "number",
      section: "Viewer",
      label: "Tab width",
      description: "Synthetic registry row proving the loader walks the table.",
      min: 1,
      max: 8,
      default: 4,
      live: false,
      override: {
        env: "PI_NAV_SYNTHETIC",
        flag: { name: "navigator-synthetic", description: "synthetic", type: "string" },
        parse: (raw, source) => {
          const trimmed = raw.trim();
          if (trimmed === "") return { value: undefined };
          const value = Number(trimmed);
          if (!Number.isFinite(value)) {
            return { value: undefined, warning: `${trimmed} is not a valid ${source} value; using the file/default setting` };
          }
          return { value: Math.min(8, Math.max(1, value)) };
        },
      },
    };
    (NAVIGATOR_CONFIG_FIELDS as unknown as NavigatorConfigField[]).push(synthetic);
    try {
      const env = loadNavigatorSettings({ userPath: join(dir, "missing.json"), env: { PI_NAV_SYNTHETIC: "6" } });
      expect(valueAt(env.settings, synthetic.path)).toBe(6);
      expect(env.origins["viewer.tabWidth"]).toEqual({ layer: "env", source: "PI_NAV_SYNTHETIC" });

      const flagged = loadNavigatorSettings({
        userPath: join(dir, "missing.json"),
        env: { PI_NAV_SYNTHETIC: "6" },
        flags: { "navigator-synthetic": "2" },
      });
      expect(valueAt(flagged.settings, synthetic.path)).toBe(2);
      expect(flagged.origins["viewer.tabWidth"]).toEqual({ layer: "flag", source: "--navigator-synthetic" });

      const invalid = loadNavigatorSettings({
        userPath: join(dir, "missing.json"),
        flags: { "navigator-synthetic": "abc" },
      });
      expect(valueAt(invalid.settings, synthetic.path)).toBe(synthetic.default);
      expect(invalid.origins).toEqual({});
    } finally {
      (NAVIGATOR_CONFIG_FIELDS as unknown as NavigatorConfigField[]).pop();
    }
  });

  it("resolveOverrideOrigins mirrors the loader's precedence without reading the file", () => {
    const env = { [NAVIGATOR_IMAGES_ENV]: "chafa", [NAVIGATOR_LAYOUT_ENV]: "files-viewer" };
    const flags = { [NAVIGATOR_IMAGES_FLAG]: "native", [NAVIGATOR_ICONS_FLAG]: true, [NAVIGATOR_LAYOUT_FLAG]: "sixel" };
    const expected = {
      "images.mode": { layer: "flag" as const, source: `--${NAVIGATOR_IMAGES_FLAG}` },
      "icons.enabled": { layer: "flag" as const, source: `--${NAVIGATOR_ICONS_FLAG}` },
      "layout.default": { layer: "env" as const, source: NAVIGATOR_LAYOUT_ENV },
    };
    expect(resolveOverrideOrigins(env, flags)).toEqual(expected);
    // The resolver is the loader's own walk, so the two must agree.
    expect(resolveOverrideOrigins(env, flags)).toEqual(
      loadNavigatorSettings({ userPath: join(dir, "missing.json"), env, flags }).origins,
    );
    expect(resolveOverrideOrigins()).toEqual({});
  });
});

// ── writeNavigatorSettings: atomic tmp+rename ──

describe("writeNavigatorSettings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-nav-write-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the canonical shape atomically and leaves no tmp file behind", () => {
    const path = join(dir, "nested", "deep", "pi-navigator.json"); // exercises mkdir -p
    writeNavigatorSettings(path, fullSettings({ images: { mode: "chafa" }, icons: { enabled: true }, layout: { default: "git-viewer" } }));
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual({
      version: 1,
      images: { mode: "chafa" },
      icons: { enabled: true },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false, respectGitignore: true },
      layout: { default: "git-viewer" },
    });
    const entries = readdirSync(join(dir, "nested", "deep"));
    expect(entries).toEqual(["pi-navigator.json"]);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("reading back a written file yields the written settings", () => {
    const path = join(dir, "pi-navigator.json");
    writeNavigatorSettings(path, fullSettings({ images: { mode: "chafa" } }));
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings).toEqual(fullSettings({ images: { mode: "chafa" } }));
    expect(result.warnings).toEqual([]);
    expect(result.origins).toEqual({});
  });

  it("overwrites an existing file atomically", () => {
    const path = join(dir, "pi-navigator.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "off" } })), "utf8");
    writeNavigatorSettings(path, fullSettings({ images: { mode: "chafa" }, layout: { default: "files-viewer" } }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      images: { mode: "chafa" },
      icons: { enabled: false },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false, respectGitignore: true },
      layout: { default: "files-viewer" },
    });
    expect(readdirSync(dir)).toEqual(["pi-navigator.json"]);
  });

  it("cleans up the temporary file if rename fails", () => {
    const path = join(dir, "fail.json");
    mkdirSync(path);
    expect(() => writeNavigatorSettings(path, fullSettings())).toThrow();
    const entries = readdirSync(dir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

// ── commitNavigatorSettings: the one persist operation (Issue #145) ──

describe("commitNavigatorSettings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-nav-commit-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes atomically, reloads file-only, and returns the persisted settings with the reload warnings", () => {
    const path = join(dir, "nested", "pi-navigator.json");
    const committed = commitNavigatorSettings(
      path,
      fullSettings({ images: { mode: "native" }, layout: { default: "files-viewer" } }),
    );
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.settings).toEqual(fullSettings({ images: { mode: "native" }, layout: { default: "files-viewer" } }));
    expect(committed.warnings).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(
      serializeNavigatorSettings(fullSettings({ images: { mode: "native" }, layout: { default: "files-viewer" } })),
    );
    expect(readdirSync(join(dir, "nested")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("returns a bounded error when the write fails", () => {
    const path = join(dir, "not-a-file.json");
    mkdirSync(path); // renaming the tmp file onto a directory fails
    const committed = commitNavigatorSettings(path, fullSettings());
    expect(committed.ok).toBe(false);
    if (committed.ok) return;
    expect(committed.error.length).toBeGreaterThan(0);
    expect(committed.error.length).toBeLessThanOrEqual(161); // 160 + the ellipsis
  });
});

// ── applyFieldEdit (§2.2) ──

describe("applyFieldEdit", () => {
  it("applies boolean edits without mutating the input", () => {
    const base = fullSettings();
    const on = applyFieldEdit(base, "icons.enabled", "on");
    expect(on).toEqual({ ok: true, settings: fullSettings({ icons: { enabled: true } }) });
    expect(base.icons.enabled).toBe(false); // never mutates
    const off = applyFieldEdit(fullSettings({ icons: { enabled: true } }), "icons.enabled", "off");
    expect(off).toEqual({ ok: true, settings: fullSettings({ icons: { enabled: false } }) });
  });

  it("applies enum edits", () => {
    expect(applyFieldEdit(fullSettings(), "images.mode", "chafa")).toEqual({ ok: true, settings: fullSettings({ images: { mode: "chafa" } }) });
    expect(applyFieldEdit(fullSettings({ viewer: { wrap: false, markdown: "code" } }), "viewer.markdown", "rendered")).toEqual({
      ok: true,
      settings: fullSettings({ viewer: { wrap: false, markdown: "rendered" } }),
    });
    for (const layout of NAVIGATOR_LAYOUTS) {
      expect(applyFieldEdit(fullSettings(), "layout.default", layout)).toEqual({
        ok: true,
        settings: fullSettings({ layout: { default: layout } }),
      });
    }
    const bad = applyFieldEdit(fullSettings(), "layout.default", "split");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("expected one of files-git-viewer, files-viewer, git-viewer");
  });

  it("rejects an unknown field id", () => {
    const result = applyFieldEdit(fullSettings(), "bogus.key", "on");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unknown setting "bogus.key"');
  });

  it("rejects a bad boolean value", () => {
    const result = applyFieldEdit(fullSettings(), "tree.showHidden", "maybe");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expected on or off");
  });

  it("edits tree.respectGitignore through the on/off string face (Issue #158)", () => {
    const off = applyFieldEdit(fullSettings(), "tree.respectGitignore", "off");
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.settings.tree.respectGitignore).toBe(false);
    const on = applyFieldEdit(off.ok ? off.settings : fullSettings(), "tree.respectGitignore", "on");
    expect(on.ok).toBe(true);
    if (on.ok) expect(on.settings.tree.respectGitignore).toBe(true);
    const bad = applyFieldEdit(fullSettings(), "tree.respectGitignore", "maybe");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("expected on or off");
  });

  it("rejects a bad enum value", () => {
    const result = applyFieldEdit(fullSettings(), "images.mode", "kitty");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expected one of off, chafa, native, auto");
    const markdown = applyFieldEdit(fullSettings(), "viewer.markdown", "preview");
    expect(markdown.ok).toBe(false);
  });

  it("clamps numbers into [min, max] and rejects NaN", () => {
    expect(parseNumberField("5", 1, 3)).toEqual({ ok: true, value: 3 });
    expect(parseNumberField("0", 1, 3)).toEqual({ ok: true, value: 1 });
    expect(parseNumberField("2", 1, 3)).toEqual({ ok: true, value: 2 });
    expect(parseNumberField("2")).toEqual({ ok: true, value: 2 });
    expect(parseNumberField("oops").ok).toBe(false);
    const raw = parseNumberField("oops");
    if (!raw.ok) expect(raw.error).toContain("oops");
    expect(parseNumberField("").ok).toBe(false);
    expect(parseNumberField("   ").ok).toBe(false);
    expect(parseNumberField("Infinity").ok).toBe(false);
    expect(parseNumberField("-Infinity").ok).toBe(false);
  });
});

// ── field rule parity (Issue #145): one rule table, two faces ──

describe("field rule parity (Issue #145)", () => {
  it("accepts every field's default and every enum option through the string and JSON faces", () => {
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      const candidates = new Set<string>();
      if (field.kind === "boolean") {
        candidates.add("on");
        candidates.add("off");
      } else {
        candidates.add(String(field.default));
      }
      for (const option of field.options ?? []) candidates.add(option);
      for (const candidate of candidates) {
        const edited = applyFieldEdit(DEFAULT_NAVIGATOR_SETTINGS, field.id, candidate);
        expect(edited.ok, `${field.id} = ${candidate}`).toBe(true);
        if (!edited.ok) continue;
        const accepted = valueAt(edited.settings, field.path);
        // JSON face A: serialize what the string face accepted, then normalize.
        const reloaded = normalizeNavigatorSettings(serializeNavigatorSettings(edited.settings));
        expect(reloaded.warnings, `${field.id} = ${candidate}`).toEqual([]);
        expect(valueAt(reloaded.settings, field.path), `${field.id} = ${candidate}`).toEqual(accepted);
        // JSON face B: the typed value the string face produced is accepted directly.
        const typed = normalizeNavigatorSettings({ [field.path[0] ?? ""]: { [field.path[1] ?? ""]: accepted } });
        expect(typed.warnings, `${field.id} = ${candidate}`).toEqual([]);
        expect(valueAt(typed.settings, field.path), `${field.id} = ${candidate}`).toEqual(accepted);
      }
      // The registry default is what both faces fall back to.
      const defaults = normalizeNavigatorSettings(serializeNavigatorSettings(DEFAULT_NAVIGATOR_SETTINGS));
      expect(defaults.warnings, field.id).toEqual([]);
      expect(valueAt(defaults.settings, field.path), field.id).toEqual(field.default);
    }
  });

  it("keeps the number rules in parity through a synthetic registry row", () => {
    const numberField: NavigatorConfigField = {
      id: "viewer.tabWidth",
      path: ["viewer", "tabWidth"],
      kind: "number",
      section: "Viewer",
      label: "Tab width",
      description: "Synthetic numeric row for the rule-parity sweep.",
      min: 1,
      max: 8,
      default: 4,
      live: false,
    };
    (NAVIGATOR_CONFIG_FIELDS as unknown as NavigatorConfigField[]).push(numberField);
    try {
      const high = applyFieldEdit(DEFAULT_NAVIGATOR_SETTINGS, "viewer.tabWidth", "99");
      expect(high.ok).toBe(true);
      if (high.ok) expect(valueAt(high.settings, numberField.path)).toBe(8);
      const low = normalizeNavigatorSettings({ viewer: { tabWidth: 0 } });
      expect(low.warnings).toEqual([]);
      expect(valueAt(low.settings, numberField.path)).toBe(1);
      const invalid = normalizeNavigatorSettings({ viewer: { tabWidth: "wide" } });
      expect(invalid.warnings).toEqual(['viewer.tabWidth "wide" is invalid; using 4']);
      const rejected = applyFieldEdit(DEFAULT_NAVIGATOR_SETTINGS, "viewer.tabWidth", "wide");
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error).toBe('invalid number "wide" for "viewer.tabWidth"');
    } finally {
      (NAVIGATOR_CONFIG_FIELDS as unknown as NavigatorConfigField[]).pop();
    }
  });
});

// ── NAVIGATOR_CONFIG_FIELDS sync guard (overseer pattern) ──

describe("NAVIGATOR_CONFIG_FIELDS", () => {
  it("has exactly seven entries matching the spec table", () => {
    expect(NAVIGATOR_CONFIG_FIELDS).toHaveLength(7);
    expect(fieldById("images.mode")).toMatchObject({
      id: "images.mode",
      path: ["images", "mode"],
      kind: "enum",
      section: "Images",
      label: "Image rendering",
      options: ["off", "chafa", "native", "auto"],
      live: false,
    });
    expect(fieldById("icons.enabled")).toMatchObject({
      id: "icons.enabled",
      path: ["icons", "enabled"],
      kind: "boolean",
      section: "Icons",
      label: "Nerd Font icons",
      live: false,
    });
    expect(fieldById("viewer.wrap")).toMatchObject({
      id: "viewer.wrap",
      path: ["viewer", "wrap"],
      kind: "boolean",
      section: "Viewer",
      label: "Word wrap",
      live: false,
    });
    expect(fieldById("viewer.markdown")).toMatchObject({
      id: "viewer.markdown",
      path: ["viewer", "markdown"],
      kind: "enum",
      section: "Viewer",
      label: "Markdown view",
      options: ["code", "rendered"],
      live: false,
    });
    expect(fieldById("tree.showHidden")).toMatchObject({
      id: "tree.showHidden",
      path: ["tree", "showHidden"],
      kind: "boolean",
      section: "Tree",
      label: "Hidden files",
      live: false,
    });
    expect(fieldById("tree.respectGitignore")).toMatchObject({
      id: "tree.respectGitignore",
      path: ["tree", "respectGitignore"],
      kind: "boolean",
      section: "Tree",
      label: "Respect .gitignore",
      default: true,
      live: false,
    });
    expect(fieldById("layout.default")).toMatchObject({
      id: "layout.default",
      path: ["layout", "default"],
      kind: "enum",
      section: "Layout",
      label: "Default layout",
      options: ["files-git-viewer", "files-viewer", "git-viewer"],
      default: "files-git-viewer",
      live: false,
    });
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      expect(field.description.length).toBeGreaterThan(0);
    }
  });

  it("has unique ids and unique paths", () => {
    const ids = NAVIGATOR_CONFIG_FIELDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const paths = NAVIGATOR_CONFIG_FIELDS.map((f) => f.path.join("."));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("declares the startup layers on exactly the three override-backed rows (Issue #145)", () => {
    expect(NAVIGATOR_CONFIG_FIELDS.filter((field) => field.override !== undefined).map((field) => field.id)).toEqual([
      "images.mode",
      "icons.enabled",
      "layout.default",
    ]);
    expect(fieldById("images.mode").override).toEqual({
      env: NAVIGATOR_IMAGES_ENV,
      flag: {
        name: NAVIGATOR_IMAGES_FLAG,
        description: "pi-navigator image rendering: native, chafa, auto or off (beats PI_NAV_IMAGES and the settings file)",
        type: "string",
      },
      parse: expect.any(Function),
    });
    expect(fieldById("icons.enabled").override).toEqual({
      env: ICONS_ENV,
      flag: {
        name: NAVIGATOR_ICONS_FLAG,
        description: "pi-navigator: show the Nerd Font icon column (beats PI_NAV_ICONS and the settings file)",
        type: "boolean",
      },
      parse: expect.any(Function),
    });
    expect(fieldById("layout.default").override).toEqual({
      env: NAVIGATOR_LAYOUT_ENV,
      flag: {
        name: NAVIGATOR_LAYOUT_FLAG,
        description: "pi-navigator overlay layout: files-git-viewer, files-viewer or git-viewer (beats PI_NAV_LAYOUT and the settings file)",
        type: "string",
      },
      parse: expect.any(Function),
    });
    // File-only rows carry no startup layer at all.
    for (const id of ["viewer.wrap", "viewer.markdown", "tree.showHidden", "tree.respectGitignore"]) {
      expect(fieldById(id).override, id).toBeUndefined();
    }
  });

  it("every field path resolves in DEFAULT_NAVIGATOR_SETTINGS", () => {
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      let current: unknown = DEFAULT_NAVIGATOR_SETTINGS;
      for (const segment of field.path) {
        current = (current as Record<string, unknown>)[segment];
        expect(current, `${field.id} path segment "${segment}"`).not.toBeUndefined();
      }
    }
  });

  it("kinds and options are valid and every field is not live", () => {
    const validKinds = new Set(["enum", "boolean", "number"]);
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      expect(validKinds.has(field.kind)).toBe(true);
      expect(field.live).toBe(false);
      if (field.kind === "enum") {
        expect(field.options?.length ?? 0).toBeGreaterThan(0);
      } else {
        expect(field.options).toBeUndefined();
      }
    }
    // The registry options must match what the normalizer actually accepts.
    const modeField = fieldById("images.mode");
    expect(modeField?.options).toEqual(["off", "chafa", "native", "auto"]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "off" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "chafa" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "native" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "auto" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "sixel" } }).warnings.length).toBeGreaterThan(0);
    const markdownField = fieldById("viewer.markdown");
    expect(markdownField?.options).toEqual(["code", "rendered"]);
    expect(normalizeNavigatorSettings({ version: 1, viewer: { markdown: "rendered" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, viewer: { markdown: "preview" } }).warnings.length).toBeGreaterThan(0);
    // Issue #119: the layout enum's options are exactly NAVIGATOR_LAYOUTS.
    const layoutField = fieldById("layout.default");
    expect(layoutField?.options).toEqual([...NAVIGATOR_LAYOUTS]);
    for (const layout of NAVIGATOR_LAYOUTS) {
      expect(normalizeNavigatorSettings({ version: 1, layout: { default: layout } }).warnings).toEqual([]);
    }
    expect(normalizeNavigatorSettings({ version: 1, layout: { default: "grid" } }).warnings.length).toBeGreaterThan(0);
  });

  it("applyFieldEdit round-trips every registry field through the normalizer", () => {
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      const edited = applyFieldEdit(DEFAULT_NAVIGATOR_SETTINGS, field.id, field.kind === "boolean" ? "on" : field.options?.[0] ?? "");
      expect(edited.ok, field.id).toBe(true);
      if (edited.ok) {
        const reloaded = normalizeNavigatorSettings(serializeNavigatorSettings(edited.settings));
        expect(reloaded.settings, field.id).toEqual(edited.settings);
        expect(reloaded.warnings).toEqual([]);
      }
    }
  });
});
