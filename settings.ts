/**
 * pi-navigator settings — versioned user-level settings terrain (§5.1/§5.2):
 * typed defaults, a never-throw pure normalizer, a loader with file/env/flag
 * provenance and truthful override origins, a canonical serializer, an atomic
 * tmp+rename writer plus the one commit operation on top of it, and the field
 * registry for the `/navigator settings` modal (pi-overseer pattern, JSON
 * instead of YAML — this repo has zero runtime dependencies).
 *
 * The registry rows are the single source of the schema (Issue #145): they
 * carry the per-kind accept/parse rules both settings faces share and, when a
 * startup layer can set a field, its env name, flag descriptor and override
 * parser. Warnings are short and user-facing: they travel through ctx.ui.notify
 * exactly once per load. The env/flags layers are passed in explicitly — nothing
 * in this module reads process.env.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
// pi-lens-ignore: TS2304
import { dirname } from "node:path";

import {
  NAVIGATOR_IMAGES_ENV,
  NAVIGATOR_IMAGES_FLAG,
  NAVIGATOR_ICONS_FLAG,
  NAVIGATOR_LAYOUT_ENV,
  NAVIGATOR_LAYOUT_FLAG,
} from "./constants";
import { ICONS_ENV, parseIconMode } from "./icons";
import { parseTruthyEnv } from "./env";
import { NAVIGATOR_LAYOUTS, type NavigatorLayout } from "./types";

export type NavigatorImageMode = "off" | "chafa" | "native" | "auto";

export interface NavigatorImageSettings {
  readonly mode: NavigatorImageMode;
}

export interface NavigatorIconSettings {
  readonly enabled: boolean;
}

export interface NavigatorViewerSettings {
  readonly wrap: boolean;
  readonly markdown: "code" | "rendered";
}

export interface NavigatorTreeSettings {
  readonly showHidden: boolean;
}

export interface NavigatorLayoutSettings {
  readonly default: NavigatorLayout;
}

export interface NavigatorSettings {
  readonly version: number;
  readonly images: NavigatorImageSettings;
  readonly icons: NavigatorIconSettings;
  readonly viewer: NavigatorViewerSettings;
  readonly tree: NavigatorTreeSettings;
  readonly layout: NavigatorLayoutSettings;
}

const SETTINGS_VERSION = 1;
const IMAGE_MODES = ["off", "chafa", "native", "auto"] as const;
const VIEWER_MODES = ["code", "rendered"] as const;

export interface NavigatorConfigField {
  readonly id: string;
  readonly path: readonly string[];
  readonly kind: "enum" | "boolean" | "number";
  /** Grouping section name; reserved for future grouped-menu views. */
  readonly section: string;
  readonly label: string;
  readonly description: string;
  readonly options?: readonly string[];
  /** Minimum value; reserved for future numeric config fields. */
  readonly min?: number;
  /** Maximum value; reserved for future numeric config fields. */
  readonly max?: number;
  readonly default: string | number | boolean;
  /** Whether changing this field takes effect immediately without restart; reserved for future live-reload. */
  readonly live: boolean;
  /**
   * The startup layers that can set this field (Issue #145): the env var name,
   * the flag descriptor `registerFlag` registers, and the one parser both
   * layers share. Absent for fields only the file can set. A boolean flag
   * applies its raw value directly, without running `parse`.
   */
  readonly override?: {
    readonly env: string;
    readonly flag: { readonly name: string; readonly description: string; readonly type: "string" | "boolean" };
    readonly parse?: (raw: string, source: string) => { value?: string | number | boolean; warning?: string };
  };
}

