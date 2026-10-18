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
 * session.ts's real binding to images.makeImagePipeline; only the expensive
 * resolveImageSupport resolution is stubbed, and the chafa child is captured
 * at node:child_process (the real runChafaRender 
 * pre-spawn abort contract, Issue #117 follow-up, stays exercised).
 *
 * No `as any` into private state (Issue #098 precedent): every observation is
 * a sink call, an injected-loader call, or an injected seam argument.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { IMAGE_RESIZE_DEBOUNCE_MS, MAX_POLL_INTERVAL_MS, REFRESH_INTERVAL_MS } from "../constants";
import type { ImageSupport, KittyProbeVerdict, PiChafaApi } from "../images";
import { DEFAULT_NAVIGATOR_SETTINGS, type NavigatorSettings } from "../settings";
import { makeNavigatorTheme } from "../theme";
import type { CommitDiff, RepoInfo } from "../git";
import { createSession, type NavigatorSession, type SessionDeps } from "../session";
import type { TreeEntry } from "../tree";
import type { FileNode, GitState, OpenTarget, ViewerFile } from "../types";
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
  /** Holds the next `readGitState` open until the test resolves it (single-flight). */
  gitRelease: null as null | Promise<void>,
  trackedReads: 0,
  // git.ts (Issue #220): non-UTF-8 records readGitTree reports as dropped.
  treeSkipped: 0,
  // git.ts (Issue #170): how many times the session asked for repo detection.
  detectReads: 0,
  commitDiff: null as unknown,
  // git.ts (Issue #158)
  ignored: [] as TreeEntry[],
  ignoredReads: 0,
  // tree.ts
  buildCalls: 0,
  codeStamps: 0,
  // tree.ts (Issue #158)
  dirEntries: {} as Record<string, TreeEntry[]>,
  fsEntries: [] as TreeEntry[],
  dirSkips: [] as Array<{ relDir: string; skip: ((relPath: string) => boolean) | undefined }>,
  fsSkips: [] as Array<((relPath: string) => boolean) | undefined>,
  lastBuildEntries: [] as TreeEntry[],
  lastBuildCodes: null as Map<string, string> | null,
  // images.ts (mocked seams)
  support: "deferred" as "deferred" | "chafa" | "native",
  supportResolved: 0,
  /** Makes the harness capabilities accessor throw inside resolveImageSupport (Issue #206). */
  capabilitiesThrow: false,
  chafaCalls: [] as Array<{ path: string; signal: AbortSignal }>,
  /** Releases the captured chafa child callback (null until one is spawned). */
  chafaRelease: null as null | (() => void),
}));

vi.mock("../git", () => ({
  detectRepo: (): Promise<RepoInfo> => {
    ctl.detectReads += 1;
    return Promise.resolve({ available: true, prefix: "" });
  },
  readGitState: (_cwd: string, _repo: RepoInfo): Promise<GitState> => {
    ctl.gitReads += 1;
    if (ctl.gitError) return Promise.reject(ctl.gitError);
    const gate = ctl.gitRelease;
    if (gate !== null) {
      // Armed read: park until the test resolves the deferred (single-flight).
      ctl.gitRelease = null;
      return gate.then(() => ctl.gitState as GitState);
    }
    return Promise.resolve(ctl.gitState as GitState);
  },
  gitTreeProbe: (): string => ctl.treeProbe,
  gitCodeMap: (git: { unstaged: Array<{ relPath: string; code: string }> }): Map<string, string> =>
    new Map(git.unstaged.map((f) => [f.relPath, f.code])),
  readGitTree: (): Promise<{ entries: TreeEntry[]; skipped: number }> => {
    ctl.trackedReads += 1;
    return Promise.resolve({
      entries: ctl.tracked.map((relPath) => ({
        relPath: relPath.replace(/\/$/, ""),
        isDir: relPath.endsWith("/"),
        symlink: false,
      })),
      skipped: ctl.treeSkipped,
    });
  },
  readIgnoredEntries: (): Promise<TreeEntry[]> => {
    ctl.ignoredReads += 1;
    return Promise.resolve(ctl.ignored);
  },
  readCommitDiff: (): Promise<CommitDiff> => Promise.resolve(ctl.commitDiff as CommitDiff),
}));

