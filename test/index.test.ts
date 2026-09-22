/**
 * index.ts unit and integration suites (Issue #063, Issue #095):
 * - makeWarningNotifier deduplication and channel isolation
 * - parseNavigatorArgs subcommand parsing
 * - navigatorCompletions argument prefix completions
 * - extension lifecycle: command registration, subcommand routing, help renderer, headless guard
 */

import { describe, expect, it, vi } from "vitest";

import registerNavigatorExtension, {
  makeWarningNotifier,
  navigatorCompletions,
  parseNavigatorArgs,
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