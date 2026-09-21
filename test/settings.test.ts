/**
 * settings.ts unit suites (§12.1): the versioned settings terrain — typed
 * defaults, the never-throw pure normalizer, the loader with file/env
 * provenance, the canonical serializer, the atomic writer, the field
 * registry sync guard, and `applyFieldEdit` (pi-overseer pattern). The env
 * overrides are always passed in explicitly; no test reads or mutates
 * process.env.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_NAVIGATOR_SETTINGS,
  NAVIGATOR_CONFIG_FIELDS,
  applyFieldEdit,
  loadNavigatorSettings,
  normalizeNavigatorSettings,
  parseImageMode,
  parseNumberField,
  serializeNavigatorSettings,
  writeNavigatorSettings,
} from "../settings";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** A complete settings object with the canonical shape (all four sections). */
function fullSettings(overrides: Partial<{
  images: { mode: "off" | "chafa" };
  icons: { enabled: boolean };
  viewer: { wrap: boolean; markdown: "code" | "rendered" };
  tree: { showHidden: boolean };
}> = {}): ReturnType<typeof cloneDefaultsLike> {
  return {
    version: 1,
    images: overrides.images ?? { mode: "off" },
    icons: overrides.icons ?? { enabled: false },
    viewer: overrides.viewer ?? { wrap: false, markdown: "code" },
    tree: overrides.tree ?? { showHidden: false },
  };
}

function cloneDefaultsLike(): {
  version: 1;
  images: { mode: "off" | "chafa" };
  icons: { enabled: boolean };
  viewer: { wrap: boolean; markdown: "code" | "rendered" };
  tree: { showHidden: boolean };
} {
  return {
    version: 1,
    images: { mode: "off" },
    icons: { enabled: false },
    viewer: { wrap: false, markdown: "code" },
    tree: { showHidden: false },
  };
}

// ── PI_NAV_IMAGES truth table (§5.1) ──

