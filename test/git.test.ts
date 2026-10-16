/**
 * git.ts suites: pure porcelain parsing (plan section 11, first bullet) plus a
 * real-git integration pass on a scratch repository — the machine now has git,
 * which the plan's QA log explicitly waited for.
 */

import * as childProcess from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_LINES } from "../constants";
import {
  detectRepo,
  gitCodeMap,
  gitRunner,
  gitTreeProbe,
  parsePorcelain,
  readCommitDiff,
  readGitState,
  readGitTree,
  readIgnoredEntries,
  type RepoInfo,
} from "../git";
import type { GitState } from "../types";

const execFileAsync = promisify(execFile);

// ── Pure parsing ──

describe("parsePorcelain", () => {
  it("splits staged and unstaged changes from -z records", () => {
    const out = parsePorcelain("M  a.ts\0 M b.ts\0MM c.ts\0", "");
    expect(out.staged).toEqual([
      { relPath: "a.ts", code: "M" },
      { relPath: "c.ts", code: "M" },
    ]);
    expect(out.unstaged).toEqual([
      { relPath: "b.ts", code: "M" },
      { relPath: "c.ts", code: "M" },
    ]);
  });

  it("treats ?? entries as untracked in the unstaged list", () => {
    const out = parsePorcelain("?? new.txt\0?? dir/other.txt\0", "");
    expect(out.staged).toEqual([]);
    expect(out.unstaged).toEqual([
      { relPath: "new.txt", code: "??" },
      { relPath: "dir/other.txt", code: "??" },
    ]);
  });

  it("normalizes the trailing slash of an untracked DIRECTORY record (Issues #058, #146)", () => {
    // `git status --porcelain -unormal -z` collapses an entirely untracked
    // directory into a single `?? brandnew/` record. The slash is the only
    // dir marker; parsePorcelain — the one production interpretation —
    // strips it and records isDir, so tree entries and badge keys agree.
    const out = parsePorcelain("?? brandnew/\0", "");
    expect(out.unstaged).toEqual([{ relPath: "brandnew", code: "??", isDir: true }]);
    const nested = parsePorcelain("?? src/newdir/\0", "src/");
    expect(nested.unstaged).toEqual([{ relPath: "newdir", code: "??", isDir: true }]);
  });

  it("consumes the trailing source record of a -z rename and keeps the target", () => {
    // git status --porcelain -z emits "R  <target>\0<source>\0".
    const out = parsePorcelain("R  moved.ts\0original.ts\0", "");
    expect(out.staged).toEqual([{ relPath: "moved.ts", code: "R" }]);
    expect(out.unstaged).toEqual([]);
    // The source path must not leak into any list.
    expect(out.staged.some((f) => f.relPath === "original.ts")).toBe(false);
  });

  it("handles a worktree rename (Y = R) the same way", () => {
    const out = parsePorcelain(" R moved.ts\0original.ts\0", "");
    expect(out.staged).toEqual([]);
    expect(out.unstaged).toEqual([{ relPath: "moved.ts", code: "R" }]);
  });

  it("keeps an unmerged XY pair intact in its own list (Issue #202)", () => {
    // Porcelain v1 reports a conflict as a two-character XY code. Reading
    // raw[0]/raw[1] as independent single letters fabricated a staged "U"
    // AND an unstaged "U"; the pair belongs in `unmerged` whole, and
    // nothing may land in the other two lists.
    const { staged, unstaged, unmerged } = parsePorcelain("UU f.txt\0AA g.txt\0DU h.txt\0", "");
    expect(unmerged.map((f) => [f.relPath, f.code])).toEqual([
      ["f.txt", "UU"],
      ["g.txt", "AA"],
      ["h.txt", "DU"],
    ]);
    expect(staged).toEqual([]);
    expect(unstaged).toEqual([]);
  });

  it("still splits a normal MM entry into staged + unstaged (Issue #202)", () => {
    const { staged, unstaged, unmerged } = parsePorcelain("MM c.ts\0", "");
    expect(staged).toEqual([{ relPath: "c.ts", code: "M" }]);
    expect(unstaged).toEqual([{ relPath: "c.ts", code: "M" }]);
    expect(unmerged).toEqual([]);
  });

  it("translates repository-root paths to cwd-relative via the prefix", () => {
    const out = parsePorcelain("M  src/a.ts\0 M src/b.ts\0?? src/new.txt\0", "src/");
    expect(out.staged).toEqual([{ relPath: "a.ts", code: "M" }]);
    expect(out.unstaged).toEqual([
      { relPath: "b.ts", code: "M" },
      { relPath: "new.txt", code: "??" },
    ]);
  });

  it("drops paths outside the cwd prefix", () => {
    const out = parsePorcelain("M  other/b.ts\0 M src/c.ts\0", "src/");
    expect(out.staged).toEqual([]);
    expect(out.unstaged).toEqual([{ relPath: "c.ts", code: "M" }]);
  });

  it("drops a record whose path is not valid UTF-8, in every list (Issue #220)", () => {
    // A latin1 read hands parsePorcelain raw byte strings; a path with an
    // invalid byte is dropped rather than mangled into U+FFFD.
    const bad = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]).toString("latin1");
    const out = parsePorcelain(`M  ${bad}\0 M ${bad}\0?? ${bad}\0UU ${bad}\0`, "");
    expect(out.staged).toEqual([]);
    expect(out.unstaged).toEqual([]);
    expect(out.unmerged).toEqual([]);
  });

  it("still consumes an invalid rename target's source record (Issue #220)", () => {
    const bad = Buffer.from([0xff]).toString("latin1");
    const out = parsePorcelain(`R  moved${bad}.ts\0original.ts\0 M keep.ts\0`, "");
    expect(out.staged).toEqual([]);
    expect(out.unstaged).toEqual([{ relPath: "keep.ts", code: "M" }]);
  });

  it("skips degenerate records", () => {
    const out = parsePorcelain("\0\0M  a.ts\0", "");
    expect(out.unstaged).toEqual([]);
    expect(out.staged).toEqual([{ relPath: "a.ts", code: "M" }]);
  });
});

