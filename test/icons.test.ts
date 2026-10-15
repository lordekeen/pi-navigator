/**
 * icons.ts unit suites (Issue #028): the extension→glyph map and the env
 * parser. The parser is the deterministic source of truth for the icon
 * toggle — no auto-detection, per the approved design.
 */

import { describe, expect, it } from "vitest";

import { GENERIC_ICON, ICON_GLYPHS, mapExtensionToIcon, parseIconMode } from "../icons";

// ── PI_NAV_ICONS truth table (Issue #061) ──

describe("parseIconMode", () => {
  it.each(["1", "true", "yes", "on"])("enables icons for %s", (value) => {
    expect(parseIconMode(value)).toEqual({ enabled: true });
  });

  it.each(["0", "false", "no", "off"])("disables icons for %s", (value) => {
    expect(parseIconMode(value)).toEqual({ enabled: false });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseIconMode(" TRUE ")).toEqual({ enabled: true });
    expect(parseIconMode("  On  ")).toEqual({ enabled: true });
    expect(parseIconMode("OFF")).toEqual({ enabled: false });
    expect(parseIconMode("\tno\n")).toEqual({ enabled: false });
  });

  it("treats undefined, empty, and whitespace as no override, without a warning", () => {
    expect(parseIconMode(undefined)).toEqual({ enabled: undefined });
    expect(parseIconMode("")).toEqual({ enabled: undefined });
    expect(parseIconMode("   ")).toEqual({ enabled: undefined });
  });

  it("rejects garbage with a bounded warning and falls back to the file/default", () => {
    const result = parseIconMode("sometimes");
    expect(result.enabled).toBeUndefined();
    expect(result.warning).toBeDefined();
    expect(result.warning ?? "").toContain("sometimes");
    expect(result.warning ?? "").toContain("PI_NAV_ICONS");
    expect(result.warning ?? "").toContain("file/default");
  });

  it("rejects the images-only chafa token with a warning (no silent enable)", () => {
    expect(parseIconMode("chafa")).toEqual({
      enabled: undefined,
      warning: "chafa is not a valid PI_NAV_ICONS value; using the file/default setting",
    });
  });
});

describe("mapExtensionToIcon", () => {
  it("maps known file extensions to their glyph", () => {
    expect(mapExtensionToIcon("src/main.ts", false)).toBe("\ue628");
    expect(mapExtensionToIcon("src/app.tsx", false)).toBe("\ue7ba");
    expect(mapExtensionToIcon("package.json", false)).toBe("\ue60b");
    expect(mapExtensionToIcon("README.md", false)).toBe("\uf48a");
    expect(mapExtensionToIcon("main.py", false)).toBe("\ue606");
  });

  it("maps special filenames and dotfiles by exact name (Issue #045)", () => {
    expect(mapExtensionToIcon(".gitignore", false)).toBe("\uf1d3");
    expect(mapExtensionToIcon("nested/.editorconfig", false)).toBe("\ue615");
    expect(mapExtensionToIcon("Dockerfile", false)).toBe("\uf308");
    expect(mapExtensionToIcon("LICENSE", false)).toBe("\uf24e");
  });

  it("maps by lowercase extension, case-insensitively", () => {
    expect(mapExtensionToIcon("Readme.MD", false)).toBe("\uf48a");
    expect(mapExtensionToIcon("Main.TS", false)).toBe("\ue628");
  });

  it("falls back to the generic glyph for unknown/no extension", () => {
    expect(mapExtensionToIcon("file.xyz", false)).toBe(GENERIC_ICON);
    expect(mapExtensionToIcon("Makefile", false)).toBe(GENERIC_ICON);
    expect(mapExtensionToIcon(".env", false)).toBe(GENERIC_ICON);
  });

  it("does not impersonate another language's glyph for unmapped languages (Issue #031)", () => {
    // `sol` (Solidity) previously mapped to the TypeScript codepoint by
    // copy-paste; unmapped languages must fall back to the generic glyph
    // rather than borrowing another language's icon.
    expect(mapExtensionToIcon("Token.sol", false)).toBe(GENERIC_ICON);
    expect(mapExtensionToIcon("contract.sol", false)).toBe(GENERIC_ICON);
  });

  it("returns the folder glyph for directories regardless of name", () => {
    expect(mapExtensionToIcon("src", true)).toBe("\uf4d3");
    expect(mapExtensionToIcon("node_modules.tar.gz", true)).toBe("\uf4d3");
  });
});

// ── Nerd Fonts v3 glyph audit (Issue #111) ──

describe("Nerd Fonts v3 glyph audit (Issue #111)", () => {
  it("uses v3-present codepoints for the four slots that rendered as tofu", () => {
    // cs/svg/lock/license were \uf81a/\uf72f/\uf3e2/\uf718 — v2 Material
    // Design Icons codepoints whose ranges Nerd Fonts v3 deleted outright, so
    // they drew nothing on any v3-patched font.
    expect(mapExtensionToIcon("Program.cs", false)).toBe("\ue7b2");
    expect(mapExtensionToIcon("logo.svg", false)).toBe("\ue698");
    expect(mapExtensionToIcon("Gemfile.lock", false)).toBe("\uf023");
    expect(mapExtensionToIcon("LICENSE", false)).toBe("\uf24e");
  });

  it("does not borrow a product logo for images, JavaScript, Vue, or unmapped files", () => {
    // \uf302 is `linux-apple` (the Apple logo), \ue74c is `dev-grunt`,
    // \ue731 is `dev-appwrite`, and the old generic \ue723 was `dev-ansible`.
    expect(mapExtensionToIcon("shot.png", false)).toBe("\uf1c5");
    expect(mapExtensionToIcon("shot.webp", false)).toBe("\uf1c5");
    expect(mapExtensionToIcon("bundle.js", false)).toBe("\ue781");
    expect(mapExtensionToIcon("App.vue", false)).toBe("\ue8dc");
    expect(GENERIC_ICON).toBe("\uf016");
  });

  it("gives yml/yaml, the css family, and toml distinct glyphs", () => {
    expect(mapExtensionToIcon("ci.yml", false)).toBe("\ue6a8");
    expect(mapExtensionToIcon("ci.yaml", false)).toBe("\ue6a8");
    expect(mapExtensionToIcon("package.json", false)).toBe("\ue60b"); // seti-json is json-only again
    expect(mapExtensionToIcon("theme.css", false)).toBe("\ue749");
    expect(mapExtensionToIcon("theme.scss", false)).toBe("\ue74b");
    expect(mapExtensionToIcon("theme.sass", false)).toBe("\ue74b");
    expect(mapExtensionToIcon("theme.less", false)).toBe("\ue758");
    expect(mapExtensionToIcon("Cargo.toml", false)).toBe("\ue6b2");
  });

  it("keeps every glyph out of the v2 Material Design Icons ranges v3 deleted", () => {
    // \uf3e0-\uf3ff and \uf600-\ufdff hold zero glyphs in Nerd Fonts v3
    // (glyphnames.json 3.5.1), so any codepoint there is invisible on a
    // v3-patched font. Guards the class, not just the four slots above.
    for (const glyph of ICON_GLYPHS) {
      const cp = glyph.codePointAt(0) ?? 0;
      const deleted = (cp >= 0xf3e0 && cp <= 0xf3ff) || (cp >= 0xf600 && cp <= 0xfdff);
      expect(deleted, `${glyph} (U+${cp.toString(16)}) sits in a deleted v3 range`).toBe(false);
    }
  });
});
