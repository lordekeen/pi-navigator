/**
 * index.ts unit and integration suites (Issue #063, Issue #095):
 * - makeWarningNotifier deduplication and channel isolation
 * - makeTreeTruncationWarner one-shot truncation policy (Issue #108)
 * - createViewerCache retention/eviction policy (Issues #020, #109, #112, D7)
 * - parseNavigatorArgs subcommand parsing
 * - navigatorCompletions argument prefix completions
 * - extension lifecycle: command registration, subcommand routing, help renderer, headless guard
 * - settings-menu integration through runSettings (Issues #121, #133): Esc leaves the
 *   settings file byte-identical, Save writes once, and both outcomes notify info
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  getCapabilities,
  KeybindingsManager,
  resetCapabilitiesCache,
  setCapabilities,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

import { IMAGE_NATIVE_CACHE_MAX_CHARS, MAX_FS_ENTRIES } from "../constants";
import { DEFAULT_PI_CHAFA_SUBSET, KITTY_PROBE_SAMPLE, makeImagePipeline, type ImageSupport, type KittyProbeVerdict } from "../images";
import { NAVIGATOR_CONFIG_FIELDS, serializeNavigatorSettings, type NavigatorSettings } from "../settings";
import type { ViewerFile } from "../types";
import { loadFile } from "../viewer";
import registerNavigatorExtension, {
  createViewerCache,
  isCacheableRender,
  makeTreeTruncationWarner,
  makeTuiKittyDecodeProbe,
  makeWarningNotifier,
  navigatorCompletions,
  parseNavigatorArgs,
  touchCacheEntry,
} from "../index";

/**
 * Test seam (Issue #121): the integration tests point getAgentDir at a
 * per-test temp dir so runSettings writes a scratch pi-navigator.json
 * instead of the real user config.
 */
const agentDir = vi.hoisted(() => ({ dir: "/tmp/pi-navigator-test" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => agentDir.dir };
});

function fakeUi() {
  const notify = vi.fn();
  return { ui: { notify }, notify };
}

function mockPi() {
  const commands = new Map<string, any>();
  const entryRenderers = new Map<string, any>();
  const entries: Array<{ type: string; data: any }> = [];
  // Issue #131: the extension registers three startup flags while loading, so
  // the harness models both halves of the host contract — the registrations
  // and the values a user actually passed. getFlag returns undefined for a
  // registered-but-unset flag, exactly like the host when no default was
  // declared, which is what makes "absent" observable.
  const flagRegistrations = new Map<string, any>();
  const flagValues = new Map<string, boolean | string>();
  const pi = {
    registerCommand: (name: string, def: any) => commands.set(name, def),
    registerEntryRenderer: (type: string, fn: any) => entryRenderers.set(type, fn),
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
    registerFlag: (name: string, options: any) => flagRegistrations.set(name, options),
    getFlag: (name: string) => flagValues.get(name),
    // driveFestive: runSettings probes for pi-chafa through the pi API; an
    // empty tool/command set is a clean "not present".
    getAllTools: () => [],
    getCommands: () => [],
  };
  return { pi: pi as any, commands, entryRenderers, entries, flagRegistrations, flagValues };
}

