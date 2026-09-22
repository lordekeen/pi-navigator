/**
 * env.ts unit suites (Issue #063): the shared env truth-table parser behind
 * `parseIconMode` (icons.ts) and `parseImageMode` (settings.ts). Pinned here
 * directly so the enable/disable token sets and the warning wording cannot
 * drift between the two env vars (the images env additionally accepts the
 * `chafa` token, handled in settings.ts before delegating).
 */

import { describe, expect, it } from "vitest";

import { FALSY_ENV_VALUES, TRUTHY_ENV_VALUES, parseTruthyEnv } from "../env";

describe("parseTruthyEnv", () => {
  it("exports exactly the shared enable/disable token sets", () => {
    expect([...TRUTHY_ENV_VALUES]).toEqual(["1", "true", "yes", "on"]);
    expect([...FALSY_ENV_VALUES]).toEqual(["0", "false", "no", "off"]);
  });

  it.each([...TRUTHY_ENV_VALUES])("enables for the truthy token %s", (value) => {
    expect(parseTruthyEnv(value, "PI_NAV_ICONS")).toEqual({ value: true });
  });

  it.each([...FALSY_ENV_VALUES])("disables for the falsy token %s", (value) => {
    expect(parseTruthyEnv(value, "PI_NAV_ICONS")).toEqual({ value: false });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseTruthyEnv(" TRUE ", "PI_NAV_ICONS")).toEqual({ value: true });
    expect(parseTruthyEnv("  On  ", "PI_NAV_ICONS")).toEqual({ value: true });
    expect(parseTruthyEnv("OFF", "PI_NAV_IMAGES")).toEqual({ value: false });
    expect(parseTruthyEnv("\tno\n", "PI_NAV_IMAGES")).toEqual({ value: false });
  });

  it("treats undefined, empty, and whitespace as no override, without a warning", () => {
    expect(parseTruthyEnv(undefined, "PI_NAV_ICONS")).toEqual({ value: undefined });
    expect(parseTruthyEnv("", "PI_NAV_ICONS")).toEqual({ value: undefined });
    expect(parseTruthyEnv("   ", "PI_NAV_IMAGES")).toEqual({ value: undefined });
  });

  it("rejects garbage with the exact warning string, embedding the env name", () => {
    expect(parseTruthyEnv("native", "PI_NAV_IMAGES")).toEqual({
      value: undefined,
      warning: "native is not a valid PI_NAV_IMAGES value; using the file/default setting",
    });
    expect(parseTruthyEnv("  sometimes  ", "PI_NAV_ICONS")).toEqual({
      value: undefined,
      warning: "sometimes is not a valid PI_NAV_ICONS value; using the file/default setting",
    });
  });
});