/**
 * pi-navigator constants.
 *
 * Values locked in plans/pi-navigator-implementation-plan.md sections 6, 7 and 8.
 * No runtime dependency is introduced here; every number is consumed by the
 * data modules (tree, git, viewer) and the overlay component.
 */

// ── Refresh ──

/** Git and tree refresh base interval while the overlay is open. */
export const REFRESH_INTERVAL_MS = 3000;

/** Maximum idle polling interval under dynamic backoff. */
export const MAX_POLL_INTERVAL_MS = 10000;

// ── Viewing caps ──

/** Files larger than this render as a truncated head plus a notice row. */
export const MAX_HIGHLIGHT_BYTES = 1024 * 1024;

/** Line cap for full highlighting; beyond it the file is truncated. */
export const MAX_HIGHLIGHT_LINES = 5000;

/** Line counting is skipped above this size. */
export const MAX_LINE_COUNT_BYTES = 256 * 1024;

/**
 * Maximum number of parsed ViewerFile entries kept in the per-file viewer
 * cache in index.ts. Re-opening a file whose mtime is unchanged reuses the
 * cached highlighted lines instead of re-running the loadFile pipeline.
 */
export const MAX_VIEWER_CACHE_ENTRIES = 16;

/** Bytes read for binary sniffing (NUL byte detection). */
export const BINARY_SNIFF_BYTES = 4096;

/** Tabs expand to this many columns before highlighting. */
export const TAB_WIDTH = 4;

// ── Tree ──

/** Directory recursion depth cap for the filesystem walk fallback. */
export const MAX_TREE_DEPTH = 6;

/** Directory names skipped by the filesystem walk fallback. */
export const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".pytest_cache",
  ".mypy_cache",
  "__pycache__",
  "venv",
  ".venv",
  ".DS_Store",
]);

/** Extensions routed to the image viewer tier instead of text. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

// ── Git ──

/** Timeout for every git invocation. */
export const GIT_TIMEOUT_MS = 3000;

/** Commits pulled for the history section. */
export const GIT_HISTORY_COUNT = 20;

// ── Layout ──

/** Overlay options passed to ctx.ui.custom. */
export const OVERLAY_OPTIONS = {
  width: "90%",
  minWidth: 80,
  maxHeight: "85%",
  anchor: "center",
  margin: 1,
} as const;

/** Left column: 30 percent of the inner width, clamped. */
export const LEFT_COLUMN_RATIO = 0.3;
export const LEFT_COLUMN_MIN = 24;
export const LEFT_COLUMN_MAX = 44;

/** Below this inner width the left column is hidden (toggle with t). */
export const LEFT_COLUMN_HIDE_BELOW = 72;

/** Minimum rows reserved for the git section of the left column. */
export const GIT_MIN_ROWS = 4;

/** Below this overlay width the compact notice is rendered instead. */
export const MIN_OVERLAY_WIDTH = 40;
/**
 * Below this overlay height the compact notice is rendered instead. Five rows
 * are chrome (top border, title, separator, footer, bottom border), so this is
 * the plan section 6 minimum of 8 body rows plus that chrome.
 */
export const MIN_OVERLAY_HEIGHT = 13;

/** Half-page scroll fraction for ctrl+d / ctrl+u. */
export const HALF_PAGE_DIVISOR = 2;
