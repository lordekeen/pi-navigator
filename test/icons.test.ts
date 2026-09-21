/**
 * icons.ts unit suites (Issue #028): the extension→glyph map and the env
 * parser. The parser is the deterministic source of truth for the icon
 * toggle — no auto-detection, per the approved design.
 */

import { describe, expect, it } from "vitest";

import { GENERIC_ICON, mapExtensionToIcon, parseEnableIcons, parseIconMode } from "../icons";

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
});

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

  it("disables on unset, empty, and anything else (compat wrapper over parseIconMode)", () => {
    expect(parseEnableIcons(undefined)).toBe(false);
    expect(parseEnableIcons("")).toBe(false);
    expect(parseEnableIcons("0")).toBe(false);
    expect(parseEnableIcons("false")).toBe(false);
    expect(parseEnableIcons("off")).toBe(false);
    expect(parseEnableIcons("2")).toBe(false);
  });

  it("matches parseIconMode for disable values", () => {
    expect(parseEnableIcons("no")).toBe(parseIconMode("no").enabled ?? false);
    expect(parseEnableIcons("false")).toBe(parseIconMode("false").enabled ?? false);
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
    expect(mapExtensionToIcon("nested/.editorconfig", false)).toBe("\uf461");
    expect(mapExtensionToIcon("Dockerfile", false)).toBe("\uf308");
    expect(mapExtensionToIcon("LICENSE", false)).toBe("\uf718");
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