/** Ordered registry for the `/navigator settings` modal (§5.2, §2.1). */
export const NAVIGATOR_CONFIG_FIELDS: readonly NavigatorConfigField[] = [
  {
    id: "images.mode",
    path: ["images", "mode"],
    kind: "enum",
    section: "Images",
    label: "Image rendering",
    description: "Render images as native terminal graphics (kitty/iTerm2), chafa symbols, or auto; off keeps the metadata card.",
    options: [...IMAGE_MODES],
    default: "off",
    live: false,
    override: {
      env: NAVIGATOR_IMAGES_ENV,
      flag: {
        name: NAVIGATOR_IMAGES_FLAG,
        description: "pi-navigator image rendering: native, chafa, auto or off (beats PI_NAV_IMAGES and the settings file)",
        type: "string",
      },
      parse: (raw, source) => {
        const parsed = parseImageMode(raw, source);
        return { value: parsed.mode, warning: parsed.warning };
      },
    },
  },
  {
    id: "icons.enabled",
    path: ["icons", "enabled"],
    kind: "boolean",
    section: "Icons",
    label: "Nerd Font icons",
    description: "Show a Nerd Font filetype icon column in the file tree (requires a Nerd Font terminal).",
    default: false,
    live: false,
    override: {
      env: ICONS_ENV,
      flag: {
        name: NAVIGATOR_ICONS_FLAG,
        description: "pi-navigator: show the Nerd Font icon column (beats PI_NAV_ICONS and the settings file)",
        type: "boolean",
      },
      parse: (raw) => {
        const parsed = parseIconMode(raw);
        return { value: parsed.enabled, warning: parsed.warning };
      },
    },
  },
  {
    id: "viewer.wrap",
    path: ["viewer", "wrap"],
    kind: "boolean",
    section: "Viewer",
    label: "Word wrap",
    description: "Start files with word wrap enabled; the `w` key still toggles it per session.",
    default: false,
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
    default: "code",
    live: false,
  },
  {
    id: "tree.showHidden",
    path: ["tree", "showHidden"],
    kind: "boolean",
    section: "Tree",
    label: "Hidden files",
    description: "Start with hidden files visible; the `.` key still toggles it per session.",
    default: false,
    live: false,
  },
  {
    id: "layout.default",
    path: ["layout", "default"],
    kind: "enum",
    section: "Layout",
    label: "Default layout",
    description:
      "Layout opened by bare /navigator; /navigator all, /navigator files, and /navigator git always open their own layout for one session.",
    options: [...NAVIGATOR_LAYOUTS],
    default: "files-git-viewer",
    live: false,
    override: {
      env: NAVIGATOR_LAYOUT_ENV,
      flag: {
        name: NAVIGATOR_LAYOUT_FLAG,
        description: "pi-navigator overlay layout: files-git-viewer, files-viewer or git-viewer (beats PI_NAV_LAYOUT and the settings file)",
        type: "string",
      },
      parse: (raw, source) => {
        const parsed = parseLayoutMode(raw, source);
        return { value: parsed.layout, warning: parsed.warning };
      },
    },
  },
];

/** Unknown-key warnings are per key but bounded to a handful (§5.2). */
const MAX_UNKNOWN_KEY_WARNINGS = 5;

/**
 * Build the canonical default settings from the registry's per-field
 * defaults, with the canonical section order (first registry appearance:
 * images, icons, viewer, tree) and `version: 1`. Fresh objects every call,
 * so `cloneDefaults()` is safe to mutate; the exported frozen default is
 * derived from the same function.
 */
function buildDefaultSettings(): NavigatorSettings {
  const settings: Record<string, unknown> = { version: SETTINGS_VERSION };
  const sections = new Map<string, Record<string, unknown>>();
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    const [sectionKey, key] = field.path;
    if (sectionKey === undefined || key === undefined || field.path.length !== 2) continue;
    let section = sections.get(sectionKey);
    if (section === undefined) {
      section = {};
      sections.set(sectionKey, section);
    }
    section[key] = field.default;
  }
  for (const [sectionKey, section] of sections) settings[sectionKey] = section;
  // The registry rows are the single source of the schema; the cast is
  // backed by the registry sync-guard tests (every path resolves, kinds
  // match the section interfaces).
  // SAFETY: buildDefaultSettings assembles exactly the NavigatorSettings
  // shape from registry rows the sync-guard tests pin to the interfaces.
  return settings as unknown as NavigatorSettings;
}

/** Recursively deep-freeze an object. */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object") {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

function deepFreezeDefaults(settings: NavigatorSettings): NavigatorSettings {
  return deepFreeze(settings);
}

export const DEFAULT_NAVIGATOR_SETTINGS: NavigatorSettings = deepFreezeDefaults(buildDefaultSettings());