function mockCtx(opts: { hasUI?: boolean; cwd?: string; mode?: "tui" | "rpc" | "json" | "print" } = {}) {
  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = {
    hasUI: opts.hasUI ?? true,
    mode: opts.mode ?? "tui",
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
  it("routes `set` with its two trailing tokens, and reports missing ones as undefined (Issue #131)", () => {
    // `set` is reached through the shared subcommand table, so this assertion
    // doubles as a drift guard: removing the row would parse as `unknown`.
    expect(parseNavigatorArgs("set viewer.wrap on")).toEqual({ kind: "set", field: "viewer.wrap", value: "on" });
    expect(parseNavigatorArgs("set viewer.wrap")).toEqual({ kind: "set", field: "viewer.wrap", value: undefined });
    expect(parseNavigatorArgs("set")).toEqual({ kind: "set", field: undefined, value: undefined });
    expect(parseNavigatorArgs("  set  images.mode  native  ")).toEqual({ kind: "set", field: "images.mode", value: "native" });
    // Every other subcommand rejects trailing tokens instead of ignoring them.
    expect(parseNavigatorArgs("help extra")).toEqual({ kind: "extra", sub: "help", extra: ["extra"] });
  });
  it("parses empty or whitespace arguments as overlay", () => {
    expect(parseNavigatorArgs("")).toEqual({ kind: "overlay" });
    expect(parseNavigatorArgs("   ")).toEqual({ kind: "overlay" });
  });

  it("parses known subcommands settings and help", () => {
    expect(parseNavigatorArgs("settings")).toEqual({ kind: "settings" });
    expect(parseNavigatorArgs("  settings  ")).toEqual({ kind: "settings" });
    expect(parseNavigatorArgs("help")).toEqual({ kind: "help" });
  });

  it("routes the layout subcommands to the layout kind with their layout (Issue #119)", () => {
    expect(parseNavigatorArgs("all")).toEqual({ kind: "layout", layout: "files-git-viewer" });
    expect(parseNavigatorArgs("files")).toEqual({ kind: "layout", layout: "files-viewer" });
    expect(parseNavigatorArgs("git")).toEqual({ kind: "layout", layout: "git-viewer" });
    expect(parseNavigatorArgs("git  ")).toEqual({ kind: "layout", layout: "git-viewer" });
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
    // Issue #119: the three layout openers lead the table; #131 appends `set`.
    expect(values).toEqual(["all", "files", "git", "settings", "set", "help"]);
  });

  it("labels every completion with its token and describes the layout (Issue #139)", () => {
    const completions = navigatorCompletions("");
    expect(completions![0]).toEqual({
      value: "all",
      label: "all",
      description: "Open files + git + viewer overlay",
    });
    expect(completions![1]).toEqual({
      value: "files",
      label: "files",
      description: "Open files + viewer overlay",
    });
    expect(completions![2]).toEqual({
      value: "git",
      label: "git",
      description: "Open git + viewer overlay",
    });
    // The popup row name is what the user is typing, everywhere.
    for (const item of completions!) expect(item.label).toBe(item.value);
  });

  it("filters completions by prefix", () => {
    const set = navigatorCompletions("set");
    expect(set).toHaveLength(2);
    expect(set![0]?.value).toBe("settings");
    expect(set![1]?.value).toBe("set");

    const hel = navigatorCompletions("hel");
    expect(hel).toHaveLength(1);
    expect(hel![0]?.value).toBe("help");
  });

  it("returns an empty array when no completions match prefix (Issue #134)", () => {
    // `[]` is "I have nothing"; the old `null` meant "not my job" and handed the
    // argument slot back to another provider for our own argument list.
    expect(navigatorCompletions("xyz")).toEqual([]);
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

  it("refuses the overlay in RPC mode, where hasUI is true but custom() cannot mount (#122)", async () => {
    const { pi, commands } = mockPi();
    registerNavigatorExtension(pi);
    const cmd = commands.get("navigator");
    const { ctx, notifications } = mockCtx({ hasUI: true, mode: "rpc" });

    await cmd.handler("", ctx);
    expect(notifications).toEqual([
      { msg: "pi-navigator requires the interactive TUI", level: "warning" },
    ]);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("refuses the overlay in json and print modes via the tui-mode clause (#122)", async () => {
    for (const mode of ["json", "print"] as const) {
      const { pi, commands } = mockPi();
      registerNavigatorExtension(pi);
      const cmd = commands.get("navigator");
      const { ctx, notifications } = mockCtx({ hasUI: false, mode });

      await cmd.handler("", ctx);
      expect(notifications).toEqual([
        { msg: "pi-navigator requires the interactive TUI", level: "warning" },
      ]);
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    }
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

  it("registers the three startup flags without a default (Issue #131)", () => {
    const { pi, flagRegistrations } = mockPi();
    registerNavigatorExtension(pi);
    expect([...flagRegistrations.keys()].sort()).toEqual(["navigator-icons", "navigator-images", "navigator-layout"]);
    // A declared default is stored into the flag value by the host, so getFlag
    // would return it even when the user passed nothing — absent must stay
    // undefined for the precedence chain (defaults ← file ← env ← flag).
    for (const options of flagRegistrations.values()) expect(options.default).toBeUndefined();
    expect(flagRegistrations.get("navigator-icons")?.type).toBe("boolean");
    expect(flagRegistrations.get("navigator-images")?.type).toBe("string");
    expect(flagRegistrations.get("navigator-layout")?.type).toBe("string");
    // Issue #145: registration is a loop over the registry rows that declare a
    // flag, so names, types and descriptions cannot drift from the settings
    // table; no default key is ever added.
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      const flag = field.override?.flag;
      if (flag === undefined) continue;
      expect(flagRegistrations.get(flag.name)).toEqual({ type: flag.type, description: flag.description });
    }
  });

  it("carries a flag value into the settings loader, naming the flag when it is invalid (Issue #131)", async () => {
    // The loader's precedence is unit-tested; this pins the WIRING — the value
    // has to travel from pi.getFlag() into loadNavigatorSettings(). Two things
    // make it real: an invalid flag value is the observable, and the settings
    // load happens INSIDE the ctx.ui.custom factory, so the mock must invoke
    // that factory — a custom that never calls it would assert nothing, which
    // is the failure class Issue #114 recorded.
    const { pi, commands, flagValues } = mockPi();
    registerNavigatorExtension(pi);
    flagValues.set("navigator-images", "sixel");
    const notifications: Array<{ msg: string; level: string }> = [];
    const tui = {
      terminal: { rows: 24, write: vi.fn() },
      requestRender: vi.fn(),
      addInputListener: () => () => undefined,
    };
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
    let componentHolder: Array<{ handleInput: (data: string) => void }> = [];
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/test",
      ui: {
        notify: (msg: string, level: string) => notifications.push({ msg, level }),
        custom: (factory: (tui: unknown, th: unknown, kb: unknown, done: (value: null) => void) => unknown) => {
          const mounted = factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), () => undefined) as {
            handleInput: (data: string) => void;
          };
          componentHolder = [mounted];
          return Promise.resolve(mounted);
        },
      },
    } as any;

    await commands.get("navigator").handler("", ctx);
    expect(notifications.map((n) => n.msg).some((m) => m.includes("--navigator-images"))).toBe(true);

    // Close the mount so the poll timer is cleared (no leaked handles).
    componentHolder[0]?.handleInput("\u001b");
  });

  // ── /navigator set: the headless config path (Issue #131) ──

  it("writes a setting from a plain command with no UI mounted, in print mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-nav-set-"));
    agentDir.dir = dir;
    try {
      const { pi, commands } = mockPi();
      registerNavigatorExtension(pi);
      const { ctx, notifications } = mockCtx({ hasUI: false, mode: "print" });
      await commands.get("navigator").handler("set viewer.wrap on", ctx);
      const written = JSON.parse(readFileSync(join(dir, "pi-navigator.json"), "utf8"));
      expect(written.viewer.wrap).toBe(true);
      expect(notifications.some((n) => n.level === "info" && n.msg.includes("viewer.wrap"))).toBe(true);
      // Headless: the durable effect is the file, so no component is mounted
      // even though the mode could not host one.
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      agentDir.dir = "/tmp/pi-navigator-test";
    }
  });

  it("refuses an unknown field and a missing argument without writing anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-nav-set-"));
    agentDir.dir = dir;
    try {
      const { pi, commands } = mockPi();
      registerNavigatorExtension(pi);
      const { ctx, notifications } = mockCtx();
      await commands.get("navigator").handler("set bogus.field on", ctx);
      await commands.get("navigator").handler("set bogus.field", ctx);
      expect(notifications.some((n) => n.level === "warning" && n.msg.includes('unknown setting "bogus.field"'))).toBe(true);
      expect(notifications.some((n) => n.level === "warning" && n.msg.includes("usage: /navigator set"))).toBe(true);
      expect(existsSync(join(dir, "pi-navigator.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      agentDir.dir = "/tmp/pi-navigator-test";
    }
  });

  it("warns when a startup layer will shadow the value it just wrote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-nav-set-"));
    agentDir.dir = dir;
    try {
      const { pi, commands, flagValues } = mockPi();
      registerNavigatorExtension(pi);
      flagValues.set("navigator-layout", "git-viewer");
      const { ctx, notifications } = mockCtx();
      await commands.get("navigator").handler("set layout.default files-viewer", ctx);
      // The write is durable but this run ignores it — say so.
      expect(notifications.find((n) => n.level === "info")?.msg).toContain("--navigator-layout overrides it for this run");
      expect(JSON.parse(readFileSync(join(dir, "pi-navigator.json"), "utf8")).layout.default).toBe("files-viewer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      agentDir.dir = "/tmp/pi-navigator-test";
    }
  });

  // ── #134: rejects extra arguments, and suggests near misses ──

  it("rejects a trailing argument with a one-line usage and opens nothing", async () => {
    const { pi, commands } = mockPi();
    registerNavigatorExtension(pi);
    const { ctx, notifications } = mockCtx();
    await commands.get("navigator").handler("all extra", ctx);
    expect(notifications.map((n) => n.msg)).toContain(
      'pi-navigator: unexpected argument "extra" — usage: /navigator all',
    );
    // A rejected invocation must not also mount the overlay.
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("rejects a third token after `set`'s value, with the value syntax in the usage", async () => {
    const { pi, commands } = mockPi();
    registerNavigatorExtension(pi);
    const { ctx, notifications } = mockCtx();
    await commands.get("navigator").handler("set viewer.wrap on now", ctx);
    expect(notifications.map((n) => n.msg)).toContain(
      'pi-navigator: unexpected argument "now" — usage: /navigator set <setting> <value>',
    );
  });

  it("suggests the correction for a near miss, and stays quiet for an unrelated token", async () => {
    const { pi, commands } = mockPi();
    registerNavigatorExtension(pi);
    const { ctx, notifications } = mockCtx();
    await commands.get("navigator").handler("setting", ctx);
    expect(notifications.map((n) => n.msg)).toContain(
      'pi-navigator: unknown subcommand "setting" — did you mean "/navigator settings"?',
    );
    await commands.get("navigator").handler("zzz", ctx);
    const messages = notifications.map((n) => n.msg);
    expect(messages).toContain('pi-navigator: unknown subcommand "zzz"');
    // A token that is not a plausible typo gets no suggestion at all.
    expect(messages.some((m) => m.includes('"zzz"') && m.includes("did you mean"))).toBe(false);
  });

  it("threads the injected KeybindingsManager into the overlay, so Ctrl+C cancels (Issues #125/#126)", async () => {
    const { pi, commands } = mockPi();
    registerNavigatorExtension(pi);
    const cmd = commands.get("navigator");

    const tui = {
      terminal: { rows: 24, write: vi.fn() },
      requestRender: vi.fn(),
      addInputListener: () => () => undefined,
    };
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
    const done = vi.fn();
    let component: { handleInput: (data: string) => void } | null = null;
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/test",
      ui: {
        notify: vi.fn(),
        custom: vi.fn(
          (factory: (tui: unknown, th: unknown, kb: unknown, done: (value: null) => void) => unknown) => {
            component = factory(tui, theme, keybindings, done) as { handleInput: (data: string) => void };
            return Promise.resolve(component);
          },
        ),
      },
    } as any;

    await cmd.handler("", ctx);
    expect(component).not.toBeNull();
    // Ctrl+C is the host's cancel alias (tui.select.cancel, default keys
    // Escape + Ctrl+C): with the manager threaded from the custom factory
    // into the overlay it cancels — closing the overlay — instead of being
    // swallowed. Closing also tears the mount down (no poll timers leak).
    component!.handleInput("\x03");
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(null);
  });
});