describe("parseImageMode", () => {
  it.each(["1", "true", "yes", "on", "chafa"])("enables chafa rendering for %s", (value) => {
    expect(parseImageMode(value)).toEqual({ mode: "chafa" });
  });

  it.each(["0", "false", "no", "off"])("disables rendering for %s", (value) => {
    expect(parseImageMode(value)).toEqual({ mode: "off" });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseImageMode(" TRUE ")).toEqual({ mode: "chafa" });
    expect(parseImageMode("  On  ")).toEqual({ mode: "chafa" });
    expect(parseImageMode("OFF")).toEqual({ mode: "off" });
    expect(parseImageMode("\tchafa\n")).toEqual({ mode: "chafa" });
  });

  it("treats undefined, empty, and whitespace as no override, without a warning", () => {
    expect(parseImageMode(undefined)).toEqual({ mode: undefined });
    expect(parseImageMode("")).toEqual({ mode: undefined });
    expect(parseImageMode("   ")).toEqual({ mode: undefined });
  });

  it("rejects garbage with a bounded warning and falls back to the file/default", () => {
    const result = parseImageMode("native");
    expect(result.mode).toBeUndefined();
    expect(result.warning).toBeDefined();
    expect(result.warning ?? "").toContain("native");
    expect(result.warning ?? "").toContain("PI_NAV_IMAGES");
    expect(result.warning ?? "").toContain("file/default");
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

  it("expanded defaults cover all four sections", () => {
    expect(DEFAULT_NAVIGATOR_SETTINGS).toEqual({
      version: 1,
      images: { mode: "off" },
      icons: { enabled: false },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false },
    });
  });

  it("accepts images.mode chafa", () => {
    const result = normalizeNavigatorSettings(fullSettings({ images: { mode: "chafa" } }));
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.warnings).toEqual([]);
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

  it("warns on invalid images.mode values and falls back to off, including reserved native", () => {
    for (const mode of ["native", "kitty", "NATIVE"]) {
      const result = normalizeNavigatorSettings({ version: 1, images: { mode } });
      expect(result.settings.images.mode).toBe("off");
      expect(result.warnings.some((w) => w.includes("images.mode"))).toBe(true);
    }
  });

  it("accepts object sections and rejects non-object sections with a warning", () => {
    const result = normalizeNavigatorSettings({ version: 1, icons: { enabled: true }, viewer: { wrap: true, markdown: "rendered" }, tree: { showHidden: true } });
    expect(result.settings).toEqual({
      version: 1,
      images: { mode: "off" },
      icons: { enabled: true },
      viewer: { wrap: true, markdown: "rendered" },
      tree: { showHidden: true },
    });
    expect(result.warnings).toEqual([]);
    for (const section of ["icons", "viewer", "tree"]) {
      const sectionResult = normalizeNavigatorSettings({ version: 1, [section]: "junk" });
      expect(sectionResult.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
      expect(sectionResult.warnings.some((w) => w.includes(section))).toBe(true);
    }
  });

  it("accepts only booleans for icons.enabled, viewer.wrap, and tree.showHidden", () => {
    const enabled = normalizeNavigatorSettings({ version: 1, icons: { enabled: true }, viewer: { wrap: true }, tree: { showHidden: true } });
    expect(enabled.settings.icons.enabled).toBe(true);
    expect(enabled.settings.viewer.wrap).toBe(true);
    expect(enabled.settings.tree.showHidden).toBe(true);
    expect(enabled.warnings).toEqual([]);
    for (const [sectionKey, value] of [["icons", "yes"], ["viewer", 1], ["tree", "true"]] as const) {
      const bad = normalizeNavigatorSettings({ version: 1, [sectionKey]: { enabled: value, wrap: value, showHidden: value } });
      if (sectionKey === "viewer") {
        expect(bad.settings.viewer.wrap).toBe(false);
        expect(bad.warnings.some((w) => w.includes("viewer.wrap"))).toBe(true);
      } else if (sectionKey === "icons") {
        expect(bad.settings.icons.enabled).toBe(false);
        expect(bad.warnings.some((w) => w.includes("icons.enabled"))).toBe(true);
      } else {
        expect(bad.settings.tree.showHidden).toBe(false);
        expect(bad.warnings.some((w) => w.includes("tree.showHidden"))).toBe(true);
      }
    }
  });

  it("accepts only code/rendered for viewer.markdown", () => {
    expect(normalizeNavigatorSettings({ version: 1, viewer: { markdown: "rendered" } }).settings.viewer.markdown).toBe("rendered");
    const bad = normalizeNavigatorSettings({ version: 1, viewer: { markdown: "preview" } });
    expect(bad.settings.viewer.markdown).toBe("code");
    expect(bad.warnings.some((w) => w.includes("viewer.markdown"))).toBe(true);
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
  it("emits the canonical nested shape with all four sections", () => {
    expect(serializeNavigatorSettings(DEFAULT_NAVIGATOR_SETTINGS)).toEqual({
      version: 1,
      images: { mode: "off" },
      icons: { enabled: false },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false },
    });
    expect(serializeNavigatorSettings(fullSettings({ images: { mode: "chafa" }, icons: { enabled: true }, viewer: { wrap: true, markdown: "rendered" }, tree: { showHidden: true } }))).toEqual({
      version: 1,
      images: { mode: "chafa" },
      icons: { enabled: true },
      viewer: { wrap: true, markdown: "rendered" },
      tree: { showHidden: true },
    });
  });

  it("round-trips through the normalizer with no warnings", () => {
    const samples = [
      DEFAULT_NAVIGATOR_SETTINGS,
      fullSettings({ images: { mode: "chafa" } }),
      fullSettings({ icons: { enabled: true }, viewer: { wrap: true, markdown: "rendered" }, tree: { showHidden: true } }),
    ];
    for (const settings of samples) {
      const result = normalizeNavigatorSettings(serializeNavigatorSettings(settings));
      expect(result.settings).toEqual(settings);
      expect(result.warnings).toEqual([]);
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
    expect(result.sources).toEqual(["defaults"]);
  });

  it("warns once on corrupt JSON and falls back to defaults", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ not json !!!", "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0] ?? "").toContain("unreadable");
    expect(result.sources).toEqual(["defaults"]);
  });

  it("loads a valid file and reports its path as the source", () => {
    const path = join(dir, "valid.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "chafa" } })), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.warnings).toEqual([]);
    expect(result.sources).toEqual([path]);
  });

  it("lets the env override beat the file (precedence: defaults ← file ← env)", () => {
    const offFile = join(dir, "file-off.json");
    writeFileSync(offFile, JSON.stringify(fullSettings({ images: { mode: "off" } })), "utf8");
    const enabled = loadNavigatorSettings({ userPath: offFile, env: { images: "chafa" } });
    expect(enabled.settings.images.mode).toBe("chafa");
    expect(enabled.warnings).toEqual([]);
    expect(enabled.sources).toEqual([offFile]);

    const onFile = join(dir, "file-on.json");
    writeFileSync(onFile, JSON.stringify(fullSettings({ images: { mode: "chafa" } })), "utf8");
    const disabled = loadNavigatorSettings({ userPath: onFile, env: { images: "0" } });
    expect(disabled.settings.images.mode).toBe("off");
    expect(disabled.warnings).toEqual([]);
  });

  it("resolves PI_NAV_ICONS precedence inside the loader (file ← env)", () => {
    const offFile = join(dir, "icons-off.json");
    writeFileSync(offFile, JSON.stringify(fullSettings({ icons: { enabled: false } })), "utf8");
    const enabled = loadNavigatorSettings({ userPath: offFile, env: { icons: "1" } });
    expect(enabled.settings.icons.enabled).toBe(true);
    expect(enabled.warnings).toEqual([]);
    expect(enabled.sources).toEqual([offFile]);

    const onFile = join(dir, "icons-on.json");
    writeFileSync(onFile, JSON.stringify(fullSettings({ icons: { enabled: true } })), "utf8");
    const disabled = loadNavigatorSettings({ userPath: onFile, env: { icons: "no" } });
    expect(disabled.settings.icons.enabled).toBe(false);
    expect(disabled.warnings).toEqual([]);
  });

  it("applies the env overrides with no file present", () => {
    const result = loadNavigatorSettings({ userPath: join(dir, "missing.json"), env: { images: "1", icons: "on" } });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.settings.icons.enabled).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.sources).toEqual(["defaults"]);
  });

  it("ignores empty or whitespace env values without a warning", () => {
    const path = join(dir, "file.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "chafa" }, icons: { enabled: false } })), "utf8");
    for (const images of ["", "   ", undefined]) {
      const result = loadNavigatorSettings({ userPath: path, env: { images, icons: "  " } });
      expect(result.settings.images.mode).toBe("chafa");
      expect(result.settings.icons.enabled).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.sources).toEqual([path]);
    }
  });

  it("warns on garbage env and falls back to the file/default setting", () => {
    const path = join(dir, "file.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "off" }, icons: { enabled: false } })), "utf8");
    const result = loadNavigatorSettings({ userPath: path, env: { images: "native", icons: "sometimes" } });
    expect(result.settings.images.mode).toBe("off");
    expect(result.settings.icons.enabled).toBe(false);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0] ?? "").toContain("PI_NAV_IMAGES");
    expect(result.warnings[1] ?? "").toContain("PI_NAV_ICONS");
  });

  it("surfaces normalizer warnings through the loader (version too new)", () => {
    const path = join(dir, "v2.json");
    writeFileSync(path, JSON.stringify({ version: 2, images: { mode: "chafa" } }), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0] ?? "").toContain("newer than this navigator supports");
    expect(result.sources).toEqual([path]);
  });

  it("warns on unknown file keys through the loader", () => {
    const path = join(dir, "unknown.json");
    writeFileSync(path, JSON.stringify({ version: 1, images: { mode: "chafa" }, bogus: true }), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.warnings).toContain('unknown setting "bogus" ignored');
    expect(result.settings.images.mode).toBe("chafa");
  });

  it("falls back from a reserved images.mode with a warning", () => {
    const path = join(dir, "native.json");
    writeFileSync(path, JSON.stringify({ version: 1, images: { mode: "native" } }), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings.images.mode).toBe("off");
    expect(result.warnings.some((w) => w.includes("images.mode"))).toBe(true);
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
    writeNavigatorSettings(path, fullSettings({ images: { mode: "chafa" }, icons: { enabled: true } }));
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual({
      version: 1,
      images: { mode: "chafa" },
      icons: { enabled: true },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false },
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
    expect(result.sources).toEqual([path]);
  });

  it("overwrites an existing file atomically", () => {
    const path = join(dir, "pi-navigator.json");
    writeFileSync(path, JSON.stringify(fullSettings({ images: { mode: "off" } })), "utf8");
    writeNavigatorSettings(path, fullSettings({ images: { mode: "chafa" } }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      images: { mode: "chafa" },
      icons: { enabled: false },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false },
    });
    expect(readdirSync(dir)).toEqual(["pi-navigator.json"]);
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

  it("rejects a bad enum value", () => {
    const result = applyFieldEdit(fullSettings(), "images.mode", "kitty");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("expected one of off, chafa");
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
  });
});

