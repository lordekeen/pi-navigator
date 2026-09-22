/**
 * git.ts suites: pure porcelain parsing (plan section 11, first bullet) plus a
 * real-git integration pass on a scratch repository — the machine now has git,
 * which the plan's QA log explicitly waited for.
 */

import * as childProcess from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_HIGHLIGHT_BYTES } from "../constants";
import {
  detectRepo,
  gitCodeMap,
  gitRunner,
  gitTreeProbe,
  isGitAvailable,
  parsePorcelain,
  readCommitDiff,
  readGitState,
  readTrackedFiles,
  toCwdRelative,
} from "../git";

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

  it("keeps the trailing slash of an untracked DIRECTORY record (Issue #058)", () => {
    // `git status --porcelain -unormal -z` collapses an entirely untracked
    // directory into a single `?? brandnew/` record; the slash is the only
    // dir marker and must survive parsing for entriesFromPaths to pick up.
    const out = parsePorcelain("?? brandnew/\0", "");
    expect(out.unstaged).toEqual([{ relPath: "brandnew/", code: "??" }]);
    const nested = parsePorcelain("?? src/newdir/\0", "src/");
    expect(nested.unstaged).toEqual([{ relPath: "newdir/", code: "??" }]);
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

  it("skips degenerate records", () => {
    const out = parsePorcelain("\0\0M  a.ts\0", "");
    expect(out.unstaged).toEqual([]);
    expect(out.staged).toEqual([{ relPath: "a.ts", code: "M" }]);
  });
});

describe("toCwdRelative / gitCodeMap / gitTreeProbe", () => {
  it("translates and filters tracked paths", () => {
    expect(toCwdRelative(["src/a.ts", "other/x.ts"], "src/")).toEqual(["a.ts"]);
    expect(toCwdRelative(["a.ts", "b.ts"], "")).toEqual(["a.ts", "b.ts"]);
  });

  it("lets worktree codes win over index codes", () => {
    const state = {
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [{ relPath: "a.ts", code: "M" }],
      staged: [{ relPath: "a.ts", code: "A" }],
      history: [],
      refreshedAt: 0,
    };
    expect(gitCodeMap(state).get("a.ts")).toBe("M");
  });

  it("strips the trailing slash of untracked dir records so the badge lands on the dir row (Issue #058)", () => {
    const state = {
      available: true,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      unstaged: [{ relPath: "brandnew/", code: "??" }],
      staged: [{ relPath: "stageddir/", code: "A" }],
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
      history: [],
      refreshedAt: 0,
    };
    expect(gitTreeProbe(state)).toContain("main 2 1");
    expect(gitTreeProbe(state)).toContain("A a.ts");
    expect(gitTreeProbe(state)).toContain("M b.ts");
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

    const tracked = await readTrackedFiles(repo);
    // ls-files order follows the byte sort; compare as sets.
    expect([...tracked].sort()).toEqual(["line\nbreak.txt", "with space.txt"]);

    const state = await readGitState(repo);
    expect(state.unstaged).toContainEqual({ relPath: "with space.txt", code: "M" });
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

    const tracked = toCwdRelative(await readTrackedFiles(repo), "sub/");
    expect(tracked).toEqual(["a.ts"]);
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

  it("returns the cached git-on-path result without spawning subprocess (Issue #094)", async () => {
    // Two calls to isGitAvailable for the same cwd return the cached result.
    expect(await isGitAvailable(repo)).toBe(true);
    const spy = vi.spyOn(gitRunner, "execFile");
    try {
      expect(await isGitAvailable(repo)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
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

  it("preserves commit subject containing unit separator (Issue #043)", async () => {
    await writeFile(join(repo, "unit.txt"), "unit");
    await commit(repo, "feat\x1fwith\x1fseparator");
    const state = await readGitState(repo);
    expect(state.history[0]?.subject).toBe("feat\x1fwith\x1fseparator");
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

  it("never throws on a bogus hash and degrades cleanly (v3)", async () => {
    const diff = await readCommitDiff(repo, "deadbeef");
    expect(diff.lines).toEqual([]);
    expect(diff.filesChanged).toBe(0);
    expect(diff.notice).toContain("cannot read commit");
  });
});