function cloneDefaults(): NavigatorSettings {
  return buildDefaultSettings();
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
 * The one per-kind rule table (Issue #145): `accept` is the JSON face (the
 * normalizer's typed-value check) and `parse` is the string face (the editor's
 * raw edit). Both faces share these rules, so the two can never disagree about
 * what a field accepts; warning/error phrasing is pinned byte-for-byte by
 * test/settings.test.ts (string defaults quoted, boolean/number defaults bare
 * — exactly what the hand-written section blocks emitted).
 */
interface FieldKindRule {
  accept: (
    field: NavigatorConfigField,
    raw: unknown,
  ) => { ok: true; value: string | number | boolean } | { ok: false; error: string };
  parse: (
    field: NavigatorConfigField,
    raw: string,
  ) => { ok: true; value: string | number | boolean } | { ok: false; error: string };
}

export const FIELD_KIND_RULES: Record<"enum" | "boolean" | "number", FieldKindRule> = {
  boolean: {
    accept(field, raw) {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      return { ok: false, error: `${field.id} "${String(raw)}" is invalid; using ${String(field.default)}` };
    },
    parse(field, raw) {
      if (raw === "on") return { ok: true, value: true };
      if (raw === "off") return { ok: true, value: false };
      return { ok: false, error: `invalid value "${raw}" for "${field.id}"; expected on or off` };
    },
  },
  enum: {
    accept(field, raw) {
      const options = field.options ?? [];
      for (const option of options) {
        if (option === raw) return { ok: true, value: option };
      }
      return { ok: false, error: `${field.id} "${String(raw)}" is invalid; using "${String(field.default)}"` };
    },
    parse(field, raw) {
      const options = field.options ?? [];
      if (!options.includes(raw)) {
        return { ok: false, error: `invalid value "${raw}" for "${field.id}"; expected one of ${options.join(", ")}` };
      }
      return { ok: true, value: raw };
    },
  },
  number: {
    accept(field, raw) {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        let value = raw;
        if (field.min !== undefined) value = Math.max(field.min, value);
        if (field.max !== undefined) value = Math.min(field.max, value);
        return { ok: true, value };
      }
      return { ok: false, error: `${field.id} "${String(raw)}" is invalid; using ${String(field.default)}` };
    },
    parse(field, raw) {
      const parsed = parseNumberField(raw, field.min, field.max);
      if (!parsed.ok) return { ok: false, error: `${parsed.error} for "${field.id}"` };
      return { ok: true, value: parsed.value };
    },
  },
};

/** Thin JSON-face call into the shared per-kind rules (Issue #145). */
function validateFieldValue(
  field: NavigatorConfigField,
  rawValue: unknown,
): { ok: true; value: string | number | boolean } | { ok: false; error: string } {
  return FIELD_KIND_RULES[field.kind].accept(field, rawValue);
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

  // One generic walk over the registry: per section (first-appearance
  // order) guard the object shape and warn on unknown leaf keys, then
  // validate each field against its kind. Validated values land in a fresh
  // defaults clone, so missing and invalid leaves keep their defaults.
  const settings = cloneDefaults();
  // SAFETY: the clone is a fresh NavigatorSettings record; writing
  // validated registry values through the record view never mutates the
  // caller's input.
  const settingsRec = settings as unknown as Record<string, Record<string, unknown>>;

  // Group the registry fields per section (canonical order: images, icons,
  // viewer, tree).
  const sections = new Map<string, { fields: NavigatorConfigField[] }>();
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    if (field.path.length !== 2) continue;
    const sectionKey = field.path[0];
    if (sectionKey === undefined) continue;
    let group = sections.get(sectionKey);
    if (group === undefined) {
      group = { fields: [] };
      sections.set(sectionKey, group);
    }
    group.fields.push(field);
  }

  const unknownKeys: string[] = [];

  for (const [sectionKey, group] of sections) {
    const rawSection = rawRec[sectionKey];
    if (rawSection === undefined) continue;
    const sectionRec = asRecord(rawSection);
    if (sectionRec === undefined) {
      warnings.push(`"${sectionKey}" must be an object; using defaults`);
      continue;
    }
    const knownKeys = new Set(group.fields.map((field) => field.path[1]));
    for (const key of Object.keys(sectionRec)) {
      if (!knownKeys.has(key)) {
        unknownKeys.push(`${sectionKey}.${key}`);
      }
    }
    const sectionSettings = settingsRec[sectionKey];
    if (sectionSettings === undefined) continue;
    for (const field of group.fields) {
      const key = field.path[1];
      if (key === undefined) continue;
      const rawValue = sectionRec[key];
      if (rawValue === undefined) continue;
      const validated = validateFieldValue(field, rawValue);
      if (!validated.ok) {
        warnings.push(validated.error);
        continue; // the clone's default already stands
      }
      sectionSettings[key] = validated.value;
    }
  }

  for (const key of Object.keys(rawRec)) {
    if (key !== "version" && !sections.has(key)) {
      unknownKeys.push(key);
    }
  }

  for (let i = 0; i < unknownKeys.length; i++) {
    if (i < MAX_UNKNOWN_KEY_WARNINGS) {
      warnings.push(`unknown setting "${unknownKeys[i]}" ignored`);
    } else {
      const remaining = unknownKeys.length - i;
      warnings.push(`and ${remaining} more unknown setting${remaining === 1 ? "" : "s"} ignored`);
      break;
    }
  }

  return { settings, warnings };
}