// ── NAVIGATOR_CONFIG_FIELDS sync guard (overseer pattern) ──

describe("NAVIGATOR_CONFIG_FIELDS", () => {
  it("has exactly five entries matching the spec table", () => {
    expect(NAVIGATOR_CONFIG_FIELDS).toHaveLength(5);
    expect(NAVIGATOR_CONFIG_FIELDS[0]).toMatchObject({
      id: "images.mode",
      path: ["images", "mode"],
      kind: "enum",
      section: "Images",
      label: "Image rendering",
      options: ["off", "chafa"],
      live: false,
    });
    expect(NAVIGATOR_CONFIG_FIELDS[1]).toMatchObject({
      id: "icons.enabled",
      path: ["icons", "enabled"],
      kind: "boolean",
      section: "Icons",
      label: "Nerd Font icons",
      live: false,
    });
    expect(NAVIGATOR_CONFIG_FIELDS[2]).toMatchObject({
      id: "viewer.wrap",
      path: ["viewer", "wrap"],
      kind: "boolean",
      section: "Viewer",
      label: "Word wrap",
      live: false,
    });
    expect(NAVIGATOR_CONFIG_FIELDS[3]).toMatchObject({
      id: "viewer.markdown",
      path: ["viewer", "markdown"],
      kind: "enum",
      section: "Viewer",
      label: "Markdown view",
      options: ["code", "rendered"],
      live: false,
    });
    expect(NAVIGATOR_CONFIG_FIELDS[4]).toMatchObject({
      id: "tree.showHidden",
      path: ["tree", "showHidden"],
      kind: "boolean",
      section: "Tree",
      label: "Hidden files",
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
    const modeField = NAVIGATOR_CONFIG_FIELDS[0];
    expect(modeField?.options).toEqual(["off", "chafa"]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "off" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "chafa" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "native" } }).warnings.length).toBeGreaterThan(0);
    const markdownField = NAVIGATOR_CONFIG_FIELDS[3];
    expect(markdownField?.options).toEqual(["code", "rendered"]);
    expect(normalizeNavigatorSettings({ version: 1, viewer: { markdown: "rendered" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, viewer: { markdown: "preview" } }).warnings.length).toBeGreaterThan(0);
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