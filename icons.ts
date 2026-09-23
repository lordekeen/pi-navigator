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

import { parseTruthyEnv } from "./env";

/** Environment variable that enables the icon column. */
export const ICONS_ENV = "PI_NAV_ICONS";

/**
 * Generic file glyph: `fa-file_o` (a blank document). Verified present in
 * Nerd Fonts v3; the previous value (\ue723) was `dev-ansible`, so every
 * unmapped file wore the Ansible logo (Issue #111).
 */
export const GENERIC_ICON = "\uf016"; //  fa-file_o

/**
 * Curated extension → Nerd Font codepoint map.
 *
 * The preview glyph in each comment IS the codepoint, so a blank or
 * off-looking preview means the codepoint is wrong. Every value is verified
 * against Nerd Fonts v3 `glyphnames.json` (3.5.1); the trailing name is the
 * registry name. Do NOT paste codepoints from a v2 cheatsheet — v3 deleted
 * the old Material Design Icons ranges (\uf3e0-\uf3ff and \uf600-\ufdff),
 * where they render as tofu (Issue #111).
 */
const EXT_ICONS: Record<string, string> = {
  ts: "\ue628",       //  seti-typescript
  tsx: "\ue7ba",      //  dev-react
  js: "\ue781",       //  dev-javascript
  jsx: "\ue7ba",      //  dev-react
  mjs: "\ue781",      //  dev-javascript
  cjs: "\ue781",      //  dev-javascript
  json: "\ue60b",     //  seti-json
  jsonc: "\ue60b",    //  seti-json
  md: "\uf48a",       //  oct-markdown
  mdx: "\uf48a",      //  oct-markdown
  sh: "\ue795",       //  dev-terminal
  bash: "\ue795",     //  dev-terminal
  zsh: "\ue795",      //  dev-terminal
  css: "\ue749",      //  dev-css3
  scss: "\ue74b",     //  dev-sass
  sass: "\ue74b",     //  dev-sass
  less: "\ue758",     //  dev-less
  html: "\ue736",     //  dev-html5
  htm: "\ue736",      //  dev-html5
  vue: "\ue8dc",      //  dev-vuejs
  svelte: "\ue697",   //  seti-svelte
  py: "\ue606",       //  seti-python
  go: "\ue626",       //  custom-go
  rs: "\ue7a8",       //  dev-rust
  rb: "\ue739",       //  dev-ruby
  php: "\ue73d",      //  dev-php
  java: "\ue738",     //  dev-java
  c: "\ue61e",        //  custom-c
  h: "\ue61e",        //  custom-c
  cpp: "\ue61d",      //  custom-cpp
  cc: "\ue61d",       //  custom-cpp
  hpp: "\ue61d",      //  custom-cpp
  cs: "\ue7b2",       //  dev-csharp
  swift: "\ue755",    //  dev-swift
  kt: "\ue634",       //  custom-kotlin
  yml: "\ue6a8",      //  seti-yml
  yaml: "\ue6a8",     //  seti-yml
  toml: "\ue6b2",     //  custom-toml
  xml: "\ue619",      //  seti-xml
  svg: "\ue698",      //  seti-svg
  png: "\uf1c5",      //  fa-file_image
  jpg: "\uf1c5",      //  fa-file_image
  jpeg: "\uf1c5",     //  fa-file_image
  gif: "\uf1c5",      //  fa-file_image
  webp: "\uf1c5",     //  fa-file_image
  ico: "\uf1c5",      //  fa-file_image
  bmp: "\uf1c5",      //  fa-file_image
  avif: "\uf1c5",     //  fa-file_image
  lock: "\uf023",     //  fa-lock
  sql: "\uf1c0",      //  fa-database
  db: "\uf1c0",       //  fa-database
  txt: "\uf15c",      //  fa-file_lines
  log: "\uf15c",      //  fa-file_lines
  pdf: "\uf1c1",      //  fa-file_pdf
};

/** Exact filename glyph map for dotfiles and special filenames without standard extensions. */
const FILENAME_ICONS: Record<string, string> = {
  dockerfile: "\uf308",       //  linux-docker
  license: "\uf24e",          //  fa-balance_scale
  ".gitignore": "\uf1d3",     //  fa-git
  ".gitattributes": "\uf1d3", //  fa-git
  ".editorconfig": "\ue615",  //  seti-config
};

/** Folder glyph for directories. */
const DIR_ICON = "\uf4d3"; //  oct-file_directory_fill

/**
 * Every glyph the map can emit, for the v3-range guard in the icon suite
 * (Issue #111): the table is curated by hand, so a codepoint copied from a v2
 * cheatsheet renders as tofu with nothing to catch it at runtime.
 */
export const ICON_GLYPHS: readonly string[] = [
  ...Object.values(EXT_ICONS),
  ...Object.values(FILENAME_ICONS),
  DIR_ICON,
  GENERIC_ICON,
];

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
 * "no override", never a warning. Thin projection onto the shared
 * `parseTruthyEnv` (env.ts); the images-only `chafa` token is deliberately
 * not an icon enable value, so `PI_NAV_ICONS=chafa` warns like any other
 * unknown token.
 */
export function parseIconMode(value: string | undefined): { enabled?: boolean; warning?: string } {
  const parsed = parseTruthyEnv(value, ICONS_ENV);
  if (parsed.warning !== undefined) return { enabled: undefined, warning: parsed.warning };
  return { enabled: parsed.value };
}

/**
 * Compatibility wrapper over `parseIconMode`: `1`/`true`/`yes`/`on` → true,
 * anything else (including unset) → false. Pure so the module and tests stay
 * hermetic.
 */
export function parseEnableIcons(env: string | undefined): boolean {
  return parseIconMode(env).enabled ?? false;
}