vi.mock("../tree", () => ({
  createTreeWalkBudget: () => ({ truncated: false }),
  collectDirEntries: (
    _cwd: string,
    relDir: string,
    _budget?: unknown,
    skip?: (relPath: string) => boolean,
  ) => {
    ctl.dirSkips.push({ relDir, skip });
    const entries = ctl.dirEntries[relDir] ?? [];
    return Promise.resolve(entries.filter((entry) => skip === undefined || !skip(entry.relPath)));
  },
  collectFsEntries: (_cwd: string, opts?: { skip?: (relPath: string) => boolean }) => {
    ctl.fsSkips.push(opts?.skip);
    const skip = opts?.skip;
    return Promise.resolve({
      entries: ctl.fsEntries.filter((entry) => skip === undefined || !skip(entry.relPath)),
      truncated: false,
    });
  },
  collectFsProbe: () => Promise.resolve("fs-probe-static"),
  expandedUntrackedDirs: () => new Set<string>(),
  collectExpanded: () => new Set<string>(),
  reapplyExpansion: () => {},
  buildTree: (_cwd: string, entries: TreeEntry[], codes: Map<string, string>): FileNode => {
    ctl.buildCalls += 1;
    ctl.lastBuildEntries = entries;
    ctl.lastBuildCodes = codes;
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
    resolveImageSupport: async (
      _api: PiChafaApi,
      _paths: unknown,
      _settings: unknown,
      deps?: { capabilities?: () => { images: unknown } },
    ) => {
      // The harness's capabilities accessor runs where the real resolver's
      // native ladder would: a throwing one rejects the whole resolution (#206).
      deps?.capabilities?.();
      ctl.supportResolved += 1;
      if (ctl.support === "deferred") return actual.makeDeferredImageSupport("off");
      if (ctl.support === "chafa") {
        return {
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
      }
      // native: strict kitty — a native-only plan (no chafa fallback).
      return {
        mode: "native",
        nativeProtocol: "kitty",
        tier: "native",
        piChafa: { present: false, via: "none" },
        chafa: { state: "deferred" },
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
  };
});

/**
 * The chafa child is captured at node:child_process (Issue #144): the real
 * images.makeImagePipeline and runChafaRender run end to end, and an active
 * render never settles unless a test releases it — supersession and disposal
 * are observed through the recorded signal.
 */
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: ((
      _bin: string,
      args: string[],
      opts: { signal?: AbortSignal },
      cb: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      ctl.chafaCalls.push({ path: args[args.length - 1] ?? "", signal: opts.signal as AbortSignal });
      ctl.chafaRelease = () => cb(null, "\u2588", "");
    }) as unknown as typeof actual.execFile,
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
    unmerged: [],
    history: [{ shortHash: "abc1234", dateRel: "2 hours ago", subject: "fix things" }],
    refreshedAt: 0,
    ...overrides,
  };
}

interface Sink {
  setTree: Mock<(root: FileNode, source: "git" | "fs") => void>;
  setGitState: Mock<(git: GitState) => void>;
  setImageSupport: Mock<(support: ImageSupport) => void>;
  getOpenTarget: Mock<() => OpenTarget | null>;
  checkOpenTarget: Mock<(target: OpenTarget, mtimeMs: number | null) => boolean>;
  getImageView: Mock<() => { rendered: boolean; asCard: boolean } | null>;
  reflowOpenImage: Mock<() => void>;
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

function makeSession(overrides: Partial<SessionDeps> = {}): Harness {
  const sink: Sink = {
    setTree: vi.fn(),
    setGitState: vi.fn(),
    setImageSupport: vi.fn(),
    getOpenTarget: vi.fn<() => OpenTarget | null>(() => null),
    checkOpenTarget: vi.fn<(target: OpenTarget, mtimeMs: number | null) => boolean>(() => false),
    getImageView: vi.fn<() => { rendered: boolean; asCard: boolean } | null>(() => null),
    reflowOpenImage: vi.fn<() => void>(),
    requestRender: vi.fn(),
  };
  const notify = vi.fn<(message: string) => void>();
  const notifyWarning = vi.fn<(message: string) => void>();

  // Stand-in for viewer.ts's loadFile: records calls and mirrors its mtime
  // reporting so the session's cache keys match a real run. The image branch
  // mirrors the loader mapping (Issue #144): one pipeline call, one typed
  // outcome.
  const loadFile = vi.fn<LoadFn>(async (absPath, relPath, opts) => {
    const image = opts?.image;
    const renderer = opts?.imageRenderer;
    if (image !== undefined && renderer !== undefined) {
      const out = await renderer(absPath);
      const mtimeMs = (await stat(absPath)).mtimeMs;
      if (out.kind === "aborted") {
        return {
          kind: "image",
          relPath,
          lines: [],
          sizeBytes: 16,
          mtimeMs,
          imageVerdict: { kind: "card" },
        };
      }
      if (out.kind === "failed") {
        return {
          kind: "image",
          relPath,
          lines: [],
          sizeBytes: 16,
          mtimeMs,
          imageVerdict: { kind: "card", failed: { renderer: out.renderer, detail: out.reason } },
        };
      }
      return {
        kind: "image",
        relPath,
        lines: [],
        sizeBytes: 16,
        mtimeMs,
        imageVerdict: {
          kind: "rendered",
          renderer: out.renderer,
          lines: out.lines,
          cols: out.cols,
          rows: out.rows,
        },
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
    capabilities: () => {
      if (ctl.capabilitiesThrow) throw new Error("capabilities exploded");
      return { images: null };
    },
    pi: fakePi,
    sink,
    ...overrides,
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
  ctl.gitRelease = null;
  ctl.detectReads = 0;
  ctl.trackedReads = 0;
  ctl.treeSkipped = 0;
  ctl.ignored = [];
  ctl.ignoredReads = 0;
  ctl.dirEntries = {};
  ctl.fsEntries = [];
  ctl.dirSkips = [];
  ctl.fsSkips = [];
  ctl.lastBuildEntries = [];
  ctl.lastBuildCodes = null;
  ctl.commitDiff = null;
  ctl.buildCalls = 0;
  ctl.codeStamps = 0;
  ctl.support = "deferred";
  ctl.supportResolved = 0;
  ctl.capabilitiesThrow = false;
  ctl.chafaCalls = [];
  ctl.chafaRelease = null;
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

  it("detects the repository once, retiring the cache on a git failure (Issue #170)", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const timers = installTimerLog();
    const { session } = makeSession();
    session.start();
    await flushTicks();
    expect(ctl.detectReads).toBe(1);

    // Second tick reuses the cached RepoInfo: detection stays at one.
    await runUntil(dueAt(timer(timers, 0)));
    expect(ctl.gitReads).toBe(2);
    expect(ctl.detectReads).toBe(1);

    // A status failure retires the cache (this tick still used it); the next
    // tick re-detects, and a healthy read caches it again (#107 keeps such a
    // state available: true, so the error field is the retirement signal).
    ctl.gitState = makeGitState({ error: "git status failed" });
    await runUntil(dueAt(timer(timers, 1)));
    expect(ctl.detectReads).toBe(1);

    ctl.gitState = makeGitState();
    await runUntil(dueAt(timer(timers, 2)));
    expect(ctl.detectReads).toBe(2);
    await runUntil(dueAt(timer(timers, 3)));
    expect(ctl.detectReads).toBe(2);
  });

  it("drops a tick that fires while the previous refresh is still awaiting git (single-flight, Issue #221)", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const { session, sink } = makeSession();

    // Park the first tick's git read on a deferred: while it is still awaiting
    // git, the session's `inFlight` gate must make the next tick a no-op so the
    // porcelain read can never race itself (Issue #221).
    let releaseGit!: () => void;
    ctl.gitRelease = new Promise<void>((resolve) => {
      releaseGit = resolve;
    });

    session.refresh();
    await flushTicks();
    expect(ctl.gitReads).toBe(1); // the first read is parked

    // A refresh that lands mid-flight is dropped, not queued: exactly one git
    // read, and the sink has nothing from the unfinished tick.
    session.refresh();
    await flushTicks();
    expect(ctl.gitReads).toBe(1);
    expect(sink.setGitState).not.toHaveBeenCalled();

    // Releasing the parked read lands the first tick's state exactly once...
    releaseGit();
    await flushTicks();
    expect(sink.setGitState).toHaveBeenCalledTimes(1);
    expect(sink.setGitState.mock.calls[0]?.[0]).toMatchObject({ branch: "main" });

    // ...and the guard is not sticky: a later tick reads git again.
    session.refresh();
    await flushTicks();
    expect(ctl.gitReads).toBe(2);
    expect(sink.setGitState).toHaveBeenCalledTimes(2);
    session.dispose();
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
    expect(sink.checkOpenTarget).not.toHaveBeenCalled(); // nothing displayed yet

    // The viewer now shows w.txt: the next tick stats it and hands the stat to
    // the sink, whose TRUE verdict (a drifted mtime) resets the backoff. A
    // deterministic stat fixture replaces the real fs.stat so the tick under
    // fake timers resolves reliably.
    ctl.fakeStat = async () => ({ mtimeMs: 500_000_000 });
    const target: OpenTarget = { kind: "file", relPath: "w.txt" };
    sink.getOpenTarget.mockReturnValue(target);
    sink.checkOpenTarget.mockReturnValue(true);
    await runUntil(dueAt(timer(timers, 2)));
    expect(sink.checkOpenTarget).toHaveBeenCalledWith(target, 500_000_000);
    expect(ctl.gitReads).toBe(4);
    expect(timer(timers, 3).delay).toBe(REFRESH_INTERVAL_MS); // reset applied
    // The flag lives in the component behind checkOpenTarget now (#142): the
    // session has no way to write it any more.
    expect("setDiskChanged" in sink).toBe(false);

    // From now on ticks run at the base interval again.
    await runUntil(dueAt(timer(timers, 3)) - 1);
    expect(ctl.gitReads).toBe(4);
    await runUntil(dueAt(timer(timers, 3)));
    expect(ctl.gitReads).toBe(5);
    session.dispose();
  });
});

describe("createSession: open-target disk watch (Issue #142)", () => {
  it("a settle tick stats the displayed target and lets its false verdict drive the idle backoff", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const timers = installTimerLog();
    const { session, sink } = makeSession();
    const target: OpenTarget = { kind: "file", relPath: "w.txt" };
    sink.getOpenTarget.mockReturnValue(target);
    ctl.fakeStat = async () => ({ mtimeMs: 1234 });
    sink.checkOpenTarget.mockReturnValue(false); // unchanged on disk

    session.start();
    await flushTicks();
    await runUntil(dueAt(timer(timers, 0)));
    // The session statted the displayed target and deferred the verdict —
    // mtime comparison and flag are the sink's business now.
    expect(sink.checkOpenTarget).toHaveBeenCalledWith(target, 1234);
    expect(timer(timers, 1).delay).toBe(5000); // false → idle growth
    session.dispose();
  });

  it("a commit target performs no stat and no checkOpenTarget call", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    let statCalls = 0;
    ctl.fakeStat = async () => {
      statCalls += 1;
      return { mtimeMs: 1 };
    };
    sink.getOpenTarget.mockReturnValue({ kind: "commit", hash: "abc1234" });

    session.start();
    await flushTicks();
    // A commit is not a filesystem path: no stat, and the session no longer
    // parses `commit:` out of a display string to notice that.
    expect(statCalls).toBe(0);
    expect(sink.checkOpenTarget).not.toHaveBeenCalled();
    session.dispose();
  });

  it("a stat failure is reported as changed via checkOpenTarget(target, null)", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    const target: OpenTarget = { kind: "file", relPath: "gone.txt" };
    sink.getOpenTarget.mockReturnValue(target);
    ctl.fakeStat = async () => {
      throw new Error("ENOENT");
    };

    session.start();
    await flushTicks();
    expect(sink.checkOpenTarget).toHaveBeenCalledWith(target, null);
    session.dispose();
  });

  it("no displayed target: the probe neither stats nor checks", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const { session, sink } = makeSession(); // getOpenTarget defaults to null
    let statCalls = 0;
    ctl.fakeStat = async () => {
      statCalls += 1;
      return { mtimeMs: 1 };
    };

    session.start();
    await flushTicks();
    expect(statCalls).toBe(0);
    expect(sink.checkOpenTarget).not.toHaveBeenCalled();
    session.dispose();
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

describe("createSession: tree.respectGitignore (Issue #158)", () => {
  const offSettings: NavigatorSettings = {
    ...settings,
    tree: { ...settings.tree, respectGitignore: false },
  };

  it("on (default): the untracked-dir fill drops ignored paths, prunes ignored dirs, and adds no listing read on idle ticks", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["untracked-dir/", "tracked.txt"];
    ctl.ignored = [
      { relPath: "untracked-dir/debug.log", isDir: false, symlink: false },
      { relPath: "untracked-dir/ignored-sub", isDir: true, symlink: false },
    ];
    ctl.dirEntries = {
      "untracked-dir": [
        { relPath: "untracked-dir/keep.txt", isDir: false, symlink: false },
        { relPath: "untracked-dir/debug.log", isDir: false, symlink: false },
        { relPath: "untracked-dir/ignored-sub", isDir: true, symlink: false },
        { relPath: "untracked-dir/ignored-sub/hidden.txt", isDir: false, symlink: false },
      ],
    };
    vi.useFakeTimers();
    const { session } = makeSession();
    session.start();
    await flushTicks();

    // The leak this issue closes: an ignored child of a `??` dir never enters
    // the tree, and an ignored dir prunes its whole subtree.
    const rels = ctl.lastBuildEntries.map((entry) => entry.relPath);
    expect(rels).toHaveLength(3); // untracked-dir, tracked.txt, keep.txt
    expect(rels).toContain("untracked-dir/keep.txt");
    expect(rels).not.toContain("untracked-dir/debug.log");
    expect(rels).not.toContain("untracked-dir/ignored-sub");
    expect(rels).not.toContain("untracked-dir/ignored-sub/hidden.txt");
    // The ignored listing never feeds the badge map when the setting is on.
    expect(ctl.lastBuildCodes?.get("untracked-dir/debug.log")).toBeUndefined();

    // The predicate matches exact paths and ignored-dir prefixes (a collapsed
    // `dir/` record does not enumerate its children).
    const { skip } = ctl.dirSkips[0] ?? {};
    expect(skip?.("untracked-dir/debug.log")).toBe(true);
    expect(skip?.("untracked-dir/ignored-sub/hidden.txt")).toBe(true);
    expect(skip?.("untracked-dir/keep.txt")).toBe(false);

    // One listing read for the changed tick's fill; an idle tick adds none
    // (the default-on path adds no work to the every-tick status read).
    expect(ctl.ignoredReads).toBe(1);
    ctl.ignored = [...ctl.ignored, { relPath: "later.log", isDir: false, symlink: false }];
    session.refresh();
    await flushTicks();
    expect(ctl.buildCalls).toBe(1);
    expect(ctl.ignoredReads).toBe(1);
    session.dispose();
  });

  it("off: merges the ignored listing with !! codes, fills ignored dirs, and dedupes the fill overlap", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["untracked-dir/", "tracked.txt"];
    ctl.ignored = [
      { relPath: "ignored-dir", isDir: true, symlink: false },
      { relPath: "loose.log", isDir: false, symlink: false },
      { relPath: "untracked-dir/debug.log", isDir: false, symlink: false },
      { relPath: "untracked-dir/nested", isDir: true, symlink: false },
    ];
    ctl.dirEntries = {
      "untracked-dir": [
        { relPath: "untracked-dir/keep.txt", isDir: false, symlink: false },
        { relPath: "untracked-dir/debug.log", isDir: false, symlink: false },
        { relPath: "untracked-dir/nested", isDir: true, symlink: false },
        { relPath: "untracked-dir/nested/other.log", isDir: false, symlink: false },
      ],
      "ignored-dir": [{ relPath: "ignored-dir/secret.txt", isDir: false, symlink: false }],
      "untracked-dir/nested": [{ relPath: "untracked-dir/nested/other.log", isDir: false, symlink: false }],
    };
    vi.useFakeTimers();
    const { session, sink } = makeSession({ settings: offSettings });
    session.start();
    await flushTicks();

    // Ignored files and dirs are visible, and ignored dirs are expanded into
    // their children (the fill ran for `!!` dirs too).
    const rels = ctl.lastBuildEntries.map((entry) => entry.relPath);
    for (const rel of [
      "ignored-dir",
      "loose.log",
      "untracked-dir/debug.log",
      "untracked-dir/keep.txt",
      "untracked-dir/nested/other.log",
      "ignored-dir/secret.txt",
    ]) {
      expect(rels).toContain(rel);
    }
    // The listing repeated paths the fill also produced; first occurrence
    // wins, so no relPath reaches buildTree twice (duplicate file rows).
    expect(new Set(rels).size).toBe(rels.length);
    expect(rels.filter((rel) => rel === "untracked-dir/debug.log")).toHaveLength(1);
    expect(rels.filter((rel) => rel === "untracked-dir/nested/other.log")).toHaveLength(1);

    // Only the ignored listing's own entries are badged `!!`; filled children
    // keep the existing no-per-file-code convention.
    for (const rel of ["ignored-dir", "loose.log", "untracked-dir/debug.log", "untracked-dir/nested"]) {
      expect(ctl.lastBuildCodes?.get(rel)).toBe("!!");
    }
    expect(ctl.lastBuildCodes?.get("untracked-dir/keep.txt")).toBeUndefined();
    expect(ctl.lastBuildCodes?.get("ignored-dir/secret.txt")).toBeUndefined();
    expect(ctl.lastBuildCodes?.get("untracked-dir/nested/other.log")).toBeUndefined();

    // `??` dirs and `!!` dirs alike are filled; nothing is skipped when off.
    expect(ctl.dirSkips.map((call) => call.relDir).sort()).toEqual([
      "ignored-dir",
      "untracked-dir",
      "untracked-dir/nested",
    ]);
    for (const call of ctl.dirSkips) expect(call.skip).toBeUndefined();

    // The git panel is untouched: the same state object reaches the sink and
    // ignored records never enter it.
    expect(sink.setGitState).toHaveBeenCalledWith(ctl.gitState);
    session.dispose();
  });

  it("off: the ignored listing joins the probe, so a top-level ignored add rebuilds the tree", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    ctl.ignored = [{ relPath: "first.log", isDir: false, symlink: false }];
    vi.useFakeTimers();
    const { session } = makeSession({ settings: offSettings });
    session.start();
    await flushTicks();
    expect(ctl.buildCalls).toBe(1);
    expect(ctl.ignoredReads).toBe(1);

    // Porcelain is unchanged; only the ignored listing moved. The setting is
    // off, so the new entry is visible and must trigger a rebuild.
    ctl.ignored = [
      { relPath: "first.log", isDir: false, symlink: false },
      { relPath: "second.log", isDir: false, symlink: false },
    ];
    session.refresh();
    await flushTicks();
    expect(ctl.ignoredReads).toBe(2);
    expect(ctl.buildCalls).toBe(2);
    session.dispose();
  });

  it("on: the empty-repo fs fallback is filtered through the predicate (git can resolve ignores)", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = []; // nothing tracked or untracked: a fresh repository
    ctl.ignored = [
      { relPath: "ignored-dir", isDir: true, symlink: false },
      { relPath: "loose.log", isDir: false, symlink: false },
    ];
    ctl.fsEntries = [
      { relPath: "ignored-dir", isDir: true, symlink: false },
      { relPath: "ignored-dir/secret.txt", isDir: false, symlink: false },
      { relPath: "loose.log", isDir: false, symlink: false },
      { relPath: "keep.txt", isDir: false, symlink: false },
    ];
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    session.start();
    await flushTicks();

    expect(sink.setTree.mock.calls[0]?.[1]).toBe("fs");
    expect(ctl.lastBuildEntries.map((entry) => entry.relPath)).toEqual(["keep.txt"]);
    expect(ctl.fsSkips).toHaveLength(1);
    expect(ctl.fsSkips[0]).toBeDefined();
    session.dispose();
  });

  it("no git: fs mode is a documented no-op in both polarities", async () => {
    ctl.gitState = makeGitState({ available: false, error: "not a repo" });
    ctl.treeProbe = "probe-1";
    ctl.ignored = [{ relPath: "loose.log", isDir: false, symlink: false }];
    ctl.fsEntries = [
      { relPath: "loose.log", isDir: false, symlink: false },
      { relPath: "keep.txt", isDir: false, symlink: false },
    ];
    vi.useFakeTimers();
    for (const treeSettings of [settings, offSettings]) {
      ctl.ignoredReads = 0;
      ctl.fsSkips = [];
      ctl.lastBuildEntries = [];
      const { session, sink } = makeSession({ settings: treeSettings });
      session.start();
      await flushTicks();
      expect(sink.setTree.mock.calls[0]?.[1]).toBe("fs");
      // No git, no ignore resolution: the static ignore list stays the only
      // filter and the setting changes nothing here.
      expect(ctl.ignoredReads).toBe(0);
      expect(ctl.fsSkips[0]).toBeUndefined();
      expect(ctl.lastBuildEntries.map((entry) => entry.relPath)).toEqual(["loose.log", "keep.txt"]);
      session.dispose();
    }
  });
});

