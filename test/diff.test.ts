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
import { composeDiffLines, restyleDiffViewerFile, styleCommitMessage, styleDiffLines } from "../diff";
import type { NavigatorTheme } from "../theme";
import type { ViewerFile } from "../types";

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
  "diffAdded",
  "diffRemoved",
  "diffContext",
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
  // [A-Za-z], not [a-z]: token names are camelCase (`diffAdded`).
  return s.replace(/<\/?[A-Za-z]+>/g, "");
}

describe("styleDiffLines classification", () => {
  it.each([
    ["+++ b/src/a.ts", "muted"], // file header (with space) → muted, not diffAdded
    ["--- a/src/a.ts", "muted"], // file header (with space) → muted, not diffRemoved
    ["+added line", "diffAdded"],
    ["-removed line", "diffRemoved"],
    ["@@ -12,7 +12,8 @@ fn()", "accent"],
    ["diff --git a/src/a.ts b/src/a.ts", "muted"],
    ["index abc1234..def5678 100644", "muted"],
    ["new file mode 100644", "muted"],
    ["deleted file mode 100644", "muted"],
    ["Binary files a/img.png and b/img.png differ", "muted"],
    ["context line stays plain", "diffContext"],
    ["", "diffContext"], // empty string is a context line, not a crash
  ])("classifies %j as %s", (line, token) => {
    const { T } = makeTaggingTheme();
    const out = styleDiffLines([line], T);
    expect(out).toEqual([`<${token}>${line}</${token}>`]);
  });

  it.each([
    ["+++", "diffAdded"], // "+++ " (with space) is the header; bare +++ is an add
    ["---", "diffRemoved"], // same for bare ---
    ["+++", "diffAdded"],
    ["---nospace", "diffRemoved"],
    ["+ +", "diffAdded"], // leading + wins over what follows
    ["@@", "accent"], // bare @@ still a hunk header
    ["@@@ triple", "accent"], // startsWith("@@") is satisfied by @@@
  ])("prefix edge %j → %s", (line, token) => {
    const { T } = makeTaggingTheme();
    const out = styleDiffLines([line], T);
    expect(out).toEqual([`<${token}>${line}</${token}>`]);
  });

  it.each([
    ["a + b", "diffContext"], // + mid-line is not an added line
    ['const x = "-1"', "diffContext"], // - inside a string literal is not a removal
    ["  + indented add", "diffContext"], // classification is leading-character only
    ["@ home", "diffContext"], // @ not followed by @@ is context
    ["diff", "diffContext"], // bare "diff" without trailing space is context
    ["index", "diffContext"],
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
    expect(styled.startsWith("<diffAdded>+"), "first char survives the wrap").toBe(true);
    expect(styled.endsWith("last</diffAdded>"), "last char survives the wrap").toBe(true);
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
      "-gone", // diffRemoved
      "+here", // diffAdded
      "same", // diffContext
    ];
    styleDiffLines(input, T);
    expect([...used].sort()).toEqual(["accent", "diffAdded", "diffContext", "diffRemoved", "muted"].sort());
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

// ── composeDiffLines + restyleDiffViewerFile (Issue #141) ──

describe("composeDiffLines", () => {
  it("puts one blank separator between a non-empty message and a non-empty diff", () => {
    const { T } = makeTaggingTheme();
    const out = composeDiffLines(
      { message: { subject: "the subject", body: ["body line"] }, lines: ["+added", " ctx"] },
      T,
    );
    expect(out).toEqual([
      "<bold>the subject</bold>",
      "<text>body line</text>",
      "",
      "<diffAdded>+added</diffAdded>",
      "<diffContext> ctx</diffContext>",
    ]);
  });

  it("omits the separator when the diff body is empty (message-only commit)", () => {
    const { T } = makeTaggingTheme();
    expect(
      composeDiffLines({ message: { subject: "empty root commit", body: [] }, lines: [] }, T),
    ).toEqual(["<bold>empty root commit</bold>"]);
  });

  it("omits the separator when the message is empty (body-only diff)", () => {
    const { T } = makeTaggingTheme();
    expect(
      composeDiffLines({ message: { subject: "", body: [] }, lines: ["diff --git a/x b/x"] }, T),
    ).toEqual(["<muted>diff --git a/x b/x</muted>"]);
  });

  it("keeps a body-only message above the diff, with the separator", () => {
    const { T } = makeTaggingTheme();
    expect(
      composeDiffLines({ message: { subject: "", body: ["orphan body"] }, lines: ["+x"] }, T),
    ).toEqual(["<text>orphan body</text>", "", "<diffAdded>+x</diffAdded>"]);
  });

  it("returns [] when both parts are empty", () => {
    const { T } = makeTaggingTheme();
    expect(composeDiffLines({ message: { subject: "", body: [] }, lines: [] }, T)).toEqual([]);
  });
});

describe("restyleDiffViewerFile (Issue #141)", () => {
  const diffFile = (key: string): ViewerFile => ({
    kind: "diff",
    relPath: "commit:abc1234",
    commitHash: "abc1234",
    parents: ["dead000"],
    lineCount: 1,
    notice: "commit abc1234",
    lines: ["stale"],
    styleDiff: { message: { subject: "the subject", body: [] }, lines: ["+added"] },
    styleKey: key,
  });

  it("recomposes the lines from styleDiff under a new key, preserving the other fields", () => {
    const { T } = makeTaggingTheme();
    const before = diffFile("key-A");
    const after = restyleDiffViewerFile(before, T, "key-B");
    expect(after).not.toBe(before);
    expect(after.lines).toEqual(["<bold>the subject</bold>", "", "<diffAdded>+added</diffAdded>"]);
    expect(after.styleKey).toBe("key-B");
    expect(after.styleDiff).toBe(before.styleDiff); // retained source untouched
    expect(after.relPath).toBe("commit:abc1234");
    expect(after.commitHash).toBe("abc1234");
    expect(after.parents).toEqual(["dead000"]);
    expect(after.notice).toBe("commit abc1234");
    expect(after.lineCount).toBe(1);
  });

  it("returns the same reference when the key already matches", () => {
    const { T } = makeTaggingTheme();
    const file = diffFile("key-A");
    expect(restyleDiffViewerFile(file, T, "key-A")).toBe(file);
  });

  it("returns the same reference when there is no retained source", () => {
    const { T } = makeTaggingTheme();
    const { styleDiff: _dropped, ...file } = diffFile("key-A");
    expect(restyleDiffViewerFile(file, T, "key-B")).toBe(file);
  });

  it("returns the same reference for a non-diff kind", () => {
    const { T } = makeTaggingTheme();
    const file: ViewerFile = { ...diffFile("key-A"), kind: "text" };
    expect(restyleDiffViewerFile(file, T, "key-B")).toBe(file);
  });

  it("injects no hardcoded ANSI: the fake theme adds tags only", () => {
    const { T } = makeTaggingTheme();
    for (const line of restyleDiffViewerFile(diffFile("key-A"), T, "key-B").lines) {
      expect(line).not.toContain("\x1b");
    }
  });
});
