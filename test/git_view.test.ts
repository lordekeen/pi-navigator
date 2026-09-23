/**
 * git_view.ts suites (Issue #064 view-model extraction): the row model
 * (buildGitRows / buildGitNavRows), the header, one row, the commit marker
 * and the status-code text. GitState fixtures are hand-built; the identity
 * theme passes text through for width assertions, and a tone-tagging theme
 * verifies which theme channel a builder used.
 */

import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

import { FAMILY_MAX_ROWS } from "../constants";
import {
  buildGitHeader,
  buildGitNavRows,
  buildGitRow,
  buildGitRows,
  codeText,
  commitMarker,
  type GitHeaderView,
  type GitRowView,
} from "../git_view";
import { makeNavigatorTheme } from "../theme";
import type { GitCommit, GitRow, GitState } from "../types";

const identityTheme = makeNavigatorTheme({
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
} as never);

const toneTheme = makeNavigatorTheme({
  fg: (c: string, t: string) => `${c}:${t}`,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  underline: (t: string) => t,
  inverse: (t: string) => t,
} as never);

function commit(shortHash: string, parents?: string[], subject = `subject ${shortHash}`): GitCommit {
  return { shortHash, parents, dateRel: "2d", subject };
}

function gitState(partial: Partial<GitState> = {}): GitState {
  return {
    available: true,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    unstaged: [],
    staged: [],
    history: [],
    refreshedAt: 0,
    ...partial,
  };
}

function rowView(partial: Partial<GitRowView> = {}): GitRowView {
  return { theme: identityTheme, expanded: new Set<string>(), ...partial };
}

describe("buildGitRows", () => {
  it("unavailable git renders a single dim group with the error label", () => {
    const rows = buildGitRows(gitState({ available: false, error: "not a repo" }), new Set());
    expect(rows).toEqual([{ kind: "group", label: "not a repo", tone: "dim" }]);
    expect(buildGitRows(null, new Set())).toEqual([{ kind: "group", label: "git unavailable", tone: "dim" }]);
  });

  it("renders unstaged/staged groups with file rows plus a History group", () => {
    const rows = buildGitRows(
      gitState({
        unstaged: [
          { relPath: "a.ts", code: "M" },
          { relPath: "b.ts", code: "??" },
        ],
        staged: [{ relPath: "c.ts", code: "A" }],
        history: [commit("abc")],
      }),
      new Set(),
    );
    expect(rows[0]).toEqual({ kind: "group", label: "Unstaged (2)", tone: "warning" });
    expect(rows[1]).toEqual({ kind: "file", relPath: "a.ts", code: "M", staged: false });
    expect(rows[2]).toEqual({ kind: "file", relPath: "b.ts", code: "??", staged: false });
    expect(rows[3]).toEqual({ kind: "group", label: "Staged (1)", tone: "success" });
    expect(rows[4]).toEqual({ kind: "file", relPath: "c.ts", code: "A", staged: true });
    expect(rows[5]).toEqual({ kind: "group", label: "History (1)", tone: "muted" });
    expect(rows[6]).toEqual({ kind: "commit", commit: expect.objectContaining({ shortHash: "abc" }) });
  });

  it("shows a dim Clean row when both change lists are empty", () => {
    const rows = buildGitRows(gitState(), new Set());
    expect(rows[0]).toEqual({ kind: "group", label: "Clean \u2014 nothing staged or unstaged", tone: "dim" });
  });

  it("shows the status error as a warning group row instead of Clean (Issue #107)", () => {
    const rows = buildGitRows(
      gitState({ error: "git status failed \u2014 changes not listed (press r to retry)" }),
      new Set(),
    );
    expect(rows[0]).toEqual({
      kind: "group",
      label: "git status failed \u2014 changes not listed (press r to retry)",
      tone: "warning",
    });
    expect(rows.some((r) => r.kind === "group" && r.label.startsWith("Clean"))).toBe(false);
    // History still follows the error row.
    expect(rows[1]).toEqual({ kind: "group", label: "History (0)", tone: "muted" });
  });

  it("expanding a commit nests its direct parents one level under the anchor", () => {
    const history = [commit("a", ["b"]), commit("b", ["c"]), commit("c")];
    const oneLevel = buildGitRows(gitState({ history }), new Set(["a"]));
    const nested = oneLevel.findIndex((row, i) => i > 0 && row.kind === "commit-child" && row.commit.shortHash === "b");
    expect(nested).toBeGreaterThan(0);
    expect(oneLevel[nested]).toMatchObject({ kind: "commit-child", depth: 1 });
    expect(oneLevel[nested - 1]).toMatchObject({ kind: "commit", commit: { shortHash: "a" } });

    const twoLevels = buildGitRows(gitState({ history }), new Set(["a", "b"]));
    const cRow = twoLevels.find(
      (row): row is Extract<GitRow, { kind: "commit-child" }> => row.kind === "commit-child" && row.commit.shortHash === "c",
    );
    expect(cRow?.depth).toBe(2); // nested under b, which is itself nested under a
  });

  it("emits a dim 'more ancestors' hint row when the family walk hits the cap", () => {
    const parents = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const history = [commit("root", parents), ...parents.map((p) => commit(p))];
    const rows = buildGitRows(gitState({ history }), new Set(["root"]));
    const children = rows.filter((row) => row.kind === "commit-child");
    expect(children).toHaveLength(FAMILY_MAX_ROWS);
    const hints = rows.filter(
      (row) => row.kind === "group" && row.label.startsWith("\u2026 more ancestors"),
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ tone: "dim" });
  });
});