describe("createSession: non-UTF-8 git paths (Issue #220)", () => {
  it("warns once when git dropped a path that is not valid UTF-8", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    ctl.treeSkipped = 1;
    vi.useFakeTimers();
    const { session, notifyWarning } = makeSession();
    session.start();
    await flushTicks();
    expect(notifyWarning).toHaveBeenCalledTimes(1);
    expect(notifyWarning).toHaveBeenCalledWith("1 path(s) are not valid UTF-8 and are not listed");
    session.dispose();
  });

  it("stays quiet when nothing was dropped", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const { session, notifyWarning } = makeSession();
    session.start();
    await flushTicks();
    expect(notifyWarning).not.toHaveBeenCalled();
    session.dispose();
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

  it("does not retain a superseded image load's failure-free card (Issue #184)", async () => {
    const path = join(dir, "img.png");
    await writeFile(path, "png-bytes");
    ctl.support = "chafa";

    // Load A parks inside the loader and later resolves to the aborted
    // (supersession) card; load B supersedes it and leaves no entry of its
    // own (an error card has no mtime). Only A could poison the cache.
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let calls = 0;
    const loadFile = vi.fn<LoadFn>(async (absPath, relPath) => {
      calls += 1;
      if (calls === 1) {
        await gateA;
        return {
          kind: "image",
          relPath,
          lines: [],
          sizeBytes: 16,
          mtimeMs: (await stat(absPath)).mtimeMs,
          imageVerdict: { kind: "card" },
        };
      }
      return { kind: "error", relPath, lines: [], message: "superseded" };
    });
    const { session, sink } = makeSession({ loadFile });
    session.refresh();
    await vi.waitFor(() =>
      expect(sink.setImageSupport).toHaveBeenCalledWith(expect.objectContaining({ tier: "chafa" })),
    );

    const a = session.loadFile("img.png", { image: IMAGE_REQ });
    await vi.waitFor(() => expect(calls).toBe(1)); // A parked inside the loader
    const b = session.loadFile("img.png", { image: IMAGE_REQ }); // aborts A
    await b;
    releaseA();
    await a; // A's card resolves after the supersession

    // Same mtime + variant: a retained card would be served here, hiding the
    // reopened render.
    await session.loadFile("img.png", { image: IMAGE_REQ });
    expect(calls).toBe(3);
    session.dispose();
  });

  it("restyles a hit under a new style key without re-reading; a matching key is a no-op", async () => {
    const path = join(dir, "w.txt");
    await writeFile(path, "x\ny");
    await utimes(path, 1000000, 1000000); // pin mtime
    let key = "key-A";
    const loadFile = vi.fn<LoadFn>(async (absPath, relPath, opts) => ({
      kind: "text",
      relPath,
      sizeBytes: 3,
      lineCount: 2,
      lines: ["stale"],
      styleText: "x\ny",
      styleKey: opts?.styleKey,
      mtimeMs: (await stat(absPath)).mtimeMs,
    }));
    const { session } = makeSession({ loadFile, styleKey: () => key });

    const first = await session.loadFile("w.txt");
    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(loadFile.mock.calls[0]?.[2]).toMatchObject({ styleKey: "key-A" });
    // One stat per load (Issue #144): the session's record rides along.
    expect(loadFile.mock.calls[0]?.[2]?.stat).toEqual({
      isFile: true,
      sizeBytes: 3,
      mtimeMs: 1000 * 1000 * 1000,
    });
    expect(first.styleKey).toBe("key-A");
    expect(first.lines).toEqual(["stale"]);

    // A theme switch changes the key: the hit self-heals from the retained
    // source. `.txt` has no language, so the real restyle resolves to a plain
    // line split — no initialized pi theme needed.
    key = "key-B";
    const second = await session.loadFile("w.txt");
    expect(loadFile).toHaveBeenCalledTimes(1); // still a hit: no re-read
    expect(second).not.toBe(first);
    expect(second.styleKey).toBe("key-B");
    expect(second.lines).toEqual(["x", "y"]);

    // The restyled object was stored back: the same key now hits it as-is.
    const third = await session.loadFile("w.txt");
    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(third).toBe(second);
  });
});