describe("gitCodeMap / gitTreeProbe", () => {
  it("lets worktree codes win over index codes", () => {
    const state = {
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [{ relPath: "a.ts", code: "M" }],
      staged: [{ relPath: "a.ts", code: "A" }],
      unmerged: [],
      history: [],
      refreshedAt: 0,
    };
    expect(gitCodeMap(state).get("a.ts")).toBe("M");
  });

  it("keys the badge by the normalized relPaths so it lands on the dir row (Issues #058, #146)", () => {
    // parsePorcelain has already stripped the `?? dir/` slash and recorded
    // isDir; the code map takes the relPaths as they are.
    const state = {
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [{ relPath: "brandnew", code: "??", isDir: true }],
      staged: [{ relPath: "stageddir", code: "A" }],
      unmerged: [],
      history: [],
      refreshedAt: 0,
    };
    expect(gitCodeMap(state).get("brandnew")).toBe("??");
    expect(gitCodeMap(state).get("stageddir")).toBe("A");
    expect(gitCodeMap(state).get("brandnew/")).toBeUndefined();
  });

  it("folds branch, counters and file lines into the probe signature", () => {
    const state = {
      available: true,
      branch: "main",
      detached: false,
      ahead: 2,
      behind: 1,
      unstaged: [{ relPath: "b.ts", code: "M" }],
      staged: [{ relPath: "a.ts", code: "A" }],
      unmerged: [],
      history: [],
      refreshedAt: 0,
    };
    expect(gitTreeProbe(state)).toContain("main 2 1");
    expect(gitTreeProbe(state)).toContain("A a.ts");
    expect(gitTreeProbe(state)).toContain("M b.ts");
  });
});

// ── readGitTree: the one git → tree entry path (Issue #146) ──

describe("readGitTree (Issue #146)", () => {
  const INFO: RepoInfo = { available: true, prefix: "" };

  function stateOf(overrides: Partial<GitState> = {}): GitState {
    return {
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [],
      staged: [],
      unmerged: [],
      history: [],
      refreshedAt: 0,
      ...overrides,
    };
  }

  /** Spawn argv of every stubbed invocation, newest stub session first. */
  const spawns: string[][] = [];

  /**
   * Build `ls-files --stage -z` output from records. The mode defaults to a
   * plain blob so callers that only care about paths stay terse (Issue #219).
   */
  function stageOutput(records: Array<{ mode?: string; path: string }>): string {
    return records
      .map((record) => `${record.mode ?? "100644"} 0000000000000000000000000000000000000000 0\t${record.path}\0`)
      .join("");
  }

  /** Stub the entry's `ls-files --stage -z` spawn: emit records, or fail. */
  function stubTracked(records: Array<{ mode?: string; path: string }> | null): void {
    spawns.length = 0;
    vi.spyOn(gitRunner, "execFile").mockImplementation(
      ((
        _file: string,
        args: readonly string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        spawns.push([...args]);
        if (records === null) callback(new Error("ls-files failed"), "", "");
        else callback(null, stageOutput(records), "");
      }) as unknown as typeof gitRunner.execFile,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns ls-files with --full-name so the listing stays repository-root-relative", async () => {
    // The flag is the invariant the prefix translation depends on: without
    // it ls-files is cwd-relative and a subdirectory cwd drops every tracked
    // path (Issue #146).
    stubTracked([{ path: "a.ts" }]);
    await readGitTree("/work", stateOf(), INFO);
    expect(spawns).toEqual([["ls-files", "--stage", "--full-name", "-z"]]);
  });

  it("translates tracked paths through the repo prefix and drops outsiders", async () => {
    stubTracked([{ path: "sub/a.ts" }, { path: "other/x.ts" }]);
    const { entries } = await readGitTree("/work", stateOf(), { available: true, prefix: "sub/" });
    expect(entries).toEqual([{ relPath: "a.ts", isDir: false, symlink: false }]);
  });

  it("merges untracked records after tracked ones, `?? dir/` becoming a slash-free isDir entry", async () => {
    stubTracked([{ path: "a.ts" }]);
    const porcelain = parsePorcelain("?? brandnew/\0?? loose.txt\0", "");
    const { entries } = await readGitTree("/work", stateOf({ unstaged: porcelain.unstaged }), INFO);
    expect(entries).toEqual([
      { relPath: "a.ts", isDir: false, symlink: false },
      { relPath: "brandnew", isDir: true, symlink: false },
      { relPath: "loose.txt", isDir: false, symlink: false },
    ]);
  });

  it("dedupes by relPath with tracked-first precedence", async () => {
    stubTracked([{ path: "dup.ts" }]);
    const { entries } = await readGitTree(
      "/work",
      stateOf({ unstaged: [{ relPath: "dup.ts", code: "??" }] }),
      INFO,
    );
    expect(entries).toEqual([{ relPath: "dup.ts", isDir: false, symlink: false }]);
  });

  it("degrades to untracked-only when ls-files fails, never throwing", async () => {
    stubTracked(null);
    const { entries } = await readGitTree(
      "/work",
      stateOf({ unstaged: [{ relPath: "new.txt", code: "??" }] }),
      INFO,
    );
    expect(entries).toEqual([{ relPath: "new.txt", isDir: false, symlink: false }]);
  });

  it("types a gitlink as a directory and a symlink as a symlink (Issue #219)", async () => {
    // 160000 is a gitlink (a submodule commit object) → the tree shows a
    // directory row; 120000 is a symlink → the `↗` marker; 100644 a plain file.
    stubTracked([
      { mode: "160000", path: "submod" },
      { mode: "120000", path: "link" },
      { mode: "100644", path: "f.txt" },
    ]);
    const { entries } = await readGitTree("/work", stateOf(), INFO);
    expect(entries).toEqual([
      { relPath: "submod", isDir: true, symlink: false },
      { relPath: "link", isDir: false, symlink: true },
      { relPath: "f.txt", isDir: false, symlink: false },
    ]);
  });

  it("drops a tracked path that is not valid UTF-8 and reports the drop (Issue #220)", async () => {
    // git ls-files -z emits the raw filename bytes. Without a strict decode
    // the 0xFF byte came back as U+FFFD, so the tree showed a name the disk
    // does not have and every later lookup for it failed silently.
    const bad = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x74, 0x78, 0x74]).toString("latin1");
    stubTracked([{ path: "good.txt" }, { path: bad }]);
    const { entries, skipped } = await readGitTree("/work", stateOf(), INFO);
    expect(entries).toEqual([{ relPath: "good.txt", isDir: false, symlink: false }]);
    expect(skipped).toBe(1);
  });

  it("reports zero skips for a listing that is entirely valid UTF-8", async () => {
    // The stub feeds what a latin1 read yields: the raw UTF-8 bytes of the
    // name re-read as latin1 ("ümlaut.txt" → "Ã¼mlaut.txt").
    const bytes = Buffer.from("ümlaut.txt", "utf8").toString("latin1");
    stubTracked([{ path: bytes }]);
    const { entries, skipped } = await readGitTree("/work", stateOf(), INFO);
    expect(entries).toEqual([{ relPath: "ümlaut.txt", isDir: false, symlink: false }]);
    expect(skipped).toBe(0);
  });
});

