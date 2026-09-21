/**
 * pi-navigator settings — versioned user-level settings terrain (§5.1/§5.2):
 * typed defaults, a never-throw pure normalizer, a loader with file/env
 * provenance, a canonical serializer, an atomic tmp+rename writer, and the
 * field registry for the `/navigator settings` modal (pi-overseer pattern,
 * JSON instead of YAML — this repo has zero runtime dependencies).
 *
 * Warnings are short and user-facing: they travel through ctx.ui.notify
 * exactly once per load. The env overrides are passed in explicitly (like
 * PI_NAV_ICONS) — nothing in this module reads process.env.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
// pi-lens-ignore: TS2304
import { dirname } from "node:path";

import { parseIconMode } from "./icons";

export interface NavigatorImageSettings {
  mode: "off" | "chafa";
}

export interface NavigatorIconSettings {
  enabled: boolean;
}

export interface NavigatorViewerSettings {
  wrap: boolean;
  markdown: "code" | "rendered";
}

export interface NavigatorTreeSettings {
  showHidden: boolean;
}

export interface NavigatorSettings {
  readonly version: number;
  readonly images: NavigatorImageSettings;
  readonly icons: NavigatorIconSettings;
  readonly viewer: NavigatorViewerSettings;
  readonly tree: NavigatorTreeSettings;
}

const SETTINGS_VERSION = 1;
const IMAGE_MODES = ["off", "chafa"] as const;
type ImageMode = (typeof IMAGE_MODES)[number];
const VIEWER_MODES = ["code", "rendered"] as const;
type ViewerMode = (typeof VIEWER_MODES)[number];

const IMAGE_ENABLE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on", "chafa"]);
const IMAGE_DISABLE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/** Unknown-key warnings are per key but bounded to a handful (§5.2). */
const MAX_UNKNOWN_KEY_WARNINGS = 5;

export const DEFAULT_NAVIGATOR_SETTINGS: NavigatorSettings = Object.freeze({
  version: SETTINGS_VERSION,
  images: Object.freeze({ mode: "off" }),
  icons: Object.freeze({ enabled: false }),
  viewer: Object.freeze({ wrap: false, markdown: "code" }),
  tree: Object.freeze({ showHidden: false }),
});

function cloneDefaults(): NavigatorSettings {
  return {
    version: SETTINGS_VERSION,
    images: { mode: "off" },
    icons: { enabled: false },
    viewer: { wrap: false, markdown: "code" },
    tree: { showHidden: false },
  };
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

  // icons: absent → default; present but not an object → warning + default.
  let iconsEnabled = false;
  const rawIcons = rawRec.icons;
  if (rawIcons !== undefined) {
    const iconsRec = asRecord(rawIcons);
    if (iconsRec === undefined) {
      warnings.push('"icons" must be an object; using defaults');
    } else {
      warnUnknownSettings(
        warnings,
        Object.keys(iconsRec).filter((key) => key !== "enabled"),
        "icons.",
      );
      const rawEnabled = iconsRec.enabled;
      if (rawEnabled !== undefined) {
        if (typeof rawEnabled === "boolean") {
          iconsEnabled = rawEnabled;
        } else {
          warnings.push(`icons.enabled "${String(rawEnabled)}" is invalid; using false`);
        }
      }
    }
  }

  // viewer: absent → default; present but not an object → warning + default.
  let wrap = false;
  let markdown: ViewerMode = "code";
  const rawViewer = rawRec.viewer;
  if (rawViewer !== undefined) {
    const viewerRec = asRecord(rawViewer);
    if (viewerRec === undefined) {
      warnings.push('"viewer" must be an object; using defaults');
    } else {
      warnUnknownSettings(
        warnings,
        Object.keys(viewerRec).filter((key) => key !== "wrap" && key !== "markdown"),
        "viewer.",
      );
      const rawWrap = viewerRec.wrap;
      if (rawWrap !== undefined) {
        if (typeof rawWrap === "boolean") {
          wrap = rawWrap;
        } else {
          warnings.push(`viewer.wrap "${String(rawWrap)}" is invalid; using false`);
        }
      }
      const rawMarkdown = viewerRec.markdown;
      if (rawMarkdown !== undefined) {
        if (rawMarkdown === "code" || rawMarkdown === "rendered") {
          markdown = rawMarkdown;
        } else {
          warnings.push(`viewer.markdown "${String(rawMarkdown)}" is invalid; using "code"`);
        }
      }
    }
  }

  // tree: absent → default; present but not an object → warning + default.
  let showHidden = false;
  const rawTree = rawRec.tree;
  if (rawTree !== undefined) {
    const treeRec = asRecord(rawTree);
    if (treeRec === undefined) {
      warnings.push('"tree" must be an object; using defaults');
    } else {
      warnUnknownSettings(
        warnings,
        Object.keys(treeRec).filter((key) => key !== "showHidden"),
        "tree.",
      );
      const rawShowHidden = treeRec.showHidden;
      if (rawShowHidden !== undefined) {
        if (typeof rawShowHidden === "boolean") {
          showHidden = rawShowHidden;
        } else {
          warnings.push(`tree.showHidden "${String(rawShowHidden)}" is invalid; using false`);
        }
      }
    }
  }

  warnUnknownSettings(
    warnings,
    Object.keys(rawRec).filter(
      (key) => key !== "version" && key !== "images" && key !== "icons" && key !== "viewer" && key !== "tree",
    ),
    "",
  );

  return {
    settings: {
      version: SETTINGS_VERSION,
      images: { mode },
      icons: { enabled: iconsEnabled },
      viewer: { wrap, markdown },
      tree: { showHidden },
    },
    warnings,
  };
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
  env?: { images?: string | undefined; icons?: string | undefined };
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

  const iconMode = parseIconMode(paths.env?.icons);
  if (iconMode.enabled !== undefined) {
    settings = { ...settings, icons: { ...settings.icons, enabled: iconMode.enabled } };
  }
  if (iconMode.warning !== undefined) warnings.push(iconMode.warning);

  if (sources.length === 0) sources.push("defaults");
  return { settings, warnings, sources };
}

