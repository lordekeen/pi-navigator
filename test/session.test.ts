/**
 * session.ts suites (Issue #140): the extracted overlay data lifecycle, driven
 * entirely through the real `createSession(deps)` interface — poll cadence and
 * backoff, tree stamping on probe change, the per-file viewer cache, per-load
 * abort ownership, the refresh-error dedupe, dispose safety and the v3
 * commit-diff loader.
 *
 * git.ts and tree.ts are mocked: the session's real collaborators do fs
 * walking and spawn git, and the closure wiring under test (probe compare,
 * stamping, backoff, cache, abort) talks to those seams. The image path keeps
 * session.ts's real makeImageSeams; only the expensive resolveImageSupport
 * resolution and the chafa execution are stubbed, and the chafa stub mirrors
 * runChafaRender's pre-spawn abort contract (Issue #117 follow-up).
 *
 * No `as any` into private state (Issue #098 precedent): every observation is
 * a sink call, an injected-loader call, or an injected seam argument.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { MAX_POLL_INTERVAL_MS, REFRESH_INTERVAL_MS } from "../constants";
import type { ImageSupport, KittyProbeVerdict, PiChafaApi } from "../images";
import { DEFAULT_NAVIGATOR_SETTINGS, type NavigatorSettings } from "../settings";
import { makeNavigatorTheme } from "../theme";
import type { CommitDiff, RepoInfo } from "../git";
import { createSession, type NavigatorSession } from "../session";
import type { FileNode, GitState, ViewerFile } from "../types";
import type { LoadFileOptions } from "../viewer";

/** Mutable control state for the mocked git/tree/image collaborators. */
const ctl = vi.hoisted(() => ({
  // node:fs/promises (deterministic stat for the open-file probe)
  fakeStat: null as null | ((path: string) => Promise<{ mtimeMs: number }>),
  // git.ts
  gitState: null as unknown,
  gitError: null as Error | null,
  treeProbe: "",
  tracked: [] as string[],
  gitReads: 0,
  trackedReads: 0,
  commitDiff: null as unknown,
  // tree.ts
  buildCalls: 0,
  codeStamps: 0,
  // images.ts (mocked seams)
  support: "deferred" as "deferred" | "chafa",
  supportResolved: 0,
  chafaCalls: [] as Array<{ path: string; signal: AbortSignal }>,
}));

vi.mock("../git", () => ({
  detectRepo: (): Promise<RepoInfo> => Promise.resolve({ available: true, prefix: "" }),
  readGitState: (_cwd: string, _repo: RepoInfo): Promise<GitState> => {
    ctl.gitReads += 1;
    return ctl.gitError ? Promise.reject(ctl.gitError) : Promise.resolve(ctl.gitState as GitState);
  },
  gitTreeProbe: (): string => ctl.treeProbe,
  gitCodeMap: (git: { unstaged: Array<{ relPath: string; code: string }> }): Map<string, string> =>
    new Map(git.unstaged.map((f) => [f.relPath, f.code])),
  readTrackedFiles: (): Promise<string[]> => {
    ctl.trackedReads += 1;
    return Promise.resolve(ctl.tracked);
  },
  toCwdRelative: (paths: string[], _prefix: string): string[] => [...paths],
  readCommitDiff: (): Promise<CommitDiff> => Promise.resolve(ctl.commitDiff as CommitDiff),
}));

vi.mock("../tree", () => ({
  createTreeWalkBudget: () => ({ truncated: false }),
  entriesFromPaths: (paths: string[]) =>
    paths.map((p) => ({ relPath: p.replace(/\/$/, ""), isDir: p.endsWith("/") })),
  collectDirEntries: () => Promise.resolve([]),
  collectFsEntries: () => Promise.resolve({ entries: [], truncated: false }),
  collectFsProbe: () => Promise.resolve("fs-probe-static"),
  expandedUntrackedDirs: () => new Set<string>(),
  collectExpanded: () => new Set<string>(),
  reapplyExpansion: () => {},
  buildTree: (): FileNode => {
    ctl.buildCalls += 1;
    return {
      name: "",
      lowerName: "",
      path: "/",
      relPath: "",
      lowerRelPath: "",
      isDir: true,
      isSymlink: false,
      hidden: false,
      depth: 0,
      expanded: true,
      subtreeChanged: false,
      children: [],
    };
  },
  applyGitCodes: () => {
    ctl.codeStamps += 1;
  },
}));

