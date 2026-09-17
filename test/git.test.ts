/**
 * git.ts suites: pure porcelain parsing (plan section 11, first bullet) plus a
 * real-git integration pass on a scratch repository — the machine now has git,
 * which the plan's QA log explicitly waited for.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectRepo,
  gitCodeMap,
  gitTreeProbe,
  isGitAvailable,
  parsePorcelain,
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

  it("returns the cached git-on-path result", async () => {
    // Two calls to isGitAvailable for the same cwd return the cached result.
    // runGit's ENOENT self-healing (Issue #021) handles the real invalidation
    // path; this test exercises the normal cache-hit branch.
    expect(await isGitAvailable(repo)).toBe(true);
    expect(await isGitAvailable(repo)).toBe(true);
  });
});