/**
 * images.ts unit suite (spec §12.2): pi-chafa detection, config mirror, chafa
 * probe, render args/sanitizer, geometry, host settings, and the aggregate
 * support resolution. Every test injects readText/exec — no real $HOME, no
 * real chafa, no real settings files.
 *
 * The suite drives the production surface only (Issue #180): the config
 * mirror, chafa probe, host settings and the native ladder are asserted
 * through `resolveImageSupport`'s snapshot; the chafa renderer (argv,
 * timeout, sanitizer, failure mapping) through `makeImagePipeline` with an
 * injected exec; the native renderer through the pipeline's readBytes /
 * convertToPng / renderImage seams. No internalized symbol is imported.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCapabilities,
  getImageDimensions,
  resetCapabilitiesCache,
  setCapabilities,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { IMAGE_NATIVE_MAX_BYTES } from "../constants";
import {
  NATIVE_PROTOCOL_RULES,
  buildKittyProbeQuery,
  consumeKittyProbeReply,
  createKittyProbeState,
  detectPiChafa,
  isNativelyRenderable,
  makeDeferredImageSupport,
  makeImagePipeline,
  resolveChafaGeometry,
  resolveImageSupport,
} from "../images";
import type { ExecFn, ImageSupport, KittyProbeVerdict, PiChafaApi, ReadText } from "../images";

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

/**
 * Expected default pi-chafa subset (spec §3.1), pinned as a literal: the
 * internal constant is not exported, so the defaults stay asserted by an
 * independent expected value.
 */
const DEFAULT_CONFIG: ImageSupport["config"] = {
  version: 1,
  binaryPath: null,
  cellWidth: 60,
  maxRows: 50,
  colors: "240",
  symbolsSet: "block+border",
  dither: "none",
  timeoutMs: 8000,
  preferNative: true,
};

/** A resolved auto-mode snapshot; overrides narrow it per case. */
function support(overrides: Partial<ImageSupport> = {}): ImageSupport {
  return {
    mode: "auto",
    nativeProtocol: "kitty",
    tier: "native",
    piChafa: { present: true, via: "settings" },
    chafa: { state: "ok", binary: "chafa", version: { major: 1, minor: 18 } },
    config: { ...DEFAULT_CONFIG },
    hostShowImages: true,
    hostImageWidthCells: 60,
    ...overrides,
  };
}

/** Strict-chafa snapshot: the pipeline's single attempt for the chafa suites. */
function chafaSupport(overrides: Partial<ImageSupport> = {}): ImageSupport {
  return support({
    mode: "chafa",
    nativeProtocol: null,
    tier: "chafa",
    ...overrides,
  });
}

/** Strict-native snapshot: the pipeline's single attempt for the native suites. */
function nativeSupport(overrides: Partial<ImageSupport> = {}): ImageSupport {
  return support({
    mode: "native",
    chafa: { state: "deferred" },
    ...overrides,
  });
}

const neverProbe = async (): Promise<KittyProbeVerdict> => "no-reply";
const liveSignal = new AbortController().signal;

/** Real 1×1 PNG bytes (a standalone fixture pi-tui's own sniffers decode). */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type ReadBytes = (path: string) => Promise<Uint8Array>;

/** readBytes seam seeded with real bytes for a base64 fixture. */
const readBytesOf = (base64: string) =>
  vi.fn<ReadBytes>(async () => new Uint8Array(Buffer.from(base64, "base64")));

/** async readBytes seam over the 1×1 PNG fixture. */
const pngBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(Buffer.from(PNG_1X1_BASE64, "base64"));

