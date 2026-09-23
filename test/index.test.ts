/**
 * index.ts unit and integration suites (Issue #063, Issue #095):
 * - makeWarningNotifier deduplication and channel isolation
 * - makeTreeTruncationWarner one-shot truncation policy (Issue #108)
 * - createViewerCache retention/eviction policy (Issues #020, #109, #112, D7)
 * - parseNavigatorArgs subcommand parsing
 * - navigatorCompletions argument prefix completions
 * - extension lifecycle: command registration, subcommand routing, help renderer, headless guard
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { getCapabilities, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";

import { IMAGE_NATIVE_CACHE_MAX_CHARS, MAX_FS_ENTRIES } from "../constants";
import { DEFAULT_PI_CHAFA_SUBSET, KITTY_PROBE_SAMPLE, type ImageSupport, type KittyProbeVerdict } from "../images";
import type { ViewerFile } from "../types";
import { loadFile } from "../viewer";
import registerNavigatorExtension, {
  createViewerCache,
  isCacheableRender,
  makeImageSeams,
  makeTreeTruncationWarner,
  makeTuiKittyDecodeProbe,
  makeWarningNotifier,
  navigatorCompletions,
  parseNavigatorArgs,
  touchCacheEntry,
} from "../index";

function fakeUi() {
  const notify = vi.fn();
  return { ui: { notify }, notify };
}

function mockPi() {
  const commands = new Map<string, any>();
  const entryRenderers = new Map<string, any>();
  const entries: Array<{ type: string; data: any }> = [];
  const pi = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerEntryRenderer: (type: string, fn: any) => entryRenderers.set(type, fn),
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
  };
  return { pi: pi as any, commands, entryRenderers, entries };
}

function mockCtx(opts: { hasUI?: boolean; cwd?: string } = {}) {
  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = {
    hasUI: opts.hasUI ?? true,
    cwd: opts.cwd ?? "/test",
    ui: {
      notify: (msg: string, level: string) => notifications.push({ msg, level }),
      custom: vi.fn().mockResolvedValue(null),
    },
  };
  return { ctx: ctx as any, notifications };
}

describe("makeWarningNotifier", () => {
  it("prefixes the message with pi-navigator: and uses warning severity", () => {
    const { ui, notify } = fakeUi();
    makeWarningNotifier(ui)("boom");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("pi-navigator: boom", "warning");
  });

  it("notifies each distinct message once", () => {
    const { ui, notify } = fakeUi();
    const warn = makeWarningNotifier(ui);
    warn("alpha");
    warn("beta");
    warn("alpha");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map((call) => call[0])).toEqual(["pi-navigator: alpha", "pi-navigator: beta"]);
  });

  it("dedupes per factory call, not per module", () => {
    const { ui, notify } = fakeUi();
    makeWarningNotifier(ui)("boom");
    makeWarningNotifier(ui)("boom");
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe("parseNavigatorArgs (Issue #095)", () => {
  it("parses empty or whitespace arguments as overlay", () => {
    expect(parseNavigatorArgs("")).toEqual({ kind: "overlay" });
    expect(parseNavigatorArgs("   ")).toEqual({ kind: "overlay" });
  });

  it("parses known subcommands settings and help", () => {
    expect(parseNavigatorArgs("settings")).toEqual({ kind: "settings" });
    expect(parseNavigatorArgs("  settings  ")).toEqual({ kind: "settings" });
    expect(parseNavigatorArgs("help")).toEqual({ kind: "help" });
    expect(parseNavigatorArgs("help extra")).toEqual({ kind: "help" });
  });

  it("routes the layout subcommands to the layout kind with their layout (Issue #119)", () => {
    expect(parseNavigatorArgs("all")).toEqual({ kind: "layout", layout: "files-git-viewer" });
    expect(parseNavigatorArgs("files")).toEqual({ kind: "layout", layout: "files-viewer" });
    expect(parseNavigatorArgs("git")).toEqual({ kind: "layout", layout: "git-viewer" });
    expect(parseNavigatorArgs("git  ")).toEqual({ kind: "layout", layout: "git-viewer" });
    expect(parseNavigatorArgs("files trailing tokens")).toEqual({ kind: "layout", layout: "files-viewer" });
  });

  it("parses unknown subcommands and preserves raw token", () => {
    expect(parseNavigatorArgs("bogus")).toEqual({ kind: "unknown", raw: "bogus" });
    expect(parseNavigatorArgs("foo bar")).toEqual({ kind: "unknown", raw: "foo" });
  });
});

describe("navigatorCompletions (Issue #095)", () => {
  it("returns all subcommands when prefix is empty", () => {
    const completions = navigatorCompletions("");
    expect(completions).not.toBeNull();
    const values = completions!.map((c) => c.value);
    // Issue #119: the three layout openers lead the table.
    expect(values).toEqual(["all", "files", "git", "settings", "help"]);
  });

  it("exposes the layout openers' completion labels and descriptions", () => {
    const completions = navigatorCompletions("");
    expect(completions![0]).toEqual({
      value: "all",
      label: "Open files + git + viewer overlay",
      description: "open overlay with files and git panes (default)",
    });
    expect(completions![1]).toEqual({
      value: "files",
      label: "Open files + viewer overlay",
      description: "open overlay with files pane only",
    });
    expect(completions![2]).toEqual({
      value: "git",
      label: "Open git + viewer overlay",
      description: "open overlay with git panel only",
    });
  });

  it("filters completions by prefix", () => {
    const set = navigatorCompletions("set");
    expect(set).toHaveLength(1);
    expect(set![0]?.value).toBe("settings");

    const hel = navigatorCompletions("hel");
    expect(hel).toHaveLength(1);
    expect(hel![0]?.value).toBe("help");
  });

  it("returns null when no completions match prefix", () => {
    expect(navigatorCompletions("xyz")).toBeNull();
  });
});

describe("extension lifecycle & routing (Issue #095)", () => {
  it("registers entry renderer and navigator command", () => {
    const { pi, commands, entryRenderers } = mockPi();
    registerNavigatorExtension(pi);

    expect(commands.has("navigator")).toBe(true);
    expect(entryRenderers.has("navigator-help")).toBe(true);
  });

  it("routes help subcommand to appendEntry", async () => {
    const { pi, commands, entries } = mockPi();
    registerNavigatorExtension(pi);
    const cmd = commands.get("navigator");
    const { ctx } = mockCtx({ cwd: "/repo" });

    await cmd.handler("help", ctx);
    expect(entries).toEqual([{ type: "navigator-help", data: { cwd: "/repo" } }]);
  });

  it("warns on unknown subcommand and appends help entry", async () => {
    const { pi, commands, entries } = mockPi();
    registerNavigatorExtension(pi);
    const cmd = commands.get("navigator");
    const { ctx, notifications } = mockCtx({ cwd: "/repo" });

    await cmd.handler("unknown-cmd", ctx);
    expect(notifications).toEqual([
      { msg: 'pi-navigator: unknown subcommand "unknown-cmd"', level: "warning" },
    ]);
    expect(entries).toEqual([{ type: "navigator-help", data: { cwd: "/repo" } }]);
  });

  it("guards against headless execution when opening overlay", async () => {
    const { pi, commands } = mockPi();
    registerNavigatorExtension(pi);
    const cmd = commands.get("navigator");
    const { ctx, notifications } = mockCtx({ hasUI: false });

    await cmd.handler("", ctx);
    expect(notifications).toEqual([
      { msg: "pi-navigator requires the interactive TUI", level: "warning" },
    ]);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("renders help entry via registered entry renderer", () => {
    const { pi, entryRenderers } = mockPi();
    registerNavigatorExtension(pi);
    const renderer = entryRenderers.get("navigator-help");
    expect(renderer).toBeDefined();

    const theme = {
      fg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    };
    const renderedComp = renderer({ type: "navigator-help", data: { cwd: "/repo" } }, { expanded: true }, theme);
    expect(renderedComp).toBeDefined();
    const renderedLines = renderedComp.render(80);
    expect(renderedLines.some((l: string) => l.includes("pi-navigator"))).toBe(true);
    expect(renderedLines.some((l: string) => l.includes("/navigator settings"))).toBe(true);
    expect(renderedLines.some((l: string) => l.includes("/navigator help"))).toBe(true);
    // Issue #119: the durable help lists all five subcommands.
    expect(renderedLines.some((l: string) => l.includes("/navigator all"))).toBe(true);
    expect(renderedLines.some((l: string) => l.includes("/navigator files"))).toBe(true);
    expect(renderedLines.some((l: string) => l.includes("/navigator git"))).toBe(true);
  });

  it("passes a layout subcommand's layout through to runNavigator (Issue #119)", async () => {
    const { pi, commands } = mockPi();
    registerNavigatorExtension(pi);
    const cmd = commands.get("navigator");
    // runNavigator surfaces the layout through the overlay options it hands
    // to ctx.ui.custom — capture the factory's options argument.
    const customCalls: unknown[][] = [];
    const { ctx } = mockCtxWithCustomCapture(customCalls);

    await cmd.handler("files", ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    const options = customCalls[0]?.[1] as { overlay: boolean } | undefined;
    expect(options?.overlay).toBe(true);

    await cmd.handler("", ctx); // bare: still opens (settings default resolves inside)
    expect(ctx.ui.custom).toHaveBeenCalledTimes(2);
  });
});

/** mockCtx variant that records every ctx.ui.custom call's arguments. */
function mockCtxWithCustomCapture(calls: unknown[][]): { ctx: any; notifications: Array<{ msg: string; level: string }> } {
  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    cwd: "/test",
    ui: {
      notify: (msg: string, level: string) => notifications.push({ msg, level }),
      custom: vi.fn((...args: unknown[]) => {
        calls.push(args);
        // The overlay factory returns its component object; the harness never
        // renders it, so resolving null (close) immediately is fine.
        return Promise.resolve(null);
      }),
    },
  };
  return { ctx: ctx as any, notifications };
}
describe("makeTuiKittyDecodeProbe (Issue #101, #116)", () => {
  type Listener = ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;

  function fakeTui() {
    const writes: string[] = [];
    let listener: Listener;
    const tui = {
      terminal: { rows: 24, write: (s: string) => writes.push(s) },
      requestRender: () => undefined,
      addInputListener: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    };
    return {
      tui,
      writes,
      emit: (data: string | undefined) => (data === undefined ? undefined : listener?.(data)),
      isSubscribed: () => listener !== undefined,
    };
  }

  it("writes one a=q query with the PNG sample and resolves ok when the terminal replies OK (Issue #101, #116)", async () => {
    const { tui, writes, emit } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const pending = probe();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("a=q,t=d,f=100");
    // Issue #116: always sends the PNG sample, never JPEG/WebP
    expect(writes[0]).toContain(KITTY_PROBE_SAMPLE);
    const id = /i=(\d+)/.exec(writes[0] ?? "")?.[1];
    expect(id).toBeDefined();
    const result = emit(`\x1b_Gi=${id};OK\x1b\\`);
    expect(result).toEqual({ consume: true });
    await expect(pending).resolves.toBe("ok");
  });

  it("resolves error on an explicit terminal error reply (Issue #116)", async () => {
    const { tui, writes, emit } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const pending = probe();
    // Issue #116: always PNG sample — the old per-MIME JPEG/WebP probe was the
    // root cause of the decode error because f=100 means PNG in the kitty spec.
    expect(writes[0]).toContain(KITTY_PROBE_SAMPLE);
    const id = /i=(\d+)/.exec(writes[0] ?? "")?.[1];
    emit(`\x1b_Gi=${id};bad image\x1b\\`);
    await expect(pending).resolves.toBe("error");
  });

  it("reassembles a reply split across chunks and passes unrelated input through (Issue #101)", async () => {
    const { tui, writes, emit } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const pending = probe();
    expect(writes[0]).toContain(KITTY_PROBE_SAMPLE);
    const id = /i=(\d+)/.exec(writes[0] ?? "")?.[1];
    expect(emit("some user keystrokes")).toBeUndefined();
    expect(emit(`\x1b_Gi=${id};O`)).toBeUndefined(); // partial: never consumed
    expect(emit("K\x1b\\")).toEqual({ consume: true });
    await expect(pending).resolves.toBe("ok");
  });

  it("resolves no-reply on timeout, unsubscribes, and ignores a late reply (Issue #116)", async () => {
    vi.useFakeTimers();
    try {
      const { tui, writes, emit, isSubscribed } = fakeTui();
      // Issue #116: fresh cache per invocation so error verdicts expire.
      const probe = makeTuiKittyDecodeProbe(tui, { timeoutMs: 250, cache: {} });
      const pending = probe();
      expect(isSubscribed()).toBe(true);
      expect(writes).toHaveLength(1);
      // Terminal never answers the a=q query (Konsole-style): the timer fires.
      vi.advanceTimersByTime(250);
      await expect(pending).resolves.toBe("no-reply");
      expect(isSubscribed()).toBe(false);
      // A late reply after settling is ignored entirely.
      expect(emit("\x1b_Gi=1;OK\x1b\\")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches the result: a second call reuses the first promise (Issue #116)", async () => {
    const { tui, writes, emit } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const first = probe();
    const second = probe();
    expect(second).toBe(first); // same cached promise
    expect(writes).toHaveLength(1); // only one query was transmitted
    const id = /i=(\d+)/.exec(writes[0] ?? "")?.[1];
    emit(`\x1b_Gi=${id};OK\x1b\\`);
    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
  });
});

describe("touchCacheEntry (Issue #109)", () => {
  it("refreshes recency so the next eviction drops the least recently used key", () => {
    const cache = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    touchCacheEntry(cache, "a");
    // Map iteration order is now LRU-first: b, c were untouched; a is newest.
    expect([...cache.keys()]).toEqual(["b", "c", "a"]);
    // Mirror the eviction site in loadFileCached: at capacity, drop the first
    // (least recently used) key, then insert — b goes, a survives.
    cache.delete(cache.keys().next().value as string);
    cache.set("d", 4);
    expect([...cache.keys()]).toEqual(["c", "a", "d"]);
  });

  it("is a no-op for an absent key", () => {
    const cache = new Map<string, number>([["a", 1]]);
    touchCacheEntry(cache, "missing");
    expect([...cache.keys()]).toEqual(["a"]);
    expect(cache.get("a")).toBe(1);
  });
});

describe("isCacheableRender (Issue #112)", () => {
  it("never retains a kitty native render", () => {
    // Re-serving one re-emits its kitty image id, and pi-tui then re-places
    // that id without re-transmitting the data (placement-only `a=p`), so the
    // pane stays blank after the `i` roundtrip or any reopen.
    expect(isCacheableRender(true, "kitty")).toBe(false);
  });

  it("retains an iTerm2 native render (inline payload, no id state)", () => {
    expect(isCacheableRender(true, "iterm2")).toBe(true);
  });

  it("retains every non-native render", () => {
    expect(isCacheableRender(false, "kitty")).toBe(true);
    expect(isCacheableRender(false, null)).toBe(true);
  });
});

describe("createViewerCache (Issues #020, #109, #112, D7)", () => {
  function file(overrides: Partial<ViewerFile> = {}): ViewerFile {
    return { kind: "text", relPath: "x", lines: [], mtimeMs: 1000, ...overrides };
  }

  it("never serves or retains a kitty native render, even over an existing entry (#112)", () => {
    const cache = createViewerCache(2);
    const text = file({ relPath: "img.png" });
    cache.store("img.png", { cacheable: true, variant: "", file: text });
    expect(cache.size).toBe(1);

    // A cacheable:false lookup (kitty native render in flight) is a clean miss
    // even though a cacheable entry for the same path exists.
    expect(cache.lookup("img.png", { cacheable: false, mtimeMs: 1000, variant: "" })).toBeUndefined();
    // Storing the kitty render is a no-op: the previous entry survives.
    const kitty = file({ relPath: "img.png", kind: "image", imageTier: "native", imageLines: ["\x1b_Gf=100..."] });
    cache.store("img.png", { cacheable: false, variant: "native:kitty:2x2", file: kitty });
    expect(cache.size).toBe(1);
    expect(cache.lookup("img.png", { cacheable: true, mtimeMs: 1000, variant: "" })).toBe(text);
  });

  it("evicts the least recently used entry at capacity — the recency touch in lookup is what keeps `a` (#109)", () => {
    const cache = createViewerCache(2);
    const a = file({ relPath: "a" });
    const b = file({ relPath: "b" });
    const c = file({ relPath: "c" });
    cache.store("a", { cacheable: true, variant: "", file: a });
    cache.store("b", { cacheable: true, variant: "", file: b });
    // Genuine hit refreshes a's recency (this is the #109 fix under test).
    expect(cache.lookup("a", { cacheable: true, mtimeMs: 1000, variant: "" })).toBe(a);
    cache.store("c", { cacheable: true, variant: "", file: c });
    expect(cache.size).toBe(2);
    expect(cache.lookup("a", { cacheable: true, mtimeMs: 1000, variant: "" })).toBe(a);
    expect(cache.lookup("b", { cacheable: true, mtimeMs: 1000, variant: "" })).toBeUndefined();
  });

  it("evicts the plain-oldest entry when no hit refreshes recency (#109)", () => {
    const cache = createViewerCache(2);
    const a = file({ relPath: "a" });
    const b = file({ relPath: "b" });
    const c = file({ relPath: "c" });
    cache.store("a", { cacheable: true, variant: "", file: a });
    cache.store("b", { cacheable: true, variant: "", file: b });
    // No lookup of a: it stays the oldest, so the FIFO eviction drops it.
    cache.store("c", { cacheable: true, variant: "", file: c });
    expect(cache.size).toBe(2);
    expect(cache.lookup("a", { cacheable: true, mtimeMs: 1000, variant: "" })).toBeUndefined();
    expect(cache.lookup("b", { cacheable: true, mtimeMs: 1000, variant: "" })).toBe(b);
  });

  it("does not retain a file without an mtime (error cards)", () => {
    const cache = createViewerCache(2);
    const error: ViewerFile = { kind: "error", relPath: "gone.ts", lines: [], message: "ENOENT" };
    cache.store("gone.ts", { cacheable: true, variant: "", file: error });
    expect(cache.size).toBe(0);
    expect(cache.lookup("gone.ts", { cacheable: true, mtimeMs: 1000, variant: "" })).toBeUndefined();
  });

  it("drops a native render above IMAGE_NATIVE_CACHE_MAX_CHARS but retains one under it (D7)", () => {
    const cache = createViewerCache(2);
    const over = file({
      relPath: "big.png",
      kind: "image",
      imageTier: "native",
      imageLines: ["x".repeat(IMAGE_NATIVE_CACHE_MAX_CHARS + 1)],
    });
    cache.store("big.png", { cacheable: true, variant: "native:iterm2:2x2", file: over });
    expect(cache.size).toBe(0);

    const under = file({
      relPath: "small.png",
      kind: "image",
      imageTier: "native",
      imageLines: ["y".repeat(IMAGE_NATIVE_CACHE_MAX_CHARS - 1)],
    });
    cache.store("small.png", { cacheable: true, variant: "native:iterm2:2x2", file: under });
    expect(cache.size).toBe(1);
    expect(
      cache.lookup("small.png", { cacheable: true, mtimeMs: 1000, variant: "native:iterm2:2x2" }),
    ).toBe(under);
  });

  it("lookup misses on a stale mtime, a variant change, and an absent path, and hits within ±1 ms", () => {
    const cache = createViewerCache(2);
    const f = file({ relPath: "a.ts" });
    cache.store("a.ts", { cacheable: true, variant: "v1", file: f });

    // Genuine hit with the stored mtime; hits at the exact ±1 ms boundary and
    // inside it.
    expect(cache.lookup("a.ts", { cacheable: true, mtimeMs: 1000, variant: "v1" })).toBe(f);
    expect(cache.lookup("a.ts", { cacheable: true, mtimeMs: 1001, variant: "v1" })).toBe(f);
    expect(cache.lookup("a.ts", { cacheable: true, mtimeMs: 999.5, variant: "v1" })).toBe(f);
    // Stale mtime: more than 1 ms away.
    expect(cache.lookup("a.ts", { cacheable: true, mtimeMs: 1002, variant: "v1" })).toBeUndefined();
    expect(cache.lookup("a.ts", { cacheable: true, mtimeMs: 998, variant: "v1" })).toBeUndefined();
    // Variant change is a miss even at the same mtime.
    expect(cache.lookup("a.ts", { cacheable: true, mtimeMs: 1000, variant: "v2" })).toBeUndefined();
    // Absent path misses at any mtime.
    expect(cache.lookup("nope.ts", { cacheable: true, mtimeMs: 1000, variant: "v1" })).toBeUndefined();
    // drop removes the entry (stat-failure path in loadFileCached).
    cache.drop("a.ts");
    expect(cache.size).toBe(0);
    expect(cache.lookup("a.ts", { cacheable: true, mtimeMs: 1000, variant: "v1" })).toBeUndefined();
  });
});

describe("makeTreeTruncationWarner (Issue #108)", () => {
  const exactMessage = `file tree truncated at ${MAX_FS_ENTRIES} entries \u2014 some files are not listed`;

  it("stays silent for false and warns once with the exact message on the first true", () => {
    const notify = vi.fn();
    const noteTruncation = makeTreeTruncationWarner(notify);
    noteTruncation(false);
    noteTruncation(false);
    expect(notify).not.toHaveBeenCalled();
    noteTruncation(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(exactMessage);
  });

  it("is silent for a second true, per instance", () => {
    const notify = vi.fn();
    const noteTruncation = makeTreeTruncationWarner(notify);
    noteTruncation(true);
    noteTruncation(true);
    noteTruncation(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("latches per instance, not globally", () => {
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    const a = makeTreeTruncationWarner(notifyA);
    const b = makeTreeTruncationWarner(notifyB);
    a(true);
    // b is a fresh instance: a's latch must not silence it.
    b(true);
    expect(notifyA).toHaveBeenCalledTimes(1);
    expect(notifyB).toHaveBeenCalledTimes(1);
  });
});

describe("makeImageSeams (Issue #116 fix 1)", () => {
  /** A resolved auto-mode snapshot; overrides narrow it per case. */
  function snapshot(overrides: Partial<ImageSupport> = {}): ImageSupport {
    return {
      mode: "auto",
      nativeProtocol: "kitty",
      tier: "native",
      piChafa: { present: true, via: "settings" },
      chafa: { state: "ok", binary: "chafa", version: { major: 1, minor: 18 } },
      config: { ...DEFAULT_PI_CHAFA_SUBSET },
      hostShowImages: true,
      hostImageWidthCells: 60,
      ...overrides,
    };
  }

  const neverProbe = async (): Promise<KittyProbeVerdict> => "no-reply";

  it("gates the native seam on the snapshot it was built from", async () => {
    // The whole point of the snapshot binding: a load that captured a
    // non-native support must refuse natively even if the session has since
    // become native-capable, so the seam can never disagree with the tier the
    // loader chose when it picked the seams.
    const seams = makeImageSeams({
      support: snapshot({ tier: "chafa", nativeProtocol: null }),
      probeDecode: neverProbe,
      signal: new AbortController().signal,
    });
    await expect(seams.renderNativeImage("/work/x.png", { cols: 10, rows: 5 })).resolves.toEqual({
      ok: false,
      reason: "native rendering is not available",
    });
  });

  it("gates the chafa seam on the snapshot (deferred chafa refuses without spawning)", async () => {
    // mode: "native" keeps chafa deferred, so the seam must refuse before it
    // ever reaches the binary — that is what makes the no-fallback path work.
    const seams = makeImageSeams({
      support: snapshot({ mode: "native", chafa: { state: "deferred" } }),
      probeDecode: neverProbe,
      signal: new AbortController().signal,
    });
    await expect(seams.renderImage("/work/x.png", { cols: 10, rows: 5 })).resolves.toEqual({
      ok: false,
      reason: "chafa is not available",
    });
  });

  it("binds both seams to the owning load's signal; an aborted load refuses without work (Issue #117 follow-up)", async () => {
    const controller = new AbortController();
    const seams = makeImageSeams({
      support: snapshot(),
      probeDecode: neverProbe,
      signal: controller.signal,
    });

    // A live load forwards its signal: the native seam reaches the bounded
    // read and fails on the missing path.
    await expect(
      seams.renderNativeImage("/work/missing.png", { cols: 10, rows: 5 }),
    ).resolves.toEqual({ ok: false, reason: "could not read the image file" });

    // A superseded load (its own signal aborted) short-circuits in BOTH seams
    // without reading a file or forking a chafa child.
    controller.abort();
    await expect(
      seams.renderNativeImage("/work/missing.png", { cols: 10, rows: 5 }),
    ).resolves.toEqual({ ok: false, reason: "render aborted" });
    await expect(
      seams.renderImage("/work/missing.png", { cols: 10, rows: 5 }),
    ).resolves.toEqual({ ok: false, reason: "render aborted" });
  });

  it("a superseded load's abort never reaches the chafa seam, so the newest load stays native (Issue #117)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nav117-"));
    const saved = getCapabilities();
    try {
      const png = join(dir, "pixel.png");
      writeFileSync(png, Buffer.from(KITTY_PROBE_SAMPLE, "base64"));
      setCapabilities({ ...saved, images: "kitty" });

      // Per-load abort ownership, mirroring index.ts beginImageLoad: each load
      // owns one controller, and load B's start aborts load A's.
      const controllerA = new AbortController();
      const controllerB = new AbortController();

      let markAEntered!: () => void;
      let markBEntered!: () => void;
      const aEntered = new Promise<void>((resolve) => {
        markAEntered = resolve;
      });
      const bEntered = new Promise<void>((resolve) => {
        markBEntered = resolve;
      });
      let releaseA!: (verdict: KittyProbeVerdict) => void;
      let releaseB!: (verdict: KittyProbeVerdict) => void;
      const gateA = new Promise<KittyProbeVerdict>((resolve) => {
        releaseA = resolve;
      });
      const gateB = new Promise<KittyProbeVerdict>((resolve) => {
        releaseB = resolve;
      });

      const seamsA = makeImageSeams({
        support: snapshot(),
        probeDecode: () => {
          markAEntered();
          return gateA;
        },
        signal: controllerA.signal,
      });
      const seamsB = makeImageSeams({
        support: snapshot(),
        probeDecode: () => {
          markBEntered();
          return gateB;
        },
        signal: controllerB.signal,
      });
      const req = { cols: 20, rows: 10 };

      // Load A parks on its probe with its own controller; load B's start
      // (beginImageLoad) aborts A, exactly like index.ts.
      const loadA = loadFile(png, "a.png", {
        image: req,
        renderNativeImage: seamsA.renderNativeImage,
        renderImage: seamsA.renderImage,
      });
      await aEntered;
      controllerA.abort();
      const loadB = loadFile(png, "b.png", {
        image: req,
        renderNativeImage: seamsB.renderNativeImage,
        renderImage: seamsB.renderImage,
      });
      await bEntered;

      releaseA("no-reply");
      const a = await loadA;
      expect(a.imageTier).toBe("metadata");
      expect(a.imageError).toBe("render aborted");

      // Defense in depth: even if the superseded load's chafa fallback ran
      // (the pre-#117 viewer did), it can only observe its own aborted signal —
      // load B's controller is untouched.
      await expect(seamsA.renderImage(png, req)).resolves.toEqual({
        ok: false,
        reason: "render aborted",
      });

      releaseB("no-reply");
      const b = await loadB;
      // Pre-#117 the superseded load's chafa fallback aborted B here and the
      // displayed image silently degraded to chafa.
      expect(b.imageTier).toBe("native");
      expect(b.imageLines?.length ?? 0).toBeGreaterThan(0);
    } finally {
      setCapabilities(saved);
      resetCapabilitiesCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