/** Inverse of the normalizer: the canonical nested object for persistence. */
export function serializeNavigatorSettings(settings: NavigatorSettings): Record<string, unknown> {
  return {
    version: settings.version,
    images: { mode: settings.images.mode },
    icons: { enabled: settings.icons.enabled },
    viewer: { wrap: settings.viewer.wrap, markdown: settings.viewer.markdown },
    tree: { showHidden: settings.tree.showHidden },
  };
}

/**
 * Atomically persist the canonical settings to `path` (tmp file + rename).
 * Used only by the settings menu and tests — never by the feature.
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
  readonly min?: number;
  readonly max?: number;
  readonly live: boolean;
}

/** Ordered registry for the `/navigator settings` modal (§5.2, §2.1). */
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
  {
    id: "icons.enabled",
    path: ["icons", "enabled"],
    kind: "boolean",
    section: "Icons",
    label: "Nerd Font icons",
    description: "Show a Nerd Font filetype icon column in the file tree (requires a Nerd Font terminal).",
    live: false,
  },
  {
    id: "viewer.wrap",
    path: ["viewer", "wrap"],
    kind: "boolean",
    section: "Viewer",
    label: "Word wrap",
    description: "Start files with word wrap enabled; the `w` key still toggles it per session.",
    live: false,
  },
  {
    id: "viewer.markdown",
    path: ["viewer", "markdown"],
    kind: "enum",
    section: "Viewer",
    label: "Markdown view",
    description: "Open Markdown files as rendered text or plain code; the `m` key still toggles it per session.",
    options: [...VIEWER_MODES],
    live: false,
  },
  {
    id: "tree.showHidden",
    path: ["tree", "showHidden"],
    kind: "boolean",
    section: "Tree",
    label: "Hidden files",
    description: "Start with hidden files visible; the `.` key still toggles it per session.",
    live: false,
  },
];

/**
 * Parse a raw numeric setting value, clamping into [min, max] when defined
 * and rejecting NaN (§2.2). Factored out of `applyFieldEdit` so the number
 * rule set is testable today (the registry has no number fields yet; min/max
 * are future-use).
 */
export function parseNumberField(
  rawValue: string,
  min?: number,
  max?: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = Number(rawValue);
  if (Number.isNaN(parsed)) return { ok: false, error: `invalid number "${rawValue}"` };
  let value = parsed;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return { ok: true, value };
}

/**
 * Apply one field edit to a fresh settings object (never mutates the input).
 * Validates with the same rule set as the normalizer — no second source of
 * truth for accepted values (§2.2).
 */
export function applyFieldEdit(
  settings: NavigatorSettings,
  fieldId: string,
  rawValue: string,
): { ok: true; settings: NavigatorSettings } | { ok: false; error: string } {
  const field = NAVIGATOR_CONFIG_FIELDS.find((candidate) => candidate.id === fieldId);
  if (field === undefined) return { ok: false, error: `unknown setting "${fieldId}"` };

  let value: string | number | boolean;
  switch (field.kind) {
    case "boolean": {
      if (rawValue === "on") value = true;
      else if (rawValue === "off") value = false;
      else return { ok: false, error: `invalid value "${rawValue}" for "${fieldId}"; expected on or off` };
      break;
    }
    case "enum": {
      const options = field.options ?? [];
      if (!options.includes(rawValue)) {
        return { ok: false, error: `invalid value "${rawValue}" for "${fieldId}"; expected one of ${options.join(", ")}` };
      }
      value = rawValue;
      break;
    }
    case "number": {
      const parsed = parseNumberField(rawValue, field.min, field.max);
      if (!parsed.ok) return { ok: false, error: `${parsed.error} for "${fieldId}"` };
      value = parsed.value;
      break;
    }
  }

  return { ok: true, settings: setField(settings, field.path, value) };
}

/**
 * Shallow-clone the settings with one registry path set. All five registry
 * paths are exactly two segments deep, so the section is cloned explicitly.
 * The cast is safe: `applyFieldEdit` validated the value against the field's
 * kind before this runs.
 */
function setField(settings: NavigatorSettings, path: readonly string[], value: string | number | boolean): NavigatorSettings {
  if (path.length !== 2) return settings;
  const key = `${path[0]}.${path[1] ?? ""}`;
  switch (key) {
    case "images.mode":
      return { ...settings, images: { ...settings.images, mode: value as ImageMode } };
    case "icons.enabled":
      return { ...settings, icons: { ...settings.icons, enabled: value as boolean } };
    case "viewer.wrap":
      return { ...settings, viewer: { ...settings.viewer, wrap: value as boolean } };
    case "viewer.markdown":
      return { ...settings, viewer: { ...settings.viewer, markdown: value as ViewerMode } };
    case "tree.showHidden":
      return { ...settings, tree: { ...settings.tree, showHidden: value as boolean } };
    default:
      return settings;
  }
}