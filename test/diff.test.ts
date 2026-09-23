/**
 * Direct suite for diff.ts `styleDiffLines` (Issue #063 finding 6).
 *
 * The module is a pure prefix-keyed classifier: git.ts hands it plain lines
 * and it wraps each one in the NavigatorTheme token for its class. These
 * tests pin the classification table (including the meta/file-header forms
 * the implementation actually handles), the edges around prefix detection,
 * and content preservation — styling must wrap, never drop, truncate, or
 * reorder characters.
 */

import { describe, expect, it } from "vitest";
import { styleCommitMessage, styleDiffLines } from "../diff";
import type { NavigatorTheme } from "../theme";

/** Every NavigatorTheme token, each wrapping its input in its own tag. */
const ALL_TOKENS = [
  "accent",
  "muted",
  "dim",
  "success",
  "warning",
  "error",
  "text",
  "bold",
  "selectedBg",
  "searchMatch",
  "searchCurrent",
  "frame",
] as const;

function makeTaggingTheme(): { T: NavigatorTheme; used: Set<string> } {
  const used = new Set<string>();
  const T = {} as NavigatorTheme;
  for (const token of ALL_TOKENS) {
    T[token] = (t: string) => {
      used.add(token);
      return `<${token}>${t}</${token}>`;
    };
  }
  return { T, used };
}

/** Strip the fake theme's tag wrappers so raw content can be compared. */
function stripTagging(s: string): string {
  return s.replace(/<\/?[a-z]+>/g, "");
}

describe("styleDiffLines classification", () => {
  it.each([
    ["+++ b/src/a.ts", "muted"], // file header (with space) → muted, not success
    ["--- a/src/a.ts", "muted"], // file header (with space) → muted, not error
    ["+added line", "success"],
    ["-removed line", "error"],
    ["@@ -12,7 +12,8 @@ fn()", "accent"],
    ["diff --git a/src/a.ts b/src/a.ts", "muted"],
    ["index abc1234..def5678 100644", "muted"],
    ["new file mode 100644", "muted"],
    ["deleted file mode 100644", "muted"],
    ["Binary files a/img.png and b/img.png differ", "muted"],
    ["context line stays plain", "text"],
    ["", "text"], // empty string is a context line, not a crash
  ])("classifies %j as %s", (line, token) => {
    const { T } = makeTaggingTheme();
    const out = styleDiffLines([line], T);
    expect(out).toEqual([`<${token}>${line}</${token}>`]);
  });

  it.each([
    ["+++", "success"], // "+++ " (with space) is the header; bare +++ is an add
    ["---", "error"], // same for bare ---
    ["+++", "success"],
    ["---nospace", "error"],
    ["+ +", "success"], // leading + wins over what follows
    ["@@", "accent"], // bare @@ still a hunk header
    ["@@@ triple", "accent"], // startsWith("@@") is satisfied by @@@
  ])("prefix edge %j → %s", (line, token) => {
    const { T } = makeTaggingTheme();
    const out = styleDiffLines([line], T);
    expect(out).toEqual([`<${token}>${line}</${token}>`]);
  });

  it.each([
    ["a + b", "text"], // + mid-line is not an added line
    ['const x = "-1"', "text"], // - inside a string literal is not a removal
    ["  + indented add", "text"], // classification is leading-character only
    ["@ home", "text"], // @ not followed by @@ is context
    ["diff", "text"], // bare "diff" without trailing space is context
    ["index", "text"],
  ])("does not misclassify %j (stays %s)", (line, token) => {
    const { T } = makeTaggingTheme();
    const out = styleDiffLines([line], T);
    expect(out).toEqual([`<${token}>${line}</${token}>`]);
  });
});

describe("styleDiffLines structure", () => {
  it("returns an empty array for empty input", () => {
    const { T } = makeTaggingTheme();
    expect(styleDiffLines([], T)).toEqual([]);
  });

  it("preserves line count 1:1 and content after stripping tags", () => {
    const { T } = makeTaggingTheme();
    const input = [
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " unchanged",
      "",
    ];
    const out = styleDiffLines(input, T);
    expect(out).toHaveLength(input.length);
    expect(out.map(stripTagging)).toEqual(input);
  });

  it("styling wraps around the whole line: first char and last char survive", () => {
    const { T } = makeTaggingTheme();
    const out = styleDiffLines(["+first++last"], T);
    const styled = out[0] ?? "";
    expect(stripTagging(styled)).toBe("+first++last");
    expect(styled.startsWith("<success>+"), "first char survives the wrap").toBe(true);
    expect(styled.endsWith("last</success>"), "last char survives the wrap").toBe(true);
  });

  it("injects no hardcoded ANSI: the fake theme adds tags only, so any \\x1b in output would come from the module", () => {
    const { T } = makeTaggingTheme();
    const input = ["+++", "---", "+", "-", "@@", "diff x", "index y", "ctx"];
    for (const line of styleDiffLines(input, T)) {
      expect(line).not.toContain("\x1b");
    }
  });

  it("uses exactly the five classifier tokens across a representative diff", () => {
    const { T, used } = makeTaggingTheme();
    const input = [
      "diff --git a/x b/x", // muted
      "--- a/x", // muted
      "+++ b/x", // muted
      "@@ -1 +1 @@", // accent
      "-gone", // error
      "+here", // success
      "same", // text
    ];
    styleDiffLines(input, T);
    expect([...used].sort()).toEqual(["accent", "error", "muted", "success", "text"].sort());
  });
});

// ── styleCommitMessage (Issue #120) ──

describe("styleCommitMessage", () => {
  it("bolds the subject and renders body lines as text", () => {
    const { T, used } = makeTaggingTheme();
    const out = styleCommitMessage({ subject: "the subject", body: ["", "body line"] }, T);
    expect(out).toEqual(["<bold>the subject</bold>", "<text></text>", "<text>body line</text>"]);
    expect([...used].sort()).toEqual(["bold", "text"].sort());
  });

  it("returns [] for an empty message and skips an empty subject with a body", () => {
    const { T } = makeTaggingTheme();
    expect(styleCommitMessage({ subject: "", body: [] }, T)).toEqual([]);
    expect(styleCommitMessage({ subject: "", body: ["orphan body"] }, T)).toEqual([
      "<text>orphan body</text>",
    ]);
  });

  it("preserves body content byte-for-byte after stripping tags", () => {
    const { T } = makeTaggingTheme();
    const body = ["leading blank next", "", "  indented  spaces  ", "+-looks like a diff"];
    const out = styleCommitMessage({ subject: "s", body }, T);
    expect(out.map(stripTagging)).toEqual(["s", ...body]);
  });
});
