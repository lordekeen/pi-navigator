/**
 * Shared environment truth-table parser for pi-navigator (Issue #063).
 *
 * `PI_NAV_ICONS` (icons.ts) and `PI_NAV_IMAGES` (settings.ts) used to carry
 * two copies of the same enable/disable value sets and the same
 * invalid-value warning shape; both now project onto `parseTruthyEnv` so the
 * table cannot drift. The images env additionally accepts the `chafa` token,
 * which `parseImageMode` recognizes itself before delegating (Issue #028
 * carve-out).
 *
 * Pure and dependency-free on purpose: icons.ts imports this module and is
 * pulled in by the TUI component module, so it must stay free of `node:*`
 * and pi imports.
 */

/** Truthy env tokens: 1/true/yes/on enable the feature (lower-case, trimmed). */
export const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/** Falsy env tokens: 0/false/no/off disable the feature (lower-case, trimmed). */
export const FALSY_ENV_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/**
 * Parse an env override against the shared truth table: enable =
 * 1/true/yes/on, disable = 0/false/no/off, anything else ignored with one
 * warning so the file/default setting stands. Case-insensitive, trimmed;
 * unset/empty/whitespace input is "no override", never a warning.
 *
 * `envName` (e.g. "PI_NAV_ICONS") is embedded verbatim in the warning.
 */
export function parseTruthyEnv(
  value: string | undefined,
  envName: string,
): { value?: boolean; warning?: string } {
  if (value === undefined) return { value: undefined };
  const trimmed = value.trim();
  if (trimmed === "") return { value: undefined };
  const normalized = trimmed.toLowerCase();
  if (TRUTHY_ENV_VALUES.has(normalized)) return { value: true };
  if (FALSY_ENV_VALUES.has(normalized)) return { value: false };
  return { value: undefined, warning: `${trimmed} is not a valid ${envName} value; using the file/default setting` };
}