// ── readIgnoredEntries: the one ignored-path listing (Issue #158) ──

describe("readIgnoredEntries (Issue #158)", () => {
  const INFO: RepoInfo = { available: true, prefix: "" };
  /** Spawn argv of every stubbed invocation, newest stub session first. */
  const spawns: string[][] = [];

  /** Stub the listing's spawn: emit NUL-separated records, or fail. */
  function stubIgnored(stdout: string | null): void {
    spawns.length = 0;
    vi.spyOn(gitRunner, "execFile").mockImplementation(
      ((
        _file: string,
        args: readonly string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        spawns.push([...args]);
        if (stdout === null) callback(new Error("ls-files failed"), "", "");
        else callback(null, stdout, "");
      }) as unknown as typeof gitRunner.execFile,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns the ignored listing with --full-name and the documented flags", async () => {
    stubIgnored("");
    await readIgnoredEntries("/work", INFO);
    expect(spawns).toEqual([
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--full-name", "-z"],
    ]);
  });

  it("splits NUL records, drops empties, and normalizes a collapsed dir's trailing slash into isDir", async () => {
    // `--directory` collapses a fully ignored tree into one `dir/` record; the
    // slash is that record's dir marker and becomes isDir at this boundary.
    stubIgnored("ignored.log\0ignored-dir/\0\0nested/thing.txt\0");
    const entries = await readIgnoredEntries("/work", INFO);
    expect(entries).toEqual([
      { relPath: "ignored.log", isDir: false, symlink: false },
      { relPath: "ignored-dir", isDir: true, symlink: false },
      { relPath: "nested/thing.txt", isDir: false, symlink: false },
    ]);
  });

  it("translates through the repo prefix, drops outsiders, and dedupes", async () => {
    stubIgnored("sub/a.log\0other/b.log\0sub/collapsed/\0sub/dup.log\0sub/dup.log\0");
    const entries = await readIgnoredEntries("/work/sub", { available: true, prefix: "sub/" });
    expect(entries).toEqual([
      { relPath: "a.log", isDir: false, symlink: false },
      { relPath: "collapsed", isDir: true, symlink: false },
      { relPath: "dup.log", isDir: false, symlink: false },
    ]);
  });

  it("drops an ignored path that is not valid UTF-8 (Issue #220)", async () => {
    // Ignored records are display-only, so the drop is silent here; readGitTree
    // is what counts drops (for tracked/untracked records).
    const bad = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x6c, 0x6f, 0x67]).toString("latin1");
    stubIgnored(`good.log\0${bad}\0`);
    const entries = await readIgnoredEntries("/work", INFO);
    expect(entries).toEqual([{ relPath: "good.log", isDir: false, symlink: false }]);
  });

  it("degrades to an empty listing on failure or overflow, never throwing", async () => {
    stubIgnored(null);
    expect(await readIgnoredEntries("/work", INFO)).toEqual([]);

    vi.restoreAllMocks();
    vi.spyOn(gitRunner, "execFile").mockImplementation(((...args: any[]) => {
      const error = new Error("maxBuffer exceeded") as Error & { code?: string };
      error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      const callback = args[args.length - 1] as (error: Error, stdout: string, stderr: string) => void;
      callback(error, "", "");
      return {} as any;
    }) as unknown as typeof gitRunner.execFile);
    expect(await readIgnoredEntries("/work", INFO)).toEqual([]);
  });
});

// ── Real git integration ──

