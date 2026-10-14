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
import { makeNavigatorTheme, makeStyleKey, type NavigatorTheme } from "../theme";

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
  scrollbarTrack: "fg:scrollbarTrack(<x>)",
  scrollbarThumb: "fg:scrollbarThumb(<x>)",
  diffAdded: "fg:toolDiffAdded(<x>)",
  diffRemoved: "fg:toolDiffRemoved(<x>)",
  diffContext: "fg:toolDiffContext(<x>)",
  // The one non-delegating token: a verbatim SGR re-emission (Issue #165).
  // Asserted by its own case below, since it takes two arguments.
  syntax: "\x1b[<x>m<y>\x1b[39m",
};

/** Every delegating token, i.e. all but the two-argument `syntax`. */
const SINGLE_ARG_TOKENS = Object.entries(TOKEN_MAP).filter(([token]) => token !== "syntax");

/** The delegating tokens' call shape: one text argument. */
type SingleArgToken = (text: string) => string;

describe("makeNavigatorTheme token mapping", () => {
  it("re-emits a captured SGR foreground verbatim and resets only the fg", () => {
    const nav = makeNavigatorTheme(makeFakeTheme() as never);
    expect(nav.syntax("38;5;240", "ab")).toBe("\x1b[38;5;240mab\x1b[39m");
    expect(nav.syntax("38;2;1;2;3", "x")).toBe("\x1b[38;2;1;2;3mx\x1b[39m");
    // The reset is fg-only (39), so an enclosing background survives.
    expect(nav.syntax("38;5;2", `bg`)).toBe("\x1b[38;5;2mbg\x1b[39m");
  });

  it.each(SINGLE_ARG_TOKENS)(
    "token %s composes the expected underlying pi theme token(s)",
    (token, expected) => {
      const nav = makeNavigatorTheme(makeFakeTheme() as never);
      expect((nav[token as keyof NavigatorTheme] as SingleArgToken)("<x>")).toBe(expected);
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
      if (token === "searchMatch" || token === "searchCurrent" || token === "syntax") continue;
      expect((nav[token] as SingleArgToken)("")).toBe(TOKEN_MAP[token].replace("<x>", ""));
    }
    // The two-argument pass-through: both inputs flow through unchanged.
    expect(nav.syntax("38;5;240", "")).toBe("\x1b[38;5;240m\x1b[39m");
  });
});

// ── makeStyleKey (Issues #136/#141) ──

/** Stub pi Theme exposing only the surfaces makeStyleKey reads. */
function makeStyleTheme(overrides: { getFgAnsi?: (token: string) => string; getColorMode?: () => string } = {}) {
  return {
    getFgAnsi: (token: string) => `fg:${token}`,
    getColorMode: () => "truecolor",
    ...overrides,
  };
}

/** The theme tokens the retained-content fingerprint covers (Issues #136/#141). */
const VIEWER_TOKENS = [
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "muted",
  "mdCodeBlock",
  "text",
  "accent",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
];

describe("makeStyleKey (Issues #136/#141)", () => {
  it("is stable when the theme's token sequences do not change", () => {
    const key = makeStyleKey(makeStyleTheme() as never);
    expect(key()).toBe(makeStyleKey(makeStyleTheme() as never)());
    expect(key()).toBe(key());
  });

  it("changes when a syntax-token ANSI sequence changes", () => {
    const before = makeStyleKey(makeStyleTheme() as never)();
    const after = makeStyleKey(
      makeStyleTheme({ getFgAnsi: (token) => (token === "syntaxKeyword" ? "fg2:keyword" : `fg:${token}`) }) as never,
    )();
    expect(after).not.toBe(before);
  });

  it("changes when a diff-composer token's ANSI sequence changes (Issue #141)", () => {
    const before = makeStyleKey(makeStyleTheme() as never)();
    const after = makeStyleKey(
      makeStyleTheme({
        getFgAnsi: (token) => (token === "toolDiffAdded" ? "fg2:added" : `fg:${token}`),
      }) as never,
    )();
    expect(after).not.toBe(before);
  });

  it("changes when the color mode changes", () => {
    const before = makeStyleKey(makeStyleTheme() as never)();
    const after = makeStyleKey(makeStyleTheme({ getColorMode: () => "256" }) as never)();
    expect(after).not.toBe(before);
  });

  it("fingerprints every token the retained-content stylers depend on", () => {
    const seen: string[] = [];
    const key = makeStyleKey(
      makeStyleTheme({
        getFgAnsi: (token) => {
          seen.push(token);
          return `fg:${token}`;
        },
      }) as never,
    )();
    expect(seen).toEqual(VIEWER_TOKENS);
    for (const token of VIEWER_TOKENS) expect(key).toContain(`fg:${token}`);
    expect(key).toContain("truecolor");
  });
});
