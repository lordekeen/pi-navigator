/**
 * icons.ts unit suites (Issue #028): the extension→glyph map and the env
 * parser. The parser is the deterministic source of truth for the icon
 * toggle — no auto-detection, per the approved design.
 */

import { describe, expect, it } from "vitest";

import { GENERIC_ICON, mapExtensionToIcon, parseEnableIcons } from "../icons";

describe("parseEnableIcons", () => {
  it("enables on the accepted truthy values", () => {
    expect(parseEnableIcons("1")).toBe(true);
    expect(parseEnableIcons("true")).toBe(true);
    expect(parseEnableIcons("yes")).toBe(true);
    expect(parseEnableIcons("on")).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseEnableIcons(" TRUE ")).toBe(true);
    expect(parseEnableIcons("  On  ")).toBe(true);
  });

  it("disables on unset, empty, and anything else", () => {
    expect(parseEnableIcons(undefined)).toBe(false);
    expect(parseEnableIcons("")).toBe(false);
    expect(parseEnableIcons("0")).toBe(false);
    expect(parseEnableIcons("false")).toBe(false);
    expect(parseEnableIcons("off")).toBe(false);
    expect(parseEnableIcons("2")).toBe(false);
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

  it("maps by lowercase extension, case-insensitively", () => {
    expect(mapExtensionToIcon("Readme.MD", false)).toBe("\uf48a");
    expect(mapExtensionToIcon("Main.TS", false)).toBe("\ue628");
  });

  it("falls back to the generic glyph for unknown/no extension", () => {
    expect(mapExtensionToIcon("file.xyz", false)).toBe(GENERIC_ICON);
    expect(mapExtensionToIcon("Makefile", false)).toBe(GENERIC_ICON);
    expect(mapExtensionToIcon(".env", false)).toBe(GENERIC_ICON);
  });

  it("returns the folder glyph for directories regardless of name", () => {
    expect(mapExtensionToIcon("src", true)).toBe("\uf4d3");
    expect(mapExtensionToIcon("node_modules.tar.gz", true)).toBe("\uf4d3");
  });
});
