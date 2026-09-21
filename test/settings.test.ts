/**
 * settings.ts unit suites (§12.1): the versioned settings terrain — typed
 * defaults, the never-throw pure normalizer, the loader with file/env
 * provenance, the canonical serializer, the atomic writer, and the field
 * registry sync guard (pi-overseer pattern). The env override is always
 * passed in explicitly; no test reads or mutates process.env.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_NAVIGATOR_SETTINGS,
  NAVIGATOR_CONFIG_FIELDS,
  loadNavigatorSettings,
  normalizeNavigatorSettings,
  parseImageMode,
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
    const result = normalizeNavigatorSettings({ version: 1, images: { mode: "off" } });
    expect(result.settings).toEqual(DEFAULT_NAVIGATOR_SETTINGS);
    expect(result.warnings).toEqual([]);
  });

  it("accepts images.mode chafa", () => {
    const result = normalizeNavigatorSettings({ version: 1, images: { mode: "chafa" } });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.warnings).toEqual([]);
  });

  it("treats a missing version as 1 without a warning", () => {
    const result = normalizeNavigatorSettings({ images: { mode: "chafa" } });
    expect(result.settings.version).toBe(1);
    expect(result.settings.images.mode).toBe("chafa");
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
  it("emits the canonical nested shape", () => {
    expect(serializeNavigatorSettings(DEFAULT_NAVIGATOR_SETTINGS)).toEqual({ version: 1, images: { mode: "off" } });
    expect(serializeNavigatorSettings({ version: 1, images: { mode: "chafa" } })).toEqual({ version: 1, images: { mode: "chafa" } });
  });

  it("round-trips through the normalizer with no warnings", () => {
    const samples = [
      DEFAULT_NAVIGATOR_SETTINGS,
      { version: 1, images: { mode: "chafa" } } as const,
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
    writeFileSync(path, JSON.stringify({ version: 1, images: { mode: "chafa" } }), "utf8");
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.warnings).toEqual([]);
    expect(result.sources).toEqual([path]);
  });

  it("lets the env override beat the file (precedence: defaults ← file ← env)", () => {
    const offFile = join(dir, "file-off.json");
    writeFileSync(offFile, JSON.stringify({ version: 1, images: { mode: "off" } }), "utf8");
    const enabled = loadNavigatorSettings({ userPath: offFile, env: { images: "chafa" } });
    expect(enabled.settings.images.mode).toBe("chafa");
    expect(enabled.warnings).toEqual([]);
    expect(enabled.sources).toEqual([offFile]);

    const onFile = join(dir, "file-on.json");
    writeFileSync(onFile, JSON.stringify({ version: 1, images: { mode: "chafa" } }), "utf8");
    const disabled = loadNavigatorSettings({ userPath: onFile, env: { images: "0" } });
    expect(disabled.settings.images.mode).toBe("off");
    expect(disabled.warnings).toEqual([]);
  });

  it("applies the env override with no file present", () => {
    const result = loadNavigatorSettings({ userPath: join(dir, "missing.json"), env: { images: "1" } });
    expect(result.settings.images.mode).toBe("chafa");
    expect(result.warnings).toEqual([]);
    expect(result.sources).toEqual(["defaults"]);
  });

  it("ignores empty or whitespace env values without a warning", () => {
    const path = join(dir, "file.json");
    writeFileSync(path, JSON.stringify({ version: 1, images: { mode: "chafa" } }), "utf8");
    for (const images of ["", "   ", undefined]) {
      const result = loadNavigatorSettings({ userPath: path, env: { images } });
      expect(result.settings.images.mode).toBe("chafa");
      expect(result.warnings).toEqual([]);
      expect(result.sources).toEqual([path]);
    }
  });

  it("warns on garbage env and falls back to the file/default setting", () => {
    const path = join(dir, "file.json");
    writeFileSync(path, JSON.stringify({ version: 1, images: { mode: "off" } }), "utf8");
    const result = loadNavigatorSettings({ userPath: path, env: { images: "native" } });
    expect(result.settings.images.mode).toBe("off");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0] ?? "").toContain("PI_NAV_IMAGES");
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
    writeNavigatorSettings(path, { version: 1, images: { mode: "chafa" } });
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { version: number; images: { mode: string } };
    expect(onDisk).toEqual({ version: 1, images: { mode: "chafa" } });
    const entries = readdirSync(join(dir, "nested", "deep"));
    expect(entries).toEqual(["pi-navigator.json"]);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("reading back a written file yields the written settings", () => {
    const path = join(dir, "pi-navigator.json");
    writeNavigatorSettings(path, { version: 1, images: { mode: "chafa" } });
    const result = loadNavigatorSettings({ userPath: path });
    expect(result.settings).toEqual({ version: 1, images: { mode: "chafa" } });
    expect(result.warnings).toEqual([]);
    expect(result.sources).toEqual([path]);
  });

  it("overwrites an existing file atomically", () => {
    const path = join(dir, "pi-navigator.json");
    writeFileSync(path, JSON.stringify({ version: 1, images: { mode: "off" } }), "utf8");
    writeNavigatorSettings(path, { version: 1, images: { mode: "chafa" } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, images: { mode: "chafa" } });
    expect(readdirSync(dir)).toEqual(["pi-navigator.json"]);
  });
});

// ── NAVIGATOR_CONFIG_FIELDS sync guard (overseer pattern) ──

describe("NAVIGATOR_CONFIG_FIELDS", () => {
  it("has exactly one entry describing images.mode", () => {
    expect(NAVIGATOR_CONFIG_FIELDS).toHaveLength(1);
    expect(NAVIGATOR_CONFIG_FIELDS[0]).toMatchObject({
      id: "images.mode",
      path: ["images", "mode"],
      kind: "enum",
      section: "Images",
      label: "Image rendering",
      options: ["off", "chafa"],
      live: false,
    });
    expect((NAVIGATOR_CONFIG_FIELDS[0]?.description.length ?? 0)).toBeGreaterThan(0);
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

  it("enum options equal the normalizer's accepted values and images.mode is not live", () => {
    const field = NAVIGATOR_CONFIG_FIELDS[0];
    expect(field?.options).toEqual(["off", "chafa"]);
    // The registry options must match what the normalizer actually accepts.
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "off" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "chafa" } }).warnings).toEqual([]);
    expect(normalizeNavigatorSettings({ version: 1, images: { mode: "native" } }).warnings.length).toBeGreaterThan(0);
    expect(field?.live).toBe(false);
  });
});