/** The 1×1 PNG payload the kitty probe query carries (the production sample). */
function probeSampleBase64(): string {
  const match =
    /^\x1b_Ga=q,t=d,f=100,i=\d+;([A-Za-z0-9+/=]+)\x1b\\$/.exec(
      buildKittyProbeQuery(1),
    );
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

/** pi-tui encoder stand-in (no capability mutation needed). */
const encoder = (sequence = "SEQ") =>
  vi.fn(() => ({ sequence, columns: 7, rows: 3 }));

/** A chafa exec stand-in returning a fixed stdout payload. */
const stdoutExec = (stdout: string) =>
  vi.fn<ExecFn>(async () => ({ stdout, stderr: "" }));

/** A chafa exec stand-in producing one row per entry. */
const chafaExec = (rows: string[] = ["\x1b[31m██\x1b[0m"]) =>
  stdoutExec(rows.join("\n"));

describe("pi-chafa config mirror through resolveImageSupport (spec §3.1)", () => {
  const agentDir = "/home/user/.pi/agent";
  const configPath = `${agentDir}/pi-chafa.json`;
  const paths = {
    userSettings: "/home/user/.pi/agent/settings.json",
    projectSettings: "/cwd/.pi/settings.json",
    agentDir,
  };
  const noTools: PiChafaApi = { getAllTools: () => [], getCommands: () => [] };
  const resolve = (deps: {
    env?: Record<string, string | undefined>;
    readText: ReadText;
  }) =>
    resolveImageSupport(noTools, paths, { images: { mode: "chafa" } }, deps);

  it("reads the fixture file and applies the full CHAFA_* env precedence table over it", async () => {
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
    const { config } = await resolve({
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
    });
    expect(config).toEqual({
      ...DEFAULT_CONFIG,
      binaryPath: "/opt/chafa",
      cellWidth: 70,
      maxRows: 45,
      colors: "256",
      symbolsSet: "ascii",
      dither: "diffusion",
      timeoutMs: 12000,
    });
  });

  it("lets CHAFA_CONFIG_DIR win over agentDir for locating the file", async () => {
    const readText = readTextOf({
      "/cfg/dir/pi-chafa.json": JSON.stringify({ colors: "8" }),
    });
    const { config } = await resolve({
      env: { CHAFA_CONFIG_DIR: "/cfg/dir/" },
      readText,
    });
    expect(config.colors).toBe("8");
    expect(config.cellWidth).toBe(60); // file only set colors
    expect(config.binaryPath).toBeNull();
  });

  it("skips invalid env values silently — file/default wins — and treats empty env as absent", async () => {
    const readText = readTextOf({
      [configPath]: JSON.stringify({
        colors: "16",
        maxRows: 30,
        dither: "ordered",
      }),
    });
    const { config } = await resolve({
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

  it("mirrors preferNative from the file and overlays CHAFA_PREFER_NATIVE (envBoolean semantics)", async () => {
    const fileWith = (preferNative: unknown): ReadText =>
      readTextOf({ [configPath]: JSON.stringify({ preferNative }) });
    const prefer = async (
      readText: ReadText,
      env?: Record<string, string | undefined>,
    ): Promise<boolean> => (await resolve({ readText, env })).config.preferNative;
    // File value honored when no env override.
    expect(await prefer(fileWith(false))).toBe(false);
    expect(await prefer(fileWith(true))).toBe(true);
    // Truthy env tokens win over the file (case-insensitive, trimmed).
    for (const token of ["1", "true", "yes", "on", " TRUE ", "Yes"]) {
      expect(await prefer(fileWith(false), { CHAFA_PREFER_NATIVE: token })).toBe(
        true,
      );
    }
    // Falsy env tokens win over the file (case-insensitive, trimmed).
    for (const token of ["0", "false", "no", "off", " FALSE ", "Off"]) {
      expect(await prefer(fileWith(true), { CHAFA_PREFER_NATIVE: token })).toBe(
        false,
      );
    }
  });

  it("ignores invalid CHAFA_PREFER_NATIVE and non-boolean file values silently", async () => {
    // Invalid env falls back to the file value (pi-chafa ignores it silently).
    const readText = readTextOf({
      [configPath]: JSON.stringify({ preferNative: false }),
    });
    for (const garbage of ["maybe", "", "   ", "2", "nope"]) {
      expect(
        (await resolve({ readText, env: { CHAFA_PREFER_NATIVE: garbage } }))
          .config.preferNative,
      ).toBe(false);
    }
    // Non-boolean file values are skipped → default true.
    for (const value of ["yes", 1, null, "false", []]) {
      expect(
        (
          await resolve({
            readText: readTextOf({
              [configPath]: JSON.stringify({ preferNative: value }),
            }),
          })
        ).config.preferNative,
      ).toBe(true);
    }
    // Absent everywhere → default true.
    expect((await resolve({ readText: readTextOf({}) })).config.preferNative).toBe(
      true,
    );
  });

  it("skips unknown keys and invalid file values silently", async () => {
    const readText = readTextOf({
      [configPath]: JSON.stringify({
        version: 1,
        preferNative: "yes", // non-boolean → skipped, default stands
        formatOrder: ["native"],
        colors: "hotpink",
        cellWidth: -3,
        symbolsSet: "  border  ",
        binaryPath: "",
        timeoutMs: 0,
      }),
    });
    const { config } = await resolve({ readText });
    expect(config.version).toBe(1);
    expect(config.colors).toBe("240");
    expect(config.cellWidth).toBe(60);
    expect(config.symbolsSet).toBe("border");
    expect(config.binaryPath).toBeNull();
    expect(config.timeoutMs).toBe(8000);
    expect(config.preferNative).toBe(true);
  });

  it("falls back to defaults on corrupt JSON and missing files", async () => {
    expect(
      (await resolve({ readText: readTextOf({ [configPath]: "{not json" }) }))
        .config,
    ).toEqual(DEFAULT_CONFIG);
    expect((await resolve({ readText: readTextOf({}) })).config).toEqual(
      DEFAULT_CONFIG,
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

describe("chafa probe through resolveImageSupport (spec §6.2)", () => {
  const paths = {
    userSettings: "/home/user/.pi/agent/settings.json",
    projectSettings: "/cwd/.pi/settings.json",
    agentDir: "/home/user/.pi/agent",
  };
  /** Runtime-presence API: the probe only runs when pi-chafa is present. */
  const chafaApi = (): PiChafaApi => ({
    getAllTools: () => [
      {
        name: "show_image",
        sourceInfo: { path: "/pkg/pi-chafa/index.js" },
      },
    ],
    getCommands: () => [],
  });
  const runtimeFiles = (config?: string): ReadText =>
    readTextOf({
      [paths.userSettings]: "{}",
      [paths.projectSettings]: "{}",
      "/pkg/pi-chafa/package.json": JSON.stringify({ name: "pi-chafa" }),
      ...(config !== undefined
        ? { [paths.agentDir + "/pi-chafa.json"]: config }
        : {}),
    });
  const probe = (exec: ExecFn, config?: string) =>
    resolveImageSupport(
      chafaApi(),
      paths,
      { images: { mode: "chafa" } },
      { readText: runtimeFiles(config), exec, env: {} },
    );

  it("parses the version and uses the trimmed binaryPath", async () => {
    const exec: ExecFn = async (bin, args, opts) => {
      expect(bin).toBe("/usr/bin/chafa");
      expect(args).toEqual(["--version"]);
      expect(opts.timeout).toBe(3000);
      expect(opts.maxBuffer).toBe(1024 * 1024);
      return { stdout: "Chafa version 1.18.2\n", stderr: "" };
    };
    const resolved = await probe(
      exec,
      JSON.stringify({ binaryPath: "  /usr/bin/chafa  " }),
    );
    expect(resolved.chafa).toEqual({
      state: "ok",
      binary: "/usr/bin/chafa",
      version: { major: 1, minor: 18 },
    });
    expect(resolved.tier).toBe("chafa");
  });

  it("defaults to chafa on PATH and accepts exactly the minimum version", async () => {
    const exec: ExecFn = async (bin) => {
      expect(bin).toBe("chafa");
      return { stdout: "Chafa version 1.10.0\n", stderr: "" };
    };
    const resolved = await probe(exec);
    expect(resolved.chafa).toEqual({
      state: "ok",
      binary: "chafa",
      version: { major: 1, minor: 10 },
    });
    expect(resolved.tier).toBe("chafa");
  });

  it("rejects versions below the minimum with the upgrade hint", async () => {
    const exec: ExecFn = async () => ({
      stdout: "Chafa version 1.9.3\n",
      stderr: "",
    });
    const resolved = await probe(exec);
    const chafa = resolved.chafa;
    expect(chafa.state).toBe("too-old");
    if (chafa.state === "too-old") {
      expect(chafa.detail).toContain(
        "chafa 1.9 is older than the minimum supported version 1.10",
      );
      expect(chafa.detail).toContain("Upgrade chafa (");
      expect(chafa.detail).toContain("or point CHAFA_BIN at a newer binary.");
    }
    expect(resolved.tier).toBe("none");
  });

  it("reports ENOENT as missing with the verbatim install hint", async () => {
    const resolved = await probe(
      failProbeExec,
      JSON.stringify({ binaryPath: "/no/such/chafa" }),
    );
    const chafa = resolved.chafa;
    expect(chafa.state).toBe("missing");
    if (chafa.state === "missing") {
      expect(chafa.detail).toBe(
        "chafa was not found on PATH (looked for /no/such/chafa). Install it with: apt install chafa (or your distro's package). Or set CHAFA_BIN to its absolute path.",
      );
    }
  });

  it("reports unparsable output as an error", async () => {
    const exec: ExecFn = async () => ({ stdout: "chafa version 1.18.2\n", stderr: "" });
    expect((await probe(exec)).chafa).toEqual({
      state: "error",
      detail: `Could not parse a version from "chafa --version". Is chafa really chafa?`,
    });
  });

  it("reports other exec failures as a bounded error", async () => {
    const exec: ExecFn = async () => {
      throw new Error("permission denied");
    };
    const chafa = (await probe(exec)).chafa;
    expect(chafa.state).toBe("error");
    if (chafa.state === "error") {
      expect(chafa.detail).toBe("Failed to run chafa --version: permission denied");
    }
  });
});

describe("chafa argv through makeImagePipeline (spec §3.1, §7.2)", () => {
  it("builds the exact pi-chafa argv vector for a fixed config and geometry", async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: "x", stderr: "" }));
    const pipeline = makeImagePipeline(
      chafaSupport({ config: { ...DEFAULT_CONFIG } }),
      { cols: 40, rows: 20 },
      { probeDecode: neverProbe, signal: liveSignal, exec },
    );
    await pipeline.render("/tmp/sample.png");
    expect(exec.mock.calls[0]?.[0]).toBe("chafa");
    expect(exec.mock.calls[0]?.[1]).toEqual([
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

describe("chafa payload sanitizer through makeImagePipeline (spec §8, D7)", () => {
  const geometry = { cols: 40, rows: 10 };

  /** One chafa render of `stdout` through the pipeline's chafa attempt. */
  const render = (stdout: string, geom = geometry) =>
    makeImagePipeline(chafaSupport(), geom, {
      probeDecode: neverProbe,
      signal: liveSignal,
      exec: stdoutExec(stdout),
    }).render("/tmp/a.png");

  it("passes an SGR-only payload through with no trailing newlines", async () => {
    const out = await render(
      "\x1b[38;5;123m██\x1b[0m\n\x1b[31m█\x1b[0m",
    );
    expect(out).toEqual({
      kind: "ok",
      renderer: "chafa",
      lines: ["\x1b[38;5;123m██\x1b[0m", "\x1b[31m█\x1b[0m"],
      cols: geometry.cols,
      rows: geometry.rows,
    });
    if (out.kind === "ok") {
      for (const line of out.lines) expect(line.endsWith("\n")).toBe(false);
    }
  });

  it("drops chafa's cursor-hide/show escapes and trailing empty lines", async () => {
    const out = await render(
      "\x1b[?25l\x1b[32mline one\x1b[0m\x1b[?25l\nline two\nline three\n\n\n\x1b[?25h\n",
    );
    expect(out).toEqual({
      kind: "ok",
      renderer: "chafa",
      lines: ["\x1b[32mline one\x1b[0m", "line two\x1b[0m", "line three\x1b[0m"],
      cols: geometry.cols,
      rows: geometry.rows,
    });
    if (out.kind === "ok") {
      expect(out.lines.join("|")).not.toContain("?25l");
      expect(out.lines.join("|")).not.toContain("?25h");
    }
  });

  it("keeps byte-identical output across a payload dense with SGR transitions (Issue #104)", async () => {
    const row = (n: number) => `\x1b[38;5;${160 + (n % 95)}m█\x1b[0m`;
    const payload = Array.from({ length: 10 }, (_, i) =>
      Array.from({ length: 20 }, (_, j) => row(i * 20 + j)).join(""),
    ).join("\n");
    const out = await render(payload);
    // Hundreds of escapes, no reordering, no drops, no added resets: the
    // sticky-regex rewrite must be a byte-identical replacement (Issue #104).
    expect(out).toEqual({
      kind: "ok",
      renderer: "chafa",
      lines: payload.split("\n"),
      cols: geometry.cols,
      rows: geometry.rows,
    });
  });

  it("strips carriage returns", async () => {
    const out = await render("a\r\nb\r");
    expect(out).toEqual({
      kind: "ok",
      renderer: "chafa",
      lines: ["a\x1b[0m", "b\x1b[0m"],
      cols: geometry.cols,
      rows: geometry.rows,
    });
    if (out.kind === "ok") expect(out.lines.join("")).not.toContain("\r");
  });

  it("rejects any other non-SGR escape sequence", async () => {
    for (const hostile of [
      "\x1b[2J",
      "\x1b[1;2H",
      "\x1b]0;title\x07",
      "\x1b[?25l\x1b[2J",
      "\x1b[?25hrest\x1b[1A",
      "lone \x1b at end",
      "\x1b[31", // unterminated SGR
    ]) {
      expect(await render(hostile)).toEqual({
        kind: "failed",
        renderer: "chafa",
        reason: "unexpected escape sequence",
      });
    }
  });

  it("appends a trailing reset to rows that lack one", async () => {
    const out = await render("\x1b[31mred\x1b[39m\nplain");
    expect(out).toEqual({
      kind: "ok",
      renderer: "chafa",
      lines: ["\x1b[31mred\x1b[39m\x1b[0m", "plain\x1b[0m"],
      cols: geometry.cols,
      rows: geometry.rows,
    });
  });

  it("truncates over-wide rows to exactly cols with no bright ellipsis", async () => {
    const out = await render(`\x1b[33m${"x".repeat(60)}\x1b[0m`);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    const line = out.lines[0];
    expect(line).toBe(`\x1b[33m${"x".repeat(40)}\x1b[0m`);
    if (line === undefined) return; // unreachable — the toBe above asserts it
    expect(out.lines).toHaveLength(1);
    expect(visibleWidth(line)).toBe(geometry.cols);
    expect(line).not.toContain("…");
    expect(line.endsWith("\x1b[0m")).toBe(true);
  });

  it("caps the number of lines to the geometry rows", async () => {
    const out = await render(
      Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n"),
      { cols: 40, rows: 5 },
    );
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.lines).toHaveLength(5);
  });

  it("rejects empty output", async () => {
    expect(await render("")).toEqual({
      kind: "failed",
      renderer: "chafa",
      reason: "chafa produced no output",
    });
    expect(await render("\n\n")).toEqual({
      kind: "failed",
      renderer: "chafa",
      reason: "chafa produced no output",
    });
  });
});

describe("chafa render contract through makeImagePipeline (spec §7.2)", () => {
  const geometry = { cols: 30, rows: 10 };
  const runChafa = (
    exec: ExecFn,
    config: ImageSupport["config"] = DEFAULT_CONFIG,
    geom = geometry,
  ) =>
    makeImagePipeline(chafaSupport({ config: { ...config } }), geom, {
      probeDecode: neverProbe,
      signal: liveSignal,
      exec,
    }).render("/tmp/a.png");

  it("runs chafa with the built args and sanitizes the stdout payload", async () => {
    const exec: ExecFn = async (bin, args, opts) => {
      expect(bin).toBe("chafa");
      expect(args).toEqual([
        "--format",
        "symbols",
        "--relative",
        "off",
        "--size",
        "30x10",
        "--colors",
        "240",
        "--symbols",
        "block+border",
        "--dither",
        "none",
        "--animate",
        "off",
        "/tmp/a.png",
      ]);
      expect(opts.timeout).toBe(8000);
      expect(opts.maxBuffer).toBe(8 * 1024 * 1024);
      return { stdout: "\x1b[?25l\x1b[31m█\x1b[0m\n\x1b[?25h", stderr: "" };
    };
    expect(await runChafa(exec)).toEqual({
      kind: "ok",
      renderer: "chafa",
      lines: ["\x1b[31m█\x1b[0m"],
      cols: geometry.cols,
      rows: geometry.rows,
    });
  });

  it("clamps the render timeout into [500, 60000]", async () => {
    const seen: number[] = [];
    const exec: ExecFn = async (_bin, _args, opts) => {
      seen.push(opts.timeout);
      return { stdout: "x", stderr: "" };
    };
    await runChafa(exec, { ...DEFAULT_CONFIG, timeoutMs: 10 });
    await runChafa(exec, { ...DEFAULT_CONFIG, timeoutMs: 120000 });
    expect(seen).toEqual([500, 60000]);
  });

  it("reports aborts (error, code, and signal) as a typed aborted outcome", async () => {
    const aborting: ExecFn = async () => {
      const error = new Error("The operation was aborted") as NodeJS.ErrnoException;
      error.name = "AbortError";
      throw error;
    };
    expect(await runChafa(aborting)).toEqual({ kind: "aborted" });

    const codeAbort: ExecFn = async () => {
      const error = new Error("aborted") as NodeJS.ErrnoException;
      error.code = "ABORT_ERR";
      throw error;
    };
    expect(await runChafa(codeAbort)).toEqual({ kind: "aborted" });

    const controller = new AbortController();
    const signalAbort: ExecFn = async () => {
      controller.abort();
      throw new Error("child killed");
    };
    expect(
      await makeImagePipeline(chafaSupport(), geometry, {
        probeDecode: neverProbe,
        signal: controller.signal,
        exec: signalAbort,
      }).render("/tmp/a.png"),
    ).toEqual({ kind: "aborted" });

    // Pre-spawn abort check: a superseded pipeline never forks a chafa child.
    const preAborted = new AbortController();
    preAborted.abort();
    const exec = vi.fn<ExecFn>();
    expect(
      await makeImagePipeline(chafaSupport(), geometry, {
        probeDecode: neverProbe,
        signal: preAborted.signal,
        exec,
      }).render("/tmp/a.png"),
    ).toEqual({ kind: "aborted" });
    expect(exec).not.toHaveBeenCalled();
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
    const out = await runChafa(timedOut);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
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
    expect(await runChafa(stderrExec)).toEqual({
      kind: "failed",
      renderer: "chafa",
      reason: "chafa exited with an error: chafa: cannot open file",
    });

    const codeExec: ExecFn = async () => {
      const error = new Error("oops") as NodeJS.ErrnoException;
      error.code = "7";
      throw error;
    };
    expect(await runChafa(codeExec)).toEqual({
      kind: "failed",
      renderer: "chafa",
      reason: "chafa failed (code 7)",
    });
  });

  it("sanitizes control bytes out of the chafa failure detail (Issue #216)", async () => {
    // chafa echoes the repo-controlled image path on stderr, so a file name
    // carrying ESC/BEL reaches the image card's hint row unless the detail is
    // sanitized at the one boundary every failure passes through.
    const stderrExec: ExecFn = async () => {
      const error = new Error("exit 1") as NodeJS.ErrnoException & {
        stderr?: string;
      };
      error.code = "1";
      error.stderr = "\x1b[31m/tmp/a\x07.png: cannot open file\x1b[0m";
      throw error;
    };
    const out = await runChafa(stderrExec);
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") {
      expect(out.reason).toContain("chafa exited with an error:");
      expect(out.reason).toContain("/tmp/a");
      expect(out.reason).toContain(".png: cannot open file");
      expect(out.reason).not.toContain("\u001b");
      expect(out.reason).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    }
  });
});

describe("makeImagePipeline (Issue #144)", () => {
  const geometry = { cols: 30, rows: 8 };

  it("exposes the plan's attempts and runs them in order; a native ok stops the list", async () => {
    const exec = chafaExec();
    const pipeline = makeImagePipeline(support(), geometry, {
      probeDecode: neverProbe,
      signal: liveSignal,
      readBytes: pngBytes,
      renderImage: encoder("\x1b_Gnative\x1b\\"),
      exec,
    });
    expect(pipeline.attempts).toEqual(["native", "chafa"]);

    await expect(pipeline.render("/work/x.png")).resolves.toEqual({
      kind: "ok",
      renderer: "native",
      lines: ["\x1b_Gnative\x1b\\", "", ""],
      cols: geometry.cols,
      rows: geometry.rows,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("stamps the requested geometry on an ok outcome, not pi-tui's aspect-fitted result", async () => {
    const pipeline = makeImagePipeline(nativeSupport(), geometry, {
      probeDecode: neverProbe,
      signal: liveSignal,
      readBytes: pngBytes,
      renderImage: encoder("SEQ"),
    });
    const out = await pipeline.render("/work/x.png");
    expect(out).toEqual({
      kind: "ok",
      renderer: "native",
      lines: ["SEQ", "", ""],
      cols: 30,
      rows: 8,
    });
  });

  it("falls through native → chafa in order after a clean native failure", async () => {
    const exec = chafaExec();
    const pipeline = makeImagePipeline(support(), geometry, {
      probeDecode: async () => "error", // native clean failure before any read
      signal: liveSignal,
      exec,
    });
    await expect(pipeline.render("/work/x.png")).resolves.toEqual({
      kind: "ok",
      renderer: "chafa",
      lines: ["\x1b[31m██\x1b[0m"],
      cols: geometry.cols,
      rows: geometry.rows,
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("returns the last clean failure after the list", async () => {
    const exec = vi.fn<ExecFn>(async () => {
      const error = new Error("chafa died") as NodeJS.ErrnoException & { stderr?: string };
      error.stderr = "chafa: boom";
      throw error;
    });
    const pipeline = makeImagePipeline(support(), geometry, {
      probeDecode: async () => "error",
      signal: liveSignal,
      exec,
    });
    await expect(pipeline.render("/work/x.png")).resolves.toEqual({
      kind: "failed",
      renderer: "chafa",
      reason: "chafa exited with an error: chafa: boom",
    });
  });

  it("stops on an aborted render: no later attempt runs", async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = chafaExec();
    const readBytes = vi.fn(pngBytes);
    const pipeline = makeImagePipeline(support(), geometry, {
      probeDecode: neverProbe,
      signal: controller.signal,
      readBytes,
      renderImage: encoder(),
      exec,
    });
    await expect(pipeline.render("/work/x.png")).resolves.toEqual({ kind: "aborted" });
    expect(readBytes).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("treats a throwing renderer as that renderer's hard failure and stops the list", async () => {
    const exec = chafaExec();
    const pipeline = makeImagePipeline(support(), geometry, {
      probeDecode: neverProbe,
      signal: liveSignal,
      readBytes: pngBytes,
      renderImage: vi.fn(() => {
        throw new Error("encoder exploded");
      }),
      exec,
    });
    await expect(pipeline.render("/work/x.png")).resolves.toEqual({
      kind: "failed",
      renderer: "native",
      reason: "encoder exploded",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("never throws: a non-Error throw degrades to the generic reason", async () => {
    const pipeline = makeImagePipeline(nativeSupport(), geometry, {
      probeDecode: neverProbe,
      signal: liveSignal,
      readBytes: pngBytes,
      renderImage: vi.fn(() => {
        throw "not an error";
      }),
    });
    await expect(pipeline.render("/work/x.png")).resolves.toEqual({
      kind: "failed",
      renderer: "native",
      reason: "unexpected renderer failure",
    });
  });

  it("fails chafa cleanly when the snapshot is not ok, without spawning", async () => {
    const exec = chafaExec();
    const pipeline = makeImagePipeline(
      chafaSupport({ chafa: { state: "missing", detail: "nope" } }),
      geometry,
      { probeDecode: neverProbe, signal: liveSignal, exec },
    );
    expect(pipeline.attempts).toEqual(["chafa"]);
    await expect(pipeline.render("/work/x.png")).resolves.toEqual({
      kind: "failed",
      renderer: "chafa",
      reason: "chafa is not available",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails the native attempt cleanly when the snapshot carries no protocol", async () => {
    const snapshot = nativeSupport();
    const pipeline = makeImagePipeline(snapshot, geometry, { probeDecode: neverProbe, signal: liveSignal });
    expect(pipeline.attempts).toEqual(["native"]);
    // Defense in depth: a snapshot whose plan says native but whose protocol
    // is null must reject cleanly rather than render.
    snapshot.nativeProtocol = null;
    await expect(pipeline.render("/work/x.png")).resolves.toEqual({
      kind: "failed",
      renderer: "native",
      reason: "native rendering is not available",
    });
  });

  it("derives the protocol rules from the table (kitty five clauses, iterm2 the complements)", () => {
    expect(NATIVE_PROTOCOL_RULES.kitty).toEqual({
      decodeProbe: true,
      requiresPng: true,
      freshImageId: true,
      layout: "sequence-first",
      cacheable: false,
    });
    expect(NATIVE_PROTOCOL_RULES.iterm2).toEqual({
      decodeProbe: false,
      requiresPng: false,
      freshImageId: false,
      layout: "cursor-up-tail",
      cacheable: true,
    });
  });
});

describe("host image settings through resolveImageSupport (spec §6.3)", () => {
  const path = "/home/user/.pi/agent/settings.json";
  const paths = {
    userSettings: path,
    projectSettings: "/cwd/.pi/settings.json",
    agentDir: "/home/user/.pi/agent",
  };
  const noTools: PiChafaApi = { getAllTools: () => [], getCommands: () => [] };
  const resolve = (settingsText: string | undefined) =>
    resolveImageSupport(
      noTools,
      paths,
      { images: { mode: "chafa" } },
      {
        readText: readTextOf(settingsText !== undefined ? { [path]: settingsText } : {}),
        env: {},
      },
    );
  /** The three host fields the snapshot exposes. */
  const host = (resolved: ImageSupport) => ({
    showImages: resolved.hostShowImages,
    imageWidthCells: resolved.hostImageWidthCells,
    nativeProtocol: resolved.nativeProtocol,
  });

  it("honors terminal.showImages false", async () => {
    const resolved = await resolve(
      JSON.stringify({
        terminal: { showImages: false },
      }),
    );
    expect(host(resolved)).toEqual({
      showImages: false,
      imageWidthCells: 60,
      nativeProtocol: null,
    });
    expect(resolved.tier).toBe("none");
  });

  it("honors a positive integer imageWidthCells", async () => {
    const resolved = await resolve(
      JSON.stringify({
        terminal: { imageWidthCells: 120 },
      }),
    );
    expect(host(resolved)).toEqual({
      showImages: true,
      imageWidthCells: 120,
      nativeProtocol: null,
    });
  });

  it("parses terminal.images for exact kitty/iterm2 only", async () => {
    const read = (terminal: unknown) => resolve(JSON.stringify({ terminal }));
    expect(host(await read({ images: "kitty" }))).toEqual({
      showImages: true,
      imageWidthCells: 60,
      nativeProtocol: "kitty",
    });
    expect(host(await read({ images: "iterm2" }))).toEqual({
      showImages: true,
      imageWidthCells: 60,
      nativeProtocol: "iterm2",
    });
    // Everything else — false, "auto", "none", wrong case, non-string,
    // absent — is null.
    for (const images of [false, "auto", "none", "AUTO", "Kitty", 42, null]) {
      expect(host(await read({ images }))).toEqual({
        showImages: true,
        imageWidthCells: 60,
        nativeProtocol: null,
      });
    }
    expect(host(await read({}))).toEqual({
      showImages: true,
      imageWidthCells: 60,
      nativeProtocol: null,
    });
    // images is independent of showImages.
    expect(host(await read({ images: "kitty", showImages: false }))).toEqual({
      showImages: false,
      imageWidthCells: 60,
      nativeProtocol: "kitty",
    });
  });

  it("falls back to defaults on missing, corrupt, or invalid settings", async () => {
    const defaults = { showImages: true, imageWidthCells: 60, nativeProtocol: null };
    expect(host(await resolve(undefined))).toEqual(defaults);
    expect(host(await resolve("{corrupt"))).toEqual(defaults);
    expect(
      host(
        await resolve(
          JSON.stringify({
            terminal: { showImages: "false", imageWidthCells: 0 },
          }),
        ),
      ),
    ).toEqual(defaults);
  });
});

describe("native protocol ladder through resolveImageSupport (spec §5.3, D4; Issue #100)", () => {
  const paths = {
    userSettings: "/home/user/.pi/agent/settings.json",
    projectSettings: "/cwd/.pi/settings.json",
    agentDir: "/home/user/.pi/agent",
  };
  const noTools: PiChafaApi = { getAllTools: () => [], getCommands: () => [] };
  const settingsWith = (images: unknown): ReadText =>
    readTextOf({ [paths.userSettings]: JSON.stringify({ terminal: { images } }) });
  /** Mode "native": the ladder reads; tier mirrors an active protocol. */
  const resolve = (deps?: Parameters<typeof resolveImageSupport>[3]) =>
    resolveImageSupport(noTools, paths, { images: { mode: "native" } }, deps);

  it("prefers the host capability over conflicting settings and env", async () => {
    expect(
      (
        await resolve({
          capabilities: () => ({ images: "kitty" }),
          readText: settingsWith("iterm2"),
          env: { PI_IMAGE_PROTOCOL: "iterm2" },
        })
      ).nativeProtocol,
    ).toBe("kitty");
    expect(
      (
        await resolve({
          capabilities: () => ({ images: "iterm2" }),
          readText: settingsWith("kitty"),
          env: { PI_IMAGE_PROTOCOL: "kitty" },
        })
      ).nativeProtocol,
    ).toBe("iterm2");
  });

  it("falls back to the settings file when the host reports null", async () => {
    for (const images of ["kitty", "iterm2"] as const) {
      const resolved = await resolve({
        capabilities: () => ({ images: null }),
        readText: settingsWith(images),
        env: {},
      });
      expect(resolved.nativeProtocol).toBe(images);
      expect(resolved.tier).toBe("native");
    }
  });

  it("falls back to the env when host and settings are both absent or non-native", async () => {
    for (const protocol of ["kitty", "iterm2"] as const) {
      // host null + settings false
      expect(
        (
          await resolve({
            capabilities: () => ({ images: null }),
            readText: settingsWith(false),
            env: { PI_IMAGE_PROTOCOL: protocol },
          })
        ).nativeProtocol,
      ).toBe(protocol);
      // host null + settings "auto"
      expect(
        (
          await resolve({
            capabilities: () => ({ images: null }),
            readText: settingsWith("auto"),
            env: { PI_IMAGE_PROTOCOL: protocol },
          })
        ).nativeProtocol,
      ).toBe(protocol);
      // no capabilities accessor at all + settings absent
      expect(
        (
          await resolve({
            readText: readTextOf({}),
            env: { PI_IMAGE_PROTOCOL: protocol },
          })
        ).nativeProtocol,
      ).toBe(protocol);
    }
  });

  it("trims the env value before the exact match", async () => {
    expect(
      (
        await resolve({
          capabilities: () => ({ images: null }),
          readText: readTextOf({}),
          env: { PI_IMAGE_PROTOCOL: "  kitty  " },
        })
      ).nativeProtocol,
    ).toBe("kitty");
  });

  it("returns null when every source is absent or non-native", async () => {
    // Default env (no injected env): still null with the test host.
    expect(
      (
        await resolve({
          capabilities: () => ({ images: null }),
          readText: readTextOf({}),
        })
      ).nativeProtocol,
    ).toBeNull();
    expect(
      (
        await resolve({
          capabilities: () => ({ images: null }),
          env: {},
        })
      ).nativeProtocol,
    ).toBeNull();
    expect(
      (
        await resolve({
          capabilities: () => ({ images: null }),
          readText: settingsWith("none"),
          env: { PI_IMAGE_PROTOCOL: "auto" },
        })
      ).nativeProtocol,
    ).toBeNull();
    expect(
      (
        await resolve({
          capabilities: () => ({ images: null }),
          readText: settingsWith("AUTO"),
          env: { PI_IMAGE_PROTOCOL: "false" },
        })
      ).nativeProtocol,
    ).toBeNull();
  });

  it("returns null for known no-image terminals even when settings or env declare a protocol (Issue #100)", async () => {
    for (const env of [
      { TERM_PROGRAM: "alacritty", TERM: "xterm-256color" },
      { ALACRITTY_LOG: "/tmp/Alacritty-333525.log", TERM: "xterm-256color" },
      { ALACRITTY_WINDOW_ID: "94545817931344" },
      { ALACRITTY_SOCKET: "/run/user/1000/Alacritty-wayland-0-333525.sock" },
      { TERM_PROGRAM: "vscode" },
      { TERM_PROGRAM: "zed" },
      { TERMINAL_EMULATOR: "jetbrains-jediterm" },
      { WT_SESSION: "1" },
    ]) {
      expect(
        (
          await resolve({
            capabilities: () => ({ images: null }),
            readText: settingsWith("kitty"),
            env,
          })
        ).nativeProtocol,
      ).toBeNull();
      expect(
        (
          await resolve({
            capabilities: () => ({ images: null }),
            readText: readTextOf({}),
            env: { ...env, PI_IMAGE_PROTOCOL: "iterm2" },
          })
        ).nativeProtocol,
      ).toBeNull();
    }
  });

  it("still honors the settings override for unrecognized terminals (Konsole keeps native, Issue #100)", async () => {
    // Konsole is not in pi-tui's detection table → "unknown terminal" → the
    // settings override is the only source of its native capability.
    expect(
      (
        await resolve({
          capabilities: () => ({ images: null }),
          readText: settingsWith("kitty"),
          env: { KONSOLE_VERSION: "240301", TERM: "xterm-256color" },
        })
      ).nativeProtocol,
    ).toBe("kitty");
  });

  it("known no-image terminals cannot be forced even by a positive caps report (Issue #100)", async () => {
    // pi pushes terminal.images into pi-tui's capability overrides, so caps
    // can report kitty in Alacritty too — the negative guard precedes every
    // declaration, including the capability step.
    for (const env of [
      { TERM_PROGRAM: "alacritty" },
      { ALACRITTY_LOG: "/tmp/Alacritty-x.log" },
      { WT_SESSION: "1" },
    ]) {
      expect(
        (
          await resolve({
            capabilities: () => ({ images: "kitty" }),
            readText: settingsWith("iterm2"),
            env: { ...env, PI_IMAGE_PROTOCOL: "iterm2" },
          })
        ).nativeProtocol,
      ).toBeNull();
    }
  });

  it("keeps positive capability reports for real terminals (no negative markers, Issue #100)", async () => {
    // kitty/ghostty/wezterm/iTerm2 are never in the negative table: their
    // host capability report (or PI_IMAGE_PROTOCOL forcing) still wins.
    expect(
      (
        await resolve({
          capabilities: () => ({ images: "kitty" }),
          readText: settingsWith("iterm2"),
          env: { TERM_PROGRAM: "kitty", PI_IMAGE_PROTOCOL: "iterm2" },
        })
      ).nativeProtocol,
    ).toBe("kitty");
    expect(
      (
        await resolve({
          capabilities: () => ({ images: "iterm2" }),
          env: {},
        })
      ).nativeProtocol,
    ).toBe("iterm2");
  });

  it("never lets settings garbage block the env step (positive-only ladder)", async () => {
    for (const images of [false, "auto", "none", "AUTO", "kitty-ish", 42, "false"]) {
      expect(
        (
          await resolve({
            capabilities: () => ({ images: null }),
            readText: settingsWith(images as unknown),
            env: { PI_IMAGE_PROTOCOL: "iterm2" },
          })
        ).nativeProtocol,
      ).toBe("iterm2");
    }
  });

  it("returns null when running under tmux or screen multiplexer (#070, #097)", async () => {
    // TMUX env variable set
    expect(
      (
        await resolve({
          capabilities: () => ({ images: "kitty" }),
          env: { TMUX: "1", PI_IMAGE_PROTOCOL: "kitty" },
          readText: settingsWith("kitty"),
        })
      ).nativeProtocol,
    ).toBeNull();

    // TERM starting with tmux
    expect(
      (
        await resolve({
          capabilities: () => ({ images: "iterm2" }),
          env: { TERM: "tmux-256color" },
          readText: settingsWith("iterm2"),
        })
      ).nativeProtocol,
    ).toBeNull();

    // TERM starting with screen
    expect(
      (
        await resolve({
          capabilities: () => ({ images: "kitty" }),
          env: { TERM: "screen.xterm-256color" },
          readText: settingsWith("kitty"),
        })
      ).nativeProtocol,
    ).toBeNull();
  });

  it("uses only injected capabilities/readText/env — never the real $HOME or process env", async () => {
    const resolved = await resolveImageSupport(
      noTools,
      { ...paths, userSettings: "/not-real/settings.json" },
      { images: { mode: "native" } },
      {
        capabilities: () => ({ images: null }),
        readText: readTextOf({}),
        env: {},
      },
    );
    expect(resolved.nativeProtocol).toBeNull();
    expect(resolved.tier).toBe("none");
  });
});

describe("kitty protocol probe helpers (Issue #101, #116)", () => {
  it("buildKittyProbeQuery always sends a PNG sample under f=100 (Issue #116)", () => {
    const q = buildKittyProbeQuery(31);
    // The PNG sample is the ONLY valid payload for f=100 — JPEG/WebP samples
    // would be rejected by kitty's a=q decoder, which interprets f=100 literally
    // as PNG (Issue #116 root cause). The Issue #102 per-MIME sample table was
    // removed with its last consumer (Issue #117 cleanup). The query itself is
    // the fixture (Issue #180): parse the payload out and prove it is a PNG.
    const match = /^\x1b_Ga=q,t=d,f=100,i=31;([A-Za-z0-9+/=]+)\x1b\\$/.exec(q);
    expect(match).not.toBeNull();
    const bytes = Buffer.from(match?.[1] ?? "", "base64");
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it("the PNG probe sample decodes as 1x1 via pi-tui getImageDimensions", () => {
    const dims = getImageDimensions(probeSampleBase64(), "image/png");
    expect(dims).not.toBeNull();
    expect(dims?.widthPx).toBe(1);
    expect(dims?.heightPx).toBe(1);
  });

  it("consumeKittyProbeReply matches the OK reply terminated by ESC ST", () => {
    expect(consumeKittyProbeReply(createKittyProbeState(), "\x1b_Gi=7;OK\x1b\\", 7)).toBe("ok");
  });

  it("consumeKittyProbeReply matches the OK reply terminated by BEL", () => {
    expect(consumeKittyProbeReply(createKittyProbeState(), "\x1b_Gi=7;OK\x07", 7)).toBe("ok");
  });

  it("treats any non-OK message as an error reply", () => {
    expect(
      consumeKittyProbeReply(createKittyProbeState(), "\x1b_Gi=7;Invalid image data\x1b\\", 7),
    ).toBe("error");
  });

  it("reassembles replies split across input chunks", () => {
    const state = createKittyProbeState();
    expect(consumeKittyProbeReply(state, "\x1b_Gi=7;O", 7)).toBe("pending");
    expect(consumeKittyProbeReply(state, "K\x1b\\", 7)).toBe("ok");
  });

  it("waits for the terminator once our id is seen", () => {
    const state = createKittyProbeState();
    expect(consumeKittyProbeReply(state, "\x1b_Gi=7;", 7)).toBe("pending");
    expect(consumeKittyProbeReply(state, "boom\x1b\\", 7)).toBe("error");
  });

  it("ignores replies addressed to other ids and unrelated input", () => {
    const state = createKittyProbeState();
    expect(consumeKittyProbeReply(state, "\x1b_Gi=8;OK\x1b\\", 7)).toBe("foreign");
    expect(consumeKittyProbeReply(state, "plain keystrokes", 7)).toBe("foreign");
    // The buffer resets, so our own reply still matches afterwards.
    expect(consumeKittyProbeReply(state, "\x1b_Gi=7;OK\x1b\\", 7)).toBe("ok");
  });
  it("skips a complete foreign reply and still matches ours in the same chunk (Issue #193)", () => {
    // ESC-ST-terminated foreign reply followed by ours in one chunk: the
    // foreign exchange must be skipped, not thrown away with our reply.
    expect(
      consumeKittyProbeReply(createKittyProbeState(), "\x1b_Gi=8;OK\x1b\\\x1b_Gi=7;OK\x1b\\", 7),
    ).toBe("ok");
    // BEL-terminated foreign reply, and a foreign error message.
    expect(
      consumeKittyProbeReply(createKittyProbeState(), "\x1b_Gi=8;boom\x07\x1b_Gi=7;OK\x07", 7),
    ).toBe("ok");
    // A foreign exchange split across chunks keeps its remainder buffered and
    // waits for the terminator instead of clearing the shared buffer.
    const split = createKittyProbeState();
    expect(consumeKittyProbeReply(split, "\x1b_Gi=8;OK", 7)).toBe("pending");
    expect(consumeKittyProbeReply(split, "\x1b\\\x1b_Gi=7;OK\x1b\\", 7)).toBe("ok");
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
      config: DEFAULT_CONFIG,
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
        config: DEFAULT_CONFIG,
        hostShowImages: true,
        hostImageWidthCells: 60,
      });
    }
  });
});

describe("makeImagePipeline plan attempts (Issue #143)", () => {
  const geometry = { cols: 80, rows: 24 };
  const plan = (
    snapshot: ImageSupport,
    geom: { cols: number; rows: number } = geometry,
  ) =>
    makeImagePipeline(snapshot, geom, {
      probeDecode: neverProbe,
      signal: liveSignal,
    }).attempts;

  it("plans nothing without a geometry (nothing laid out / pane too small)", () => {
    // The pipeline's geometry parameter is non-nullable; the plan keeps its
    // null guard for direct callers, so drive it with the runtime null.
    const noGeometry = null as unknown as { cols: number; rows: number };
    expect(plan(support(), noGeometry)).toEqual([]);
    expect(plan(support({ tier: "chafa" }), noGeometry)).toEqual([]);
    expect(plan(makeDeferredImageSupport("auto"), noGeometry)).toEqual([]);
  });

  it("plans nothing when the snapshot resolved no renderer (tier none)", () => {
    expect(plan(support({ tier: "none" }))).toEqual([]);
    expect(plan(support({ tier: "none", nativeProtocol: null }))).toEqual([]);
    // The host gate stays whole: terminal.showImages=false resolves tier none
    // even though the chafa probe may still have succeeded for the hint copy.
    expect(plan(support({ hostShowImages: false, tier: "none" }))).toEqual([]);
    expect(plan(support({ mode: "off", tier: "none" }))).toEqual([]);
    expect(plan(makeDeferredImageSupport("off"))).toEqual([]);
  });

  it("plans nothing when strict chafa has no usable probe", () => {
    const notOk: ImageSupport["chafa"] = { state: "missing", detail: "not found" };
    expect(
      plan(support({ mode: "chafa", nativeProtocol: null, tier: "none", chafa: notOk })),
    ).toEqual([]);
    expect(plan(support({ mode: "chafa", nativeProtocol: null, tier: "none" }))).toEqual([]);
  });

  it("plans native only under strict native with a protocol", () => {
    expect(plan(nativeSupport())).toEqual(["native"]);
    // Strict native without a capability resolves tier none: nothing renders.
    expect(plan(nativeSupport({ nativeProtocol: null, tier: "none" }))).toEqual([]);
  });

  it("orders auto native → chafa when preferNative (the resolved tier) says native", () => {
    expect(plan(support())).toEqual(["native", "chafa"]);
    expect(
      plan(support({ config: { ...DEFAULT_CONFIG, preferNative: true } })),
    ).toEqual(["native", "chafa"]);
  });

  it("plans chafa only under auto when preferNative is false (the tier already resolved to chafa)", () => {
    expect(
      plan(support({ tier: "chafa", config: { ...DEFAULT_CONFIG, preferNative: false } })),
    ).toEqual(["chafa"]);
  });

  it("plans chafa only under auto without a native protocol", () => {
    expect(plan(support({ nativeProtocol: null, tier: "chafa" }))).toEqual(["chafa"]);
  });

  it("defers chafa under strict native (no per-file fallback attempt)", () => {
    expect(plan(nativeSupport())).toEqual(["native"]);
  });

  it("never probes: a resolved chafa tier plans chafa even without pi-chafa metadata", () => {
    // The snapshot is the source of truth; the planner reads, never re-derives.
    expect(
      plan(
        support({
          piChafa: { present: false, via: "none" },
          chafa: { state: "ok", binary: "chafa", version: { major: 1, minor: 18 } },
          tier: "chafa",
        }),
      ),
    ).toEqual(["chafa"]);
  });
});

describe("isNativelyRenderable (Issue #143)", () => {
  it("accepts exactly the NATIVE_IMAGE_MIME extensions, case-insensitively", () => {
    expect(isNativelyRenderable("pics/photo.png")).toBe(true);
    expect(isNativelyRenderable("photo.JPG")).toBe(true);
    expect(isNativelyRenderable("a/b/c.webp")).toBe(true);
    expect(isNativelyRenderable("anim.gif")).toBe(true);
  });

  it("rejects unknown extensions, dot files and extension-less names", () => {
    expect(isNativelyRenderable("photo.bmp")).toBe(false);
    expect(isNativelyRenderable(".png")).toBe(false);
    expect(isNativelyRenderable("noext")).toBe(false);
    expect(isNativelyRenderable("trailing.")).toBe(false);
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
    expect(support.config).toEqual(DEFAULT_CONFIG);
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

describe("native render through makeImagePipeline (spec §5.3, D3)", () => {
  // Real 1×1 image fixtures (spec §12.1): decode via pi-tui's own sniffers.
  const GIF_1X1_BASE64 =
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const JPEG_1X1_BASE64 =
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
  const WEBP_1X1_BASE64 =
    "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAD8D+JaQAA3AA/ua1AAA=";
  const geometry = { cols: 40, rows: 10 };

  /** Point pi-tui's real encoders at a protocol, preserving the rest of the caps. */
  const withProtocol = (images: "kitty" | "iterm2"): void => {
    const saved = getCapabilities();
    setCapabilities({ ...saved, images });
  };

  /** Strict-native pipeline over the real seams; ctx narrows per case. */
  const renderNative = (
    absPath: string,
    ctx: Partial<Parameters<typeof makeImagePipeline>[2]> = {},
    overrides: Partial<ImageSupport> = {},
  ) =>
    makeImagePipeline(nativeSupport(overrides), geometry, {
      probeDecode: neverProbe,
      signal: liveSignal,
      ...ctx,
    }).render(absPath);

  afterEach(() => {
    resetCapabilitiesCache();
  });

  it("kitty: sequence header carries a=T,f=100,q=2,C=1 plus c=/r=/i= and filler rows are empty", async () => {
    withProtocol("kitty");
    const readBytes = readBytesOf(PNG_1X1_BASE64);
    const result = await renderNative("/tmp/pixel.png", { readBytes });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
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
    // The pipeline stamps the REQUESTED geometry; the sequence carries
    // pi-tui's aspect-fitted c=/r= — both contracts asserted here.
    expect(result.renderer).toBe("native");
    expect(result.cols).toBe(geometry.cols);
    expect(result.rows).toBe(geometry.rows);
    expect(r).toBeGreaterThan(1);
    expect(result.lines).toHaveLength(r);
    // Every line after the sequence is exactly "" (D9 row contract).
    for (const filler of result.lines.slice(1)) {
      expect(filler).toBe("");
    }
    expect(readBytes).toHaveBeenCalledWith("/tmp/pixel.png");
  });

  it("iterm2 renders a real JPEG fixture", async () => {
    withProtocol("iterm2");
    const readBytes = readBytesOf(JPEG_1X1_BASE64);
    const result = await renderNative("/tmp/pixel.jpg", { readBytes }, { nativeProtocol: "iterm2" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.at(-1)).toContain("\x1b]1337;File=");
    expect(readBytes).toHaveBeenCalledWith("/tmp/pixel.jpg");
  });

  it("iterm2 renders a real WebP fixture", async () => {
    withProtocol("iterm2");
    const readBytes = readBytesOf(WEBP_1X1_BASE64);
    const result = await renderNative("/tmp/pixel.webp", { readBytes }, { nativeProtocol: "iterm2" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.at(-1)).toContain("\x1b]1337;File=");
    expect(readBytes).toHaveBeenCalledWith("/tmp/pixel.webp");
  });

  it("kitty renders non-PNG formats (JPEG, WebP, GIF) by converting to PNG", async () => {
    withProtocol("kitty");
    for (const [ext, b64] of [
      ["jpg", JPEG_1X1_BASE64],
      ["webp", WEBP_1X1_BASE64],
      ["gif", GIF_1X1_BASE64],
    ] as const) {
      const readBytes = readBytesOf(b64);
      const result = await renderNative(`/tmp/pixel.${ext}`, { readBytes });
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.lines[0]).toContain("a=T,f=100,q=2,C=1");
      expect(result.lines.length).toBeGreaterThan(0);
      expect(readBytes).toHaveBeenCalledWith(`/tmp/pixel.${ext}`);
    }
  });

  it("kitty degrades cleanly when convertToPng fails or returns null", async () => {
    const readBytes = readBytesOf(JPEG_1X1_BASE64);
    expect(
      await renderNative("/tmp/pixel.jpg", {
        readBytes,
        convertToPng: async () => null,
      }),
    ).toEqual({
      kind: "failed",
      renderer: "native",
      reason: "could not convert image to PNG for Kitty rendering",
    });

    expect(
      await renderNative("/tmp/pixel.jpg", {
        readBytes,
        convertToPng: async () => {
          throw new Error("conversion error");
        },
      }),
    ).toEqual({
      kind: "failed",
      renderer: "native",
      reason: "could not convert image to PNG for Kitty rendering",
    });
  });

  it("kitty respects abort signal during conversion", async () => {
    const controller = new AbortController();
    const readBytes = readBytesOf(JPEG_1X1_BASE64);
    const result = await renderNative("/tmp/pixel.jpg", {
      readBytes,
      signal: controller.signal,
      convertToPng: async () => {
        controller.abort();
        return { data: PNG_1X1_BASE64, mimeType: "image/png" };
      },
    });
    expect(result).toEqual({ kind: "aborted" });
  });

  it("iterm2: fillers are empty and the last line is moveUp + File= with inline=1 and width=", async () => {
    withProtocol("iterm2");
    const readBytes = readBytesOf(PNG_1X1_BASE64);
    const result = await renderNative("/tmp/pixel.png", { readBytes }, { nativeProtocol: "iterm2" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.rows).toBe(geometry.rows); // the request, stamped by the pipeline
    const fittedRows = result.lines.length;
    expect(fittedRows).toBeGreaterThan(1);
    for (const filler of result.lines.slice(0, fittedRows - 1)) {
      expect(filler).toBe("");
    }
    const last = result.lines[fittedRows - 1] ?? "";
    expect(last.startsWith(`\x1b[${fittedRows - 1}A`)).toBe(true);
    expect(last).toContain("\x1b]1337;File=");
    expect(last).toContain("inline=1");
    expect(last).toContain("width=");
    const width = Number(/width=(\d+)/.exec(last)?.[1]);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(geometry.cols);
    expect(last).toContain(`width=${width}`);
  });

  it("degrades when the decode probe reports an error (Issue #101)", async () => {
    const readBytes = readBytesOf(PNG_1X1_BASE64);
    const result = await renderNative("/tmp/pixel.png", {
      readBytes,
      probeDecode: async () => "error",
    });
    expect(result).toEqual({
      kind: "failed",
      renderer: "native",
      reason: "terminal does not support kitty graphics",
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("proceeds on probe ok and no-reply, and tolerates a throwing probe (Issue #101)", async () => {
    for (const verdict of ["ok", "no-reply"] as const) {
      const readBytes = readBytesOf(PNG_1X1_BASE64);
      const result = await renderNative("/tmp/pixel.png", {
        readBytes,
        probeDecode: async () => verdict,
        renderImage: encoder(),
      });
      expect(result.kind).toBe("ok");
    }
    const throwing = readBytesOf(PNG_1X1_BASE64);
    const result = await renderNative("/tmp/pixel.png", {
      readBytes: throwing,
      renderImage: encoder(),
      probeDecode: async () => {
        throw new Error("boom");
      },
    });
    expect(result.kind).toBe("ok");
    expect(throwing).toHaveBeenCalled();
  });

  it("only probes kitty renders, never iterm2 (Issue #101)", async () => {
    const probeDecode = vi.fn<() => Promise<KittyProbeVerdict>>(async () => "error");
    const readBytes = readBytesOf(PNG_1X1_BASE64);
    const result = await renderNative(
      "/tmp/pixel.png",
      { readBytes, probeDecode, renderImage: encoder() },
      { nativeProtocol: "iterm2" },
    );
    expect(result.kind).toBe("ok");
    expect(probeDecode).not.toHaveBeenCalled();
  });

  it("folds the renderer's no-image terminal guard into the support ladder: no protocol, no native attempt (Issue #100)", async () => {
    // The renderer's defensive env guard is unreachable through the pipeline
    // (makeImagePipeline never passes env down); the SAME terminal inputs are
    // asserted at the resolution surface: the ladder refuses every declaration
    // (even a forced caps report), and a refusal plans no native attempt.
    const noTools: PiChafaApi = { getAllTools: () => [], getCommands: () => [] };
    for (const env of [
      { TERM_PROGRAM: "alacritty" },
      { ALACRITTY_LOG: "/tmp/Alacritty-x.log" },
      { WT_SESSION: "1" },
    ]) {
      const resolved = await resolveImageSupport(
        noTools,
        {
          userSettings: "/u/settings.json",
          projectSettings: "/p/settings.json",
          agentDir: "/home/u/.pi/agent",
        },
        { images: { mode: "native" } },
        { readText: readTextOf({}), env, capabilities: () => ({ images: "kitty" }) },
      );
      expect(resolved.nativeProtocol).toBeNull();
      expect(
        makeImagePipeline(resolved, geometry, {
          probeDecode: neverProbe,
          signal: liveSignal,
        }).attempts,
      ).toEqual([]);
    }
  });

  it("folds the renderer's multiplexer guard into the support ladder: no protocol, no native attempt (#070)", async () => {
    // Same fold as the no-image terminals above: tmux/screen input via the
    // resolution surface, where it must refuse every declaration.
    const noTools: PiChafaApi = { getAllTools: () => [], getCommands: () => [] };
    for (const env of [
      { TMUX: "1" },
      { TERM: "tmux-256color" },
      { TERM: "screen.xterm-256color" },
    ]) {
      const resolved = await resolveImageSupport(
        noTools,
        {
          userSettings: "/u/settings.json",
          projectSettings: "/p/settings.json",
          agentDir: "/home/u/.pi/agent",
        },
        { images: { mode: "native" } },
        { readText: readTextOf({}), env, capabilities: () => ({ images: "kitty" }) },
      );
      expect(resolved.nativeProtocol).toBeNull();
      expect(
        makeImagePipeline(resolved, geometry, {
          probeDecode: neverProbe,
          signal: liveSignal,
        }).attempts,
      ).toEqual([]);
    }
  });

  it.each([
    ["bmp", "/tmp/pixel.bmp"],
    ["svg", "/tmp/pixel.svg"],
    ["no extension", "/tmp/pixel"],
    ["leading dot", "/tmp/.pixel"],
  ])("%s → unsupported format, never reads", async (_label, path) => {
    const readBytes = vi.fn();
    const result = await renderNative(
      path,
      { readBytes },
      { nativeProtocol: "iterm2" },
    );
    expect(result).toEqual({
      kind: "failed",
      renderer: "native",
      reason: "native rendering does not support this image format",
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("iterm2 renders a real GIF fixture", async () => {
    withProtocol("iterm2");
    const readBytes = readBytesOf(GIF_1X1_BASE64);
    const result = await renderNative("/tmp/pixel.gif", { readBytes }, { nativeProtocol: "iterm2" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.at(-1)).toContain("\x1b]1337;File=");
    expect(readBytes).toHaveBeenCalledWith("/tmp/pixel.gif");
  });

  it("oversized read fails with the exact 4 MiB cap reason (D7)", async () => {
    const readBytes = vi.fn(
      async () => new Uint8Array(IMAGE_NATIVE_MAX_BYTES + 1),
    );
    const result = await renderNative("/tmp/pixel.png", { readBytes });
    expect(result).toEqual({
      kind: "failed",
      renderer: "native",
      reason: "image exceeds the 4 MiB native rendering cap",
    });
    expect(readBytes).toHaveBeenCalledTimes(1);
  });

  it("a pre-aborted signal fails before any read", async () => {
    const readBytes = vi.fn();
    const result = await renderNative("/tmp/pixel.png", {
      readBytes,
      signal: AbortSignal.abort(),
    });
    expect(result).toEqual({ kind: "aborted" });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("garbage bytes under .png fail with could not read image dimensions", async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5]));
    const result = await renderNative("/tmp/pixel.png", { readBytes });
    expect(result).toEqual({
      kind: "failed",
      renderer: "native",
      reason: "could not read image dimensions",
    });
  });

  it("a rejecting readBytes becomes a clean failure, never a throw", async () => {
    const readBytes = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await renderNative("/tmp/pixel.png", { readBytes });
    expect(result).toEqual({ kind: "failed", renderer: "native", reason: "could not read the image file" });
  });
});
