/**
 * pi-navigator settings — versioned user-level settings terrain (§5.1/§5.2):
 * typed defaults, a never-throw pure normalizer, a loader with file/env
 * provenance, a canonical serializer, an atomic tmp+rename writer, and the
 * field registry for the future `/navigator configure` modal (pi-overseer
 * pattern, JSON instead of YAML — this repo has zero runtime dependencies).
 *
 * Warnings are short and user-facing: they travel through ctx.ui.notify
 * exactly once per load. The env override is passed in explicitly (like
 * PI_NAV_ICONS) — nothing in this module reads process.env.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// pi-lens-ignore: TS2304
import { dirname } from "node:path";

export interface NavigatorImageSettings {
  mode: "off" | "chafa";
}

export interface NavigatorSettings {
  readonly version: number;
  readonly images: NavigatorImageSettings;
}

const SETTINGS_VERSION = 1;
const IMAGE_MODES = ["off", "chafa"] as const;
type ImageMode = (typeof IMAGE_MODES)[number];

const IMAGE_ENABLE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on", "chafa"]);
const IMAGE_DISABLE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/** Unknown-key warnings are per key but bounded to a handful (§5.2). */
const MAX_UNKNOWN_KEY_WARNINGS = 5;

export const DEFAULT_NAVIGATOR_SETTINGS: NavigatorSettings = Object.freeze({
  version: SETTINGS_VERSION,
  images: Object.freeze({ mode: "off" }),
});

function cloneDefaults(): NavigatorSettings {
  return { version: SETTINGS_VERSION, images: { mode: "off" } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Warn per unknown key, capped at a handful so a hostile file cannot flood
 * the notice channel; the overflow collapses into one summary line.
 */
function warnUnknownSettings(warnings: string[], keys: readonly string[], prefix: string): void {
  const start = warnings.length;
  for (const key of keys) {
    const emitted = warnings.length - start;
    if (emitted < MAX_UNKNOWN_KEY_WARNINGS) {
      warnings.push(`unknown setting "${prefix}${key}" ignored`);
    } else {
      warnings.push(`and ${keys.length - emitted} more unknown settings ignored`);
      return;
    }
  }
}

/**
 * Normalizes arbitrary parsed JSON into full settings with defaults.
 * Never throws, never mutates its input; invalid values fall back with a
 * short user-facing warning (pi-overseer pattern).
 */
export function normalizeNavigatorSettings(raw: unknown): { settings: NavigatorSettings; warnings: string[] } {
  const warnings: string[] = [];
  const rawRec = asRecord(raw);
  if (rawRec === undefined) {
    warnings.push("pi-navigator settings must be a JSON object; using defaults");
    return { settings: cloneDefaults(), warnings };
  }

  // version: absent → 1 (silent); integer > 1 → defaults + warning (no
  // migration attempted); any other value → warning + 1.
  if (rawRec.version !== undefined) {
    const version = rawRec.version;
    if (typeof version === "number" && Number.isInteger(version) && version >= 1) {
      if (version > SETTINGS_VERSION) {
        warnings.push(`pi-navigator settings version ${version} is newer than this navigator supports; using defaults`);
        return { settings: cloneDefaults(), warnings };
      }
    } else {
      warnings.push("settings version is invalid; using 1");
    }
  }

  // images: absent → default; present but not an object → warning + default.
  let mode: ImageMode = "off";
  const rawImages = rawRec.images;
  if (rawImages !== undefined) {
    const imagesRec = asRecord(rawImages);
    if (imagesRec === undefined) {
      warnings.push('"images" must be an object; using defaults');
    } else {
      warnUnknownSettings(
        warnings,
        Object.keys(imagesRec).filter((key) => key !== "mode"),
        "images.",
      );
      const rawMode = imagesRec.mode;
      if (rawMode !== undefined) {
        if (rawMode === "off" || rawMode === "chafa") {
          mode = rawMode;
        } else {
          warnings.push(`images.mode "${String(rawMode)}" is invalid; using "off"`);
        }
      }
    }
  }

  warnUnknownSettings(
    warnings,
    Object.keys(rawRec).filter((key) => key !== "version" && key !== "images"),
    "",
  );

  return { settings: { version: SETTINGS_VERSION, images: { mode } }, warnings };
}

/**
 * Parses the PI_NAV_IMAGES env override: enable = 1/true/yes/on/chafa,
 * disable = 0/false/no/off, anything else ignored with one warning so the
 * file/default setting stands (§5.1). Case-insensitive, trimmed; empty input
 * is "no override", never a warning.
 */
export function parseImageMode(value: string | undefined): { mode: "off" | "chafa" | undefined; warning?: string } {
  if (value === undefined) return { mode: undefined };
  const trimmed = value.trim();
  if (trimmed === "") return { mode: undefined };
  const normalized = trimmed.toLowerCase();
  if (IMAGE_ENABLE_VALUES.has(normalized)) return { mode: "chafa" };
  if (IMAGE_DISABLE_VALUES.has(normalized)) return { mode: "off" };
  return { mode: undefined, warning: `${trimmed} is not a valid PI_NAV_IMAGES value; using the file/default setting` };
}

/**
 * Loads settings with precedence defaults ← user file ← env (§5.2).
 * A missing file is not a warning (sources: ["defaults"]); an unreadable or
 * corrupt file is one bounded warning (sources: ["defaults"]); a valid file
 * contributes its path to `sources`.
 */
export function loadNavigatorSettings(paths: {
  userPath: string;
  env?: { images?: string | undefined };
}): { settings: NavigatorSettings; warnings: string[]; sources: string[] } {
  const warnings: string[] = [];
  const sources: string[] = [];

  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(paths.userPath, "utf8"));
    sources.push(paths.userPath);
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "ENOENT") {
      warnings.push(`pi-navigator settings unreadable: ${bounded(String(error), 160)}`);
    }
    // Missing or corrupt file: fall through to defaults.
    raw = {};
  }

  const normalized = normalizeNavigatorSettings(raw);
  warnings.push(...normalized.warnings);

  let settings = normalized.settings;
  const envMode = parseImageMode(paths.env?.images);
  if (envMode.mode !== undefined) {
    settings = { ...settings, images: { ...settings.images, mode: envMode.mode } };
  }
  if (envMode.warning !== undefined) warnings.push(envMode.warning);

  if (sources.length === 0) sources.push("defaults");
  return { settings, warnings, sources };
}

/** Inverse of the normalizer: the canonical nested object for persistence. */
export function serializeNavigatorSettings(settings: NavigatorSettings): Record<string, unknown> {
  return { version: settings.version, images: { mode: settings.images.mode } };
}

/**
 * Atomically persist the canonical settings to `path` (tmp file + rename).
 * Used only by the future configure UI and tests — never by the feature.
 */
export function writeNavigatorSettings(path: string, settings: NavigatorSettings): void {
  const dir = dirname(path);
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(serializeNavigatorSettings(settings), null, 2), "utf8");
  renameSync(tmp, path);
}

export interface NavigatorConfigField {
  readonly id: string;
  readonly path: readonly string[];
  readonly kind: "enum" | "boolean" | "number";
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly options?: readonly string[];
  readonly live: boolean;
}

/** Ordered registry for the future `/navigator configure` modal (§5.2). */
export const NAVIGATOR_CONFIG_FIELDS: readonly NavigatorConfigField[] = [
  {
    id: "images.mode",
    path: ["images", "mode"],
    kind: "enum",
    section: "Images",
    label: "Image rendering",
    description: "Render image files as chafa symbol art in the viewer pane; off keeps the metadata card.",
    options: [...IMAGE_MODES],
    live: false,
  },
];