describe("createSession: per-load abort ownership (Issue #117)", () => {
  it("starting a second load aborts the first load's signal, not its own", async () => {
    writeFileSync(join(dir, "img.png"), "png-bytes");
    ctl.support = "chafa";
    ctl.gitState = makeGitState();
    const { session, sink } = makeSession();
    session.refresh();
    await vi.waitFor(() =>
      expect(sink.setImageSupport).toHaveBeenCalledWith(expect.objectContaining({ tier: "chafa" })),
    );

    void session.loadFile("img.png", { image: IMAGE_REQ });
    await vi.waitFor(() => expect(ctl.chafaCalls).toHaveLength(1));
    void session.loadFile("img.png", { image: IMAGE_REQ });
    await vi.waitFor(() => expect(ctl.chafaCalls).toHaveLength(2));
    expect(ctl.chafaCalls).toHaveLength(2);
    expect(ctl.chafaCalls[0]?.signal.aborted).toBe(true); // superseded load
    expect(ctl.chafaCalls[1]?.signal.aborted).toBe(false); // its own signal
    session.dispose();
  });

  it("dispose aborts an in-flight load's signal", async () => {
    writeFileSync(join(dir, "img.png"), "png-bytes");
    ctl.support = "chafa";
    ctl.gitState = makeGitState();
    const { session, sink } = makeSession();
    session.refresh();
    await vi.waitFor(() =>
      expect(sink.setImageSupport).toHaveBeenCalledWith(expect.objectContaining({ tier: "chafa" })),
    );

    void session.loadFile("img.png", { image: IMAGE_REQ });
    await vi.waitFor(() => expect(ctl.chafaCalls).toHaveLength(1));
    expect(ctl.chafaCalls).toHaveLength(1);
    expect(ctl.chafaCalls[0]?.signal.aborted).toBe(false);
    session.dispose();
    expect(ctl.chafaCalls[0]?.signal.aborted).toBe(true);
  });
});