/**
 * Parses the PI_NAV_IMAGES env override: enable = 1/true/yes/on/chafa,
 * disable = 0/false/no/off, native = `native`, auto = `auto`; anything else
 * ignored with one warning so the file/default setting stands (§5.1).
 * Case-insensitive, trimmed; empty input is "no override", never a warning.
 * The images-only `chafa`/`native`/`auto` tokens are recognized here, before
 * delegating to the shared `parseTruthyEnv` (env.ts), so the accepted value
 * sets per env var stay byte-identical to the pre-#063 truth tables.
 */
export function parseImageMode(
  value: string | undefined,
  source: string = NAVIGATOR_IMAGES_ENV,
): { mode: NavigatorImageMode | undefined; warning?: string } {
  if (value === undefined) return { mode: undefined };
  const trimmed = value.trim();
  if (trimmed === "") return { mode: undefined };
  const normalized = trimmed.toLowerCase();
  if (normalized === "chafa") return { mode: "chafa" };
  if (normalized === "native") return { mode: "native" };
  if (normalized === "auto") return { mode: "auto" };
  const parsed = parseTruthyEnv(trimmed, source);
  if (parsed.warning !== undefined) return { mode: undefined, warning: parsed.warning };
  return { mode: parsed.value ? "chafa" : "off" };
}

/**
 * Parses the PI_NAV_LAYOUT env override for `layout.default` (Issue #119, D11):
 * accepted values are exactly the three layout names — unlike PI_NAV_IMAGES
 * there are no legacy boolean-ish tokens, because this env var is new.
 * Matching is case-sensitive; undefined/empty/whitespace is "no override",
 * never a warning; anything else is one warning and the file/default value
 * stands. Mirrors parseImageMode's contract shape.
 */
export function parseLayoutMode(
  value: string | undefined,
  source: string = NAVIGATOR_LAYOUT_ENV,
): { layout: NavigatorLayout | undefined; warning?: string } {
  if (value === undefined) return { layout: undefined };
  const trimmed = value.trim();
  if (trimmed === "") return { layout: undefined };
  if ((NAVIGATOR_LAYOUTS as readonly string[]).includes(trimmed)) {
    // SAFETY: the includes check above narrowed trimmed to exactly the union's
    // members; the cast only re-labels the verified string.
    return { layout: trimmed as NavigatorLayout };
  }
  return {
    layout: undefined,
    warning: `${trimmed} is not a valid ${source} value; using the file/default setting`,
  };
}

/** One override origin: the startup layer that actually won a field (Issue #145). */
export interface OverrideOrigin {
  readonly layer: "env" | "flag";
  readonly source: string;
}

export interface LoadedNavigatorSettings {
  readonly settings: NavigatorSettings;
  readonly warnings: string[];
  /** Sparse per-field origin report: only fields a startup layer actually won. */
  readonly origins: Record<string, OverrideOrigin>;
}

interface ResolvedOverrideLayers {
  readonly applied: ReadonlyArray<{ field: NavigatorConfigField; value: string | number | boolean }>;
  readonly warnings: readonly string[];
  readonly origins: Record<string, OverrideOrigin>;
}