vi.mock("../images", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../images")>();
  return {
    ...actual,
    resolveImageSupport: async () => {
      ctl.supportResolved += 1;
      return ctl.support === "deferred"
        ? actual.makeDeferredImageSupport("off")
        : {
            mode: "chafa",
            nativeProtocol: null,
            tier: "chafa",
            piChafa: { present: true, via: "settings" },
            chafa: { state: "ok", binary: "chafa", version: { major: 1, minor: 11 } },
            config: {
              version: 1,
              binaryPath: null,
              cellWidth: 60,
              maxRows: 50,
              colors: "240",
              symbolsSet: "block+border",
              dither: "none",
              timeoutMs: 8000,
              preferNative: true,
            },
            hostShowImages: true,
            hostImageWidthCells: 60,
          };
    },
    runChafaRender: (
      absPath: string,
      _req: { cols: number; rows: number },
      ctx: { binary: string; config: unknown; signal?: AbortSignal },
    ) => {
      // Mirror runChafaRender's pre-spawn abort check (Issue #117 follow-up).
      if (ctx.signal?.aborted) {
        return Promise.resolve({ ok: false as const, reason: "render aborted" });
      }
      ctl.chafaCalls.push({ path: absPath, signal: ctx.signal as AbortSignal });
      // An active render never settles here; supersession and disposal are
      // observed through the recorded signal instead.
      return new Promise<{ ok: true; lines: string[]; cols: number; rows: number } | {
        ok: false;
        reason: string;
      }>(() => {});
    },
  };
});

/**
 * Deterministic stat for the open-file mtime probe (probeOpenFile): the
 * switchable fake replaces fs.stat end-to-end; unset (the default) it
 * delegates to the real implementation so the cache and error-card suites
 * keep exercising the real loader path.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realStat = actual.stat as unknown as (path: string) => Promise<{ mtimeMs: number }>;
  return {
    ...actual,
    stat: ((path: string) =>
      ctl.fakeStat ? ctl.fakeStat(path) : realStat(path)) as typeof actual.stat,
  };
});

// ── Fixtures ──

const settings: NavigatorSettings = { ...DEFAULT_NAVIGATOR_SETTINGS };

/** Identity-styled navigator theme (no ANSI; string identity everywhere). */
const theme = makeNavigatorTheme({
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
} as never);

const fakePi: PiChafaApi = { getAllTools: () => [], getCommands: () => [] };

function makeGitState(overrides: Partial<GitState> = {}): GitState {
  return {
    available: true,
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    unstaged: [{ relPath: "src/a.ts", code: "M" }],
    staged: [],
    history: [{ shortHash: "abc1234", dateRel: "2 hours ago", subject: "fix things" }],
    refreshedAt: 0,
    ...overrides,
  };
}

interface Sink {
  setTree: Mock<(root: FileNode, source: "git" | "fs") => void>;
  setGitState: Mock<(git: GitState) => void>;
  setImageSupport: Mock<(support: ImageSupport) => void>;
  setDiskChanged: Mock<(changed: boolean) => void>;
  getOpenRelPath: Mock<() => string | null>;
  getOpenMtime: Mock<() => number | undefined>;
  requestRender: Mock<() => void>;
}

type LoadFn = (absPath: string, relPath: string, opts?: LoadFileOptions) => Promise<ViewerFile>;

interface Harness {
  session: NavigatorSession;
  sink: Sink;
  notify: Mock<(message: string) => void>;
  notifyWarning: Mock<(message: string) => void>;
  /** The injected viewer primitive (counting, stat-backed like viewer.ts). */
  loadFile: Mock<LoadFn>;
}

/** The image geometry hint the (fake) overlay would pass when opening one. */
const IMAGE_REQ = { cols: 40, rows: 12 };

