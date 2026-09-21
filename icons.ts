/**
 * pi-navigator Nerd Font icons.
 *
 * v1 is env-gated: `PI_NAV_ICONS=1` opts in (1/true/yes/on all enable). The
 * default is the plain-text glyphs the overlay already ships, so terminals
 * without a Nerd Font are never degraded. There is no auto-detection — pi-tui
 * exposes no nerd-font capability probe (only image/truecolor/hyperlinks), so
 * the toggle is the deterministic source of truth (approved design, Issue #028).
 *
 * The map is a curated v1 subset; unknown extensions and extensionless names
 * fall back to a generic file glyph. All codepoints are from the Nerd Font
 * glyph set. Icons inherit the row's name color at the render site — no color
 * lives here.
 */

/** Environment variable that enables the icon column. */
export const ICONS_ENV = "PI_NAV_ICONS";

const ICON_ENABLE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const ICON_DISABLE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

/** Generic file glyph (Nerd Font `nf-custom-file`-class). */
export const GENERIC_ICON = "\ue723";

/** Curated extension → Nerd Font codepoint map (v1 subset). */
const EXT_ICONS: Record<string, string> = {
  ts: "\ue628", //  typescript
  tsx: "\ue7ba", //  typescript-react
  js: "\ue74c", //  javascript
  jsx: "\ue7ba", //  javascript-react
  mjs: "\ue74c",
  cjs: "\ue74c",
  json: "\ue60b", //  json
  jsonc: "\ue60b",
  md: "\uf48a", //  markdown
  mdx: "\uf48a",
  sh: "\ue795", //  terminal
  bash: "\ue795",
  zsh: "\ue795",
  css: "\ue749", //  css
  scss: "\ue749",
  sass: "\ue749",
  less: "\ue749",
  html: "\ue736", //  html
  htm: "\ue736",
  vue: "\ue731", //  vue
  svelte: "\ue697", //  svelte
  py: "\ue606", //  python
  go: "\ue626", //  golang
  rs: "\ue7a8", //  rust
  rb: "\ue739", //  ruby
  php: "\ue73d", //  php
  java: "\ue738", //  java
  c: "\ue61e", //  c
  h: "\ue61e",
  cpp: "\ue61d", //  cpp
  cc: "\ue61d",
  hpp: "\ue61d",
  cs: "\uf81a", //  csharp
  swift: "\ue755", //  swift
  kt: "\ue634", //  kotlin
  yml: "\ue60b",
  yaml: "\ue60b",
  toml: "\ue615", //  toml
  xml: "\ue619", //  xml
  svg: "\uf72f", //  svg
  png: "\uf302", //  image
  jpg: "\uf302",
  jpeg: "\uf302",
  gif: "\uf302",
  webp: "\uf302",
  ico: "\uf302",
  bmp: "\uf302",
  avif: "\uf302",
  lock: "\uf3e2", //  lock
  sql: "\uf1c0", //  database
  db: "\uf1c0",
  txt: "\uf15c", //  file-text
  log: "\uf15c",
  pdf: "\uf1c1", //  pdf
};

/** Exact filename glyph map for dotfiles and special filenames without standard extensions. */
const FILENAME_ICONS: Record<string, string> = {
  dockerfile: "\uf308", //  docker
  license: "\uf718",
  ".gitignore": "\uf1d3", //  git
  ".gitattributes": "\uf1d3",
  ".editorconfig": "\uf461",
};

/** Folder glyph for directories. */
const DIR_ICON = "\uf4d3"; //  folder

/**
 * Resolve the Nerd Font glyph for a tree entry. Directories always get the
 * folder glyph; exact filenames match first, then extension with a generic fallback.
 */
export function mapExtensionToIcon(relPath: string, isDir: boolean): string {
  if (isDir) return DIR_ICON;
  const slash = relPath.lastIndexOf("/");
  const basename = (slash >= 0 ? relPath.slice(slash + 1) : relPath).toLowerCase();
  const fileIcon = FILENAME_ICONS[basename];
  if (fileIcon) return fileIcon;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return GENERIC_ICON;
  const ext = basename.slice(dot + 1);
  return EXT_ICONS[ext] ?? GENERIC_ICON;
}

/**
 * Parse the PI_NAV_ICONS env value (Issue #061): enable = 1/true/yes/on,
 * disable = 0/false/no/off, anything else ignored with one warning so the
 * file/default setting stands. Case-insensitive, trimmed; empty input is
 * "no override", never a warning. Mirrors `parseImageMode` (settings.ts).
 */
export function parseIconMode(value: string | undefined): { enabled?: boolean; warning?: string } {
  if (value === undefined) return { enabled: undefined };
  const trimmed = value.trim();
  if (trimmed === "") return { enabled: undefined };
  const normalized = trimmed.toLowerCase();
  if (ICON_ENABLE_VALUES.has(normalized)) return { enabled: true };
  if (ICON_DISABLE_VALUES.has(normalized)) return { enabled: false };
  return { enabled: undefined, warning: `${trimmed} is not a valid PI_NAV_ICONS value; using the file/default setting` };
}

/**
 * Compatibility wrapper over `parseIconMode`: `1`/`true`/`yes`/`on` → true,
 * anything else (including unset) → false. Pure so the module and tests stay
 * hermetic.
 */
export function parseEnableIcons(env: string | undefined): boolean {
  return parseIconMode(env).enabled ?? false;
}
