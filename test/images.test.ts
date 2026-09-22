/**
 * images.ts unit suite (spec §12.2): pi-chafa detection, config mirror, chafa
 * probe, render args/sanitizer, geometry, host settings, and the aggregate
 * support resolution. Every test injects readText/exec — no real $HOME, no
 * real chafa, no real settings files.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCapabilities,
  resetCapabilitiesCache,
  setCapabilities,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { IMAGE_NATIVE_MAX_BYTES } from "../constants";
import {
  DEFAULT_PI_CHAFA_SUBSET,
  buildSymbolsArgs,
  detectPiChafa,
  loadPiChafaConfig,
  makeDeferredImageSupport,
  probeChafa,
  readHostImageSettings,
  resolveChafaGeometry,
  resolveImageSupport,
  resolveNativeProtocol,
  runChafaRender,
  runNativeRender,
  sanitizeChafaPayload,
} from "../images";
import type { ExecFn, PiChafaApi, ReadText } from "../images";

/** Fixture readText: returns the mapped file contents, undefined otherwise. */
const readTextOf = (entries: Record<string, string>): ReadText => (path) =>
  entries[path];

const okProbeExec: ExecFn = async () => ({
  stdout: "Chafa version 1.18.2\n",
  stderr: "",
});

const failProbeExec: ExecFn = async () => {
  const error = new Error("spawn chafa ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  throw error;
};

describe("loadPiChafaConfig", () => {
  const agentDir = "/home/user/.pi/agent";
  const configPath = `${agentDir}/pi-chafa.json`;

  it("reads the fixture file and applies the full CHAFA_* env precedence table over it", () => {
    const readText = readTextOf({
      [configPath]: JSON.stringify({
        version: 1,
        cellWidth: 40,
        maxRows: 30,
        colors: "16",
        symbolsSet: "block",
        dither: "ordered",
        timeoutMs: 5000,
        binaryPath: "/usr/bin/chafa",
      }),
    });
    expect(
      loadPiChafaConfig({
        agentDir,
        env: {
          CHAFA_BIN: "/opt/chafa",
          CHAFA_CELL_WIDTH: "70",
          CHAFA_MAX_ROWS: "45",
          CHAFA_COLORS: "256",
          CHAFA_SYMBOLS: "ascii",
          CHAFA_DITHER: "diffusion",
          CHAFA_TIMEOUT_MS: "12000",
        },
        readText,
      }),
    ).toEqual({
      version: 1,
      binaryPath: "/opt/chafa",
      cellWidth: 70,
      maxRows: 45,
      colors: "256",
      symbolsSet: "ascii",
      dither: "diffusion",
      timeoutMs: 12000,
      preferNative: true,
    });
  });

  it("lets CHAFA_CONFIG_DIR win over agentDir for locating the file", () => {
    const readText = readTextOf({
      "/cfg/dir/pi-chafa.json": JSON.stringify({ colors: "8" }),
    });
    const config = loadPiChafaConfig({
      agentDir,
      env: { CHAFA_CONFIG_DIR: "/cfg/dir/" },
      readText,
    });
    expect(config.colors).toBe("8");
    expect(config.cellWidth).toBe(60); // file only set colors
    expect(config.binaryPath).toBeNull();
  });

  it("skips invalid env values silently — file/default wins — and treats empty env as absent", () => {
    const readText = readTextOf({
      [configPath]: JSON.stringify({
        colors: "16",
        maxRows: 30,
        dither: "ordered",
      }),
    });
    const config = loadPiChafaConfig({
      agentDir,
      env: {
        CHAFA_COLORS: "hotpink",
        CHAFA_MAX_ROWS: "abc",
        CHAFA_DITHER: "   ",
        CHAFA_BIN: "  ",
        CHAFA_TIMEOUT_MS: "-5",
        CHAFA_CELL_WIDTH: "1.5",
        CHAFA_SYMBOLS: "",
      },
      readText,
    });
    expect(config.colors).toBe("16");
    expect(config.maxRows).toBe(30);
    expect(config.dither).toBe("ordered");
    expect(config.binaryPath).toBeNull();
    expect(config.timeoutMs).toBe(8000);
    expect(config.cellWidth).toBe(60);
    expect(config.symbolsSet).toBe("block+border");
  });

  it("mirrors preferNative from the file and overlays CHAFA_PREFER_NATIVE (envBoolean semantics)", () => {
    const fileWith = (preferNative: unknown): ReadText =>
      readTextOf({ [configPath]: JSON.stringify({ preferNative }) });
    // File value honored when no env override.
    expect(
      loadPiChafaConfig({ agentDir, readText: fileWith(false) }).preferNative,
    ).toBe(false);
    expect(
      loadPiChafaConfig({ agentDir, readText: fileWith(true) }).preferNative,
    ).toBe(true);
    // Truthy env tokens win over the file (case-insensitive, trimmed).
    for (const token of ["1", "true", "yes", "on", " TRUE ", "Yes"]) {
      expect(
        loadPiChafaConfig({
          agentDir,
          readText: fileWith(false),
          env: { CHAFA_PREFER_NATIVE: token },
        }).preferNative,
      ).toBe(true);
    }
    // Falsy env tokens win over the file (case-insensitive, trimmed).
    for (const token of ["0", "false", "no", "off", " FALSE ", "Off"]) {
      expect(
        loadPiChafaConfig({
          agentDir,
          readText: fileWith(true),
          env: { CHAFA_PREFER_NATIVE: token },
        }).preferNative,
      ).toBe(false);
    }
  });

  it("ignores invalid CHAFA_PREFER_NATIVE and non-boolean file values silently", () => {
    // Invalid env falls back to the file value (pi-chafa ignores it silently).
    const readText = readTextOf({
      [configPath]: JSON.stringify({ preferNative: false }),
    });
    for (const garbage of ["maybe", "", "   ", "2", "nope"]) {
      expect(
        loadPiChafaConfig({
          agentDir,
          readText,
          env: { CHAFA_PREFER_NATIVE: garbage },
        }).preferNative,
      ).toBe(false);
    }
    // Non-boolean file values are skipped → default true.
    for (const value of ["yes", 1, null, "false", []]) {
      expect(
        loadPiChafaConfig({
          agentDir,
          readText: readTextOf({
            [configPath]: JSON.stringify({ preferNative: value }),
          }),
        }).preferNative,
      ).toBe(true);
    }
    // Absent everywhere → default true.
    expect(loadPiChafaConfig({ agentDir, readText: readTextOf({}) }).preferNative).toBe(
      true,
    );
  });

  it("skips unknown keys and invalid file values silently", () => {
    const readText = readTextOf({
      [configPath]: JSON.stringify({
        version: 2,
        preferNative: "yes", // non-boolean → skipped, default stands
        formatOrder: ["native"],
        colors: "hotpink",
        cellWidth: -3,
        symbolsSet: "  border  ",
        binaryPath: "",
        timeoutMs: 0,
      }),
    });
    const config = loadPiChafaConfig({ agentDir, readText });
    expect(config.version).toBe(2);
    expect(config.colors).toBe("240");
    expect(config.cellWidth).toBe(60);
    expect(config.symbolsSet).toBe("border");
    expect(config.binaryPath).toBeNull();
    expect(config.timeoutMs).toBe(8000);
    expect(config.preferNative).toBe(true);
  });

  it("falls back to defaults on corrupt JSON and missing files", () => {
    expect(
      loadPiChafaConfig({
        agentDir,
        readText: readTextOf({ [configPath]: "{not json" }),
      }),
    ).toEqual(DEFAULT_PI_CHAFA_SUBSET);
    expect(loadPiChafaConfig({ agentDir, readText: readTextOf({}) })).toEqual(
      DEFAULT_PI_CHAFA_SUBSET,
    );
  });
});

describe("detectPiChafa", () => {
  const paths = {
    userSettings: "/home/user/.pi/agent/settings.json",
    projectSettings: "/cwd/.pi/settings.json",
  };
  const noTools: PiChafaApi = { getAllTools: () => [], getCommands: () => [] };

  it("matches at runtime via the ancestor walk to the pi-chafa package.json", () => {
    const readText = readTextOf({
      "/pkg/pi-chafa/package.json": JSON.stringify({ name: "pi-chafa" }),
    });
    const api: PiChafaApi = {
      getAllTools: () => [
        {
          name: "show_image",
          sourceInfo: {
            path: "/pkg/pi-chafa/src/index.js",
            baseDir: "/pkg/pi-chafa/src",
          },
        },
      ],
      getCommands: () => [],
    };
    expect(detectPiChafa(api, paths, { readText })).toEqual({
      present: true,
      via: "runtime",
      packageRoot: "/pkg/pi-chafa",
    });
  });

  it("confirms identity via sourceInfo.baseDir when the package.json sits there", () => {
    const readText = readTextOf({
      "/pkg/pi-chafa/dist/package.json": JSON.stringify({ name: "pi-chafa" }),
    });
    const api: PiChafaApi = {
      getAllTools: () => [
        {
          name: "show_image",
          sourceInfo: { path: "/pkg/pi-chafa/dist/index.js", baseDir: "/pkg/pi-chafa/dist" },
        },
      ],
      getCommands: () => [],
    };
    expect(detectPiChafa(api, paths, { readText })).toEqual({
      present: true,
      via: "runtime",
      packageRoot: "/pkg/pi-chafa/dist",
    });
  });

  it("does not match a show_image tool whose package is named something else", () => {
    const readText = readTextOf({
      "/pkg/other/package.json": JSON.stringify({ name: "pi-navigator" }),
      [paths.userSettings]: JSON.stringify({ packages: [] }),
      [paths.projectSettings]: "{}",
    });
    const api: PiChafaApi = {
      getAllTools: () => [
        { name: "show_image", sourceInfo: { path: "/pkg/other/index.js" } },
      ],
      getCommands: () => [],
    };
    expect(detectPiChafa(api, paths, { readText })).toEqual({
      present: false,
      via: "none",
    });
  });

  it("falls back to the images extension command when no show_image tool exists", () => {
    const readText = readTextOf({
      "/ext/pi-chafa/package.json": JSON.stringify({ name: "pi-chafa" }),
    });
    const api: PiChafaApi = {
      getAllTools: () => [],
      getCommands: () => [
        {
          name: "images",
          source: "extension",
          sourceInfo: { path: "/ext/pi-chafa/dist/index.js" },
        },
      ],
    };
    expect(detectPiChafa(api, paths, { readText })).toEqual({
      present: true,
      via: "runtime",
      packageRoot: "/ext/pi-chafa",
    });
  });

  it("does not treat a non-extension images command as evidence", () => {
    const api: PiChafaApi = {
      getAllTools: () => [],
      getCommands: () => [
        { name: "images", source: "prompt", sourceInfo: { path: "/x/index.js" } },
      ],
    };
    expect(detectPiChafa(api, paths, { readText: readTextOf({}) })).toEqual({
      present: false,
      via: "none",
    });
  });

  it("prefers runtime evidence over the settings listing", () => {
    const readText = readTextOf({
      "/pkg/pi-chafa/package.json": JSON.stringify({ name: "pi-chafa" }),
      [paths.userSettings]: JSON.stringify({ packages: ["npm:pi-chafa"] }),
    });
    const api: PiChafaApi = {
      getAllTools: () => [
        { name: "show_image", sourceInfo: { path: "/pkg/pi-chafa/index.js" } },
      ],
      getCommands: () => [],
    };
    expect(detectPiChafa(api, paths, { readText })).toEqual({
      present: true,
      via: "runtime",
      packageRoot: "/pkg/pi-chafa",
    });
  });

  it("finds pi-chafa in the settings packages listing (user and project)", () => {
    expect(
      detectPiChafa(noTools, paths, {
        readText: readTextOf({
          [paths.userSettings]: JSON.stringify({ packages: ["npm:pi-chafa"] }),
        }),
      }),
    ).toEqual({ present: true, via: "settings" });
    expect(
      detectPiChafa(noTools, paths, {
        readText: readTextOf({
          [paths.projectSettings]: JSON.stringify({ packages: ["npm:pi-chafa"] }),
        }),
      }),
    ).toEqual({ present: true, via: "settings" });
  });

  it("matches relative paths, scoped npm names, and pinned versions", () => {
    for (const entry of [
      "../../Sources/pi-chafa",
      "/abs/path/pi-chafa",
      "npm:@scope/pi-chafa",
      "npm:pi-chafa@1.0.0",
      "npm:pi-chafa/",
      "npm:pi-chafa@next",
    ]) {
      expect(
        detectPiChafa(noTools, paths, {
          readText: readTextOf({
            [paths.userSettings]: JSON.stringify({ packages: [entry] }),
          }),
        }),
      ).toEqual({ present: true, via: "settings" });
    }
  });

  it("rejects non-matching package entries", () => {
    expect(
      detectPiChafa(noTools, paths, {
        readText: readTextOf({
          [paths.userSettings]: JSON.stringify({
            packages: [
              "npm:pi-navigator",
              "npm:pi-chafa-extra",
              "npm:@scope/pi-navigator",
              "pi-chafa-src",
              "npm:pi-chaf",
            ],
          }),
        }),
      }),
    ).toEqual({ present: false, via: "none" });
  });

  it("does not count a readable pi-chafa.json as presence evidence (D3)", () => {
    expect(
      detectPiChafa(noTools, paths, {
        readText: readTextOf({
          "/home/user/.pi/agent/pi-chafa.json": JSON.stringify({ colors: "256" }),
        }),
      }),
    ).toEqual({ present: false, via: "none" });
  });

  it("tolerates missing provenance and malformed settings", () => {
    expect(
      detectPiChafa(
        {
          getAllTools: () => [{ name: "show_image" }],
          getCommands: () => [],
        },
        paths,
        { readText: readTextOf({}) },
      ),
    ).toEqual({ present: false, via: "none" });
    expect(
      detectPiChafa(noTools, paths, {
        readText: readTextOf({
          [paths.userSettings]: "{not json",
          [paths.projectSettings]: "[]",
        }),
      }),
    ).toEqual({ present: false, via: "none" });
  });
});

describe("probeChafa", () => {
  it("parses the version and uses the trimmed binaryPath", async () => {
    const exec: ExecFn = async (bin, args, opts) => {
      expect(bin).toBe("/usr/bin/chafa");
      expect(args).toEqual(["--version"]);
      expect(opts.timeout).toBe(3000);
      expect(opts.maxBuffer).toBe(1024 * 1024);
      return { stdout: "Chafa version 1.18.2\n", stderr: "" };
    };
    expect(await probeChafa("  /usr/bin/chafa  ", exec)).toEqual({
      state: "ok",
      binary: "/usr/bin/chafa",
      version: { major: 1, minor: 18 },
    });
  });

  it("defaults to chafa on PATH and accepts exactly the minimum version", async () => {
    const exec: ExecFn = async (bin) => {
      expect(bin).toBe("chafa");
      return { stdout: "Chafa version 1.10.0\n", stderr: "" };
    };
    expect(await probeChafa(null, exec)).toEqual({
      state: "ok",
      binary: "chafa",
      version: { major: 1, minor: 10 },
    });
  });

  it("rejects versions below the minimum with the upgrade hint", async () => {
    const exec: ExecFn = async () => ({
      stdout: "Chafa version 1.9.3\n",
      stderr: "",
    });
    const status = await probeChafa(null, exec);
    expect(status.state).toBe("too-old");
    if (status.state === "too-old") {
      expect(status.detail).toContain(
        "chafa 1.9 is older than the minimum supported version 1.10",
      );
      expect(status.detail).toContain("Upgrade chafa (");
      expect(status.detail).toContain("or point CHAFA_BIN at a newer binary.");
    }
  });

  it("reports ENOENT as missing with the verbatim install hint", async () => {
    const status = await probeChafa("/no/such/chafa", failProbeExec);
    expect(status.state).toBe("missing");
    if (status.state === "missing") {
      expect(status.detail).toBe(
        "chafa was not found on PATH (looked for /no/such/chafa). Install it with: apt install chafa (or your distro's package). Or set CHAFA_BIN to its absolute path.",
      );
    }
  });

  it("reports unparsable output as an error", async () => {
    const exec: ExecFn = async () => ({ stdout: "chafa version 1.18.2\n", stderr: "" });
    expect(await probeChafa(null, exec)).toEqual({
      state: "error",
      detail: `Could not parse a version from "chafa --version". Is chafa really chafa?`,
    });
  });

  it("reports other exec failures as a bounded error", async () => {
    const exec: ExecFn = async () => {
      throw new Error("permission denied");
    };
    const status = await probeChafa(null, exec);
    expect(status.state).toBe("error");
    if (status.state === "error") {
      expect(status.detail).toBe("Failed to run chafa --version: permission denied");
    }
  });
});

describe("buildSymbolsArgs", () => {
  it("builds the exact pi-chafa argv vector for a fixed config and geometry", () => {
    expect(
      buildSymbolsArgs(
        "/tmp/sample.png",
        {
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
        { cols: 40, rows: 20 },
      ),
    ).toEqual([
      "--format",
      "symbols",
      "--relative",
      "off",
      "--size",
      "40x20",
      "--colors",
      "240",
      "--symbols",
      "block+border",
      "--dither",
      "none",
      "--animate",
      "off",
      "/tmp/sample.png",
    ]);
  });
});

describe("sanitizeChafaPayload", () => {
  const geometry = { cols: 40, rows: 10 };

  it("passes an SGR-only payload through with no trailing newlines", () => {
    const out = sanitizeChafaPayload(
      "\x1b[38;5;123m██\x1b[0m\n\x1b[31m█\x1b[0m",
      geometry,
    );
    expect(out).toEqual({
      ok: true,
      lines: ["\x1b[38;5;123m██\x1b[0m", "\x1b[31m█\x1b[0m"],
    });
    if (out.ok) {
      for (const line of out.lines) expect(line.endsWith("\n")).toBe(false);
    }
  });

  it("drops chafa's cursor-hide/show escapes and trailing empty lines", () => {
    const out = sanitizeChafaPayload(
      "\x1b[?25l\x1b[32mline one\x1b[0m\nline two\nline three\n\n\n\x1b[?25h\n",
      geometry,
    );
    expect(out).toEqual({
      ok: true,
      lines: ["\x1b[32mline one\x1b[0m", "line two\x1b[0m", "line three\x1b[0m"],
    });
    if (out.ok) {
      expect(out.lines.join("|")).not.toContain("?25l");
      expect(out.lines.join("|")).not.toContain("?25h");
    }
  });

  it("strips carriage returns", () => {
    const out = sanitizeChafaPayload("a\r\nb\r", geometry);
    expect(out).toEqual({ ok: true, lines: ["a\x1b[0m", "b\x1b[0m"] });
    if (out.ok) expect(out.lines.join("")).not.toContain("\r");
  });

  it("rejects any other non-SGR escape sequence", () => {
    for (const hostile of [
      "\x1b[2J",
      "\x1b[1;2H",
      "\x1b]0;title\x07",
      "\x1b[?25l\x1b[2J",
      "\x1b[?25hrest\x1b[1A",
      "lone \x1b at end",
      "\x1b[31", // unterminated SGR
    ]) {
      expect(sanitizeChafaPayload(hostile, geometry)).toEqual({
        ok: false,
        reason: "unexpected escape sequence",
      });
    }
  });

  it("appends a trailing reset to rows that lack one", () => {
    const out = sanitizeChafaPayload("\x1b[31mred\x1b[39m\nplain", geometry);
    expect(out).toEqual({
      ok: true,
      lines: ["\x1b[31mred\x1b[39m\x1b[0m", "plain\x1b[0m"],
    });
  });

  it("truncates over-wide rows to exactly cols with no bright ellipsis", () => {
    const out = sanitizeChafaPayload(`\x1b[33m${"x".repeat(60)}\x1b[0m`, geometry);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const line = out.lines[0];
    expect(line).toBe(`\x1b[33m${"x".repeat(40)}\x1b[0m`);
    if (line === undefined) return; // unreachable — the toBe above asserts it
    expect(out.lines).toHaveLength(1);
    expect(visibleWidth(line)).toBe(geometry.cols);
    expect(line).not.toContain("…");
    expect(line.endsWith("\x1b[0m")).toBe(true);
  });

  it("caps the number of lines to the geometry rows", () => {
    const out = sanitizeChafaPayload(
      Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n"),
      { cols: 40, rows: 5 },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.lines).toHaveLength(5);
  });

  it("rejects empty output", () => {
    expect(sanitizeChafaPayload("", geometry)).toEqual({
      ok: false,
      reason: "chafa produced no output",
    });
    expect(sanitizeChafaPayload("\n\n", geometry)).toEqual({
      ok: false,
      reason: "chafa produced no output",
    });
  });
});

describe("runChafaRender", () => {
  const render = { cols: 30, rows: 10 };
  const ctx = {
    binary: "chafa",
    config: { ...DEFAULT_PI_CHAFA_SUBSET },
  };

  it("runs chafa with the built args and sanitizes the stdout payload", async () => {
    const exec: ExecFn = async (bin, args, opts) => {
      expect(bin).toBe("chafa");
      expect(args).toEqual(buildSymbolsArgs("/tmp/a.png", ctx.config, render));
      expect(opts.timeout).toBe(8000);
      expect(opts.maxBuffer).toBe(8 * 1024 * 1024);
      return { stdout: "\x1b[?25l\x1b[31m█\x1b[0m\n\x1b[?25h", stderr: "" };
    };
    expect(await runChafaRender("/tmp/a.png", render, { ...ctx, exec })).toEqual({
      ok: true,
      lines: ["\x1b[31m█\x1b[0m"],
    });
  });

  it("clamps the render timeout into [500, 60000]", async () => {
    const seen: number[] = [];
    const exec: ExecFn = async (_bin, _args, opts) => {
      seen.push(opts.timeout);
      return { stdout: "x", stderr: "" };
    };
    await runChafaRender("a.png", render, {
      ...ctx,
      config: { ...ctx.config, timeoutMs: 10 },
      exec,
    });
    await runChafaRender("a.png", render, {
      ...ctx,
      config: { ...ctx.config, timeoutMs: 120000 },
      exec,
    });
    expect(seen).toEqual([500, 60000]);
  });

  it("reports aborts (error, code, and signal) as render aborted", async () => {
    const aborting: ExecFn = async () => {
      const error = new Error("The operation was aborted") as NodeJS.ErrnoException;
      error.name = "AbortError";
      throw error;
    };
    expect(await runChafaRender("a.png", render, { ...ctx, exec: aborting })).toEqual({
      ok: false,
      reason: "render aborted",
    });

    const codeAbort: ExecFn = async () => {
      const error = new Error("aborted") as NodeJS.ErrnoException;
      error.code = "ABORT_ERR";
      throw error;
    };
    expect(await runChafaRender("a.png", render, { ...ctx, exec: codeAbort })).toEqual({
      ok: false,
      reason: "render aborted",
    });

    const controller = new AbortController();
    const signalAbort: ExecFn = async () => {
      controller.abort();
      throw new Error("child killed");
    };
    expect(
      await runChafaRender("a.png", render, {
        ...ctx,
        signal: controller.signal,
        exec: signalAbort,
      }),
    ).toEqual({ ok: false, reason: "render aborted" });
  });

  it("reports killed/SIGTERM as a timeout", async () => {
    const timedOut: ExecFn = async () => {
      const error = new Error("timed out") as NodeJS.ErrnoException & {
        killed?: boolean;
      };
      error.killed = true;
      error.code = "ETIMEDOUT";
      throw error;
    };
    const out = await runChafaRender("a.png", render, { ...ctx, exec: timedOut });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe(
        "chafa timed out after 8000ms. Reduce the image size, lower cellWidth/maxRows, or raise timeoutMs in pi-chafa config.",
      );
    }
  });

  it("surfaces stderr and exit codes as bounded failures", async () => {
    const stderrExec: ExecFn = async () => {
      const error = new Error("exit 1") as NodeJS.ErrnoException & {
        stderr?: string;
      };
      error.code = "1";
      error.stderr = "chafa: cannot open file";
      throw error;
    };
    expect(await runChafaRender("a.png", render, { ...ctx, exec: stderrExec })).toEqual({
      ok: false,
      reason: "chafa exited with an error: chafa: cannot open file",
    });

    const codeExec: ExecFn = async () => {
      const error = new Error("oops") as NodeJS.ErrnoException;
      error.code = "7";
      throw error;
    };
    expect(await runChafaRender("a.png", render, { ...ctx, exec: codeExec })).toEqual({
      ok: false,
      reason: "chafa failed (code 7)",
    });
  });
});

describe("readHostImageSettings", () => {
  const path = "/home/user/.pi/agent/settings.json";

  it("honors terminal.showImages false", () => {
    expect(
      readHostImageSettings(
        { userSettings: path },
        {
          readText: readTextOf({
            [path]: JSON.stringify({
              terminal: { showImages: false },
            }),
          }),
        },
      ),
    ).toEqual({ showImages: false, imageWidthCells: 60, images: null });
  });

  it("honors a positive integer imageWidthCells", () => {
    expect(
      readHostImageSettings(
        { userSettings: path },
        {
          readText: readTextOf({
            [path]: JSON.stringify({
              terminal: { imageWidthCells: 120 },
            }),
          }),
        },
      ),
    ).toEqual({ showImages: true, imageWidthCells: 120, images: null });
  });

  it("parses terminal.images for exact kitty/iterm2 only", () => {
    const read = (terminal: unknown, overrides: string = path) =>
      readHostImageSettings(
        { userSettings: overrides },
        { readText: readTextOf({ [overrides]: JSON.stringify({ terminal }) }) },
      );
    expect(read({ images: "kitty" })).toEqual({
      showImages: true,
      imageWidthCells: 60,
      images: "kitty",
    });
    expect(read({ images: "iterm2" })).toEqual({
      showImages: true,
      imageWidthCells: 60,
      images: "iterm2",
    });
    // Everything else — false, "auto", "none", wrong case, non-string,
    // absent — is null.
    for (const images of [false, "auto", "none", "AUTO", "Kitty", 42, null]) {
      expect(read({ images })).toEqual({
        showImages: true,
        imageWidthCells: 60,
        images: null,
      });
    }
    expect(read({})).toEqual({ showImages: true, imageWidthCells: 60, images: null });
    // images is independent of showImages.
    expect(read({ images: "kitty", showImages: false })).toEqual({
      showImages: false,
      imageWidthCells: 60,
      images: "kitty",
    });
  });

  it("falls back to defaults on missing, corrupt, or invalid settings", () => {
    const defaults = { showImages: true, imageWidthCells: 60, images: null };
    expect(
      readHostImageSettings(
        { userSettings: "/nope/settings.json" },
        { readText: readTextOf({}) },
      ),
    ).toEqual(defaults);
    expect(
      readHostImageSettings(
        { userSettings: "/x/settings.json" },
        { readText: readTextOf({ "/x/settings.json": "{corrupt" }) },
      ),
    ).toEqual(defaults);
    expect(
      readHostImageSettings(
        { userSettings: "/x/settings.json" },
        {
          readText: readTextOf({
            "/x/settings.json": JSON.stringify({
              terminal: { showImages: "false", imageWidthCells: 0 },
            }),
          }),
        },
      ),
    ).toEqual(defaults);
  });
});

describe("resolveNativeProtocol", () => {
  const userSettings = "/home/user/.pi/agent/settings.json";
  const settingsWith = (images: unknown): ReadText =>
    readTextOf({ [userSettings]: JSON.stringify({ terminal: { images } }) });

  it("prefers the host capability over conflicting settings and env", () => {
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: "kitty" }),
        readText: settingsWith("iterm2"),
        env: { PI_IMAGE_PROTOCOL: "iterm2" },
        userSettings,
      }),
    ).toBe("kitty");
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: "iterm2" }),
        readText: settingsWith("kitty"),
        env: { PI_IMAGE_PROTOCOL: "kitty" },
        userSettings,
      }),
    ).toBe("iterm2");
  });

  it("falls back to the settings file when the host reports null", () => {
    for (const images of ["kitty", "iterm2"] as const) {
      expect(
        resolveNativeProtocol({
          capabilities: () => ({ images: null }),
          readText: settingsWith(images),
          env: {},
          userSettings,
        }),
      ).toBe(images);
    }
  });

  it("falls back to the env when host and settings are both absent or non-native", () => {
    for (const protocol of ["kitty", "iterm2"] as const) {
      // host null + settings false
      expect(
        resolveNativeProtocol({
          capabilities: () => ({ images: null }),
          readText: settingsWith(false),
          env: { PI_IMAGE_PROTOCOL: protocol },
          userSettings,
        }),
      ).toBe(protocol);
      // host null + settings "auto"
      expect(
        resolveNativeProtocol({
          capabilities: () => ({ images: null }),
          readText: settingsWith("auto"),
          env: { PI_IMAGE_PROTOCOL: protocol },
          userSettings,
        }),
      ).toBe(protocol);
      // no capabilities accessor at all + settings absent
      expect(
        resolveNativeProtocol({
          readText: readTextOf({}),
          env: { PI_IMAGE_PROTOCOL: protocol },
          userSettings,
        }),
      ).toBe(protocol);
    }
  });

  it("trims the env value before the exact match", () => {
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: null }),
        readText: readTextOf({}),
        env: { PI_IMAGE_PROTOCOL: "  kitty  " },
        userSettings,
      }),
    ).toBe("kitty");
  });

  it("returns null when every source is absent or non-native", () => {
    expect(resolveNativeProtocol()).toBeNull();
    expect(
      resolveNativeProtocol({ capabilities: () => ({ images: null }), env: {} }),
    ).toBeNull();
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: null }),
        readText: settingsWith("none"),
        env: { PI_IMAGE_PROTOCOL: "auto" },
        userSettings,
      }),
    ).toBeNull();
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: null }),
        readText: settingsWith("AUTO"),
        env: { PI_IMAGE_PROTOCOL: "false" },
        userSettings,
      }),
    ).toBeNull();
  });

  it("returns null for known no-image terminals even when settings or env declare a protocol (Issue #100)", () => {
    for (const env of [
      { TERM_PROGRAM: "alacritty", TERM: "xterm-256color" },
      { TERM_PROGRAM: "vscode" },
      { TERM_PROGRAM: "zed" },
      { TERMINAL_EMULATOR: "jetbrains-jediterm" },
      { WT_SESSION: "1" },
    ]) {
      expect(
        resolveNativeProtocol({
          capabilities: () => ({ images: null }),
          readText: settingsWith("kitty"),
          env,
          userSettings,
        }),
      ).toBeNull();
      expect(
        resolveNativeProtocol({
          capabilities: () => ({ images: null }),
          readText: readTextOf({}),
          env: { ...env, PI_IMAGE_PROTOCOL: "iterm2" },
          userSettings,
        }),
      ).toBeNull();
    }
  });

  it("still honors the settings override for unrecognized terminals (Konsole keeps native, Issue #100)", () => {
    // Konsole is not in pi-tui's detection table → "unknown terminal" → the
    // settings override is the only source of its native capability.
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: null }),
        readText: settingsWith("kitty"),
        env: { KONSOLE_VERSION: "240301", TERM: "xterm-256color" },
        userSettings,
      }),
    ).toBe("kitty");
  });

  it("keeps positive detection authoritative over the no-image guard (Issue #100)", () => {
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: "kitty" }),
        readText: settingsWith("iterm2"),
        env: { TERM_PROGRAM: "alacritty", PI_IMAGE_PROTOCOL: "iterm2" },
        userSettings,
      }),
    ).toBe("kitty");
  });

  it("never lets settings garbage block the env step (positive-only ladder)", () => {
    for (const images of [false, "auto", "none", "AUTO", "kitty-ish", 42, "false"]) {
      expect(
        resolveNativeProtocol({
          capabilities: () => ({ images: null }),
          readText: settingsWith(images as unknown),
          env: { PI_IMAGE_PROTOCOL: "iterm2" },
          userSettings,
        }),
      ).toBe("iterm2");
    }
  });

  it("returns null when running under tmux or screen multiplexer (#070, #097)", () => {
    // TMUX env variable set
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: "kitty" }),
        env: { TMUX: "1", PI_IMAGE_PROTOCOL: "kitty" },
        userSettings,
        readText: settingsWith("kitty"),
      }),
    ).toBeNull();

    // TERM starting with tmux
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: "iterm2" }),
        env: { TERM: "tmux-256color" },
        userSettings,
        readText: settingsWith("iterm2"),
      }),
    ).toBeNull();

    // TERM starting with screen
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: "kitty" }),
        env: { TERM: "screen.xterm-256color" },
        userSettings,
        readText: settingsWith("kitty"),
      }),
    ).toBeNull();
  });

  it("uses only injected capabilities/readText/env — never the real $HOME or process env", () => {
    expect(
      resolveNativeProtocol({
        capabilities: () => ({ images: null }),
        readText: readTextOf({}),
        env: {},
        userSettings: "/not-real/settings.json",
      }),
    ).toBeNull();
  });
});