/** mockCtx variant that records every ctx.ui.custom call's arguments. */
function mockCtxWithCustomCapture(calls: unknown[][]): { ctx: any; notifications: Array<{ msg: string; level: string }> } {
  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
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
    const kitty = file({
      relPath: "img.png",
      kind: "image",
      imageVerdict: { kind: "rendered", renderer: "native", lines: ["\x1b_Gf=100..."], cols: 2, rows: 2 },
    });
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
      imageVerdict: {
        kind: "rendered",
        renderer: "native",
        lines: ["x".repeat(IMAGE_NATIVE_CACHE_MAX_CHARS + 1)],
        cols: 2,
        rows: 2,
      },
    });
    cache.store("big.png", { cacheable: true, variant: "native:iterm2:2x2", file: over });
    expect(cache.size).toBe(0);

    const under = file({
      relPath: "small.png",
      kind: "image",
      imageVerdict: {
        kind: "rendered",
        renderer: "native",
        lines: ["y".repeat(IMAGE_NATIVE_CACHE_MAX_CHARS - 1)],
        cols: 2,
        rows: 2,
      },
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

describe("makeImagePipeline (Issues #116/#144)", () => {
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

  it("binds the pipeline to the owning load's signal: live it reads, aborted it short-circuits (Issue #117 follow-up)", async () => {
    const controller = new AbortController();
    const pipeline = makeImagePipeline(
      snapshot({ mode: "native", chafa: { state: "deferred" } }),
      { cols: 10, rows: 5 },
      { probeDecode: neverProbe, signal: controller.signal },
    );
    expect(pipeline.attempts).toEqual(["native"]);

    // A live load forwards its signal: the native attempt reaches the bounded
    // read and fails cleanly on the missing path.
    await expect(pipeline.render("/work/missing.png")).resolves.toEqual({
      kind: "failed",
      renderer: "native",
      reason: "could not read the image file",
    });

    // A superseded load (its own signal aborted) short-circuits before any
    // read or chafa child.
    controller.abort();
    await expect(pipeline.render("/work/missing.png")).resolves.toEqual({ kind: "aborted" });
  });

  it("a superseded load's abort stops its list, so the newest load stays native (Issue #117)", async () => {
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

      const req = { cols: 20, rows: 10 };
      const pipelineA = makeImagePipeline(snapshot(), req, {
        probeDecode: () => {
          markAEntered();
          return gateA;
        },
        signal: controllerA.signal,
      });
      const pipelineB = makeImagePipeline(snapshot(), req, {
        probeDecode: () => {
          markBEntered();
          return gateB;
        },
        signal: controllerB.signal,
      });

      // Load A parks on its probe with its own controller; load B's start
      // (beginImageLoad) aborts A, exactly like index.ts.
      const loadA = loadFile(png, "a.png", { image: req, imageRenderer: pipelineA.render });
      await aEntered;
      controllerA.abort();
      const loadB = loadFile(png, "b.png", { image: req, imageRenderer: pipelineB.render });
      await bEntered;

      releaseA("no-reply");
      const a = await loadA;
      // A supersession stamps a card with no failure at all (Issue #144); the
      // superseding load's sequence guard discards the result anyway.
      expect(a.imageVerdict).toEqual({ kind: "card" });

      // Defense in depth: even if the superseded pipeline were asked again, it
      // can only observe its own aborted signal — load B's controller is
      // untouched, and the abort stops before the chafa fallback would spawn.
      await expect(pipelineA.render(png)).resolves.toEqual({ kind: "aborted" });

      releaseB("no-reply");
      const b = await loadB;
      // Pre-#117 the superseded load's chafa fallback aborted B here and the
      // displayed image silently degraded to chafa.
      expect(b.imageVerdict?.kind).toBe("rendered");
      expect(b.imageVerdict?.kind === "rendered" && b.imageVerdict.renderer).toBe("native");
      expect(b.imageVerdict?.kind === "rendered" && b.imageVerdict.lines.length > 0).toBe(true);
    } finally {
      setCapabilities(saved);
      resetCapabilitiesCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings menu integration via runSettings (Issues #121, #133)", () => {
  const KEYS = { enter: "\r", down: "\x1b[B", escape: "\x1b" } as const;

  /** A tui-mode ctx whose ui.custom mounts the real menu and closes on done(). */
  function mockSettingsCtx(): {
    ctx: any;
    notifications: Array<{ msg: string; level: string }>;
    ready: Promise<void>;
    getComponent: () => { render(width: number): string[]; handleInput?(data: string): void };
  } {
    let component: { render(width: number): string[]; handleInput?(data: string): void } | undefined;
    let resolveReady!: () => void;
    let resolveClosed!: (value?: unknown) => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
    const closed = new Promise<unknown>((resolve) => { resolveClosed = resolve; });
    const notifications: Array<{ msg: string; level: string }> = [];
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/work",
      ui: {
        notify: (msg: string, level: string) => notifications.push({ msg, level }),
        custom: (factory: (tui: unknown, th: unknown, keybindings: unknown, done: (value?: unknown) => void) => unknown) => {
          const result = factory({}, theme, {}, (value?: unknown) => resolveClosed(value));
          component = result as typeof component;
          resolveReady();
          return closed;
        },
      },
    };
    return {
      ctx,
      notifications,
      ready,
      getComponent: () => {
        if (component === undefined) throw new Error("settings menu component was not created");
        return component;
      },
    };
  }

  function writeSettingsFile(dir: string, settings: NavigatorSettings): string {
    const filePath = join(dir, "pi-navigator.json");
    writeFileSync(filePath, JSON.stringify(serializeNavigatorSettings(settings), null, 2), "utf8");
    return filePath;
  }

  it("Esc after edits leaves the settings file byte-identical and reports info (cancelled) (#121, #133)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nav121-esc-"));
    agentDir.dir = dir;
    const settings: NavigatorSettings = {
      version: 1,
      images: { mode: "chafa" },
      icons: { enabled: true },
      viewer: { wrap: true, markdown: "rendered" },
      tree: { showHidden: true, respectGitignore: true },
      layout: { default: "git-viewer" },
    };
    const filePath = writeSettingsFile(dir, settings);
    const before = readFileSync(filePath, "utf8");
    try {
      const { pi, commands } = mockPi();
      registerNavigatorExtension(pi);
      const cmd = commands.get("navigator");
      const harness = mockSettingsCtx();
      const pending = cmd.handler("settings", harness.ctx);
      await harness.ready;

      harness.getComponent().handleInput?.(KEYS.enter); // images.mode chafa -> native (staged)
      harness.getComponent().handleInput?.(KEYS.escape); // cancel: discard the draft
      await pending;

      expect(readFileSync(filePath, "utf8")).toBe(before);
      expect(harness.notifications).toContainEqual({
        msg: "pi-navigator: settings unchanged (cancelled)",
        level: "info",
      });
      expect(harness.notifications.filter((n) => n.level === "warning")).toEqual([]);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Save row writes the draft exactly once and reports count + file as info (#121, #133)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nav121-save-"));
    agentDir.dir = dir;
    const settings: NavigatorSettings = {
      version: 1,
      images: { mode: "off" },
      icons: { enabled: false },
      viewer: { wrap: false, markdown: "code" },
      tree: { showHidden: false, respectGitignore: true },
      layout: { default: "files-git-viewer" },
    };
    const filePath = writeSettingsFile(dir, settings);
    try {
      const { pi, commands } = mockPi();
      registerNavigatorExtension(pi);
      const cmd = commands.get("navigator");
      const harness = mockSettingsCtx();
      const pending = cmd.handler("settings", harness.ctx);
      await harness.ready;

      const component = harness.getComponent();
      component.handleInput?.(KEYS.enter); // images.mode off -> chafa (staged)
      component.handleInput?.(KEYS.down); // icons.enabled
      component.handleInput?.(KEYS.enter); // false -> true (staged)
      for (let i = 0; i < 6; i++) component.handleInput?.(KEYS.down); // to the Save row
      component.handleInput?.(KEYS.enter); // Save: one commit, then close
      await pending;

      const after = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      expect(after).toEqual(
        serializeNavigatorSettings({ ...settings, images: { mode: "chafa" }, icons: { enabled: true } }),
      );
      expect(harness.notifications).toContainEqual({
        msg: `pi-navigator: settings saved (2 fields) \u2192 ${filePath}`,
        level: "info",
      });
      expect(harness.notifications.filter((n) => n.level === "warning")).toEqual([]);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the settings menu in every non-TUI mode (#122)", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const { pi, commands } = mockPi();
      registerNavigatorExtension(pi);
      const cmd = commands.get("navigator");
      const { ctx, notifications } = mockCtx({ hasUI: mode === "rpc", mode });

      await cmd.handler("settings", ctx);
      expect(notifications).toEqual([
        { msg: "pi-navigator settings requires the interactive TUI", level: "warning" },
      ]);
      expect(ctx.ui.custom).not.toHaveBeenCalled();
    }
  });
});