function makeSession(): Harness {
  const sink: Sink = {
    setTree: vi.fn(),
    setGitState: vi.fn(),
    setImageSupport: vi.fn(),
    setDiskChanged: vi.fn(),
    getOpenRelPath: vi.fn((): string | null => null),
    getOpenMtime: vi.fn((): number | undefined => undefined),
    requestRender: vi.fn(),
  };
  const notify = vi.fn<(message: string) => void>();
  const notifyWarning = vi.fn<(message: string) => void>();

  // Stand-in for viewer.ts's loadFile: records calls and mirrors its mtime
  // reporting so the session's cache keys match a real run.
  const loadFile = vi.fn<LoadFn>(async (absPath, relPath, opts) => {
    if (opts?.image && opts?.renderImage) {
      const out = await opts.renderImage(absPath, {
        cols: opts.image.cols,
        rows: opts.image.rows,
      });
      if (!out.ok) return { kind: "image", relPath, imageError: out.reason, lines: [] };
      return {
        kind: "image",
        relPath,
        imageTier: "chafa",
        imageCols: opts.image.cols,
        imageRows: opts.image.rows,
        imageLines: out.lines,
        lines: [],
        sizeBytes: 16,
        mtimeMs: (await stat(absPath)).mtimeMs,
      };
    }
    let mtimeMs: number | undefined;
    try {
      mtimeMs = (await stat(absPath)).mtimeMs;
    } catch {
      return { kind: "error", relPath, lines: [], message: "nope" }; // no mtimeMs
    }
    return { kind: "text", relPath, sizeBytes: 5, lineCount: 1, lines: ["x"], mtimeMs };
  });

  const session = createSession({
    cwd: dir,
    theme,
    settings,
    imagePaths: {
      userSettings: "/nonexistent/pi-navigator-user.json",
      projectSettings: "/nonexistent/pi-navigator-project.json",
      agentDir: "/nonexistent/pi-navigator-agent",
    },
    loadFile,
    notify,
    notifyWarning,
    kittyProbe: () => Promise.resolve<KittyProbeVerdict>("no-reply"),
    capabilities: () => ({ images: null }),
    pi: fakePi,
    sink,
  });

  return { session, sink, notify, notifyWarning, loadFile };
}

/** Drain the all-microtask refresh chains under fake timers. */
async function flushTicks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await vi.advanceTimersByTimeAsync(1);
}

/** When a recorded setTimeout is due (both `delay` and `at` are virtual ms). */
const dueAt = (record: { delay: number; at: number }): number => record.at + record.delay;

/**
 * Record every setTimeout call the session makes under fake timers.
 * Both the delay and the scheduling moment (virtual clock) are captured, so a
 * test can advance to a timer's exact due time instead of guessing offsets.
 */
interface TimerRecord {
  delay: number;
  at: number;
}

/** Fetch a recorded timer or fail with a clear error (indexed access is `| undefined` under strict). */
function timer(records: TimerRecord[], index: number): TimerRecord {
  const record = records[index];
  if (record === undefined) {
    throw new Error(`no poll timer record #${index} — the session scheduled fewer timers than the test expected`);
  }
  return record;
}

function installTimerLog(): TimerRecord[] {
  const records: TimerRecord[] = [];
  const original = globalThis.setTimeout.bind(null) as (
    fn: () => void,
    delay?: number,
  ) => unknown;
  const spy = vi.spyOn(globalThis, "setTimeout");
  spy.mockImplementation(((fn: () => void, delay?: number) => {
    records.push({ delay: delay ?? 0, at: Date.now() });
    return original(fn, delay);
  }) as unknown as typeof globalThis.setTimeout);
  return records;
}

/** Advance fake time exactly to a target virtual instant. */
async function runUntil(target: number): Promise<void> {
  const delta = target - Date.now();
  if (delta > 0) await vi.advanceTimersByTimeAsync(delta);
}

