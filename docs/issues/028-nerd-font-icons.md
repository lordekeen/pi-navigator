# Issue #028: Nerd Font Filetype Icons, Env-Gated

- **Status**: Resolved
- **Type**: Feature
- **Severity**: Medium
- **Component**: New `icons.ts` / [`buildFileRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts)

---

## Description

Visual polish: render Nerd Font filetype glyphs in the file tree so file kinds are recognizable at a glance. Requires a fallback for terminals without a Nerd Font. pi-tui exposes **no** font/nerd capability probe (`detectCapabilities()` covers only image/truecolor/hyperlinks), and pi's extension `ctx` exposes **no** settings getter — so auto-detection is not available; the design decision is an **explicit env toggle**, default off, so non-Nerd terminals are never degraded.

## Code References

- New `icons.ts` — `mapExtensionToIcon` + `parseEnableIcons`
- [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) `buildFileRow` (icon column), `NavigatorOverlay` ctor `enableIcons`
- [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) reads `process.env[ICONS_ENV]` once at overlay open

## Potential Solution

`PI_NAV_ICONS=1` → `parseEnableIcons` → `NavigatorOptions.enableIcons` → one-cell icon column in `buildFileRow` (dir → folder glyph, file → ext map, else generic), with truncation room adjusted so rows stay width-safe. One-time dim notice when enabled. Curated additive ext map.

## Acceptance Criteria

- [x] `PI_NAV_ICONS=1` renders the icon column; default (unset) renders exactly today's rows.
- [x] Icon column is width-safe at 120×36, 100×28, 80×24 (render suite).
- [x] Unknown/extensionless → generic glyph; dirs → folder glyph; map is additive and unit-tested.
- [x] `parseEnableIcons` truth-table tested; `navigator.ts` never reads env (index.ts owns it).
- [x] One-time, non-blocking tofu hint when icons are on.
- [x] `npm run typecheck` and `npm test` green.

## Resolution

Added `icons.ts` (curated ext → Nerd Font codepoint map, `DIR_ICON`, `GENERIC_ICON`, pure `parseEnableIcons`). `index.ts` reads `PI_NAV_ICONS` once and passes `enableIcons` into the overlay; `buildFileRow` inserts a one-cell styled icon between the arrow and label (inheriting the row's name color), and the truncation room/gap math accounts for the extra cell. A one-time dim footer notice fires on first icons-on render. Tests: `test/icons.test.ts` (parser + map), render width-safety with icons on at 80/120/100. Version bumped to 0.3.0.
