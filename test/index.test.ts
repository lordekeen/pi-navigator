/**
 * index.ts unit and integration suites (Issue #063, Issue #095):
 * - makeWarningNotifier deduplication and channel isolation
 * - parseNavigatorArgs subcommand parsing
 * - navigatorCompletions argument prefix completions
 * - extension lifecycle: command registration, subcommand routing, help renderer, headless guard
 */

import { describe, expect, it, vi } from "vitest";

import { KITTY_PROBE_SAMPLES } from "../images";
import registerNavigatorExtension, {
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
    expect(values).toContain("settings");
    expect(values).toContain("help");
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
  });
});
describe("makeTuiKittyDecodeProbe (Issue #101)", () => {
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

  it("writes one a=q query with the matching PNG sample and resolves ok when the terminal replies OK (Issue #101)", async () => {
    const { tui, writes, emit } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const pending = probe("image/png");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("a=q,t=d,f=100");
    expect(writes[0]).toContain(KITTY_PROBE_SAMPLES["image/png"]);
    const id = /i=(\d+)/.exec(writes[0] ?? "")?.[1];
    expect(id).toBeDefined();
    const result = emit(`\x1b_Gi=${id};OK\x1b\\`);
    expect(result).toEqual({ consume: true });
    await expect(pending).resolves.toBe("ok");
  });

  it("resolves error on an explicit decode error reply, probing JPEG with the JPEG sample (Issue #102)", async () => {
    const { tui, writes, emit } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    // Distinct mime key: the module-level probe cache is keyed on it.
    const pending = probe("image/jpeg");
    // The regression this issue fixes: a JPEG probe must transmit the JPEG
    // sample, never the PNG one (a PNG probe would pass strict decoders that
    // reject the real JPEG payload).
    expect(writes[0]).toContain(KITTY_PROBE_SAMPLES["image/jpeg"]);
    expect(writes[0]).not.toContain(KITTY_PROBE_SAMPLES["image/png"]);
    const id = /i=(\d+)/.exec(writes[0] ?? "")?.[1];
    emit(`\x1b_Gi=${id};bad image\x1b\\`);
    await expect(pending).resolves.toBe("error");
  });

  it("reassembles a reply split across chunks and passes unrelated input through (Issue #101)", async () => {
    const { tui, writes, emit } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const pending = probe("image/webp");
    expect(writes[0]).toContain(KITTY_PROBE_SAMPLES["image/webp"]);
    expect(writes[0]).not.toContain(KITTY_PROBE_SAMPLES["image/png"]);
    const id = /i=(\d+)/.exec(writes[0] ?? "")?.[1];
    expect(emit("some user keystrokes")).toBeUndefined();
    expect(emit(`\x1b_Gi=${id};O`)).toBeUndefined(); // partial: never consumed
    expect(emit("K\x1b\\")).toEqual({ consume: true });
    await expect(pending).resolves.toBe("ok");
  });

  it("resolves no-reply without writing or subscribing for a mime with no probe sample (Issue #102)", async () => {
    const { tui, writes, isSubscribed } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const pending = probe("image/gif");
    expect(writes).toHaveLength(0);
    expect(isSubscribed()).toBe(false);
    await expect(pending).resolves.toBe("no-reply");
  });

  it("resolves no-reply on timeout, unsubscribes, and ignores a late reply (Issue #102)", async () => {
    vi.useFakeTimers();
    try {
      // Fresh cache: this timeout path must not ride earlier probes' verdicts.
      const { tui, writes, emit, isSubscribed } = fakeTui();
      const probe = makeTuiKittyDecodeProbe(tui, { timeoutMs: 250, cache: new Map() });
      const pending = probe("image/png");
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

  it("memoizes per mime: a second probe reuses the first query and promise (Issue #101)", async () => {
    const { tui, writes } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const first = probe("image/tiff");
    const second = probe("image/tiff");
    expect(second).toBe(first); // same cached promise
    expect(writes).toHaveLength(0); // no sample, so no query is written
    await expect(first).resolves.toBe("no-reply");
    const other = probe("image/bmp");
    expect(other).not.toBe(first);
    expect(writes).toHaveLength(0);
    await expect(other).resolves.toBe("no-reply");
  });

  it("passes unrelated input through untouched for a no-sample probe (Issue #102)", async () => {
    const { tui, writes, emit } = fakeTui();
    const probe = makeTuiKittyDecodeProbe(tui);
    const pending = probe("image/avif");
    expect(writes).toHaveLength(0);
    // No listener was registered (nothing was transmitted), so input is never
    // consumed and the verdict is the conservative "no-reply".
    expect(emit("some user keystrokes")).toBeUndefined();
    expect(emit("\x1b[97u")).toBeUndefined();
    await expect(pending).resolves.toBe("no-reply");
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
