/**
 * git.ts module-state suite (Issue #222). `isGitAvailable` keeps a single
 * process-wide `gitBinaryPresent` verdict with no reset export, so the cases
 * below depend on each other's ordering: #186 must probe while the verdict is
 * still unset, and #047 sets it permanently. Vitest gives each test file its
 * own module registry, so hosting them here keeps that state out of
 * test/git.test.ts's shared module instance and removes the ordering
 * dependency — rather than adding a production `reset` export the viewer
 * never needs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitRunner, isGitAvailable } from "../git";

// ── isGitAvailable's module-level binary verdict (Issues #047, #094, #186) ──

describe("isGitAvailable binary cache", () => {
  let repo: string;

  beforeEach(async () => {
    // A real cwd for the one un-stubbed `git --version` probe in #094; the
    // other two cases stub the spawn entirely.
    repo = await mkdtemp(join(tmpdir(), "pi-nav-git-bin-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
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

  it("does not cache git-missing from an ENOENT whose cwd is gone (Issue #186)", async () => {
    // The verdict is module state with no reset, so drive a fresh module
    // instance instead of the one #094 above already cached as true.
    vi.resetModules();
    const fresh = await import("../git");
    const gone = join(tmpdir(), "pi-nav-gone-186");
    const spy = vi.spyOn(fresh.gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      const err = new Error("spawn git ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      cb(err, "", "");
      return {} as any;
    });
    try {
      // A missing cwd is transient, never cached as "git missing" …
      expect(await fresh.isGitAvailable(gone)).toBe(false);
      // … so the next probe spawns again and can still succeed.
      spy.mockImplementation((...args: any[]) => {
        args[args.length - 1](null, "git version 2.0.0", "");
        return {} as any;
      });
      expect(await fresh.isGitAvailable(repo)).toBe(true);
    } finally {
      spy.mockRestore();
      vi.resetModules();
    }
  });

  it("still caches git-missing when the binary is absent and the cwd exists (Issue #047)", async () => {
    vi.resetModules();
    const fresh = await import("../git");
    const spy = vi.spyOn(fresh.gitRunner, "execFile").mockImplementation((...args: any[]) => {
      const cb = args[args.length - 1];
      const err = new Error("spawn git ENOENT") as Error & { code?: string };
      err.code = "ENOENT";
      cb(err, "", "");
      return {} as any;
    });
    try {
      expect(await fresh.isGitAvailable(tmpdir())).toBe(false);
      spy.mockClear();
      expect(await fresh.isGitAvailable(tmpdir())).toBe(false);
      expect(spy).not.toHaveBeenCalled(); // cached: no further spawn
    } finally {
      spy.mockRestore();
      vi.resetModules();
    }
  });
});