/**
 * The one registry walk behind both the loader and `resolveOverrideOrigins`
 * (Issue #145): all env layers first (registry order), then all flag layers,
 * so flags beat env per field and the warning order stays the documented
 * defaults ← file ← env ← flag. Only a layer that produced a value is applied
 * and reported — presence alone is not enough, so a present-but-invalid flag
 * yields no origin.
 */
function resolveOverrideLayers(
  env: Readonly<Record<string, string | undefined>>,
  flags: Readonly<Record<string, string | boolean | undefined>>,
): ResolvedOverrideLayers {
  const applied: Array<{ field: NavigatorConfigField; value: string | number | boolean }> = [];
  const warnings: string[] = [];
  const origins: Record<string, OverrideOrigin> = {};

  // Pass 1 — env layers, in registry order. The parsers treat undefined and
  // blank values as "no override", but the trimming check here keeps that
  // contract visible at the walk that owns layer order.
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    const override = field.override;
    if (override === undefined) continue;
    const raw = env[override.env];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const parsed = override.parse?.(raw, override.env);
    if (parsed?.warning !== undefined) warnings.push(parsed.warning);
    if (parsed?.value === undefined) continue;
    applied.push({ field, value: parsed.value });
    origins[field.id] = { layer: "env", source: override.env };
  }

  // Pass 2 — flag layers: the most explicit layer, so they beat env for the
  // same field. A boolean flag passes true/false directly — there is no parse
  // step to warn about; a string flag reuses the row's parser with the flag
  // name as the warning source, so a bad flag value names the flag.
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    const override = field.override;
    if (override === undefined) continue;
    const { name, type } = override.flag;
    const raw = flags[name];
    if (type === "boolean") {
      if (typeof raw !== "boolean") continue;
      applied.push({ field, value: raw });
    } else {
      if (typeof raw !== "string" || raw.trim() === "") continue;
      const parsed = override.parse?.(raw, `--${name}`);
      if (parsed?.warning !== undefined) warnings.push(parsed.warning);
      if (parsed?.value === undefined) continue;
      applied.push({ field, value: parsed.value });
    }
    origins[field.id] = { layer: "flag", source: `--${name}` };
  }

  return { applied, warnings, origins };
}

/**
 * The loader's origin report without touching the file (Issue #145): the same
 * registry walk the loader uses, exported so callers that only need "which
 * startup layer wins" (the `/navigator set` shadow warning, the settings-menu
 * row annotations) do not re-derive precedence from raw presence.
 */
export function resolveOverrideOrigins(
  env: Readonly<Record<string, string | undefined>> = {},
  flags: Readonly<Record<string, string | boolean | undefined>> = {},
): Record<string, OverrideOrigin> {
  return resolveOverrideLayers(env, flags).origins;
}

/**
 * Loads settings with precedence defaults ← user file ← env ← flag (§5.2,
 * Issue #131). A missing file is not a warning; an unreadable or corrupt file
 * is one bounded warning. `env` is keyed by the env var names the registry
 * rows declare (`process.env`), `flags` by flag name; both walks are registry-
 * driven (Issue #145). `undefined` means "not passed"; an empty or whitespace
 * value is "no override", never a warning. `origins` reports, sparsely, which
 * startup layer won each field — the layer the setting actually came from, so
 * a present-but-invalid flag reports nothing.
 */
export function loadNavigatorSettings(paths: {
  userPath: string;
  env?: Readonly<Record<string, string | undefined>>;
  flags?: Readonly<Record<string, string | boolean | undefined>>;
}): LoadedNavigatorSettings {
  const warnings: string[] = [];

  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(paths.userPath, "utf8"));
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "ENOENT") {
      warnings.push(`pi-navigator settings unreadable: ${bounded(String(error), 160)}`);
    }
    // Missing or corrupt file: fall through to defaults.
    raw = {};
  }

  const normalized = normalizeNavigatorSettings(raw);
  // File-content warnings name the file they came from (Issue #135 L13): with
  // two candidate sources (this file and the PI_NAV_* env vars below), an
  // "unknown setting ... ignored" warning is unactionable without knowing which
  // one produced it. The normalizer stays path-free by design; the loader owns
  // the injected path, and the full path matches the settings-menu outcome
  // wording (Issue #133). Env warnings keep their own prefix - they name the
  // env var, and prefixing them with a file path would misattribute them.
  for (const warning of normalized.warnings) warnings.push(`${paths.userPath}: ${warning}`);

  // The startup layers, applied in the walk's order and reported as origins.
  const layers = resolveOverrideLayers(paths.env ?? {}, paths.flags ?? {});
  let settings = normalized.settings;
  for (const entry of layers.applied) {
    settings = setField(settings, entry.field.path, entry.value);
  }
  for (const warning of layers.warnings) warnings.push(warning);

  return { settings, warnings, origins: layers.origins };
}