describe("resolveChafaGeometry", () => {
  it("lets the pane win when it is narrower than the preference", () => {
    expect(
      resolveChafaGeometry({ paneCols: 30, paneRows: 20, preferredCols: 60, maxRows: 50 }),
    ).toEqual({ ok: true, cols: 30, rows: 20 });
  });

  it("honors the preference when the pane is wider", () => {
    expect(
      resolveChafaGeometry({ paneCols: 120, paneRows: 30, preferredCols: 40, maxRows: 50 }),
    ).toEqual({ ok: true, cols: 40, rows: 30 });
  });

  it("clamps preference and pane at the IMAGE_CELLS bounds", () => {
    expect(
      resolveChafaGeometry({ paneCols: 500, paneRows: 80, preferredCols: 500, maxRows: 60 }),
    ).toEqual({ ok: true, cols: 100, rows: 60 });
    expect(
      resolveChafaGeometry({ paneCols: 22, paneRows: 80, preferredCols: 5, maxRows: 60 }),
    ).toEqual({ ok: true, cols: 16, rows: 60 });
  });

  it("rejects narrow and short panes", () => {
    expect(
      resolveChafaGeometry({ paneCols: 15, paneRows: 20, preferredCols: 60, maxRows: 50 }),
    ).toEqual({ ok: false, reason: "narrow" });
    expect(
      resolveChafaGeometry({ paneCols: 60, paneRows: 3, preferredCols: 60, maxRows: 50 }),
    ).toEqual({ ok: false, reason: "short" });
  });

  it("never produces an inverted clamp when maxRows is below IMAGE_ROWS_MIN", () => {
    expect(
      resolveChafaGeometry({ paneCols: 60, paneRows: 30, preferredCols: 60, maxRows: 1 }),
    ).toEqual({ ok: true, cols: 60, rows: 4 });
  });

  it("caps rows at maxRows when the pane is taller", () => {
    expect(
      resolveChafaGeometry({ paneCols: 60, paneRows: 100, preferredCols: 60, maxRows: 10 }),
    ).toEqual({ ok: true, cols: 60, rows: 10 });
  });
});