describe("createSession: one stat per load (Issue #144)", () => {
  it("hands the performed stat to the loader and keeps the stat-failure path stat-less", async () => {
    const path = join(dir, "w.txt");
    await writeFile(path, "hello");
    const { session, loadFile } = makeSession();

    await session.loadFile("w.txt");
    const opts = loadFile.mock.calls[0]?.[2];
    expect(opts?.stat).toEqual({ isFile: true, sizeBytes: 5, mtimeMs: expect.any(Number) });

    // A failed stat defers to the loader's own stat and error card.
    const missing = await session.loadFile("missing.txt");
    expect(missing.kind).toBe("error");
    expect(loadFile.mock.calls[1]?.[2]).toBeUndefined();
  });
});

describe("createSession: image plan → variant and cacheability (Issue #144)", () => {
  /** A loader that resolves without invoking the (never-settling) chafa child. */
  const resolvingImageLoader = (renderer: "native" | "chafa"): Mock<LoadFn> =>
    vi.fn<LoadFn>(async (absPath, relPath, opts) => {
      const image = opts?.image;
      const mtimeMs = (await stat(absPath)).mtimeMs;
      if (image !== undefined && opts?.imageRenderer !== undefined) {
        return {
          kind: "image",
          relPath,
          lines: [],
          sizeBytes: 16,
          mtimeMs,
          imageVerdict: {
            kind: "rendered",
            renderer,
            lines: ["row"],
            cols: image.cols,
            rows: image.rows,
          },
        };
      }
      return { kind: "text", relPath, sizeBytes: 5, lineCount: 1, lines: ["x"], mtimeMs };
    });

  it("chafa: the same geometry hits the plan-derived variant; a geometry change misses", async () => {
    writeFileSync(join(dir, "img.png"), "png-bytes");
    ctl.support = "chafa";
    const loadFile = resolvingImageLoader("chafa");
    const { session } = makeSession({ loadFile });
    session.refresh();
    await settle();

    await session.loadFile("img.png", { image: IMAGE_REQ });
    await session.loadFile("img.png", { image: IMAGE_REQ });
    expect(loadFile).toHaveBeenCalledTimes(1); // cache hit: variant matches

    await session.loadFile("img.png", { image: { cols: 30, rows: 12 } });
    expect(loadFile).toHaveBeenCalledTimes(2); // geometry is part of the variant
  });

  it("kitty native: the render is never retained (the protocol table's cacheable column)", async () => {
    writeFileSync(join(dir, "img.png"), "png-bytes");
    ctl.support = "native";
    const loadFile = resolvingImageLoader("native");
    const { session } = makeSession({ loadFile });
    session.refresh();
    await settle();

    await session.loadFile("img.png", { image: IMAGE_REQ });
    await session.loadFile("img.png", { image: IMAGE_REQ });
    expect(loadFile).toHaveBeenCalledTimes(2); // not cacheable: every open re-renders
  });
});