describe("buildGitNavRows", () => {
  it("strips every group row, keeping only cursor-navigable rows", () => {
    const rows = buildGitRows(
      gitState({
        unstaged: [{ relPath: "a.ts", code: "M" }],
        history: [commit("abc")],
      }),
      new Set(),
    );
    const nav = buildGitNavRows(rows);
    expect(nav.every((row) => row.kind !== "group")).toBe(true);
    expect(nav.map((r) => r.kind)).toEqual(["file", "commit"]);
  });
});

describe("buildGitHeader", () => {
  function header(git: GitState | null, focus: "git" | "files" | "viewer" = "git", treeSource: "git" | "fs" | null = "git") {
    const view: GitHeaderView = { theme: identityTheme, focus, git, treeSource };
    return buildGitHeader(30, view);
  }

  it("shows unstaged/staged counters when available", () => {
    const row = header(
      gitState({
        unstaged: [{ relPath: "a.ts", code: "M" }],
        staged: [
          { relPath: "b.ts", code: "A" },
          { relPath: "c.ts", code: "A" },
        ],
      }),
    );
    expect(row).toContain("1 unstaged \u00b7 2 staged");
  });

  it("says 'fs walk' when the tree came from the filesystem fallback", () => {
    expect(header(gitState(), "git", "fs")).toContain("fs walk");
  });

  it("shows the error text when git is unavailable", () => {
    expect(header(gitState({ available: false, error: "no .git here" }))).toContain("no .git here");
  });

  it("shows the status error instead of change counters when available with error (Issue #107)", () => {
    const row = header(gitState({ error: "git status failed \u2014 changes not listed (press r to retry)" }));
    expect(row).toContain("git status failed");
    expect(row).not.toContain("0 unstaged \u00b7 0 staged");
  });
});

describe("buildGitRow", () => {
  const fileRow: GitRow = { kind: "file", relPath: "src/very/long/relative/path/file.ts", code: "M", staged: false };
  const commitRow: GitRow = { kind: "commit", commit: commit("abc1234", ["p"], "a fairly long commit subject line here") };
  const childRow: GitRow = { kind: "commit-child", commit: commit("p999999", ["x"], "nested parent subject"), depth: 2 };
  const groupRow: GitRow = { kind: "group", label: "Unstaged (3)", tone: "warning" };

  it("renders each row kind width-safe at narrow and wide panes", () => {
    for (const leftW of [30, 44]) {
      for (const row of [groupRow, fileRow, commitRow, childRow]) {
        const out = buildGitRow(row, false, leftW, rowView());
        expect(visibleWidth(out)).toBeLessThanOrEqual(leftW);
        const selected = buildGitRow(row, true, leftW, rowView());
        expect(visibleWidth(selected)).toBe(leftW); // selected rows pad to the full pane
      }
    }
  });

  it("indents commit-child rows by two cells per depth level", () => {
    const out = buildGitRow(childRow, false, 44, rowView());
    // identity theme: the leading arrow is two spaces, then 2 spaces per depth
    expect(out.startsWith("  " + "  ".repeat(2))).toBe(true);
    expect(out).toContain("p999999");
  });

  it("keeps a selected commit-child within the pane at depth 3", () => {
    const deep = buildGitRow({ kind: "commit-child", commit: commit("deep", ["x"]), depth: 3 }, true, 30, rowView());
    expect(visibleWidth(deep)).toBe(30);
  });

  it("truncates a long group label to the pane with a visible ellipsis (Issue #113)", () => {
    const errorRow: GitRow = {
      kind: "group",
      label: "git status failed \u2014 changes not listed (press r to retry)",
      tone: "warning",
    };
    for (const leftW of [44, 20, 10, 4, 1]) {
      const out = buildGitRow(errorRow, false, leftW, rowView());
      expect(visibleWidth(out), `width ${leftW}`).toBeLessThanOrEqual(leftW);
    }
    // At widths with room for the cut label the row must end in the fix's
    // ellipsis, not padTo's ragged mid-word cut. Below leftW 3 the pane only
    // fits the leading space, so the ellipsis lands outside the pane.
    for (const leftW of [44, 20, 10, 4]) {
      expect(buildGitRow(errorRow, false, leftW, rowView()), `ellipsis at width ${leftW}`).toContain("\u2026");
    }
  });

  it("leaves a group label that fits the pane untouched, with no ellipsis (Issue #113)", () => {
    const cleanRow: GitRow = { kind: "group", label: "Clean \u2014 nothing staged or unstaged", tone: "dim" };
    const out = buildGitRow(cleanRow, false, 44, rowView());
    expect(out).toBe(" Clean \u2014 nothing staged or unstaged".padEnd(44));
    expect(out).not.toContain("\u2026");
  });
});

describe("commitMarker", () => {
  it("is blank for a root, ▸ collapsed, ▾ expanded", () => {
    const root = commit("r");
    expect(commitMarker(root, new Set())).toBe("  ");
    const parent = commit("p", ["r"]);
    expect(commitMarker(parent, new Set())).toBe("\u25b8 ");
    expect(commitMarker(parent, new Set(["p"]))).toBe("\u25be ");
  });
});

describe("codeText", () => {
  it("routes each status code through the matching theme channel", () => {
    expect(codeText("M", toneTheme)).toBe("warning:M");
    expect(codeText("A", toneTheme)).toBe("success:A");
    expect(codeText("D", toneTheme)).toBe("error:D");
    expect(codeText("??", toneTheme)).toBe("dim:?"); // untracked collapses to "?"
    expect(codeText("!!", toneTheme)).toBe("dim:!"); // ignored collapses to "!"
    expect(codeText("X", toneTheme)).toBe("muted:X"); // unknown falls back to muted
  });
});