/** Inverse of the normalizer: the canonical nested object for persistence. */
export function serializeNavigatorSettings(settings: NavigatorSettings): Record<string, unknown> {
  const record: Record<string, unknown> = { version: settings.version };
  // SAFETY: NavigatorSettings is a plain record of sections; the registry
  // walk reads only paths the sync-guard tests pin to the interfaces.
  const settingsRec = settings as unknown as Record<string, Record<string, unknown>>;
  const sections = new Map<string, Record<string, unknown>>();
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    const [sectionKey, key] = field.path;
    if (sectionKey === undefined || key === undefined || field.path.length !== 2) continue;
    let section = sections.get(sectionKey);
    if (section === undefined) {
      section = {};
      sections.set(sectionKey, section);
    }
    section[key] = settingsRec[sectionKey]?.[key];
  }
  for (const [sectionKey, section] of sections) record[sectionKey] = section;
  return record;
}

/**
 * Atomically persist the canonical settings to `path` (tmp file + rename).
 * Tests use it directly for the writer contract; production callers go through
 * `commitNavigatorSettings`, which owns the reload and error wrapping (#145).
 */
export function writeNavigatorSettings(path: string, settings: NavigatorSettings): void {
  const dir = dirname(path);
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  let renamed = false;
  try {
    writeFileSync(tmp, JSON.stringify(serializeNavigatorSettings(settings), null, 2), "utf8");
    renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

/**
 * The one persist operation (Issue #145): atomic write through the existing
 * writer, then a file-only reload so the caller receives what actually landed
 * plus the reload warnings. Write failures become a bounded `{ok:false}` — the
 * shape both `/navigator set` and the settings menu already report.
 */
export function commitNavigatorSettings(
  path: string,
  settings: NavigatorSettings,
): { ok: true; settings: NavigatorSettings; warnings: string[] } | { ok: false; error: string } {
  try {
    writeNavigatorSettings(path, settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: bounded(message, 160) };
  }
  const reloaded = loadNavigatorSettings({ userPath: path });
  return { ok: true, settings: reloaded.settings, warnings: reloaded.warnings };
}

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
  const trimmed = rawValue.trim();
  if (trimmed === "") return { ok: false, error: `invalid number "${rawValue}"` };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { ok: false, error: `invalid number "${rawValue}"` };
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

  const parsed = FIELD_KIND_RULES[field.kind].parse(field, rawValue);
  if (!parsed.ok) return parsed;
  return { ok: true, settings: setField(settings, field.path, parsed.value) };
}

/**
 * Shallow-clone the settings with one registry path set. All five registry
 * paths are exactly two segments deep, so the section is cloned explicitly.
 * The cast is safe: the caller (the string face or an override parser via the
 * loader) accepted the value against the field before this runs.
 */
function setField(settings: NavigatorSettings, path: readonly string[], value: string | number | boolean): NavigatorSettings {
  if (path.length !== 2) return settings;
  const [sectionKey, key] = path;
  if (sectionKey === undefined || key === undefined) return settings;
  // SAFETY: every registry path (section, key) resolves in a
  // NavigatorSettings object; the sync-guard tests pin that.
  const settingsRec = settings as unknown as Record<string, Record<string, unknown>>;
  const section = settingsRec[sectionKey];
  if (section === undefined) return settings;
  // SAFETY: the clone keeps the NavigatorSettings shape — same sections,
  // one path overwritten with a kind-validated value.
  const cloned = { ...settings } as unknown as Record<string, Record<string, unknown>>;
  cloned[sectionKey] = { ...section, [key]: value };
  // SAFETY: the value cloned above preserved the NavigatorSettings shape.
  return cloned as unknown as NavigatorSettings;
}