/** Real-event-loop settle for tests that touch real fs (stat). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-nav-session-"));
  ctl.fakeStat = null;
  ctl.gitState = null;
  ctl.gitError = null;
  ctl.treeProbe = "";
  ctl.tracked = [];
  ctl.gitReads = 0;
  ctl.trackedReads = 0;
  ctl.commitDiff = null;
  ctl.buildCalls = 0;
  ctl.codeStamps = 0;
  ctl.support = "deferred";
  ctl.supportResolved = 0;
  ctl.chafaCalls = [];
});
afterEach(() => {
  vi.useRealTimers();
  rm(dir, { recursive: true, force: true }).catch(() => {});
});

// ── Cases ──
describe("createSession: start + refresh data flow", () => {
  it("performs an initial refresh: git state and tree reach the sink, render is requested", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts", "src/b.ts"];
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    session.start();
    await flushTicks();

    expect(sink.setGitState).toHaveBeenCalledTimes(1);
    expect(sink.setGitState.mock.calls[0]?.[0]).toMatchObject({ branch: "main" });
    expect(sink.setTree).toHaveBeenCalledTimes(1);
    expect(sink.setTree.mock.calls[0]?.[1]).toBe("git");
    expect(sink.requestRender).toHaveBeenCalled();
    expect(ctl.buildCalls).toBe(1); // the first tick built a tree
  });

  it("falls back to the filesystem walk when git is unavailable (source 'fs')", async () => {
    const unavailable = makeGitState({ available: false, error: "not a repo" });
    ctl.gitState = unavailable;
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    session.start();
    await flushTicks();

    expect(sink.setGitState).toHaveBeenCalledWith(unavailable);
    expect(sink.setTree.mock.calls[0]?.[1]).toBe("fs");
    expect(ctl.trackedReads).toBe(0); // no tracked-file walk in fs mode
  });
});

describe("createSession: poll cadence and backoff (Issue #008)", () => {
  it("an idle tick grows the delay by 2000 ms and sticks at MAX_POLL_INTERVAL_MS", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const timers = installTimerLog();
    const { session } = makeSession();
    session.start();
    await flushTicks();
    expect(ctl.gitReads).toBe(1); // initial refresh only

    // Every scheduled gap must be exactly one idle growth step, and each
    // timer must fire at exactly its due time (no earlier, no drifting).
    const expected = [
      REFRESH_INTERVAL_MS, // scheduled by the initial (changed) tick
      5000,
      7000,
      9000,
      MAX_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS, // the cap sticks
    ];
    for (let k = 0; k < expected.length; k += 1) {
      const due = dueAt(timer(timers, k));
      await runUntil(due - 1);
      expect(ctl.gitReads).toBe(1 + k); // not due yet
      await runUntil(due);
      expect(ctl.gitReads).toBe(2 + k); // fired exactly at the recorded gap
    }
    expect(timers.slice(0, expected.length).map((r) => r.delay)).toEqual(expected); // +2000 growth, capped
  });

  it("onActivity resets the delay to REFRESH_INTERVAL_MS", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const timers = installTimerLog();
    const { session } = makeSession();
    session.start();
    await flushTicks();
    // Two idle ticks: 3000 → 5000 (recorded), with the next due 7000 out.
    await runUntil(dueAt(timer(timers, 0)));
    expect(ctl.gitReads).toBe(2);
    expect(timer(timers, 1).delay).toBe(5000); // backoff applied

    session.onActivity();
    // The grown (7000 ms) delay must not fire: the reset base interval wins.
    const reset = timer(timers, 2);
    expect(reset.delay).toBe(REFRESH_INTERVAL_MS);
    await runUntil(dueAt(reset) - 1);
    expect(ctl.gitReads).toBe(2);
    await runUntil(dueAt(reset));
    expect(ctl.gitReads).toBe(3);
    // The abandoned 7000-out timer must have been cleared, not left pending.
    await runUntil(dueAt(timer(timers, 1)) + 1000);
    expect(ctl.gitReads).toBe(3);
  });

  it("a change to the open file on disk resets the delay to REFRESH_INTERVAL_MS", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const timers = installTimerLog();
    const { session, sink } = makeSession();
    session.start();
    await flushTicks();
    // Two idle ticks at the grown gaps.
    await runUntil(dueAt(timer(timers, 0)));
    expect(ctl.gitReads).toBe(2);
    expect(timer(timers, 1).delay).toBe(5000);
    await runUntil(dueAt(timer(timers, 1)));
    expect(ctl.gitReads).toBe(3);
    expect(sink.setDiskChanged).not.toHaveBeenCalledWith(true);

    // The viewer now shows w.txt with a stale known mtime: the next tick
    // detects the disk change and resets the backoff. A deterministic stat
    // fixture replaces the real fs.stat so the tick under fake timers
    // resolves reliably.
    ctl.fakeStat = async () => ({ mtimeMs: 500_000_000 });
    sink.getOpenRelPath.mockReturnValue("w.txt");
    sink.getOpenMtime.mockReturnValue(1); // anything differs from the fixture by ≫ 1 ms
    await runUntil(dueAt(timer(timers, 2)));
    expect(sink.setDiskChanged).toHaveBeenCalledWith(true);
    expect(ctl.gitReads).toBe(4);
    expect(timer(timers, 3).delay).toBe(REFRESH_INTERVAL_MS); // reset applied

    // From now on ticks run at the base interval again.
    await runUntil(dueAt(timer(timers, 3)) - 1);
    expect(ctl.gitReads).toBe(4);
    await runUntil(dueAt(timer(timers, 3)));
    expect(ctl.gitReads).toBe(5);
  });
});

describe("createSession: tree stamping (Issue #022)", () => {
  it("an unchanged probe skips the full walk; a changed probe re-stamps without a rebuild when the entry signature is unchanged", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts", "src/b.ts"];
    vi.useFakeTimers();
    const { session } = makeSession();
    session.start();
    await flushTicks();
    expect(ctl.buildCalls).toBe(1);
    expect(ctl.trackedReads).toBe(1);

    // Idle tick: probe unchanged → no walk, no rebuild, no re-stamp.
    session.refresh();
    await flushTicks();
    expect(ctl.buildCalls).toBe(1);
    expect(ctl.trackedReads).toBe(1);
    expect(ctl.codeStamps).toBe(0);

    // Probe changed but the file set still identical: the walk re-runs and
    // the codes are re-stamped — but the tree keeps its shape (no rebuild).
    ctl.treeProbe = "probe-2";
    session.refresh();
    await flushTicks();
    expect(ctl.trackedReads).toBe(2);
    expect(ctl.buildCalls).toBe(1);
    expect(ctl.codeStamps).toBe(1);

    // A signature-widening probe change rebuilds the tree instead.
    ctl.tracked = ["src/a.ts", "src/b.ts", "src/c.ts"];
    ctl.treeProbe = "probe-3";
    session.refresh();
    await flushTicks();
    expect(ctl.trackedReads).toBe(3);
    expect(ctl.buildCalls).toBe(2);
    expect(ctl.codeStamps).toBe(1); // the build carried the new codes itself
  });
});

describe("createSession: viewer cache (Issue #020)", () => {
  it("two loads of an unchanged file call the loader once; an mtime bump reloads", async () => {
    const path = join(dir, "w.txt");
    await writeFile(path, "hello");
    await utimes(path, 1000000, 1000000); // pin mtime (1e9 ms)
    const { session, loadFile } = makeSession();

    const first = await session.loadFile("w.txt");
    expect(loadFile).toHaveBeenCalledTimes(1);
    const again = await session.loadFile("w.txt");
    expect(loadFile).toHaveBeenCalledTimes(1); // cache hit: loader untouched
    expect(again).toBe(first); // cached ViewerFile object identity

    // Bumping the real file's mtime invalidates the entry.
    await utimes(path, 2000000, 2000000);
    await session.loadFile("w.txt");
    expect(loadFile).toHaveBeenCalledTimes(2);
  });

  it("error cards without an mtime are never retained", async () => {
    const { session, loadFile } = makeSession();
    const gone = await session.loadFile("missing.txt");
    expect(gone.kind).toBe("error");
    await session.loadFile("missing.txt");
    // The stat failed, the error card carries no mtimeMs, and the session
    // keeps no entry: the loader ran again on the second open.
    expect(loadFile).toHaveBeenCalledTimes(2);
    expect(loadFile.mock.calls[1]?.[2]).toBeUndefined();
  });
});

describe("createSession: per-load abort ownership (Issue #117)", () => {
  it("starting a second load aborts the first load's signal, not its own", async () => {
    writeFileSync(join(dir, "img.png"), "png-bytes");
    ctl.support = "chafa";
    ctl.gitState = makeGitState();
    const { session, sink } = makeSession();
    session.refresh();
    await settle();
    expect(sink.setImageSupport).toHaveBeenCalledWith(expect.objectContaining({ tier: "chafa" }));

    void session.loadFile("img.png", { image: IMAGE_REQ });
    await settle();
    void session.loadFile("img.png", { image: IMAGE_REQ });
    await settle();
    expect(ctl.chafaCalls).toHaveLength(2);
    expect(ctl.chafaCalls[0]?.signal.aborted).toBe(true); // superseded load
    expect(ctl.chafaCalls[1]?.signal.aborted).toBe(false); // its own signal
    session.dispose();
  });

  it("dispose aborts an in-flight load's signal", async () => {
    writeFileSync(join(dir, "img.png"), "png-bytes");
    ctl.support = "chafa";
    ctl.gitState = makeGitState();
    const { session } = makeSession();
    session.refresh();
    await settle();

    void session.loadFile("img.png", { image: IMAGE_REQ });
    await settle();
    expect(ctl.chafaCalls).toHaveLength(1);
    expect(ctl.chafaCalls[0]?.signal.aborted).toBe(false);
    session.dispose();
    expect(ctl.chafaCalls[0]?.signal.aborted).toBe(true);
  });
});

describe("createSession: refresh error dedupe", () => {
  it("notifies once per distinct failure message, not once per tick", async () => {
    ctl.gitState = makeGitState();
    ctl.gitError = new Error("boom");
    vi.useFakeTimers();
    const { session, notify, sink } = makeSession();
    session.start();
    await flushTicks();
    session.refresh();
    await flushTicks();
    session.refresh();
    await flushTicks();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("pi-navigator: boom");
    expect(sink.setGitState).not.toHaveBeenCalled(); // the tick failed before any render

    // A new message notifies again; repeating it dedupes once more.
    ctl.gitError = new Error("boom two");
    session.refresh();
    await flushTicks();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith("pi-navigator: boom two");
    session.refresh();
    await flushTicks();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe("createSession: dispose", () => {
  it("stops the poll and is safe to call twice", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    session.start();
    await flushTicks();
    expect(ctl.gitReads).toBe(1);

    session.dispose();
    session.dispose();
    await vi.advanceTimersByTimeAsync(MAX_POLL_INTERVAL_MS * 5);
    expect(ctl.gitReads).toBe(1);
    expect(sink.setGitState).toHaveBeenCalledTimes(1); // no further sink traffic
  });
});

describe("createSession: loadCommit (v3 commit detail)", () => {
  it("returns a styled diff ViewerFile whose relPath is commit:<hash>", async () => {
    const commit: CommitDiff = {
      shortHash: "abc1234",
      parents: ["dead000"],
      // Plain (unstyled) diff lines: session applies the theme, git.ts stays theme-free.
      lines: ["+added", "-removed"],
      filesChanged: 1,
      insertions: 2,
      deletions: 1,
      notice: "commit abc1234 \u00b7 1 file",
      message: { subject: "fix things", body: [] },
    };
    ctl.commitDiff = commit;
    const { session } = makeSession();
    const file = await session.loadCommit("abc1234");

    expect(file.kind).toBe("diff");
    expect(file.relPath).toBe("commit:abc1234");
    expect(file.commitHash).toBe("abc1234");
    expect(file.parents).toEqual(["dead000"]);
    expect(file.notice).toBe(commit.notice);
    // git show style: the subject line, a blank separator, then the diff body.
    expect(file.lines).toEqual(["fix things", "", "+added", "-removed"]);
  });
});
