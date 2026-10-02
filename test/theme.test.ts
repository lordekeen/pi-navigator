/**
 * Direct suite for theme.ts `makeNavigatorTheme` (Issue #063 finding 6).
 *
 * The module's entire behavior is token mapping: each semantic
 * NavigatorTheme token must delegate to the expected pi Theme token, and the
 * optional-token uses (bold, underline — Issue #042) must degrade gracefully
 * instead of throwing. The fake pi Theme composes tagged markers instead of
 * ANSI, so every assertion names the underlying token it must reach.
 */

import { describe, expect, it } from "vitest";
import { makeNavigatorTheme, type NavigatorTheme } from "../theme";

interface FakeTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold?(text: string): string;
  underline?(text: string): string;
  inverse?(text: string): string;
}

function makeFakeTheme(overrides: Partial<FakeTheme> = {}): FakeTheme {
  return {
    fg: (color, text) => `fg:${color}(${text})`,
    bg: (color, text) => `bg:${color}(${text})`,
    bold: (text) => `bold(${text})`,
    underline: (text) => `underline(${text})`,
    inverse: (text) => `inverse(${text})`,
    ...overrides,
  };
}

/**
 * The full token→composition table. Exhaustive over NavigatorTheme by
 * construction: adding a token without a row here fails typecheck, and the
 * test below fails if the mapping changes.
 */
const TOKEN_MAP: Record<keyof NavigatorTheme, string> = {
  accent: "fg:accent(<x>)",
  muted: "fg:muted(<x>)",
  dim: "fg:dim(<x>)",
  success: "fg:success(<x>)",
  warning: "fg:warning(<x>)",
  error: "fg:error(<x>)",
  text: "fg:text(<x>)",
  bold: "bold(<x>)",
  selectedBg: "bg:selectedBg(<x>)",
  searchMatch: "bg:searchMatchBg(fg:searchMatchText(<x>))",
  searchCurrent: "underline(bg:searchMatchBg(fg:searchMatchText(<x>)))",
  frame: "fg:borderMuted(<x>)",
  diffAdded: "fg:toolDiffAdded(<x>)",
  diffRemoved: "fg:toolDiffRemoved(<x>)",
  diffContext: "fg:toolDiffContext(<x>)",
};

describe("makeNavigatorTheme token mapping", () => {
  it.each(Object.entries(TOKEN_MAP))(
    "token %s composes the expected underlying pi theme token(s)",
    (token, expected) => {
      const nav = makeNavigatorTheme(makeFakeTheme() as never);
      expect(nav[token as keyof NavigatorTheme]("<x>")).toBe(expected);
    },
  );

  it("covers every NavigatorTheme key at runtime (no token without a row)", () => {
    const nav = makeNavigatorTheme(makeFakeTheme() as never) as unknown as Record<string, unknown>;
    expect(Object.keys(nav).sort()).toEqual(Object.keys(TOKEN_MAP).sort());
  });
});

describe("makeNavigatorTheme optional-token guards (Issue #042)", () => {
  it("searchCurrent falls back to the searchMatch pair when underline is missing", () => {
    const { underline: _dropped, ...minimal } = makeFakeTheme();
    const nav = makeNavigatorTheme(minimal as never);
    expect(nav.searchCurrent("<x>")).toBe(nav.searchMatch("<x>"));
    expect(nav.searchCurrent("<x>")).toBe("bg:searchMatchBg(fg:searchMatchText(<x>))");
  });

  it("searchCurrent falls back when underline is present but not a function", () => {
    const nav = makeNavigatorTheme(makeFakeTheme({ underline: "not-a-function" as unknown as FakeTheme["underline"] }) as never);
    expect(nav.searchCurrent("<x>")).toBe("bg:searchMatchBg(fg:searchMatchText(<x>))");
  });

  it("underline receives the composed searchMatch string, not the raw text", () => {
    const seen: string[] = [];
    const fake = makeFakeTheme({
      underline: (text) => {
        seen.push(text);
        return `underline(${text})`;
      },
    });
    const nav = makeNavigatorTheme(fake as never);
    nav.searchCurrent("needle");
    expect(seen).toEqual(["bg:searchMatchBg(fg:searchMatchText(needle))"]);
  });

  it("bold falls back to plain text when theme.bold is missing", () => {
    const { bold: _dropped, ...minimal } = makeFakeTheme();
    const nav = makeNavigatorTheme(minimal as never);
    expect(nav.bold("<x>")).toBe("<x>");
  });

  it("bold wraps when theme.bold is present", () => {
    const nav = makeNavigatorTheme(makeFakeTheme() as never);
    expect(nav.bold("<x>")).toBe("bold(<x>)");
  });
});

describe("makeNavigatorTheme composition discipline", () => {
  it("searchMatch reaches the underlying bg/fg tokens rather than hardcoding escapes", () => {
    const nav = makeNavigatorTheme(makeFakeTheme() as never);
    const out = nav.searchMatch("hit");
    expect(out).toContain("fg:searchMatchText(");
    expect(out).toContain("bg:searchMatchBg(");
    expect(out).not.toContain("\x1b");
  });

  it("fg is applied innermost, bg outermost in the search pair", () => {
    const nav = makeNavigatorTheme(makeFakeTheme() as never);
    const out = nav.searchMatch("hit");
    expect(out.startsWith("bg:")).toBe(true);
    expect(out).toMatch(/^bg:searchMatchBg\(fg:searchMatchText\(/);
  });

  it("tokens pass content through unchanged, including the empty string", () => {
    const nav = makeNavigatorTheme(makeFakeTheme() as never);
    for (const token of Object.keys(TOKEN_MAP) as (keyof NavigatorTheme)[]) {
      if (token === "searchMatch" || token === "searchCurrent") continue;
      expect(nav[token]("")).toBe(TOKEN_MAP[token].replace("<x>", ""));
    }
  });
});
