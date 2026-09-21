/**
 * images.ts unit suite (spec §12.2): pi-chafa detection, config mirror, chafa
 * probe, render args/sanitizer, geometry, host settings, and the aggregate
 * support resolution. Every test injects readText/exec — no real $HOME, no
 * real chafa, no real settings files.
 */

import { describe, expect, it, vi } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";

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
  runChafaRender,
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

  it("skips unknown keys and invalid file values silently", () => {
    const readText = readTextOf({
      [configPath]: JSON.stringify({
        version: 2,
        preferNative: false,
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
  it("honors terminal.showImages false", () => {
    expect(
      readHostImageSettings(
        { userSettings: "/home/user/.pi/agent/settings.json" },
        {
          readText: readTextOf({
            "/home/user/.pi/agent/settings.json": JSON.stringify({
              terminal: { showImages: false },
            }),
          }),
        },
      ),
    ).toEqual({ showImages: false, imageWidthCells: 60 });
  });

  it("honors a positive integer imageWidthCells", () => {
    expect(
      readHostImageSettings(
        { userSettings: "/home/user/.pi/agent/settings.json" },
        {
          readText: readTextOf({
            "/home/user/.pi/agent/settings.json": JSON.stringify({
              terminal: { imageWidthCells: 120 },
            }),
          }),
        },
      ),
    ).toEqual({ showImages: true, imageWidthCells: 120 });
  });

  it("falls back to defaults on missing, corrupt, or invalid settings", () => {
    const defaults = { showImages: true, imageWidthCells: 60 };
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
  it("returns the deferred snapshot for a mode", () => {
    expect(makeDeferredImageSupport("chafa")).toEqual({
      mode: "chafa",
      piChafa: { present: false, via: "none" },
      chafa: { state: "deferred" },
      config: DEFAULT_PI_CHAFA_SUBSET,
      hostShowImages: true,
      active: false,
    });
    expect(makeDeferredImageSupport("off").active).toBe(false);
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
    expect(support.active).toBe(true);
    expect(support.mode).toBe("chafa");
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
  });

  it("stays off when the mode is off, even with everything else present", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "off" } },
      { readText: supportFiles(), exec: okProbeExec, env: {} },
    );
    expect(support.active).toBe(false);
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
    expect(support.active).toBe(false);
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
    expect(support.active).toBe(false);
    expect(support.hostShowImages).toBe(false);
  });

  it("stays inactive when the chafa probe fails", async () => {
    const support = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      { readText: supportFiles(), exec: failProbeExec, env: {} },
    );
    expect(support.active).toBe(false);
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
    expect(first.active).toBe(true);
    const second = await resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      { readText: supportFiles(), exec, env: {}, previous: first },
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(second.chafa).toEqual(first.chafa);
    expect(second.active).toBe(true);
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
    expect(support.active).toBe(true);
  });
});