describe("git integration on a scratch repository", () => {
  let repo: string;
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Navigator Test",
    GIT_AUTHOR_EMAIL: "navigator@test.local",
    GIT_COMMITTER_NAME: "Navigator Test",
    GIT_COMMITTER_EMAIL: "navigator@test.local",
  };

  async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: gitEnv,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  }

  async function commit(cwd: string, message: string): Promise<void> {
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", message]);
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "pi-nav-git-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.name", "Navigator Test"]);
    await git(repo, ["config", "user.email", "navigator@test.local"]);
    await git(repo, ["config", "status.renames", "true"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("detects the repository and reads a full state", async () => {
    await writeFile(join(repo, "base.txt"), "base\n");
    await commit(repo, "first");

    await writeFile(join(repo, "base.txt"), "changed\n");
    await writeFile(join(repo, "staged.txt"), "new\n");
    await git(repo, ["add", "staged.txt"]);
    await writeFile(join(repo, "untracked.txt"), "??\n");

    const info = await detectRepo(repo);
    expect(info).toMatchObject({ available: true, prefix: "" });

    const state = await readGitState(repo, info);
    expect(state.available).toBe(true);
    expect(state.branch).toBe("main");
    expect(state.detached).toBe(false);
    expect(state.unstaged).toContainEqual({ relPath: "base.txt", code: "M" });
    expect(state.unstaged).toContainEqual({ relPath: "untracked.txt", code: "??" });
    expect(state.staged).toContainEqual({ relPath: "staged.txt", code: "A" });
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.shortHash).toMatch(/^[0-9a-f]{7}$/);
    expect(state.history[0]?.subject).toBe("first");
  });

  it("parses a staged rename against the real -z output", async () => {
    await writeFile(join(repo, "original.ts"), "code\n");
    await commit(repo, "first");
    await git(repo, ["mv", "original.ts", "moved.ts"]);
    await git(repo, ["add", "-u"]);

    const state = await readGitState(repo);
    expect(state.staged).toContainEqual({ relPath: "moved.ts", code: "R" });
    expect(state.staged.some((f) => f.relPath === "original.ts")).toBe(false);
    expect(state.unstaged).toHaveLength(0);
  });

  it("keeps paths with spaces and newlines intact through -z plumbing", async () => {
    await writeFile(join(repo, "with space.txt"), "a\n");
    await writeFile(join(repo, "line\nbreak.txt"), "b\n");
    await commit(repo, "first");
    await writeFile(join(repo, "with space.txt"), "changed\n");

    const info = await detectRepo(repo);
    const state = await readGitState(repo, info);
    const { entries } = await readGitTree(repo, state, info);
    // ls-files order follows the byte sort; compare as sets.
    expect(entries.map((entry) => entry.relPath).sort()).toEqual(["line\nbreak.txt", "with space.txt"]);
    expect(state.unstaged).toContainEqual({ relPath: "with space.txt", code: "M" });
  });

  it("reads a committed symlink's mode from git and marks it a symlink (Issue #219)", async () => {
    // The mode is read from the index (120000), not guessed from the disk, so a
    // broken or relative target still types correctly.
    await writeFile(join(repo, "target.txt"), "real\n");
    await symlink("target.txt", join(repo, "link.txt"));
    await commit(repo, "symlink");

    const info = await detectRepo(repo);
    const state = await readGitState(repo, info);
    const { entries } = await readGitTree(repo, state, info);
    expect(entries).toContainEqual({ relPath: "link.txt", isDir: false, symlink: true });
    expect(entries).toContainEqual({ relPath: "target.txt", isDir: false, symlink: false });
  });

  it("translates paths to the cwd prefix when reading from a subdirectory", async () => {
    await mkdir(join(repo, "sub"), { recursive: true });
    await writeFile(join(repo, "sub/a.ts"), "a\n");
    await writeFile(join(repo, "outside.txt"), "o\n");
    await commit(repo, "first");
    await writeFile(join(repo, "sub/a.ts"), "changed\n");

    const info = await detectRepo(join(repo, "sub"));
    expect(info.available).toBe(true);
    expect(info.prefix).toBe("sub/");

    const state = await readGitState(join(repo, "sub"), info);
    expect(state.unstaged).toEqual([{ relPath: "a.ts", code: "M" }]);

    // The real subdirectory cwd is the regression pin: `ls-files --full-name`
    // keeps the listing repository-root-relative, so the prefix translation
    // yields the cwd-relative path instead of dropping it (Issue #146).
    const { entries } = await readGitTree(join(repo, "sub"), state, info);
    expect(entries).toEqual([{ relPath: "a.ts", isDir: false, symlink: false }]);
  });

  it("omits a tracked file whose name is not valid UTF-8 and reports the drop (Issue #220)", async () => {
    // A real repo: git stores the raw 0xFF byte in the index. The tree must
    // omit that record (not show a U+FFFD name no lookup could open) and the
    // count must reach the caller that warns.
    const badPath = Buffer.concat([
      Buffer.from(join(repo, "bad")),
      Buffer.from([0xff]),
      Buffer.from("name.txt"),
    ]);
    await writeFile(badPath, "bad\n");
    await writeFile(join(repo, "good.txt"), "good\n");
    await commit(repo, "first");

    const info = await detectRepo(repo);
    expect(info.available).toBe(true);
    const state = await readGitState(repo, info);
    const { entries, skipped } = await readGitTree(repo, state, info);
    expect(skipped).toBe(1);
    expect(entries).toEqual([{ relPath: "good.txt", isDir: false, symlink: false }]);
  });

  it("reads the prefix from the last line when the repo path itself contains a newline (Issue #204)", async () => {
    // A POSIX repo path may contain a newline. `rev-parse` then prints
    // "<toplevel>\n<prefix>\n" with a multi-line toplevel, so only a
    // last-line parse yields the real prefix instead of a stray segment.
    const parent = await mkdtemp(join(tmpdir(), "pi-nav-newline-"));
    const nested = join(parent, "line\nbreak");
    try {
      await mkdir(join(nested, "sub"), { recursive: true });
      await git(nested, ["init", "-q", "-b", "main"]);
      const info = await detectRepo(join(nested, "sub"));
      expect(info.available).toBe(true);
      expect(info.prefix).toBe("sub/");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("preserves a leading space in a prefix segment (Issue #204)", async () => {
    // `.trim()` used to strip the leading space, so `stripPrefix` could not
    // match and every tracked path below the directory was dropped.
    await mkdir(join(repo, " sp dir"), { recursive: true });
    const info = await detectRepo(join(repo, " sp dir"));
    expect(info.available).toBe(true);
    expect(info.prefix).toBe(" sp dir/");
    // The last-line parse is pinned at the empty end too (repo root).
    expect((await detectRepo(repo)).prefix).toBe("");
  });

  it("reports history subjects and relative dates for the last commits", async () => {
    await writeFile(join(repo, "a.txt"), "1\n");
    await commit(repo, "commit one");
    await writeFile(join(repo, "b.txt"), "2\n");
    await commit(repo, "commit two");

    const state = await readGitState(repo);
    expect(state.history.map((c) => c.subject)).toEqual(["commit two", "commit one"]);
    for (const entry of state.history) {
      expect(entry.shortHash).toMatch(/^[0-9a-f]{7}$/);
      expect(entry.dateRel.length).toBeGreaterThan(0);
    }
  });

  it("carries parent hashes for the commit family tree (Issue #030)", async () => {
    // A merge commit has two parents and the parser must surface both.
    await writeFile(join(repo, "main.txt"), "main\n");
    await commit(repo, "root");
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(join(repo, "feat.txt"), "feat\n");
    await commit(repo, "feature work");
    await git(repo, ["checkout", "-q", "main"]);
    await git(repo, ["merge", "-q", "--no-ff", "feature"]);

    const state = await readGitState(repo);
    const merge = state.history.find((c) => c.subject === "Merge branch 'feature'");
    expect(merge).toBeTruthy();
    // history[0] is the merge; short parents look like 7-hex ids.
    expect(state.history[0]?.parents?.length).toBe(2);
    for (const p of state.history[0]?.parents ?? []) expect(p).toMatch(/^[0-9a-f]{7}$/);
    // Root commit has no parents.
    const root = state.history.find((c) => c.subject === "root");
    expect(root?.parents).toEqual([]);
  });

  it("degrades cleanly outside a repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "pi-nav-no-git-"));
    try {
      const info = await detectRepo(outside);
      expect(info.available).toBe(false);
      const state = await readGitState(outside);
      expect(state.available).toBe(false);
      expect(state.error).toBeTruthy();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports detached HEAD when checked out on a commit (Issue #096)", async () => {
    await writeFile(join(repo, "a.txt"), "hello\n");
    await commit(repo, "first");
    const stateBefore = await readGitState(repo);
    const hash = stateBefore.history[0]?.shortHash;
    expect(hash).toBeDefined();
    await git(repo, ["checkout", "-q", hash!]);
    const state = await readGitState(repo);
    expect(state.available).toBe(true);
    expect(state.detached).toBe(true);
    expect(state.branch).toBeNull();
  });

  it("reports ahead and behind counts relative to upstream (Issue #096)", async () => {
    const remote = await mkdtemp(join(tmpdir(), "pi-nav-remote-"));
    try {
      await git(remote, ["init", "--bare", "-q"]);
      await git(repo, ["remote", "add", "origin", remote]);
      await writeFile(join(repo, "a.txt"), "1\n");
      await commit(repo, "first");
      await git(repo, ["push", "-q", "-u", "origin", "main"]);
      // Add local commit (ahead 1)
      await writeFile(join(repo, "b.txt"), "2\n");
      await commit(repo, "second");
      const state = await readGitState(repo);
      expect(state.ahead).toBe(1);
      expect(state.behind).toBe(0);
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("handles empty repository with no commits gracefully (Issue #096)", async () => {
    const emptyRepo = await mkdtemp(join(tmpdir(), "pi-nav-empty-"));
    try {
      await git(emptyRepo, ["init", "-q", "-b", "main"]);
      const state = await readGitState(emptyRepo);
      expect(state.available).toBe(true);
      expect(state.branch).toBe("main");
      expect(state.history).toEqual([]);
      expect(state.staged).toEqual([]);
      expect(state.unstaged).toEqual([]);
    } finally {
      await rm(emptyRepo, { recursive: true, force: true });
    }
  });

  it("handles buffer overflow gracefully (Issue #096)", async () => {
    const spy = vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      if (gitArgs && gitArgs.includes("status")) {
        const cb = args[args.length - 1];
        const err = new Error("maxBuffer exceeded") as any;
        err.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        cb(err, "", "");
        return {} as any;
      }
      return childProcess.execFile(args[0], args[1], args[2], args[3]);
    });
    try {
      const state = await readGitState(repo);
      expect(state.available).toBe(false);
      expect(state.error).toContain("4 MB buffer");
    } finally {
      spy.mockRestore();
    }
  });

  it("surfaces a failed git status instead of Clean, keeping the state available (Issue #107)", async () => {
    const spy = vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      if (gitArgs && gitArgs.includes("status") && gitArgs.includes("--porcelain")) {
        const cb = args[args.length - 1];
        cb(new Error("index.lock exists"), "", "");
        return {} as any;
      }
      return childProcess.execFile(args[0], args[1], args[2], args[3]);
    });
    try {
      await writeFile(join(repo, "a.txt"), "hello\n");
      await commit(repo, "first");
      const state = await readGitState(repo);
      // Branch/counts/history still valid, but a failed status read never
      // reports the tree as clean.
      expect(state.available).toBe(true);
      expect(state.error).toBe("git status failed \u2014 changes not listed (press r to retry)");
      expect(state.unstaged).toEqual([]);
      expect(state.staged).toEqual([]);
      expect(state.branch).toBe("main");
      expect(state.history.map((c) => c.subject)).toEqual(["first"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("lists ignored paths from the real ignore stack, collapsed dirs included (Issue #158)", async () => {
    await writeFile(join(repo, ".gitignore"), "*.log\nignored-dir/\n");
    await writeFile(join(repo, "tracked.txt"), "t\n");
    // A tracked file matched by an ignore pattern stays tracked (git keeps it)
    // and must never surface in the ignored listing. `git add -A` respects
    // ignore rules, so the force-add is what pins the tracked-but-ignored case.
    await writeFile(join(repo, "kept.log"), "tracked despite *.log\n");
    await git(repo, ["add", "-f", "kept.log"]);
    await commit(repo, "base");
    await mkdir(join(repo, "ignored-dir"), { recursive: true });
    await writeFile(join(repo, "ignored-dir/secret.txt"), "s\n");
    await writeFile(join(repo, "loose.log"), "l\n");
    await mkdir(join(repo, "untracked-dir/nested"), { recursive: true });
    await writeFile(join(repo, "untracked-dir/keep.txt"), "k\n");
    await writeFile(join(repo, "untracked-dir/debug.log"), "d\n");
    await writeFile(join(repo, "untracked-dir/nested/other.log"), "o\n");
    await writeFile(join(repo, ".git/info/exclude"), "excluded.txt\n");
    await writeFile(join(repo, "excluded.txt"), "e\n");

    const info = await detectRepo(repo);
    expect(info.available).toBe(true);
    const entries = await readIgnoredEntries(repo, info);
    expect(entries.map((entry) => `${entry.relPath}${entry.isDir ? "/" : ""}`).sort()).toEqual([
      "excluded.txt",
      "ignored-dir/",
      "loose.log",
      "untracked-dir/debug.log",
      "untracked-dir/nested/",
      "untracked-dir/nested/other.log",
    ]);
    expect(entries.some((entry) => entry.relPath === "kept.log")).toBe(false);

    // --full-name keeps the listing repository-root-relative; the prefix
    // translation yields cwd-relative paths from a subdirectory cwd.
    const subInfo = await detectRepo(join(repo, "untracked-dir"));
    expect(subInfo.prefix).toBe("untracked-dir/");
    const subEntries = await readIgnoredEntries(join(repo, "untracked-dir"), subInfo);
    expect(subEntries.map((entry) => `${entry.relPath}${entry.isDir ? "/" : ""}`).sort()).toEqual([
      "debug.log",
      "nested/",
      "nested/other.log",
    ]);
  });

  // ── readCommitDiff (v3 commit-detail view) ──

  it("counts a binary-only numstat row as one changed file (Issue #106)", async () => {
    const spy = vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      if (gitArgs && gitArgs.includes("--numstat")) {
        const cb = args[args.length - 1];
        cb(null, "-\t-\tassets/logo.png\n", "");
        return {} as any;
      }
      return childProcess.execFile(args[0], args[1], args[2], args[3]);
    });
    try {
      await writeFile(join(repo, "base.txt"), "hello\n");
      await commit(repo, "binary touch");
      const state = await readGitState(repo);
      const diff = await readCommitDiff(repo, state.history[0]!.shortHash);
      // Binary rows count as changed files but contribute 0 insertions/deletions.
      expect(diff.filesChanged).toBe(1);
      expect(diff.insertions).toBe(0);
      expect(diff.deletions).toBe(0);
      expect(diff.notice).toContain("1 file");
    } finally {
      spy.mockRestore();
    }
  });

  it("sums binary and text numstat rows together (Issue #106)", async () => {
    const spy = vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      if (gitArgs && gitArgs.includes("--numstat")) {
        const cb = args[args.length - 1];
        cb(null, "2\t1\tsrc/a.ts\n-\t-\tassets/logo.png\n", "");
        return {} as any;
      }
      return childProcess.execFile(args[0], args[1], args[2], args[3]);
    });
    try {
      await writeFile(join(repo, "base.txt"), "hello\n");
      await commit(repo, "mixed commit");
      const state = await readGitState(repo);
      const diff = await readCommitDiff(repo, state.history[0]!.shortHash);
      // Text rows still contribute counts; binary rows count as files only.
      expect(diff.filesChanged).toBe(2);
      expect(diff.insertions).toBe(2);
      expect(diff.deletions).toBe(1);
      expect(diff.notice).toContain("2 files");
    } finally {
      spy.mockRestore();
    }
  });

  it("reads a single-file commit diff with correct stats (v3)", async () => {
    await writeFile(join(repo, "base.txt"), "line1\n");
    await commit(repo, "first");
    await writeFile(join(repo, "base.txt"), "line1\nline2\n");
    await writeFile(join(repo, "new.txt"), "hello\n");
    await commit(repo, "second");

    const state = await readGitState(repo);
    const second = state.history[0];
    expect(second?.shortHash).toBeDefined();
    const diff = await readCommitDiff(repo, second!.shortHash);

    expect(diff.shortHash).toBe(second!.shortHash);
    expect(diff.parents).toHaveLength(1);
    expect(diff.filesChanged).toBe(2);
    expect(diff.insertions).toBe(2); // 1 added line in base.txt + 1 new file
    expect(diff.deletions).toBe(0);
    // The body carries the per-file diff headers and hunks.
    expect(diff.lines.some((l) => l.startsWith("diff --git"))).toBe(true);
    expect(diff.lines.some((l) => l.startsWith("+hello"))).toBe(true);
    expect(diff.lines.some((l) => l.startsWith("+++ b/new.txt"))).toBe(true);
    expect(diff.notice).toContain(second!.shortHash);
    expect(diff.notice).toContain("+2");
  });

  it("reads a root commit diff (everything added) (v3)", async () => {
    await writeFile(join(repo, "a.txt"), "x\n");
    await writeFile(join(repo, "b.txt"), "y\n");
    await commit(repo, "root");

    const state = await readGitState(repo);
    const root = state.history[0];
    const diff = await readCommitDiff(repo, root!.shortHash);
    expect(diff.parents).toEqual([]);
    expect(diff.filesChanged).toBe(2);
    expect(diff.lines.some((l) => l.startsWith("new file mode"))).toBe(true);
    expect(diff.notice).toMatch(/2 files \u00b7 \+2/);
  });

  it("reads a merge commit diff against its first parent (v3)", async () => {
    await writeFile(join(repo, "main.txt"), "main\n");
    await commit(repo, "root");
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(join(repo, "feat.txt"), "feat\n");
    await commit(repo, "feature work");
    await git(repo, ["checkout", "-q", "main"]);
    await git(repo, ["merge", "-q", "--no-ff", "feature"]);

    const state = await readGitState(repo);
    const merge = state.history[0];
    expect(merge?.parents?.length).toBe(2);
    const diff = await readCommitDiff(repo, merge!.shortHash);
    // The merge's own delta is shown against its first parent: feat.txt added.
    expect(diff.parents).toHaveLength(2);
    expect(diff.filesChanged).toBe(1);
    expect(diff.lines.some((l) => l.startsWith("+feat line") || l.startsWith("+feat"))).toBe(true);
    expect(diff.notice).toMatch(/1 file/);
  });

  it("keeps the full subject text but strips the unit separator at the ingest boundary (Issues #043, #201)", async () => {
    // Issue #043 pinned that the log parser must not TRUNCATE a subject at the
    // field separator; Issue #201 supersedes the raw byte itself. The subject's
    // text survives intact, but the C0 separator byte is stripped at the git
    // boundary so it can never reach a rendered row.
    await writeFile(join(repo, "unit.txt"), "unit");
    await commit(repo, "feat\x1fwith\x1fseparator");
    const state = await readGitState(repo);
    expect(state.history[0]?.subject).toBe("featwithseparator");
    expect(state.history[0]?.subject).not.toContain("\x1f");
  });

  it("caps a commit diff body on BYTES, never splitting a UTF-8 character (Issue #060 finding 5)", async () => {
    // 262145 emoji = 1,048,580 UTF-8 bytes (> the 1 MiB cap) but only 524,290
    // UTF-16 code units — the old `.slice` kept the wrong budget (2 MiB of
    // UTF-8) and could cut a surrogate pair. The cap must hold in bytes and
    // the truncated body must not end on a partial sequence.
    await writeFile(join(repo, "emoji.txt"), "😀".repeat(262145) + "\n");
    await commit(repo, "emoji flood");
    const state = await readGitState(repo);
    const diff = await readCommitDiff(repo, state.history[0]!.shortHash);

    expect(diff.notice).toContain("diff truncated");
    const body = diff.lines.join("\n");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_HIGHLIGHT_BYTES);
    // No partial UTF-8 sequence survived the cut (a split sequence would
    // decode as U+FFFD when re-encoded).
    expect(body).not.toContain("\uFFFD");
  });

  it("truncates commit diff exceeding MAX_HIGHLIGHT_LINES (Issue #036)", async () => {
    const manyLines = Array.from({ length: 5050 }, (_, i) => `${i}`).join("\n");
    await writeFile(join(repo, "many.txt"), manyLines);
    await commit(repo, "many lines");
    const state = await readGitState(repo);
    const diff = await readCommitDiff(repo, state.history[0]!.shortHash);
    expect(diff.lines.length).toBeLessThanOrEqual(5000);
    expect(diff.notice).toContain("diff truncated");
  });

  it("shows a binary notice instead of an unexplained empty body (Issue #187)", async () => {
    const spy = vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      const cb = args[args.length - 1];
      if (
        gitArgs &&
        gitArgs.includes("show") &&
        gitArgs.includes("--first-parent") &&
        !gitArgs.includes("--numstat")
      ) {
        cb(null, "diff --git a/logo.png b/logo.png\n\u0000binary junk\n", "");
        return {} as any;
      }
      return childProcess.execFile(args[0], args[1], args[2], args[3]);
    });
    try {
      await writeFile(join(repo, "base.txt"), "hello\n");
      await commit(repo, "binary body");
      const state = await readGitState(repo);
      const diff = await readCommitDiff(repo, state.history[0]!.shortHash);
      // The binary body is dropped, but the notice explains why.
      expect(diff.lines).toEqual([]);
      expect(diff.notice).toContain("binary diff (not shown)");
      expect(diff.notice).not.toContain("truncated");
    } finally {
      spy.mockRestore();
    }
  });

  it("bounds the composed message + diff array by MAX_HIGHLIGHT_LINES (Issue #187)", async () => {
    const messageBody = Array.from({ length: 4000 }, () => "subject line").join("\n");
    const diffBody = Array.from({ length: 4000 }, (_, i) => `+${i}`).join("\n");
    const spy = vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      const cb = args[args.length - 1];
      if (gitArgs && gitArgs.includes("--pretty=format:%B")) {
        cb(null, `${messageBody}\n`, "");
        return {} as any;
      }
      if (
        gitArgs &&
        gitArgs.includes("show") &&
        gitArgs.includes("--first-parent") &&
        !gitArgs.includes("--numstat")
      ) {
        cb(null, `${diffBody}\n`, "");
        return {} as any;
      }
      return childProcess.execFile(args[0], args[1], args[2], args[3]);
    });
    try {
      await writeFile(join(repo, "base.txt"), "hello\n");
      await commit(repo, "budget");
      const state = await readGitState(repo);
      const diff = await readCommitDiff(repo, state.history[0]!.shortHash);
      // What composeDiffLines builds: subject + message body + separator + diff.
      const subject = diff.message.subject === "" ? 0 : 1;
      const separator = diff.message.body.length > 0 && diff.lines.length > 0 ? 1 : 0;
      const composed = subject + diff.message.body.length + separator + diff.lines.length;
      expect(composed).toBeLessThanOrEqual(MAX_HIGHLIGHT_LINES);
      expect(diff.notice).toContain("diff truncated");
    } finally {
      spy.mockRestore();
    }
  });

  it("never throws on a bogus hash and degrades cleanly (v3)", async () => {
    const diff = await readCommitDiff(repo, "deadbeef");
    expect(diff.lines).toEqual([]);
    expect(diff.filesChanged).toBe(0);
    expect(diff.notice).toContain("cannot read commit");
    // Issue #120: the degraded result carries an empty message too.
    expect(diff.message).toEqual({ subject: "", body: [] });
  });

  // ── Commit message above the diff (Issue #120) ──

  it("returns the subject as message.subject and an empty body for a single-line message (#120)", async () => {
    await writeFile(join(repo, "a.txt"), "x\n");
    await commit(repo, "just a subject");
    const state = await readGitState(repo);
    const diff = await readCommitDiff(repo, state.history[0]!.shortHash);
    expect(diff.message.subject).toBe("just a subject");
    expect(diff.message.body).toEqual([]);
  });

  it("splits a multi-paragraph message into subject and body, trimming trailing blanks (#120)", async () => {
    await writeFile(join(repo, "a.txt"), "x\n");
    // git commit -m joins repeated -m paragraphs with a blank line — the
    // classic subject + body shape, without depending on editor quoting.
    await git(repo, ["commit", "-q", "--allow-empty", "-m", "the subject line", "-m", "first body paragraph", "-m", "second body paragraph"]);
    const state = await readGitState(repo);
    const diff = await readCommitDiff(repo, state.history[0]!.shortHash);
    expect(diff.message.subject).toBe("the subject line");
    expect(diff.message.body).toEqual(["", "first body paragraph", "", "second body paragraph"]);
  });

  it("reports a failed message read as empty, not a crash (#120)", async () => {
    await writeFile(join(repo, "a.txt"), "x\n");
    await commit(repo, "fine");
    const spy = vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      if (gitArgs && gitArgs.includes("--pretty=format:%B")) {
        const cb = args[args.length - 1];
        cb(new Error("msg read failed"), "", "");
        return {} as any;
      }
      return childProcess.execFile(args[0], args[1], args[2], args[3]);
    });
    try {
      const state = await readGitState(repo);
      const diff = await readCommitDiff(repo, state.history[0]!.shortHash);
      expect(diff.message).toEqual({ subject: "", body: [] });
      // The diff itself is untouched.
      expect(diff.filesChanged).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Sanitization at the git ingest boundary (Issue #201) ──

describe("git metadata sanitization at the ingest boundary (Issue #201)", () => {
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  const REPO: RepoInfo = { available: true, prefix: "" };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Stub the four concurrent readGitState spawns with fake stdout. */
  function stubState(stdout: { branch?: string; log?: string }): void {
    vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      const cb = args[args.length - 1];
      if (gitArgs[0] === "branch") cb(null, stdout.branch ?? "main\n", "");
      else if (gitArgs[0] === "rev-list") cb(null, "0\t0\n", "");
      else if (gitArgs[0] === "status") cb(null, "", "");
      else if (gitArgs[0] === "log") cb(null, stdout.log ?? "", "");
      else cb(null, "", "");
      return {} as any;
    });
  }

  it("strips ESC/BEL/NEL from a commit subject parsed out of git log (Issue #201)", async () => {
    stubState({
      log: "abc1234\u001f\u001f2 minutes ago\u001fsubject\u001b[31mRED\u0007\u0085green\u001b]8;;http://x\u0007LINK\n",
    });
    const state = await readGitState("/tmp/pi-nav-unused", REPO);
    expect(state.history[0]?.subject).toBe("subject[31mREDgreen]8;;http://xLINK");
    expect(state.history[0]?.subject).not.toMatch(CONTROL);
  });

  it("strips a control byte from the branch name (Issue #201)", async () => {
    stubState({ branch: "ma\u001bin\n" });
    const state = await readGitState("/tmp/pi-nav-unused", REPO);
    expect(state.branch).toBe("main");
    expect(state.detached).toBe(false);
  });

  it("strips a lone CR from the message subject and escapes from diff lines (Issue #201)", async () => {
    vi.spyOn(gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const gitArgs = args[1] as string[];
      const cb = args[args.length - 1];
      const has = (flag: string): boolean => gitArgs.includes(flag);
      if (has("--verify")) cb(null, "abcdef1234567890\n", "");
      else if (has("--pretty=format:%p")) cb(null, "1111111\n", "");
      else if (has("--pretty=format:%B")) cb(null, "first\rsecond\n", "");
      else if (has("--numstat")) cb(null, "1\t0\tx.txt\n", "");
      else if (has("--first-parent"))
        cb(null, "diff --git a/x.txt b/x.txt\n+\u001b[31mred\u0007line\n+plain\n", "");
      else cb(null, "", "");
      return {} as any;
    });
    const diff = await readCommitDiff("/tmp/pi-nav-unused", "abcdef1");
    expect(diff.message.subject).toBe("first");
    expect(diff.message.subject).not.toContain("\r");
    expect(diff.message.body).toEqual(["second"]);
    expect(diff.lines.length).toBeGreaterThan(0);
    expect(diff.lines.every((line) => !CONTROL.test(line))).toBe(true);
  });
});