describe("createSession: reflow clock (Issue #144)", () => {
  const TARGET: OpenTarget = { kind: "file", relPath: "pic.png" };

  it("arms on a landed support push for an unrendered displayed image and fires reflowOpenImage after the debounce", async () => {
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    sink.getOpenTarget.mockReturnValue(TARGET);
    sink.getImageView.mockReturnValue({ rendered: false, asCard: false });

    ctl.support = "chafa";
    session.refresh();
    await flushTicks();
    expect(sink.setImageSupport).toHaveBeenCalledWith(expect.objectContaining({ tier: "chafa" }));
    expect(sink.reflowOpenImage).not.toHaveBeenCalled(); // debounced

    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    expect(sink.reflowOpenImage).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("does not re-arm a rendered image when the fingerprint and the view both stand still", async () => {
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    sink.getOpenTarget.mockReturnValue(TARGET);
    sink.getImageView.mockReturnValue({ rendered: true, asCard: false });

    ctl.support = "chafa";
    session.refresh();
    await flushTicks();
    // The first push counts as changed → arms the deferred→resolved upgrade.
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    expect(sink.reflowOpenImage).toHaveBeenCalledTimes(1);

    sink.reflowOpenImage.mockClear();
    session.refresh(); // identical snapshot: unchanged fingerprint, rendered view
    await flushTicks();
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS * 2);
    expect(sink.reflowOpenImage).not.toHaveBeenCalled();
    session.dispose();
  });

  it("never arms for a carded view or a non-image target", async () => {
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    sink.getOpenTarget.mockReturnValue({ kind: "file", relPath: "notes.txt" });
    ctl.support = "chafa";
    session.refresh();
    await flushTicks();
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS * 2);
    expect(sink.reflowOpenImage).not.toHaveBeenCalled();

    sink.getOpenTarget.mockReturnValue(TARGET);
    sink.getImageView.mockReturnValue({ rendered: false, asCard: true });
    session.refresh();
    await flushTicks();
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS * 2);
    expect(sink.reflowOpenImage).not.toHaveBeenCalled();
    session.dispose();
  });

  it("drops the reflow when the displayed target changed before the debounce", async () => {
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    sink.getOpenTarget.mockReturnValue(TARGET);
    sink.getImageView.mockReturnValue({ rendered: false, asCard: false });
    ctl.support = "chafa";
    session.refresh();
    await flushTicks();

    sink.getOpenTarget.mockReturnValue({ kind: "file", relPath: "other.png" });
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    expect(sink.reflowOpenImage).not.toHaveBeenCalled();
    session.dispose();
  });

  it("lets a newer target replace the pending arm (Issue #205)", async () => {
    vi.useFakeTimers();
    ctl.support = "chafa";
    const { session, sink } = makeSession();
    const first: OpenTarget = { kind: "file", relPath: "a.png" };
    const second: OpenTarget = { kind: "file", relPath: "b.png" };
    sink.getImageView.mockReturnValue({ rendered: true, asCard: false });

    // The support landing arms the debounce for the then-displayed A.
    sink.getOpenTarget.mockReturnValue(first);
    session.refresh();
    await flushTicks();

    // The displayed image moves to B before the debounce elapses. The timer
    // must stay single, but its pending target must become B — the old arm
    // kept A and the fire-time target check then dropped the reflow entirely.
    sink.getOpenTarget.mockReturnValue(second);
    session.imageViewChanged();

    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    expect(sink.reflowOpenImage).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("dispose clears a pending reflow", async () => {
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    sink.getOpenTarget.mockReturnValue(TARGET);
    sink.getImageView.mockReturnValue({ rendered: false, asCard: false });
    ctl.support = "chafa";
    session.refresh();
    await flushTicks();

    session.dispose();
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS * 2);
    expect(sink.reflowOpenImage).not.toHaveBeenCalled();
  });

  it("re-arms while a load is in flight and fires once it settles", async () => {
    vi.useFakeTimers();
    writeFileSync(join(dir, "img.png"), "png-bytes");
    ctl.support = "chafa";
    const { session, sink } = makeSession();
    sink.getOpenTarget.mockReturnValue({ kind: "file", relPath: "img.png" });
    sink.getImageView.mockReturnValue({ rendered: false, asCard: false });

    // Resolve the support snapshot first: it arms the upgrade reflow against
    // the (mock-)displayed target before any load starts.
    session.refresh();
    await flushTicks();

    const load = session.loadFile("img.png", { image: IMAGE_REQ });
    // vi.waitFor polls on real timers (safe timers are captured before fake
    // timers install) and advances the virtual clock per check, so the real-fs
    // stat → chafa spawn lands before the assertion regardless of load; the
    // ≤50ms virtual drift stays under the 250ms re-arm debounce.
    await vi.waitFor(() => expect(ctl.chafaCalls).toHaveLength(1));
    expect(ctl.chafaCalls).toHaveLength(1); // in flight, parked on its child

    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    expect(sink.reflowOpenImage).not.toHaveBeenCalled(); // re-armed, not fired

    // Let the load settle; the re-armed timer now re-validates and fires.
    // Await the load itself rather than a fixed number of event-loop turns:
    // the loader's post-render stat is real fs work, and `flushTicks` lost
    // that race under CI contention — the timer fired while the load was
    // still in flight, re-armed, and the assertion below saw zero calls.
    ctl.chafaRelease?.();
    await load;
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    expect(sink.reflowOpenImage).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("falls back to the displayed image while a non-image load is in flight (Issue #182)", async () => {
    vi.useFakeTimers();
    writeFileSync(join(dir, "notes.txt"), "notes");
    const { session, sink, loadFile } = makeSession();
    sink.getOpenTarget.mockReturnValue(TARGET);
    sink.getImageView.mockReturnValue({ rendered: true, asCard: false });

    // Park a text load in flight so the in-flight target shadows the displayed
    // image; the support landing must still arm the displayed image's reflow.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadFile.mockImplementationOnce(async (_absPath, relPath) => {
      await gate;
      return { kind: "text", relPath, sizeBytes: 5, lineCount: 1, lines: ["x"], mtimeMs: 1 };
    });
    const pending = session.loadFile("notes.txt");

    ctl.support = "chafa";
    session.refresh();
    await flushTicks();
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS * 2);
    expect(sink.reflowOpenImage).not.toHaveBeenCalled(); // re-armed, load in flight

    release();
    await pending;
    await flushTicks();
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    expect(sink.reflowOpenImage).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("imageViewChanged debounces one timer, ignores repeats, and is inert without a tier", async () => {
    vi.useFakeTimers();
    const { session, sink } = makeSession();
    sink.getOpenTarget.mockReturnValue(TARGET);

    // Deferred support resolves tier none: nothing can re-render.
    session.imageViewChanged();
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS * 2);
    expect(sink.reflowOpenImage).not.toHaveBeenCalled();

    ctl.support = "chafa";
    session.refresh(); // no displayed target yet → the support push arms nothing
    await flushTicks();
    sink.getOpenTarget.mockReturnValue(TARGET);
    sink.getImageView.mockReturnValue({ rendered: true, asCard: false });

    session.imageViewChanged();
    session.imageViewChanged(); // one timer at a time
    await vi.advanceTimersByTimeAsync(IMAGE_RESIZE_DEBOUNCE_MS);
    expect(sink.reflowOpenImage).toHaveBeenCalledTimes(1);
    session.dispose();
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

describe("createSession: a throwing notify or support resolution must not stop polling (Issue #206)", () => {
  it("keeps polling when the error notification itself throws (Issue #206)", async () => {
    ctl.gitError = new Error("boom");
    vi.useFakeTimers();
    const timers = installTimerLog();
    // A notify that throws is exactly the hole: the tick fails (so it notifies)
    // and the throw used to reject the whole refresh, killing the poll.
    const notify = vi.fn(() => {
      throw new Error("notify failed");
    });
    const { session, sink } = makeSession({ notify });
    session.start();
    await flushTicks();
    expect(sink.setGitState).not.toHaveBeenCalled(); // the tick still failed

    // The same failure repeats: the dedupe must still report it exactly once.
    session.refresh();
    await flushTicks();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("pi-navigator: boom");

    // Both failed ticks rescheduled the poll despite the throw (and backed off
    // from the base interval instead of retrying it).
    expect(timers.length).toBeGreaterThan(1);
    expect(timers[0]?.delay).toBe(REFRESH_INTERVAL_MS + 2000);
    session.dispose();
  });

  it("survives a throwing support resolution and keeps resolving later (Issue #206)", async () => {
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    ctl.capabilitiesThrow = true; // capabilities() runs inside resolveImageSupport
    vi.useFakeTimers();
    const { session, notifyWarning } = makeSession();
    session.start(); // start() returns void: the guard is the absence of an unhandled rejection
    await flushTicks();
    expect(ctl.supportResolved).toBe(0); // the resolution threw
    expect(notifyWarning).toHaveBeenCalledWith(
      "image support resolution failed: capabilities exploded",
    );

    ctl.capabilitiesThrow = false;
    session.refresh();
    await flushTicks();
    // The finally reset supportResolving, so later resolutions still run.
    expect(ctl.supportResolved).toBe(1);
    session.dispose();
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

  it("stops cleanly when disposed while a refresh is awaiting git (Issue #221)", async () => {
    // With respectGitignore off the tick reads the ignored listing right after
    // its git read, so "the abandoned tick did no further work" is observable
    // at the very guard under test.
    const offSettings: NavigatorSettings = {
      ...settings,
      tree: { ...settings.tree, respectGitignore: false },
    };
    ctl.gitState = makeGitState();
    ctl.treeProbe = "probe-1";
    ctl.tracked = ["src/a.ts"];
    vi.useFakeTimers();
    const timers = installTimerLog();
    const { session, sink } = makeSession({ settings: offSettings });

    // Park the tick's git read on the same deferred the single-flight test
    // uses: disposal must land while the read it awaits is still open.
    let releaseGit!: () => void;
    ctl.gitRelease = new Promise<void>((resolve) => {
      releaseGit = resolve;
    });

    session.refresh();
    await flushTicks();
    expect(ctl.gitReads).toBe(1); // the read is parked, nothing has landed

    // Disposing mid-refresh closes the tick: the parked read resolves into a
    // session that must abandon it before any further read or any state
    // reaches the sink, and the poll must stay down.
    session.dispose();
    const timersBefore = timers.length;
    const rendersBefore = sink.requestRender.mock.calls.length;
    releaseGit();
    await flushTicks();

    expect(ctl.ignoredReads).toBe(0); // stopped before the next read
    expect(sink.setTree).not.toHaveBeenCalled();
    expect(sink.setGitState).not.toHaveBeenCalled();
    expect(sink.requestRender).toHaveBeenCalledTimes(rendersBefore); // no abandoned-tick render
    expect(timers.length).toBe(timersBefore); // no further poll was armed
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

  it("retains the plain styling source and the current style key (Issue #141)", async () => {
    const commit: CommitDiff = {
      shortHash: "abc1234",
      parents: ["dead000"],
      lines: ["+added", "-removed"],
      filesChanged: 1,
      insertions: 2,
      deletions: 1,
      notice: "commit abc1234 \u00b7 1 file",
      message: { subject: "fix things", body: ["body line"] },
    };
    ctl.commitDiff = commit;
    const { session } = makeSession({ styleKey: () => "key-A" });
    const file = await session.loadCommit("abc1234");

    // The retained source is exactly the plain material `lines` was composed
    // from (identity theme here), so invalidate() can recompose without a
    // `git show`; the key records the styling it is currently under.
    expect(file.styleDiff).toEqual({ message: commit.message, lines: commit.lines });
    expect(file.styleKey).toBe("key-A");
    expect(file.lines).toEqual(["fix things", "body line", "", "+added", "-removed"]);
  });
});