describe("makeDeferredImageSupport", () => {
  it("returns the deferred snapshot with no native capability or tier for a mode", () => {
    expect(makeDeferredImageSupport("chafa")).toEqual({
      mode: "chafa",
      nativeProtocol: null,
      tier: "none",
      piChafa: { present: false, via: "none" },
      chafa: { state: "deferred" },
      config: DEFAULT_PI_CHAFA_SUBSET,
      hostShowImages: true,
      hostImageWidthCells: 60,
    });
    expect(makeDeferredImageSupport("off").tier).toBe("none");
  });

  it("never resolves a tier or probes for any mode", () => {
    for (const mode of ["off", "chafa", "native", "auto"] as const) {
      expect(makeDeferredImageSupport(mode)).toEqual({
        mode,
        nativeProtocol: null,
        tier: "none",
        piChafa: { present: false, via: "none" },
        chafa: { state: "deferred" },
        config: DEFAULT_PI_CHAFA_SUBSET,
        hostShowImages: true,
        hostImageWidthCells: 60,
      });
    }
  });
});

describe("resolveImageSupport", () => {
  const paths = {
    userSettings: "/home/user/.pi/agent/settings.json",
    projectSettings: "/cwd/.pi/settings.json",
    agentDir: "/home/user/.pi/agent",
  };

  const chafaApi = (): PiChafaApi => ({
    getAllTools: () => [
      {
        name: "show_image",
        sourceInfo: {
          path: "/pkg/pi-chafa/dist/index.js",
          baseDir: "/pkg/pi-chafa/dist",
        },
      },
    ],
    getCommands: () => [],
  });

  const supportFiles = (overrides: Record<string, string> = {}): ReadText =>
    readTextOf({
      [paths.userSettings]: JSON.stringify({ terminal: { showImages: true } }),
      [paths.projectSettings]: JSON.stringify({ packages: ["npm:pi-chafa"] }),
      "/pkg/pi-chafa/package.json": JSON.stringify({ name: "pi-chafa" }),
      [paths.agentDir + "/pi-chafa.json"]: JSON.stringify({}),
      ...overrides,
    });

  it("activates when mode is chafa, pi-chafa is present, chafa is ok, and host images are on", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      { readText: supportFiles(), exec: okProbeExec, env: {} },
    );
    expect(support.tier).toBe("chafa");
    expect(support.mode).toBe("chafa");
    expect(support.nativeProtocol).toBeNull();
    expect(support.piChafa).toEqual({
      present: true,
      via: "runtime",
      packageRoot: "/pkg/pi-chafa",
    });
    expect(support.chafa).toEqual({
      state: "ok",
      binary: "chafa",
      version: { major: 1, minor: 18 },
    });
    expect(support.hostShowImages).toBe(true);
    expect(support.hostImageWidthCells).toBe(60); // pi's default (Q2 amendment)
  });

  it("stays off when the mode is off, even with everything else present", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "off" } },
      { readText: supportFiles(), exec: okProbeExec, env: {} },
    );
    expect(support.tier).toBe("none");
    expect(support.piChafa.present).toBe(true);
    expect(support.chafa.state).toBe("ok"); // still probed for the hint copy
  });

  it("skips the probe entirely when pi-chafa is absent", async () => {
    const api: PiChafaApi = { getAllTools: () => [], getCommands: () => [] };
    const support = await resolveImageSupport(
      api,
      paths,
      { images: { mode: "chafa" } },
      {
        readText: readTextOf({
          [paths.userSettings]: "{}",
          [paths.projectSettings]: "{}",
        }),
        exec: async () => {
          throw new Error("probe must not run");
        },
        env: {},
      },
    );
    expect(support.tier).toBe("none");
    expect(support.chafa).toEqual({ state: "deferred" });
    expect(support.piChafa).toEqual({ present: false, via: "none" });
  });

  it("stays inactive when host showImages is false", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      {
        readText: supportFiles({
          [paths.userSettings]: JSON.stringify({ terminal: { showImages: false } }),
        }),
        exec: okProbeExec,
        env: {},
      },
    );
    expect(support.tier).toBe("none");
    expect(support.hostShowImages).toBe(false);
  });

  it("stays inactive when the chafa probe fails", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      { readText: supportFiles(), exec: failProbeExec, env: {} },
    );
    expect(support.tier).toBe("none");
    expect(support.chafa.state).toBe("missing");
  });

  it("reuses a previous ok probe when the binary path is unchanged", async () => {
    const exec = vi.fn(okProbeExec);
    const first = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      { readText: supportFiles(), exec, env: {} },
    );
    expect(first.tier).toBe("chafa");
    const second = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      { readText: supportFiles(), exec, env: {}, previous: first },
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(second.chafa).toEqual(first.chafa);
    expect(second.tier).toBe("chafa");
  });

  it("re-probes when the resolved binary path changed", async () => {
    const exec = vi.fn(okProbeExec);
    const first = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      { readText: supportFiles(), exec, env: {} },
    );
    const second = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      {
        readText: supportFiles({
          [paths.agentDir + "/pi-chafa.json"]: JSON.stringify({ binaryPath: "/opt/chafa" }),
        }),
        exec,
        env: {},
        previous: first,
      },
    );
    expect(exec).toHaveBeenCalledTimes(2);
    expect(second.config.binaryPath).toBe("/opt/chafa");
  });

  it("warns and substitutes defaults when the pi-chafa config version is newer than 1", async () => {
    const onWarning = vi.fn();
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      {
        readText: supportFiles({
          [paths.agentDir + "/pi-chafa.json"]: JSON.stringify({
            version: 2,
            colors: "256",
            binaryPath: "/bin/chafa",
          }),
        }),
        exec: okProbeExec,
        env: {},
        onWarning,
      },
    );
    expect(onWarning).toHaveBeenCalledWith(
      "pi-chafa config version 2 is newer than this navigator supports; using defaults",
    );
    expect(support.config).toEqual(DEFAULT_PI_CHAFA_SUBSET);
  });

  it("passes a version-1 config through without warning", async () => {
    const onWarning = vi.fn();
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      {
        readText: supportFiles({
          [paths.agentDir + "/pi-chafa.json"]: JSON.stringify({ colors: "16" }),
        }),
        exec: okProbeExec,
        env: {},
        onWarning,
      },
    );
    expect(support.config.colors).toBe("16");
    expect(onWarning).not.toHaveBeenCalled();
    expect(support.tier).toBe("chafa");
  });

  // ── tier truth table (spec §5.4) across modes × capability × preferNative
  //    × chafa gates × showImages ──

  it("mode native with a capable host resolves tier native without probing chafa", async () => {
    const exec = vi.fn(okProbeExec);
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "native" } },
      {
        readText: supportFiles(),
        exec,
        env: {},
        capabilities: () => ({ images: "kitty" }),
      },
    );
    expect(support.tier).toBe("native");
    expect(support.nativeProtocol).toBe("kitty");
    expect(support.chafa).toEqual({ state: "deferred" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("mode native on a non-capable host resolves tier none (no chafa substitution)", async () => {
    const exec = vi.fn(okProbeExec);
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "native" } },
      {
        readText: supportFiles(),
        exec,
        env: {},
        capabilities: () => ({ images: null }),
      },
    );
    expect(support.tier).toBe("none");
    expect(support.nativeProtocol).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });

  it("mode auto with a capable host and preferNative true resolves tier native", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "auto" } },
      {
        readText: supportFiles(),
        exec: okProbeExec,
        env: {},
        capabilities: () => ({ images: "kitty" }),
      },
    );
    expect(support.tier).toBe("native");
    expect(support.nativeProtocol).toBe("kitty");
    expect(support.config.preferNative).toBe(true); // default
  });

  it("mode auto with a capable host and preferNative false falls back to chafa when the gates pass", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "auto" } },
      {
        readText: supportFiles({
          [paths.agentDir + "/pi-chafa.json"]: JSON.stringify({ preferNative: false }),
        }),
        exec: okProbeExec,
        env: {},
        capabilities: () => ({ images: "kitty" }),
      },
    );
    expect(support.tier).toBe("chafa");
    expect(support.nativeProtocol).toBe("kitty");
    expect(support.chafa.state).toBe("ok");
  });

  it("mode auto with preferNative false and a failing chafa probe resolves tier none", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "auto" } },
      {
        readText: supportFiles({
          [paths.agentDir + "/pi-chafa.json"]: JSON.stringify({ preferNative: false }),
        }),
        exec: failProbeExec,
        env: {},
        capabilities: () => ({ images: "iterm2" }),
      },
    );
    expect(support.tier).toBe("none");
    expect(support.chafa.state).toBe("missing");
  });

  it("mode auto without native capability resolves chafa when the chafa gates pass", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "auto" } },
      {
        readText: supportFiles(),
        exec: okProbeExec,
        env: {},
        capabilities: () => ({ images: null }),
      },
    );
    expect(support.tier).toBe("chafa");
    expect(support.nativeProtocol).toBeNull();
  });

  it("mode off resolves tier none regardless of capability", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "off" } },
      {
        readText: supportFiles(),
        exec: okProbeExec,
        env: {},
        capabilities: () => ({ images: "kitty" }),
      },
    );
    expect(support.tier).toBe("none");
    expect(support.nativeProtocol).toBe("kitty");
  });

  it("host showImages false forces tier none for every mode", async () => {
    for (const mode of ["off", "chafa", "native", "auto"] as const) {
      const support = await resolveImageSupport(
        chafaApi(),
        paths,
        { images: { mode } },
        {
          readText: supportFiles({
            [paths.userSettings]: JSON.stringify({ terminal: { showImages: false } }),
          }),
          exec: okProbeExec,
          env: {},
          capabilities: () => ({ images: "kitty" }),
        },
      );
      expect(support.tier).toBe("none");
      expect(support.hostShowImages).toBe(false);
    }
  });

  it("degrades under tmux to chafa under auto mode or none under native mode (#070, #097)", async () => {
    // Under mode: "native", tmux forces tier: "none"
    const nativeSupport = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "native" } },
      {
        readText: supportFiles({}),
        exec: okProbeExec,
        env: { TMUX: "1", PI_IMAGE_PROTOCOL: "kitty" },
        capabilities: () => ({ images: "kitty" }),
      },
    );
    expect(nativeSupport.tier).toBe("none");
    expect(nativeSupport.nativeProtocol).toBeNull();

    // Under mode: "auto", tmux falls back to chafa
    const autoSupport = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "auto" } },
      {
        readText: supportFiles({}),
        exec: okProbeExec,
        env: { TMUX: "1", PI_IMAGE_PROTOCOL: "kitty" },
        capabilities: () => ({ images: "kitty" }),
      },
    );
    expect(autoSupport.tier).toBe("chafa");
    expect(autoSupport.nativeProtocol).toBeNull();
  });

  it("resolves nativeProtocol from the settings file when no capabilities accessor is injected", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "native" } },
      {
        readText: supportFiles({
          [paths.userSettings]: JSON.stringify({ terminal: { images: "iterm2" } }),
        }),
        exec: okProbeExec,
        env: {},
      },
    );
    expect(support.nativeProtocol).toBe("iterm2");
    expect(support.tier).toBe("native");
  });

  it("carries the host imageWidthCells preference into the snapshot (Q2 amendment)", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "auto" } },
      {
        readText: supportFiles({
          [paths.userSettings]: JSON.stringify({ terminal: { imageWidthCells: 120 } }),
        }),
        exec: okProbeExec,
        env: {},
        capabilities: () => ({ images: "kitty" }),
      },
    );
    expect(support.hostImageWidthCells).toBe(120);
    expect(support.tier).toBe("native");
  });
});
describe("runNativeRender", () => {
  // Real 1×1 image fixtures (spec §12.1): decode via pi-tui's own sniffers.
  const PNG_1X1_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const GIF_1X1_BASE64 =
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const JPEG_1X1_BASE64 =
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
  const WEBP_1X1_BASE64 =
    "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAD8D+JaQAA3AA/ua1AAA=";
  const geometry = { cols: 40, rows: 10 };

  type ReadBytes = (path: string) => Promise<Uint8Array>;

  /** readBytes seam seeded with real bytes for a base64 fixture. */
  const readBytesOf = (base64: string) =>
    vi.fn<ReadBytes>(
      async () => new Uint8Array(Buffer.from(base64, "base64")),
    );

  /** Point pi-tui's real encoders at a protocol, preserving the rest of the caps. */
  const withProtocol = (images: "kitty" | "iterm2"): void => {
    const saved = getCapabilities();
    setCapabilities({ ...saved, images });
  };

  afterEach(() => {
    resetCapabilitiesCache();
  });

  it("kitty: sequence header carries a=T,f=100,q=2,C=1 plus c=/r=/i= and filler rows are empty", async () => {
    withProtocol("kitty");
    const readBytes = readBytesOf(PNG_1X1_BASE64);
    const result = await runNativeRender("/tmp/pixel.png", geometry, {
      protocol: "kitty",
      readBytes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sequence = result.lines[0] ?? "";
    expect(sequence.startsWith("\x1b_G")).toBe(true);
    expect(sequence).toContain("a=T,f=100,q=2,C=1");
    expect(sequence).toContain("c=");
    expect(sequence).toContain("r=");
    expect(sequence).toContain("i=");
    const c = Number(/c=(\d+)/.exec(sequence)?.[1]);
    const r = Number(/r=(\d+)/.exec(sequence)?.[1]);
    expect(c).toBeGreaterThan(0);
    expect(r).toBeGreaterThan(0);
    // Returned geometry is pi-tui's (aspect-fitted), not the request.
    expect(result.cols).toBe(c);
    expect(result.rows).toBe(r);
    expect(result.rows).toBeGreaterThan(1);
    expect(result.lines).toHaveLength(result.rows);
    // Every line after the sequence is exactly "" (D9 row contract).
    for (const filler of result.lines.slice(1)) {
      expect(filler).toBe("");
    }
    expect(readBytes).toHaveBeenCalledWith("/tmp/pixel.png");
  });

  it("kitty renders a real JPEG fixture (#071)", async () => {
    withProtocol("kitty");
    const readBytes = readBytesOf(JPEG_1X1_BASE64);
    const result = await runNativeRender("/tmp/pixel.jpg", geometry, {
      protocol: "kitty",
      readBytes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toBeGreaterThan(0);
    expect(result.cols).toBeGreaterThan(0);
    expect(result.lines[0]).toContain("\x1b_G");
    expect(readBytes).toHaveBeenCalledWith("/tmp/pixel.jpg");
  });

  it("kitty renders a real WebP fixture (#071)", async () => {
    withProtocol("kitty");
    const readBytes = readBytesOf(WEBP_1X1_BASE64);
    const result = await runNativeRender("/tmp/pixel.webp", geometry, {
      protocol: "kitty",
      readBytes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toBeGreaterThan(0);
    expect(result.cols).toBeGreaterThan(0);
    expect(result.lines[0]).toContain("\x1b_G");
    expect(readBytes).toHaveBeenCalledWith("/tmp/pixel.webp");
  });

  it("iterm2: fillers are empty and the last line is moveUp + File= with inline=1 and width=", async () => {
    withProtocol("iterm2");
    const readBytes = readBytesOf(PNG_1X1_BASE64);
    const result = await runNativeRender("/tmp/pixel.png", geometry, {
      protocol: "iterm2",
      readBytes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toBeGreaterThan(1);
    expect(result.lines).toHaveLength(result.rows);
    for (const filler of result.lines.slice(0, result.rows - 1)) {
      expect(filler).toBe("");
    }
    const last = result.lines[result.rows - 1] ?? "";
    expect(last.startsWith(`\x1b[${result.rows - 1}A`)).toBe(true);
    expect(last).toContain("\x1b]1337;File=");
    expect(last).toContain("inline=1");
    expect(last).toContain("width=");
    expect(last).toContain(`width=${result.cols}`);
    expect(result.cols).toBeGreaterThan(0);
  });

  it("kitty rejects a GIF before any read (D5)", async () => {
    withProtocol("kitty");
    const readBytes = readBytesOf(GIF_1X1_BASE64);
    const result = await runNativeRender("/tmp/pixel.gif", geometry, {
      protocol: "kitty",
      readBytes,
    });
    expect(result).toEqual({ ok: false, reason: "kitty requires PNG, JPEG, or WebP" });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("runNativeRender refuses to render on known no-image terminals even when a protocol is forced (Issue #100)", async () => {
    withProtocol("kitty");
    const readBytes = readBytesOf(PNG_1X1_BASE64);
    const result = await runNativeRender("/tmp/pixel.png", geometry, {
      protocol: "kitty",
      readBytes,
      env: { TERM_PROGRAM: "alacritty" },
    });
    expect(result).toEqual({
      ok: false,
      reason: "terminal does not support image protocols",
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("runNativeRender refuses to render under multiplexer (#070)", async () => {
    withProtocol("kitty");
    const readBytes = readBytesOf(PNG_1X1_BASE64);
    const result = await runNativeRender("/tmp/pixel.png", geometry, {
      protocol: "kitty",
      readBytes,
      env: { TMUX: "1" },
    });
    expect(result).toEqual({
      ok: false,
      reason: "image protocols disabled under tmux/screen",
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it.each([
    ["bmp", "/tmp/pixel.bmp"],
    ["svg", "/tmp/pixel.svg"],
    ["no extension", "/tmp/pixel"],
    ["leading dot", "/tmp/.pixel"],
  ])("%s → unsupported format, never reads", async (_label, path) => {
    withProtocol("iterm2");
    const readBytes = vi.fn();
    const result = await runNativeRender(path, geometry, {
      protocol: "iterm2",
      readBytes,
    });
    expect(result).toEqual({
      ok: false,
      reason: "native rendering does not support this image format",
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("iterm2 renders a real GIF fixture", async () => {
    withProtocol("iterm2");
    const readBytes = readBytesOf(GIF_1X1_BASE64);
    const result = await runNativeRender("/tmp/pixel.gif", geometry, {
      protocol: "iterm2",
      readBytes,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toBeGreaterThan(0);
    expect(result.cols).toBeGreaterThan(0);
    expect(result.lines).toHaveLength(result.rows);
    expect(result.lines[result.rows - 1]).toContain("\x1b]1337;File=");
  });

  it("oversized read fails with the exact 4 MiB cap reason (D7)", async () => {
    withProtocol("kitty");
    const readBytes = vi.fn(
      async () => new Uint8Array(IMAGE_NATIVE_MAX_BYTES + 1),
    );
    const result = await runNativeRender("/tmp/pixel.png", geometry, {
      protocol: "kitty",
      readBytes,
    });
    expect(result).toEqual({
      ok: false,
      reason: "image exceeds the 4 MiB native rendering cap",
    });
    expect(readBytes).toHaveBeenCalledTimes(1);
  });

  it("a pre-aborted signal fails before any read", async () => {
    withProtocol("kitty");
    const readBytes = vi.fn();
    const result = await runNativeRender("/tmp/pixel.png", geometry, {
      protocol: "kitty",
      signal: AbortSignal.abort(),
      readBytes,
    });
    expect(result).toEqual({ ok: false, reason: "render aborted" });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("garbage bytes under .png fail with could not read image dimensions", async () => {
    withProtocol("kitty");
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5]));
    const result = await runNativeRender("/tmp/pixel.png", geometry, {
      protocol: "kitty",
      readBytes,
    });
    expect(result).toEqual({
      ok: false,
      reason: "could not read image dimensions",
    });
  });

  it("a rejecting readBytes becomes a clean failure, never a throw", async () => {
    withProtocol("kitty");
    const readBytes = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await runNativeRender("/tmp/pixel.png", geometry, {
      protocol: "kitty",
      readBytes,
    });
    expect(result).toEqual({ ok: false, reason: "could not read the image file" });
  });
});
